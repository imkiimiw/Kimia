// Everything about the third-party APIs that read X posts lives here, so it's one file to fix
// when they change. Primary: FxTwitter (api.fxtwitter.com/{user}/status/{id}); fallback:
// vxTwitter (api.vxtwitter.com/{user}/status/{id}), used only when FxTwitter fails or returns
// no media. Each API gets one retry on a temporary failure (network error, 5xx, 429, non-JSON).
//
// Response formats, as verified with real requests (2026-11):
//   FxTwitter 200: { code: 200, message: 'OK', tweet: { id, url, text, author: { screen_name, name,
//     protected }, possibly_sensitive, quote?, media?: { all: [...], photos?, videos? } } }
//     media.all[i]: { type: 'photo', url: '…?name=orig', width, height }
//                 | { type: 'video' | 'gif', url, thumbnail_url, width, height, duration,
//                     variants: [{ url, bitrate, content_type: 'video/mp4' | 'application/x-mpegURL' }],
//                     formats: [{ url, bitrate, container: 'mp4' | 'm3u8', codec }] }
//     text-only posts have no `media` key. Missing/deleted: HTTP 404 { code: 404, message: 'NOT_FOUND',
//     tweet: null }. Some impossible ids get an HTML page with status 200. Private: code 401.
//   vxTwitter 200: { tweetID, text, user_screen_name, user_name, possibly_sensitive, hasMedia,
//     media_extended: [{ type: 'image' | 'video' | 'gif', url, thumbnail_url, size: { width, height },
//     duration_millis }], qrt? }
//     Only the best video variant is given, and photo URLs lack ?name=orig. A post it can't read
//     (missing, deleted, private) is an HTML page with status 200.
//
// The normalized post this module returns (and posts.media stores):
//   { id, author, authorName, text, sensitive, fromQuote, source: 'fx' | 'vx',
//     media: [{ type: 'photo', url, width, height }
//           | { type: 'video' | 'gif', width, height, duration, variants: [{ url, bitrate, w, h, key }] }] }
//   variants are sorted best first; `size` (bytes) is added later by lib/media.js when probed.
import { fetch } from 'sdk';
import { MEDIA_HOSTS } from './config.js';

const FX_BASE = 'https://api.fxtwitter.com';
const VX_BASE = 'https://api.vxtwitter.com';
// A host that never resolves: `simulate` in tgcloud-run tests points an API here to fake an outage.
const DOWN_BASE = 'https://api-outage.invalid';
const HEADERS = { 'User-Agent': 'XMediaTelegramBot/1.0 (Telegram Serverless)', Accept: 'application/json' };
const RETRY_DELAY_MS = 600;

