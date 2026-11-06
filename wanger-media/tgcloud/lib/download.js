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
import { alertOwner } from './alerts.js';
import { BUILT_PLATFORMS, MB, PLATFORM_NAMES, TG_UPLOAD_MAX, TG_UPLOAD_PHOTO_MAX, TG_URL_PHOTO_MAX } from './config.js';
import * as downloadsDb from './db/downloads.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { deliver, DeliveryError, sendCard, sendCached } from './delivery.js';
import * as external from './external.js';
import { HttpError, probe, ResolveError } from './platforms/common.js';
import * as registry from './platforms/index.js';
import { choose, domainCandidates, limitsFrom, platformState, precheck } from './policy.js';
import { isStaff } from './roles.js';
import * as tg from './tg.js';
import { caption as buildCaption, plain } from './ui.js';
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

export const settingKeys = (platformId) => ['switch.downloads', 'limits', 'platform:' + platformId, external.SETTING];

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
export async function handleLink(ctx, user, msg, link, scope = { kind: 'private' }) {
  const lang = user.lang;
  const chatId = msg.chat.id;
  const day = tehranDay(ctx.now);
  const group = scope.kind === 'group';
  const status = group && scope.settings.silent ? null : await sendStatus(ctx, chatId, msg.message_id, lang);
  if (!status && !group) return { status: 'failed', reason: 'unreachable' };

  let claimed = false;
  let result;
  try {
    result = await run(ctx, user, msg, link, day, () => { claimed = true; }, scope);
  } catch (err) {
    result = { status: 'failed', reason: 'unavailable', error: errorText(err) };
    await system.logError(ctx.now, 'download', errorText(err), err && err.stack ? String(err.stack).slice(0, 1500) : null).catch(() => {});
    await alertOwner(ctx, 'error:download', 'alert.error', { source: 'download', message: errorText(err) }, 1800).catch(() => {});
  }
  if (claimed && (result.status === 'failed' || result.status === 'meta')) await users.refundDownload(user.id, day).catch(() => {});

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

async function run(ctx, user, msg, link, day, onClaim, scope) {
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
  const limits = group
    ? { ...global, max_mb: Math.min(global.max_mb, Number(scope.settings.max_mb) || global.max_mb) }
    : user.row.quota_override != null ? { ...global, quota_per_day: user.row.quota_override } : global;
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

  const quality = await users.getQuality(user.id);
  const cached = await downloadsDb.cacheGet(ref.key, quality);
  if (cached) {
    const meta = parseMeta(cached.title);
    try {
      await sendCached(ctx, {
        chatId: msg.chat.id, replyTo: msg.message_id, items: cached.items,
        caption: buildCaption(user.lang, { platform: adapter.id, url: ref.url, title: meta.title, author: meta.author, details: meta.details }, meta.notes || []),
      });
      await downloadsDb.cacheHit(ref.key, quality, ctx.now);
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
  const choices = [];
  let firstError = null;
  for (const item of post.items) {
    const c = choose(item, quality, maxBytes);
    if (c.error) firstError = firstError || c;
    else choices.push({ item, ...c });
  }
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
    await downloadsDb.cachePut(ref.key, quality, adapter.id, sent.items, JSON.stringify({ title: post.title, author: post.author, notes }), sent.bytes, ctx.now);
  }
  return { status: 'ok', ...base, bytes: sent.bytes, items: sent.items.length };
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

