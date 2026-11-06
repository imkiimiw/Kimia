// Download policy (brief §6) — pure decisions, so every rule is unit-tested. Before any fetch the
// checks run in this order; the first that fails decides, and anything that can't be evaluated
// denies:
//   1. global switch (downloads on)            → downloads_off
//   2. quota and cooldown (staff exempt)        → quota | cooldown        (ban: lib/router.js preGates)
//   3. forced membership                        → checked by lib/router.js gateway before we get here
//   4. platform built, method enabled, not paused → not_built | platform_off | platform_paused
//   5. host on the platform's allowlist, not blocklisted → blocked     (allowlist: lib/url.js + adapters)
//   6. size limits                              → too_big | size_unknown (choose(), after resolving)
// Pure module: must not import 'sdk'.
import {
  DEFAULT_LIMITS, MB, TG_UPLOAD_MAX, TG_UPLOAD_PHOTO_MAX, TG_URL_MAX, TG_URL_PHOTO_MAX,
} from './config.js';

const deny = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/** Limits from the 'limits' setting, clamped to what Telegram allows. */
export function limitsFrom(value) {
  const v = value && typeof value === 'object' ? value : {};
  const int = (x, d, lo, hi) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return {
    quota_per_day: int(v.quota_per_day, DEFAULT_LIMITS.quota_per_day, 0, 10000),
    cooldown_s: int(v.cooldown_s, DEFAULT_LIMITS.cooldown_s, 0, 3600),
    max_mb: int(v.max_mb, DEFAULT_LIMITS.max_mb, 1, TG_UPLOAD_MAX / MB),
  };
}

/** A platform's owner settings ('platform:<id>'): every method OFF unless explicitly true. */
export function platformState(value) {
  const v = value && typeof value === 'object' ? value : {};
  const methods = {};
  for (const [m, on] of Object.entries(v.methods || {})) methods[m] = on === true;
  return { paused: v.paused === true, methods };
}

/** The adapter's methods the owner has switched on, in the adapter's order. */
export const enabledMethods = (adapter, state) => adapter.methodOrder.filter((m) => state.methods[m] === true);

/**
 * Checks 1, 2, 4 and the URL/domain/account part of 5 (deny by default).
 * f = { downloadsOn, exempt, user: { dl_day, dl_count, last_dl_at }, today, now, limits,
 *       adapter, state, blocked }
 * → { ok: true, methods } | { ok: false, reason, ... }
 */
export function precheck(f) {
  if (!f || f.downloadsOn !== true) return deny('downloads_off');
  if (!f.exempt) {
    const u = f.user || {};
    const usedToday = u.dl_day === f.today ? Number(u.dl_count) || 0 : 0;
    if (!(f.limits.quota_per_day > usedToday)) return deny('quota', { quota: f.limits.quota_per_day });
    const wait = (Number(u.last_dl_at) || 0) + f.limits.cooldown_s - f.now;
    if (wait > 0) return deny('cooldown', { wait });
  }
  if (!f.adapter) return deny('not_built');
  if (!f.state) return deny('platform_off');
  const methods = enabledMethods(f.adapter, f.state);
  if (!methods.length) return deny('platform_off');
  if (f.state.paused) return deny('platform_paused');
  if (f.blocked !== false) return deny('blocked');
  return { ok: true, methods };
}

/** Domain blocklist candidates for a host: "a.b.example.com" → [itself, "b.example.com", "example.com"]. */
export function domainCandidates(host) {
  const parts = String(host || '').toLowerCase().split('.');
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/**
 * Picks the variant of one item to send (check 6). Variants are best first; `bytes` is the probed
 * size or null. quality: auto = the best that Telegram can fetch by URL (fast), else the best that
 * can be uploaded; best = the best that can be uploaded; small = the smallest.
 * → { variant, via: 'url' | 'upload', downgraded } | { error: 'too_big', bytes, max } | { error: 'no_variant' }
 * A variant of unknown size may only go by URL (Telegram enforces its own limit); it is never
 * downloaded by the bot.
 */
export function choose(item, quality, maxBytes) {
  const photo = item.type === 'photo';
  const upMax = Math.min(photo ? TG_UPLOAD_PHOTO_MAX : TG_UPLOAD_MAX, maxBytes); // the owner's max_mb applies to both paths
  const urlMax = Math.min(photo ? TG_URL_PHOTO_MAX : TG_URL_MAX, upMax);
  const all = item.variants || [];
  if (!all.length) return { error: 'no_variant' };
  const known = all.filter((v) => Number.isFinite(v.bytes) && v.bytes > 0);
  if (!known.length) return { variant: quality === 'small' ? all[all.length - 1] : all[0], via: 'url', downgraded: false, sizeUnknown: true };
  const fitsUrl = known.filter((v) => v.bytes <= urlMax);
  const fitsUp = known.filter((v) => v.bytes <= upMax);
  let v;
  if (quality === 'small') v = fitsUrl[fitsUrl.length - 1] || fitsUp[fitsUp.length - 1];
  else if (quality === 'best') v = fitsUp[0];
  else v = fitsUrl[0] || fitsUp[0];
  if (!v) return { error: 'too_big', bytes: known[known.length - 1].bytes, max: upMax };
  return { variant: v, via: v.bytes <= urlMax ? 'url' : 'upload', downgraded: quality !== 'small' && known[0].bytes > upMax };
}
