// The download pipeline for one link in a private chat (brief §6). lib/router.js has already run
// the ban, maintenance, language, forced-join and disclaimer gates. Steps:
//   status message "processing…" → identify → policy precheck (lib/policy.js) → claim quota/cooldown
//   → expand short links → blocklist again → file_id cache → resolve (enabled methods in order; a
//   temporary failure falls through to the next method) → sensitive / account blocklist → probe
//   sizes → choose variants → deliver → cache file_ids → history row + counters → status message
//   deleted (success) or replaced by the reason (failure/denial).
// Platforms that only give information (status METADATA_ONLY) answer with a card instead of files:
// title, author, cover by URL (checked like media), link and why there is no file — result status
// 'meta'. A failure that isn't the user's doing and an information card give the quota back (the
// cooldown stays).
// GIFs (an MP4 the platform marks as a GIF, e.g. X) in a private chat: the user is asked first —
// as a GIF (animation) or as a video — then the same link runs again with that choice (no
// transcoding: the same file, sent with sendAnimation or sendVideo). Groups get the GIF as a GIF.
import { alertOwner } from './alerts.js';
import { BUILT_PLATFORMS, MB, PLATFORM_NAMES, TG_UPLOAD_MAX, TG_UPLOAD_PHOTO_MAX, TG_URL_PHOTO_MAX } from './config.js';
import * as downloadsDb from './db/downloads.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { deliver, DeliveryError, sendCard, sendCached } from './delivery.js';
import * as external from './external.js';
import { configFrom as vipConfig, isVip, SETTING as VIP_SETTING } from './vip.js';
import { HttpError, probe, ResolveError } from './platforms/common.js';
import * as registry from './platforms/index.js';
import { choose, domainCandidates, limitsFrom, offerable, pickVariant, platformState, precheck } from './policy.js';
import { isStaff } from './roles.js';
import * as tg from './tg.js';
import { button, caption as buildCaption, markup, pairs, plain } from './ui.js';
import { encode } from './codec.js';
import { t, tp } from './i18n/index.js';
import { isAllowedFetch, parseUrl } from './url.js';
import { errorText, tehranDay } from './util.js';

const MAX_PROBES = 16;
/** Don't start downloading bytes for an upload this late in the invocation (wall limit ≈ 30 s). */
const UPLOAD_DEADLINE_MS = 15000;

/** Reason → { status, refund } for the history row and the quota. */
const OUTCOME = {
  invalid_link: 'denied', telegram_link: 'denied', unknown_site: 'denied', not_built: 'denied', unsupported_kind: 'denied', unavailable_platform: 'denied',
  downloads_off: 'denied', quota: 'denied', cooldown: 'denied', platform_off: 'denied', platform_paused: 'denied',
  blocked: 'denied', sensitive: 'denied', restricted: 'denied', private: 'denied',
  not_found: 'failed', no_media: 'failed', too_big: 'failed', size_unknown: 'failed', unavailable: 'failed',
  unsupported: 'failed', delivery: 'failed', slow: 'failed', file_type: 'failed', login_wall: 'failed', drm: 'failed',
};

/** Extra advice after some refusals, per platform (i18n 'dl.hint.<platform>'). */
const HINTS = { discord: ['unsupported_kind', 'not_found'], twitch: ['unsupported_kind'] };
const STATUS_COUNTER = { ok: 'dl_ok', meta: 'dl_meta', failed: 'dl_failed', denied: 'dl_denied' };

export const settingKeys = (platformId) => ['switch.downloads', 'limits', 'platform:' + platformId, external.SETTING, VIP_SETTING];

async function sendStatus(ctx, chatId, replyTo, lang) {
  try {
    return await tg.send(ctx, 'dl_status', chatId, plain(lang, 'dl.processing'), {
      reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    });
  } catch {
    return null;
  }
}