const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** True for an https URL on one of the twimg media hosts (anything else is refused). */
export function isAllowedMediaUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  const m = /^https:\/\/([^/?#:@]+)(?::443)?(?:[/?#]|$)/i.exec(url);
  return !!m && MEDIA_HOSTS.includes(m[1].toLowerCase());
}

/** pbs.twimg.com/media/X.jpg[?format=jpg&name=small] -> the original-size URL. */
export function originalPhotoUrl(url) {
  const m = /^(https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+)(?:\.(jpg|jpeg|png|webp))?(?:\?(.*))?$/i.exec(url);
  if (!m) return url;
  let format = m[2] ? m[2].toLowerCase() : null;
  if (!format && m[3]) {
    const f = /(?:^|&)format=(jpg|jpeg|png|webp)/i.exec(m[3]);
    if (f) format = f[1].toLowerCase();
  }
  return `${m[1]}.${format || 'jpg'}?name=orig`;
}

/** Photo URL in another size (orig / 4096x4096 / large), for photos above Telegram's 10 MB. */
export function photoSizeUrl(url, name) {
  return url.replace(/([?&])name=[^&]*/, `$1name=${name}`);
}

/** "…/vid/avc1/720x1280/…mp4" -> { w: 720, h: 1280 } */
function resolutionOf(url) {
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(url);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

function variantKey(v) {
  if (v.w && v.h) return `${v.w}x${v.h}`;
  if (v.bitrate) return `b${v.bitrate}`;
  return 'src';
}

/** mp4 variants (no HLS playlists), deduplicated, on allowed hosts, best first. */
function buildVariants(list) {
  const byUrl = new Map();
  for (const v of list) {
    if (!v || typeof v.url !== 'string' || !isAllowedMediaUrl(v.url)) continue;
    if (!/\.mp4(?:[?#]|$)/i.test(v.url)) continue;
    const res = resolutionOf(v.url) || {};
    const entry = { url: v.url, bitrate: Number(v.bitrate) || 0, w: res.w || v.w || 0, h: res.h || v.h || 0 };
    entry.key = variantKey(entry);
    const prev = byUrl.get(entry.url);
    if (!prev || entry.bitrate > prev.bitrate) byUrl.set(entry.url, entry);
  }
  return [...byUrl.values()].sort((a, b) => (b.bitrate - a.bitrate) || ((b.w * b.h) - (a.w * a.h)));
}

// ---------- FxTwitter ----------

function fxMedia(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'photo') {
    if (!isAllowedMediaUrl(m.url)) return { blocked: true };
    return { type: 'photo', url: originalPhotoUrl(m.url), width: Number(m.width) || 0, height: Number(m.height) || 0 };
  }
  if (m.type === 'video' || m.type === 'gif') {
    let raw = [];
    if (Array.isArray(m.variants)) raw = m.variants.filter((v) => v && (v.content_type || '').toLowerCase() === 'video/mp4');
    if (!raw.length && Array.isArray(m.formats)) raw = m.formats.filter((v) => v && (v.container || '').toLowerCase() === 'mp4');
    if (!raw.length && m.url) raw = [{ url: m.url, bitrate: 0 }];
    const variants = buildVariants(raw.map((v) => ({ url: v.url, bitrate: v.bitrate, w: m.width, h: m.height })));
    if (!variants.length) return { blocked: true };
    return {
      type: m.type,
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      duration: Math.round(Number(m.duration) || 0),
      variants,
    };
  }
  return null; // unknown kinds (e.g. a card) are skipped
}

function fxMediaList(tweet) {
  const media = tweet && tweet.media;
  if (!media) return [];
  const all = Array.isArray(media.all) && media.all.length
    ? media.all
    : [...(media.photos || []), ...(media.videos || [])];
  return all.map(fxMedia).filter(Boolean);
}

/** FxTwitter JSON -> { kind: 'ok', post } | { kind: 'not_found' | 'private' | 'temporary', detail } */
export function parseFx(status, body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'temporary', detail: `HTTP ${status}, not JSON` };
  }
  const code = Number(data && data.code) || status;
  if (code === 404) return { kind: 'not_found', detail: data.message || 'NOT_FOUND' };
  if (code === 401 || code === 403 || /PRIVATE/i.test(String(data && data.message))) return { kind: 'private', detail: data.message || 'PRIVATE' };
  const tweet = data && data.tweet;
  if (code !== 200 || !tweet || !tweet.id) return { kind: 'temporary', detail: `code ${code} ${data && data.message ? data.message : ''}`.trim() };
  if (tweet.author && tweet.author.protected === true && !tweet.media) return { kind: 'private', detail: 'protected author' };

  let media = fxMediaList(tweet);
  let fromQuote = false;
  if (!media.length && tweet.quote) {
    const quoted = fxMediaList(tweet.quote);
    if (quoted.length) {
      media = quoted;
      fromQuote = true;
    }
  }
  const blocked = media.filter((m) => m.blocked).length;
  return {
    kind: 'ok',
    post: {
      id: String(tweet.id),
      author: (tweet.author && tweet.author.screen_name) || null,
      authorName: (tweet.author && tweet.author.name) || null,
      text: typeof tweet.text === 'string' ? tweet.text : '',
      sensitive: tweet.possibly_sensitive === true || (fromQuote && tweet.quote.possibly_sensitive === true),
      fromQuote,
      source: 'fx',
      media: media.filter((m) => !m.blocked),
      blocked,
    },
  };
}

// ---------- vxTwitter ----------

function vxMedia(m) {
  if (!m || typeof m !== 'object' || typeof m.url !== 'string') return null;
  const w = Number(m.size && m.size.width) || 0;
  const h = Number(m.size && m.size.height) || 0;
  if (m.type === 'image') {
    if (!isAllowedMediaUrl(m.url)) return { blocked: true };
    return { type: 'photo', url: originalPhotoUrl(m.url), width: w, height: h };
  }
  if (m.type === 'video' || m.type === 'gif') {
    const variants = buildVariants([{ url: m.url, bitrate: 0, w, h }]);
    if (!variants.length) return { blocked: true };
    return { type: m.type, width: w, height: h, duration: Math.round((Number(m.duration_millis) || 0) / 1000), variants };
  }
  return null;
}

/** vxTwitter body -> same shapes as parseFx. Its "can't read this post" answer is an HTML page. */
export function parseVx(status, body) {
  if (!/^\s*\{/.test(body)) {
    if (status >= 500 || status === 429) return { kind: 'temporary', detail: `HTTP ${status}` };
    return { kind: 'not_found', detail: `HTTP ${status}, HTML page (vxTwitter could not read the post)` };
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { kind: 'temporary', detail: `HTTP ${status}, bad JSON` };
  }
  if (status >= 500 || !data || !data.tweetID) return { kind: 'temporary', detail: `HTTP ${status}` };
  let media = (data.media_extended || []).map(vxMedia).filter(Boolean);
  let fromQuote = false;
  if (!media.length && data.qrt && Array.isArray(data.qrt.media_extended)) {
    const quoted = data.qrt.media_extended.map(vxMedia).filter(Boolean);
    if (quoted.length) {
      media = quoted;
      fromQuote = true;
    }
  }
  const blocked = media.filter((m) => m.blocked).length;
  return {
    kind: 'ok',
    post: {
      id: String(data.tweetID),
      author: data.user_screen_name || null,
      authorName: data.user_name || null,
      text: typeof data.text === 'string' ? data.text : '',
      sensitive: data.possibly_sensitive === true,
      fromQuote,
      source: 'vx',
      media: media.filter((m) => !m.blocked),
      blocked,
    },
  };
}

// ---------- fetching with one retry ----------

async function getOnce(url) {
  const res = await fetch(url, { headers: HEADERS });
  return { status: res.status, body: await res.text() };
}

/** One API, with one retry on a temporary failure. Logs each attempt into `log`. */
async function ask(api, base, username, id, parse, log) {
  const url = `${base}/${username || 'i'}/status/${id}`;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    let result;
    try {
      const { status, body } = await getOnce(url);
      result = parse(status, body);
      log.push({ api, attempt, http: status, result: result.kind, ms: Date.now() - started, ...(result.detail ? { detail: result.detail } : {}) });
    } catch (err) {
      result = { kind: 'temporary', detail: String((err && err.message) || err) };
      log.push({ api, attempt, result: 'network_error', ms: Date.now() - started, detail: result.detail });
    }
    if (result.kind !== 'temporary') return result;
    last = result;
    if (attempt === 1) await sleep(RETRY_DELAY_MS);
  }
  return last;
}

/**
 * Reads a post. Returns { ok: true, post, log } or { ok: false, reason, log } where reason is
 * not_found / private / no_media / blocked / unavailable. `stats` receives { fxFail, vxFail, fallback }.
 * `simulate` ({ fx: 'down', vx: 'down' }) exists only for tgcloud-run tests.
 */
export async function fetchPost(id, username, { simulate = null } = {}) {
  const log = [];
  const stats = { fxFail: 0, vxFail: 0, fallback: 0 };
  const fxBase = simulate && simulate.fx === 'down' ? DOWN_BASE : FX_BASE;
  const vxBase = simulate && simulate.vx === 'down' ? DOWN_BASE : VX_BASE;

  const fx = await ask('fx', fxBase, username, id, parseFx, log);
  if (fx.kind === 'ok' && fx.post.media.length) return { ok: true, post: fx.post, log, stats };
  if (fx.kind === 'temporary') stats.fxFail = 1;
  if (fx.kind === 'private') return { ok: false, reason: 'private', log, stats };

  const vx = await ask('vx', vxBase, username, id, parseVx, log);
  if (vx.kind === 'ok' && vx.post.media.length) {
    stats.fallback = 1;
    return { ok: true, post: vx.post, log, stats };
  }
  if (vx.kind === 'temporary') stats.vxFail = 1;

  // Neither gave media: explain with the most specific answer either API gave.
  const okPost = fx.kind === 'ok' ? fx.post : vx.kind === 'ok' ? vx.post : null;
  if (okPost) {
    if (okPost.blocked) return { ok: false, reason: 'blocked', post: okPost, log, stats };
    return { ok: false, reason: okPost.sensitive ? 'sensitive' : 'no_media', post: okPost, log, stats };
  }
  if (vx.kind === 'private') return { ok: false, reason: 'private', log, stats };
  if (fx.kind === 'not_found') return { ok: false, reason: 'not_found', log, stats };
  if (fx.kind === 'temporary' && vx.kind === 'not_found') return { ok: false, reason: 'unavailable_or_missing', log, stats };
  return { ok: false, reason: 'unavailable', log, stats };
}
