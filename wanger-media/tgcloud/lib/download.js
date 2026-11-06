// The download pipeline for one link in a private chat (brief §6). lib/router.js has already run
// the ban, maintenance, language, forced-join and disclaimer gates. Steps:
//   status message "processing…" → identify → policy precheck (lib/policy.js) → claim quota/cooldown
//   → expand short links → blocklist again → file_id cache → resolve (enabled methods in order; a
//   temporary failure falls through to the next method) → sensitive / account blocklist → probe
//   sizes → choose variants → deliver → cache file_ids → history row + counters → status message
//   deleted (success) or replaced by the reason (failure/denial).
// A failure that isn't the user's doing gives the quota back (the cooldown stays).
import { alertOwner } from './alerts.js';
import { BUILT_PLATFORMS, PLATFORM_NAMES } from './config.js';
import * as downloadsDb from './db/downloads.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { deliver, DeliveryError, sendCached } from './delivery.js';
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
  invalid_link: 'denied', telegram_link: 'denied', unknown_site: 'denied', not_built: 'denied', unsupported_kind: 'denied',
  downloads_off: 'denied', quota: 'denied', cooldown: 'denied', platform_off: 'denied', platform_paused: 'denied',
  blocked: 'denied', sensitive: 'denied', restricted: 'denied', private: 'denied',
  not_found: 'failed', no_media: 'failed', too_big: 'failed', size_unknown: 'failed', unavailable: 'failed',
  unsupported: 'failed', delivery: 'failed', slow: 'failed',
};

export const settingKeys = (platformId) => ['switch.downloads', 'limits', 'platform:' + platformId];

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
  if (result.status === 'ok') {
    try {
      await tg.call(ctx, 'dl_status', 'deleteMessage', { chat_id: chatId, message_id: status.message_id });
      return;
    } catch { /* fall through: say it's done instead */ }
  }
  const screen = result.status === 'ok' ? plain(lang, 'dl.done') : plain(lang, 'dl.err.' + result.reason, {
    platform: PLATFORM_NAMES[result.platform] || result.platform || '',
    quota: result.quota, wait: result.wait,
    size: result.bytes ? (result.bytes / 1048576).toFixed(1) : '?',
    max: result.max ? Math.round(result.max / 1048576) : '?',
  });
  try {
    await tg.edit(ctx, 'dl_status', { chat: { id: chatId }, message_id: status.message_id }, screen);
  } catch { /* the user may have deleted it */ }
}

/**
 * Probes the sizes of every allowed variant (in parallel, at most MAX_PROBES). Drops variants whose
 * URL is off the allowlist or redirects off it — Telegram would follow such a redirect when fetching
 * by URL, so they are never sent, by URL or otherwise.
 */
async function probeAll(ctx, post, allow) {
  let budget = MAX_PROBES;
  const jobs = [];
  for (const item of post.items) {
    item.variants = item.variants.filter((v) => isAllowedFetch(v.url, allow));
    for (const v of item.variants) {
      if (budget-- <= 0) break;
      jobs.push(probe(ctx, v.url, allow)
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
export async function handleLink(ctx, user, msg, link) {
  const lang = user.lang;
  const chatId = msg.chat.id;
  const day = tehranDay(ctx.now);
  const status = await sendStatus(ctx, chatId, msg.message_id, lang);
  if (!status) return { status: 'failed', reason: 'unreachable' };

  let claimed = false;
  let result;
  try {
    result = await run(ctx, user, msg, link, day, () => { claimed = true; });
  } catch (err) {
    result = { status: 'failed', reason: 'unavailable', error: errorText(err) };
    await system.logError(ctx.now, 'download', errorText(err), err && err.stack ? String(err.stack).slice(0, 1500) : null).catch(() => {});
    await alertOwner(ctx, 'error:download', 'alert.error', { source: 'download', message: errorText(err) }, 1800).catch(() => {});
  }
  if (claimed && result.status === 'failed') await users.refundDownload(user.id, day).catch(() => {});

  await downloadsDb.record({
    userId: user.id, chatId, platform: result.platform || null, method: result.method || null,
    url: result.url || String(link).slice(0, 300), status: result.status, reason: result.reason || null,
    bytes: result.bytes || 0, items: result.items || 0,
  }, ctx.now);
  const p = result.platform && BUILT_PLATFORMS.includes(result.platform) ? result.platform : null;
  const incs = [[result.status === 'ok' ? 'dl_ok' : result.status === 'failed' ? 'dl_failed' : 'dl_denied', day, 1]];
  if (p && result.status !== 'denied') incs.push([`dl_${result.status}:${p}`, day, 1], [`dl_${result.status}:${p}`, '', 1]);
  if (result.cached) incs.push(['dl_cached', day, 1]);
  await system.count(incs);

  await finishStatus(ctx, chatId, status, lang, result);
  return result;
}

async function run(ctx, user, msg, link, day, onClaim) {
  const id = registry.identify(link);
  if (id.kind === 'invalid') return denyOrFail('invalid_link');
  if (id.kind === 'telegram') return denyOrFail('telegram_link');
  if (id.kind === 'unknown') return denyOrFail('unknown_site');
  if (id.kind === 'not_built') return denyOrFail('not_built', { platform: id.platform });
  if (id.kind === 'unsupported_kind') return denyOrFail('unsupported_kind', { platform: id.adapter.id });
  const { adapter } = id;
  let { ref } = id;
  const base = { platform: adapter.id, url: ref.url };

  const s = await system.loadSettings(settingKeys(adapter.id));
  const limits = limitsFrom(s.limits && s.limits.value);
  const state = platformState(s['platform:' + adapter.id] && s['platform:' + adapter.id].value);
  const host = parseUrl(link).host;
  const hit = await downloadsDb.blockedBy({ urlKey: ref.key, account: ref.account, domains: domainCandidates(host) });
  const exempt = isStaff(user.actor);
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
        caption: buildCaption(user.lang, { platform: adapter.id, url: ref.url, title: meta.title, author: meta.author }, meta.notes || []),
      });
      await downloadsDb.cacheHit(ref.key, quality, ctx.now);
      return { status: 'ok', ...base, method: 'cache', cached: true, bytes: cached.bytes, items: cached.items.length };
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      await downloadsDb.cacheDrop(ref.key); // stale file_ids: fetch again below
    }
  }

  let post = null;
  let lastErr = null;
  for (const method of pre.methods) {
    try {
      post = await adapter.resolve(ctx, ref, method);
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

  await probeAll(ctx, post, adapter.mediaHosts);
  const maxBytes = limits.max_mb * 1048576;
  const choices = [];
  let firstError = null;
  for (const item of post.items) {
    const c = choose(item, quality, maxBytes);
    if (c.error) firstError = firstError || c;
    else choices.push({ item, ...c });
  }
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
      chatId: msg.chat.id, replyTo: msg.message_id, choices, allow: adapter.mediaHosts, maxBytes,
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