async function finishStatus(ctx, chatId, status, lang, result) {
  if (!status) return;
  if ((result.status === 'ok' || result.status === 'meta') && !result.relayed) {
    try {
      await tg.call(ctx, 'dl_status', 'deleteMessage', { chat_id: chatId, message_id: status.message_id });
      return;
    } catch { /* fall through: say it's done instead */ }
  }
  const screen = result.relayed ? plain(lang, 'dl.relayed') : result.status === 'ok' || result.status === 'meta' ? plain(lang, 'dl.done') : plain(lang, 'dl.err.' + result.reason, {
    platform: PLATFORM_NAMES[result.platform] || result.platform || '',
    quota: result.quota, wait: result.wait,
    size: result.bytes ? (result.bytes / 1048576).toFixed(1) : '?',
    max: result.max ? Math.round(result.max / 1048576) : '?',
  });
  if (HINTS[result.platform] && HINTS[result.platform].includes(result.reason)) screen.text += '\n\n' + plain(lang, 'dl.hint.' + result.platform).text;
  try {
    await tg.edit(ctx, 'dl_status', { chat: { id: chatId }, message_id: status.message_id }, screen);
  } catch { /* the user may have deleted it */ }
}

/**
 * Probes the sizes of every allowed variant (in parallel, at most MAX_PROBES). Drops variants whose
 * URL is off the allowlist or redirects off it — Telegram would follow such a redirect when fetching
 * by URL, so they are never sent, by URL or otherwise.
 */
async function probeAll(ctx, post, allow, head) {
  let budget = MAX_PROBES;
  const jobs = [];
  for (const item of post.items) {
    item.variants = item.variants.filter((v) => isAllowedFetch(v.url, allow));
    for (const v of item.variants) {
      if (Number.isFinite(v.bytes) && v.bytes > 0) continue; // the adapter already checked it (every hop allowlisted)
      if (budget-- <= 0) break;
      jobs.push(probe(ctx, v.url, allow, { head })
        .then((p) => { v.bytes = p.bytes; v.ranges = p.ranges; if (p.type) v.mime = p.type.split(';')[0]; })
        .catch((err) => { if (err instanceof HttpError && err.kind === 'blocked_host') v.rejected = true; }));
    }
  }
  await Promise.all(jobs);
  for (const item of post.items) item.variants = item.variants.filter((v) => !v.rejected);
}

function denyOrFail(reason, extra = {}) {
  return { status: OUTCOME[reason] || 'failed', reason, ...extra };
}

/**
 * Handles one link for `user` (from lib/router.js prepareUser) sent in `msg`.
 * → the result (also recorded): { status: ok|failed|denied, reason?, platform?, method?, … }
 */
export const ASK_TTL_S = 600;
const askKey = (userId) => 'ask:' + userId;

/**
 * opts.format: 'gif' | 'video' — the answer to the GIF question (the request already passed the
 * cooldown when the link was sent); opts.status: the bot message to reuse as the status message.
 */
export async function handleLink(ctx, user, msg, link, scope = { kind: 'private' }, opts = {}) {
  const lang = user.lang;
  const chatId = msg.chat.id;
  const day = tehranDay(ctx.now);
  const group = scope.kind === 'group';
  const status = opts.status || (group && scope.settings.silent ? null : await sendStatus(ctx, chatId, msg.message_id, lang));
  if (!status && !group) return { status: 'failed', reason: 'unreachable' };

  let claimed = false;
  let result;
  try {
    result = await run(ctx, user, msg, link, day, () => { claimed = true; }, scope, opts);
  } catch (err) {
    result = { status: 'failed', reason: 'unavailable', error: errorText(err) };
    await system.logError(ctx.now, 'download', errorText(err), err && err.stack ? String(err.stack).slice(0, 1500) : null).catch(() => {});
    await alertOwner(ctx, 'error:download', 'alert.error', { source: 'download', message: errorText(err) }, 1800).catch(() => {});
  }
  if (claimed && (result.status === 'failed' || result.status === 'meta' || result.status === 'asked')) await users.refundDownload(user.id, day).catch(() => {});
  if (result.status === 'asked') return askFormat(ctx, user, msg, link, status, result);

  await downloadsDb.record({
    userId: user.id, chatId, platform: result.platform || null, method: result.method || null,
    url: result.url || String(link).slice(0, 300), status: result.status, reason: result.reason || null,
    bytes: result.bytes || 0, items: result.items || 0,
  }, ctx.now);
  const p = result.platform && BUILT_PLATFORMS.includes(result.platform) ? result.platform : null;
  const incs = [[STATUS_COUNTER[result.status] || 'dl_failed', day, 1]];
  if (p && result.status !== 'denied') incs.push([`dl_${result.status}:${p}`, day, 1], [`dl_${result.status}:${p}`, '', 1]);
  if (result.cached) incs.push(['dl_cached', day, 1]);
  if (group && result.status !== 'denied') incs.push([`g_${result.status}:${chatId}`, day, 1]);
  await system.count(incs);

  await finishStatus(ctx, chatId, status, lang, result);
  return result;
}

