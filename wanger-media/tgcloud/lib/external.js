// The owner's own external service (Phase 8, contract in docs/PHASE8.md §2). Two uses:
//   relay   — a file the bot already found by an allowed method but too big for the cloud Bot API
//             (> 50 MB) is downloaded by the service from the platform's allowlisted CDN and sent to
//             the chat through its local Bot API server (≤ 2000 MB), in the background.
//   resolve — the method 'external' of an adapter: the service resolves the post and serves the
//             files from its own host; the bot still applies every check and the size limits.
// The config lives in the settings table ('external' = { url, key, relay, max_mb }); the key is never
// shown, logged or sent anywhere but the service's own host (allowlist = that host; POSTs are never
// redirected). Every risk note and hard limit of the brief applies to the service too.
import { MB } from './config.js';
import { request, ResolveError } from './platforms/common.js';
import { isPublicHostname, parseUrl } from './url.js';

export const SETTING = 'external';
export const RELAY_MIN_MB = 51;
export const RELAY_MAX_MB = 2000;
export const RELAY_DEFAULT_MB = 500;
const MAX_ITEMS = 10;
const TYPES = ['photo', 'video', 'gif', 'audio'];
const CODES = { NOT_FOUND: 'not_found', PRIVATE: 'private', DRM: 'drm', TOO_LARGE: 'too_big', UNSUPPORTED: 'unsupported', RATE_LIMITED: 'unavailable', ERROR: 'unavailable' };

/** "https://host[/base]" without a trailing slash, or null. */
export function normalizeBase(text) {
  const s = String(text || '').trim().replace(/\/+$/, '');
  const u = parseUrl(s);
  if (!u || u.scheme !== 'https' || u.query || u.fragment || !isPublicHostname(u.host)) return null;
  return `https://${u.host}${u.path === '/' ? '' : u.path}`;
}

export const validKey = (s) => /^[\x21-\x7e]{16,200}$/.test(String(s || ''));

/** The stored setting → { url, host, key, relay, maxBytes, maxMb } or null when not usable. */
export function configFrom(value) {
  const v = value && typeof value === 'object' ? value : {};
  const url = normalizeBase(v.url);
  if (!url || !validKey(v.key)) return null;
  const mb = Number.isInteger(v.max_mb) && v.max_mb >= RELAY_MIN_MB && v.max_mb <= RELAY_MAX_MB ? v.max_mb : RELAY_DEFAULT_MB;
  return { url, host: parseUrl(url).host, key: v.key, relay: v.relay === true, maxMb: mb, maxBytes: mb * MB };
}

async function call(ctx, cfg, method, path, body) {
  const res = await request(ctx, cfg.url + path, {
    allow: [cfg.host], method,
    headers: { Authorization: 'Bearer ' + cfg.key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* not JSON */ }
  return { status: res.status, json: json && typeof json === 'object' ? json : null };
}

/** GET /v1/health → { ok, detail, version, relayMax, resolve }. */
export async function health(ctx, cfg) {
  try {
    const { status, json } = await call(ctx, cfg, 'GET', '/v1/health');
    if (status !== 200 || !json || json.ok !== true) return { ok: false, detail: `HTTP ${status}` };
    const relayMax = json.relay && Number.isFinite(json.relay.max_bytes) ? json.relay.max_bytes : null;
    return { ok: true, version: String(json.version || '?').slice(0, 20), relayMax, resolve: json.resolve === true };
  } catch (err) {
    return { ok: false, detail: (err && (err.kind || err.message)) || 'error' };
  }
}

/** One item of a resolve answer → a pipeline item, or null (wrong type, host or URL). */
export function itemFrom(it, host) {
  if (!it || !TYPES.includes(it.type) || typeof it.url !== 'string') return null;
  const u = parseUrl(it.url);
  if (!u || u.scheme !== 'https' || u.host !== host) return null; // files only from the service itself
  const num = (x) => (Number.isFinite(x) && x > 0 ? Math.round(x) : undefined);
  return {
    type: it.type, width: num(it.width), height: num(it.height), duration: num(it.duration),
    variants: [{ url: it.url, bytes: num(it.bytes), mime: typeof it.mime === 'string' ? it.mime.slice(0, 60) : undefined }],
  };
}

/** A resolve answer → a post (method 'external'), or throws ResolveError. */
export function postFrom(json, status, cfg, platform, ref) {
  if (!json) throw new ResolveError('unavailable', `HTTP ${status}`);
  if (json.ok !== true) throw new ResolveError(CODES[json.code] || 'unavailable', String(json.code || `HTTP ${status}`).slice(0, 40));
  const items = (Array.isArray(json.items) ? json.items : []).slice(0, MAX_ITEMS).map((it) => itemFrom(it, cfg.host)).filter(Boolean);
  if (!items.length) throw new ResolveError('no_media', 'no usable items');
  return {
    platform, method: 'external', key: ref.key, url: ref.url,
    title: typeof json.title === 'string' ? json.title.slice(0, 2000) : '',
    author: typeof json.author === 'string' ? json.author.slice(0, 100) : null,
    account: ref.account || null, sensitive: false, items, mediaHosts: [cfg.host],
  };
}

/** POST /v1/resolve for the method 'external'. */
export async function resolve(ctx, cfg, { platform, ref, maxBytes, quality }) {
  if (!cfg) throw new ResolveError('unavailable', 'external service not configured');
  let r;
  try {
    r = await call(ctx, cfg, 'POST', '/v1/resolve', { url: ref.url, platform, max_bytes: maxBytes, quality: quality === 'small' ? 'small' : 'best', request_id: `${platform}:${ref.key}` });
  } catch (err) {
    throw new ResolveError('unavailable', (err && (err.kind || err.message)) || 'request failed');
  }
  return postFrom(r.json, r.status, cfg, platform, ref);
}

/**
 * POST /v1/relay: the service sends the file itself, later. → true when it was queued (HTTP 202 and
 * { ok: true, queued: true }); false otherwise (the caller falls back to what the bot can send).
 */
export async function relay(ctx, cfg, job) {
  if (!cfg || !cfg.relay) return false;
  try {
    const { status, json } = await call(ctx, cfg, 'POST', '/v1/relay', job);
    return status === 202 && !!json && json.ok === true && json.queued === true;
  } catch {
    return false;
  }
}

/** The risk note shown before the method 'external' is switched on for a platform (brief §6). */
export const RISK_NOTE = {
  en: 'Your own server fetches the media for this platform. The bot still applies every check and the hard limits — no DRM, no logging in or cookies, no working around blocks — and the server must follow them too. The platform’s terms and the creators’ copyright still apply, and you are responsible for the server and its traffic.',
  fa: 'سرور خودتان رسانه\u200cی این پلتفرم را دریافت می\u200cکند. ربات همچنان همه\u200cی بررسی\u200cها و محدودیت\u200cهای قطعی را اعمال می\u200cکند — بدون DRM، بدون ورود به حساب یا کوکی، بدون دورزدن محدودیت\u200cها — و سرور هم باید آن\u200cها را رعایت کند. قوانین پلتفرم و حق نشر سازندگان همچنان برقرار است و مسئولیت سرور و ترافیکش با شماست.',
  ru: 'Медиа для этой платформы получает ваш собственный сервер. Бот по-прежнему применяет все проверки и жёсткие ограничения — без DRM, без входа в аккаунты и cookies, без обхода блокировок, — и сервер тоже обязан их соблюдать. Правила платформы и авторские права по-прежнему действуют, а за сервер и его трафик отвечаете вы.',
};