async function run(ctx, user, msg, link, day, onClaim, scope, opts = {}) {
  const group = scope.kind === 'group';
  const id = registry.identify(link);
  if (id.kind === 'invalid') return denyOrFail('invalid_link');
  if (id.kind === 'telegram') return denyOrFail('telegram_link');
  if (id.kind === 'unknown') return denyOrFail('unknown_site');
  if (id.kind === 'not_built') return denyOrFail('not_built', { platform: id.platform });
  if (id.kind === 'unavailable') return denyOrFail('unavailable_platform', { platform: id.platform });
  if (id.kind === 'unsupported_kind') return denyOrFail('unsupported_kind', { platform: id.adapter.id });
  const { adapter } = id;
  let { ref } = id;
  const base = { platform: adapter.id, url: ref.url };

  const s = await system.loadSettings(settingKeys(adapter.id));
  const global = limitsFrom(s.limits && s.limits.value);
  // Private: the user's daily quota (or their personal one). Groups: the group's own cooldowns were
  // claimed by lib/groups.js, and the group's size limit can only lower the global one.
  const base0 = group
    ? { ...global, max_mb: Math.min(global.max_mb, Number(scope.settings.max_mb) || global.max_mb) }
    : user.row.quota_override != null ? { ...global, quota_per_day: user.row.quota_override }
      : { ...global, quota_per_day: global.quota_per_day + (Number(user.row.ref_bonus) || 0) }; // + invitation bonus
  // VIP (lib/vip.js): its own quota and cooldown in private chats while it lasts.
  const plan = vipConfig(s[VIP_SETTING] && s[VIP_SETTING].value);
  const base1 = !group && isVip(user.row, ctx.now) ? { ...base0, quota_per_day: plan.quota, cooldown_s: plan.cooldown_s } : base0;
  // An answer to a question, or the 2nd/3rd link of one message: the cooldown was already passed.
  const limits = opts.format || opts.pick != null || opts.batch ? { ...base1, cooldown_s: 0 } : base1;
  const state = platformState(s['platform:' + adapter.id] && s['platform:' + adapter.id].value);
  const ext = external.configFrom(s[external.SETTING] && s[external.SETTING].value);
  const host = parseUrl(link).host;
  const hit = await downloadsDb.blockedBy({ urlKey: ref.key, account: ref.account, domains: domainCandidates(host) });
  const exempt = group || isStaff(user.actor);
  const pre = precheck({
    downloadsOn: s['switch.downloads'] ? s['switch.downloads'].value !== false : true,
    exempt, user: user.row, today: day, now: ctx.now, limits, adapter, state, blocked: !!hit,
  });
  if (!pre.ok) return denyOrFail(pre.reason, { ...base, quota: pre.quota, wait: pre.wait });

  if (!exempt) {
    if (!(await users.claimDownload(user.id, day, ctx.now, limits.quota_per_day, limits.cooldown_s))) {
      return denyOrFail('cooldown', { ...base, wait: limits.cooldown_s });
    }
    onClaim();
  }

  try {
    ref = await adapter.expand(ctx, ref);
  } catch (err) {
    return denyOrFail(err instanceof ResolveError ? err.code : 'unavailable', base);
  }
  base.url = ref.url;
  if (ref.key && (await downloadsDb.blockedBy({ urlKey: ref.key, account: ref.account }))) return denyOrFail('blocked', base);

  // Preferences (⚙️ Settings). Groups: no questions, GIFs as GIFs, media (not files).
  const prefs0 = await users.getPrefs(user.id);
  const prefs = group ? { quality: prefs0.quality, gif: 'gif', delivery: 'media' } : prefs0;
  const quality = prefs.quality === 'ask' ? 'auto' : prefs.quality;
  const fileMode = prefs.delivery === 'file';
  const picked = opts.pick != null;
  // The GIF format: the user's answer, else the preference; a link that may not ask takes GIF.
  const format = opts.format || (prefs.gif !== 'ask' ? prefs.gif : opts.noAsk ? 'gif' : null);
  // Cache variants: "<quality>[:p<pick>][:file]" and, for GIF posts sent as media, ":gif" / ":video".
  const baseVariant = [quality, picked ? 'p' + opts.pick : null, fileMode ? 'file' : null].filter(Boolean).join(':');
  const gifRow = (r) => !!r && r.items.some((i) => i.type === 'gif');
  let variant = baseVariant;
  let cached = await downloadsDb.cacheGet(ref.key, baseVariant);
  if (!group && !fileMode && (!cached || gifRow(cached))) {
    if (format) {
      variant = `${baseVariant}:${format}`;
      cached = (await downloadsDb.cacheGet(ref.key, variant)) || null;
    } else if (gifRow(cached)) cached = null; // ask first
  }
  if (cached) {
    const meta = parseMeta(cached.title);
    try {
      await sendCached(ctx, {
        chatId: msg.chat.id, replyTo: msg.message_id, items: cached.items,
        caption: buildCaption(user.lang, { platform: adapter.id, url: ref.url, title: meta.title, author: meta.author, details: meta.details }, meta.notes || []),
      });
      await downloadsDb.cacheHit(ref.key, variant, ctx.now);
      return { status: meta.meta ? 'meta' : 'ok', ...base, method: 'cache', cached: true, bytes: cached.bytes, items: cached.items.length };
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      await downloadsDb.cacheDrop(ref.key); // stale file_ids: fetch again below
    }
  }

  let post = null;
  let lastErr = null;
  for (const method of pre.methods) {
    try {
      post = method === 'external'
        ? await external.resolve(ctx, ext, { platform: adapter.id, ref, maxBytes: limits.max_mb * MB, quality })
        : await adapter.resolve(ctx, ref, method);
      break;
    } catch (err) {
      lastErr = err instanceof ResolveError ? err : new ResolveError('unavailable', errorText(err));
      if (lastErr.code !== 'unavailable') break;
    }
  }
  if (!post) return denyOrFail(lastErr ? lastErr.code : 'unavailable', base);
  base.method = post.method;
  if (post.sensitive) return denyOrFail('sensitive', base);
  if (post.account && (await downloadsDb.blockedBy({ account: post.account }))) return denyOrFail('blocked', base);
  if (post.meta) return infoCard(ctx, user, msg, adapter, ref, post, quality, base);

  // Files of the method 'external' may come only from the owner's service host.
  const allow = post.mediaHosts || adapter.mediaHosts;
  await probeAll(ctx, post, allow, post.mediaHosts ? false : adapter.headSafe === true);
  const maxBytes = limits.max_mb * 1048576;
  // "Ask every time": a single video in several deliverable qualities → the quality question.
  if (!group && !opts.noAsk && !picked && prefs.quality === 'ask' && post.items.length === 1 && post.items[0].type === 'video') {
    const offers = offerable(post.items[0], maxBytes);
    if (offers.length >= 2) return { status: 'asked', ask: 'quality', offers, ...base };
  }
  const pickOrChoose = (item) => {
    const c = picked && post.items.length === 1 ? pickVariant(item, opts.pick, maxBytes) : null;
    return c && !c.error ? c : choose(item, quality, maxBytes);
  };
  const choices = [];
  let firstError = null;
  for (const item of post.items) {
    let c = null;
    if (fileMode) { // as a document: uploaded (sendDocument by URL only takes GIF/PDF/ZIP), so the size must be known
      const d = pickOrChoose({ ...item, type: 'document' });
      if (!d.error && !d.sizeUnknown && d.variant.bytes > 0) c = { ...d, via: 'upload', doc: true };
    }
    if (!c) c = pickOrChoose(item);
    if (c.error) firstError = firstError || c;
    else choices.push({ item: c.doc ? { ...item, type: 'document', was: item.type } : item, ...c });
  }
  // A GIF the platform serves as MP4 can go as a GIF or as a video: ask (private chats), then apply.
  const asVideoToo = (c) => c.item.type === 'gif' && (c.variant.mime === 'video/mp4' || /\.mp4(\?|$)/i.test(c.variant.url));
  const hasGif = choices.some(asVideoToo);
  if (!group && !format && hasGif) return { status: 'asked', ask: 'gif', ...base };
  if (format === 'video') for (const c of choices) if (asVideoToo(c)) c.item = { ...c.item, type: 'video' };
  const storeVariant = !group && !fileMode && hasGif ? `${baseVariant}:${format}` : baseVariant;
  const relayed = group ? null : await relayBig(ctx, user, msg, adapter, post, choices[0] || null, quality, ext, base);
  if (relayed) return relayed;
  if (!choices.length) {
    if (firstError && firstError.error === 'too_big') return denyOrFail('too_big', { ...base, bytes: firstError.bytes, max: firstError.max });
    return denyOrFail('no_media', base);
  }
  if (choices.some((c) => c.via === 'upload') && Date.now() - ctx.nowMs > UPLOAD_DEADLINE_MS) return denyOrFail('slow', base);

  const notes = [];
  if (choices.some((c) => c.downgraded)) notes.push('smaller');
  if (choices.length < post.items.length) notes.push('partial');
  if (post.coverOnly) notes.push('cover_only');
  let sent;
  try {
    sent = await deliver(ctx, {
      chatId: msg.chat.id, replyTo: msg.message_id, choices, allow, maxBytes,
      caption: buildCaption(user.lang, post, notes), name: `${adapter.id}_${String(ref.id || 'media').slice(-24)}`,
    });
  } catch (err) {
    if (err instanceof DeliveryError && err.code === 'too_big') return denyOrFail('too_big', base);
    if (err instanceof DeliveryError || err instanceof HttpError || (err && err.code === 400)) {
      return denyOrFail('delivery', { ...base, error: errorText(err) });
    }
    throw err;
  }
  if (sent.items.length === choices.length && sent.items.every((i) => i.file_id) && !notes.includes('partial')) {
    await downloadsDb.cachePut(ref.key, storeVariant, adapter.id, sent.items, JSON.stringify({ title: post.title, author: post.author, notes }), sent.bytes, ctx.now);
  }
  return { status: 'ok', ...base, bytes: sent.bytes, items: sent.items.length };
}

/**
 * Turns the status message into a question — GIF or video (result.ask 'gif'), or which quality
 * (result.ask 'quality', result.offers) — and remembers the link (one per user, ASK_TTL_S).
 */
async function askFormat(ctx, user, msg, link, status, result) {
  const lang = user.lang;
  const kind = result.ask === 'quality' ? 'quality' : 'gif';
  await system.setSetting(askKey(user.id), { kind, msg: msg.message_id, url: String(link), at: ctx.now }, user.id, ctx.now);
  const mb = (b) => (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1));
  const screen = kind === 'quality' ? {
    text: t(lang, 'dl.ask_quality'),
    reply_markup: markup(pairs(result.offers.map((o) => button(`${o.height ? o.height + 'p · ' : ''}${mb(o.bytes)} MB`, encode('V', o.index, msg.message_id))))),
  } : {
    text: t(lang, 'dl.ask_gif'),
    reply_markup: markup([[button(tp(lang, 'btn.as_gif'), encode('F', 'g', msg.message_id)), button(tp(lang, 'btn.as_video'), encode('F', 'v', msg.message_id))]]),
  };
  if (status) await tg.edit(ctx, 'dl_ask', { chat: { id: msg.chat.id }, message_id: status.message_id }, screen);
  else await tg.send(ctx, 'dl_ask', msg.chat.id, screen, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
  return result;
}

/**
 * A press on the GIF question (`message` = the question). → the download result, or
 * { expired: true } when the question is not the user's latest one or is older than ASK_TTL_S.
 */
export async function onFormatChoice(ctx, user, message, format, linkMessageId) {
  return answerQuestion(ctx, user, message, 'gif', linkMessageId, { format });
}

/** A press on the quality question: `index` = the variant offered. */
export async function onPick(ctx, user, message, index, linkMessageId) {
  return answerQuestion(ctx, user, message, 'quality', linkMessageId, { pick: index, noAsk: true });
}

async function answerQuestion(ctx, user, message, kind, linkMessageId, opts) {
  const s = await system.loadSettings([askKey(user.id)]);
  const v = s[askKey(user.id)] && s[askKey(user.id)].value;
  if (!v || (v.kind || 'gif') !== kind || v.msg !== linkMessageId || !(v.at > ctx.now - ASK_TTL_S) || typeof v.url !== 'string') return { expired: true };
  await system.deleteSetting(askKey(user.id));
  await tg.edit(ctx, 'dl_status', message, plain(user.lang, 'dl.processing'));
  const linkMsg = { chat: { id: message.chat.id }, message_id: linkMessageId };
  return handleLink(ctx, user, linkMsg, v.url, { kind: 'private' }, { ...opts, status: message });
}

/**
 * The owner's large-file relay (lib/external.js): in private chats, for a single-item post resolved
 * by the bot itself, when nothing fits Telegram's 50 MB upload limit — or the user prefers the best
 * quality and a bigger ready-made variant exists. The service sends the file later; if it doesn't
 * take the job, the bot sends what it can. → a result, or null.
 */
async function relayBig(ctx, user, msg, adapter, post, choice, quality, ext, base) {
  if (!ext || !ext.relay || post.method === 'external' || post.items.length !== 1) return null;
  const item = post.items[0];
  const upMax = item.type === 'photo' ? TG_UPLOAD_PHOTO_MAX : TG_UPLOAD_MAX;
  const big = item.variants.find((v) => Number.isFinite(v.bytes) && v.bytes <= ext.maxBytes);
  if (!big || big.bytes <= upMax) return null;
  if (choice && !(quality === 'best' && choice.variant !== big)) return null;
  const queued = await external.relay(ctx, ext, {
    request_id: `${msg.chat.id}:${msg.message_id}`, url: big.url, allow_hosts: adapter.mediaHosts, bytes: big.bytes, type: item.type,
    chat_id: msg.chat.id, reply_to_message_id: msg.message_id, caption: buildCaption(user.lang, post, []),
    fail_text: plain(user.lang, 'dl.relay_failed').text,
  });
  return queued ? { status: 'ok', ...base, method: 'relay', relayed: true, bytes: big.bytes, items: 1 } : null;
}

/**
 * The information card of a METADATA_ONLY platform: the cover goes by URL only (never downloaded by
 * the bot), after the same allowlist-and-redirect check as media; without a usable cover, text.
 */
async function infoCard(ctx, user, msg, adapter, ref, post, quality, base) {
  let cover = null;
  const allow = adapter.coverHosts || adapter.mediaHosts;
  if (post.cover && isAllowedFetch(post.cover, allow)) {
    try {
      const p = await probe(ctx, post.cover, allow, { head: adapter.headSafe === true });
      if (!(p.bytes > TG_URL_PHOTO_MAX)) cover = post.cover;
    } catch { /* redirected off the allowlist: no cover */ }
  }
  const notes = ['meta_' + adapter.id];
  const sent = await sendCard(ctx, { chatId: msg.chat.id, replyTo: msg.message_id, cover, caption: buildCaption(user.lang, post, notes) });
  if (sent.items.length && sent.items.every((i) => i.file_id)) {
    await downloadsDb.cachePut(ref.key, quality, adapter.id, sent.items, JSON.stringify({ title: post.title, author: post.author, details: post.details || null, notes, meta: true }), 0, ctx.now);
  }
  return { status: 'meta', ...base, items: sent.items.length };
}

/**
 * Inline mode (lib/inline.js): the same checks as a private download except the quota (nothing is
 * sent until the user picks a result), then the cached files or what Telegram can fetch by URL.
 * → { error } | { adapter, ref, cached, meta } | { adapter, ref, post, choices }
 */
export async function resolveForInline(ctx, user, link) {
  const id = registry.identify(link);
  if (id.kind !== 'post') return { error: id.kind };
  const { adapter } = id;
  let { ref } = id;
  const s = await system.loadSettings(settingKeys(adapter.id));
  const limits = limitsFrom(s.limits && s.limits.value);
  const state = platformState(s['platform:' + adapter.id] && s['platform:' + adapter.id].value);
  const hit = await downloadsDb.blockedBy({ urlKey: ref.key, account: ref.account, domains: domainCandidates(parseUrl(link).host) });
  const pre = precheck({
    downloadsOn: s['switch.downloads'] ? s['switch.downloads'].value !== false : true,
    exempt: true, user: user.row, today: tehranDay(ctx.now), now: ctx.now, limits, adapter, state, blocked: !!hit,
  });
  if (!pre.ok) return { error: pre.reason, platform: adapter.id };
  try {
    ref = await adapter.expand(ctx, ref);
  } catch {
    return { error: 'unavailable', platform: adapter.id };
  }
  if (ref.key && (await downloadsDb.blockedBy({ urlKey: ref.key, account: ref.account }))) return { error: 'blocked' };
  const prefs = await users.getPrefs(user.id);
  const quality = prefs.quality === 'ask' ? 'auto' : prefs.quality;
  const cached = await downloadsDb.cacheGet(ref.key, quality);
  if (cached) return { adapter, ref, cached, meta: parseMeta(cached.title) };
  let post = null;
  for (const method of pre.methods.filter((m) => m !== 'external')) {
    try {
      post = await adapter.resolve(ctx, ref, method);
      break;
    } catch (err) {
      if (!(err instanceof ResolveError) || err.code !== 'unavailable') return { error: err instanceof ResolveError ? err.code : 'unavailable', platform: adapter.id };
    }
  }
  if (!post) return { error: 'unavailable', platform: adapter.id };
  if (post.sensitive) return { error: 'sensitive' };
  if (post.account && (await downloadsDb.blockedBy({ account: post.account }))) return { error: 'blocked' };
  if (post.meta) return { adapter, ref, post };
  await probeAll(ctx, post, adapter.mediaHosts, adapter.headSafe === true);
  const choices = post.items.map((item) => ({ item, ...choose(item, quality, limits.max_mb * MB) })).filter((c) => !c.error && c.via === 'url');
  return { adapter, ref, post, choices };
}

function parseMeta(text) {
  try {
    const m = JSON.parse(text || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch {
    return { title: text || '' };
  }
}

/** The platforms a user can download from right now (built, a method on, not paused), for help/menu. */
export async function enabledPlatforms() {
  const s = await system.loadSettings(['switch.downloads', ...registry.ADAPTERS.map((a) => 'platform:' + a.id)]);
  if (s['switch.downloads'] && s['switch.downloads'].value === false) return [];
  return registry.ADAPTERS.filter((a) => {
    const st = platformState(s['platform:' + a.id] && s['platform:' + a.id].value);
    return !st.paused && a.methodOrder.some((m) => st.methods[m] === true);
  }).map((a) => a.id);
}

