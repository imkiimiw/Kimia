// Shared HTTP for platform adapters (brief §9): https only; every request and every redirect hop
// must be on the adapter's allowlist (redirects are followed by hand, never automatically); an
// honest User-Agent; no cookies are ever sent; sizes are known before bytes are downloaded.
// Each request is added to ctx.trace as { view: 'http', host, status, ms }.
import { fetch } from 'sdk';
import { BOT_USERNAME, VERSION } from '../config.js';
import { isAllowedFetch, parseUrl } from '../url.js';
import { clip } from '../util.js';

export const USER_AGENT = `WangerMediaBot/${VERSION} (+https://t.me/${BOT_USERNAME})`;
export const MAX_REDIRECTS = 5;
/** One sdk fetch response is capped at 30 MB; stay below it per request. */
export const FETCH_CHUNK = 25 * 1024 * 1024;

export class HttpError extends Error {
  /** kind: blocked_host | redirects | status | network | too_big | parse | short_read */
  constructor(kind, message, status = null) {
    super(message || kind);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
  }
}

const header = (res, name) => {
  try { return res.headers.get(name); } catch { return null; }
};

function record(ctx, method, url, status, t0) {
  if (!ctx || !ctx.trace) return;
  const u = parseUrl(url);
  ctx.trace.push({ view: 'http', method, host: u ? u.host : '?', status, ms: Date.now() - t0 });
}

/** Resolves a Location header against the URL it came from. */
export function resolveLocation(base, location) {
  if (!location) return null;
  if (/^https?:\/\//i.test(location)) return location;
  const b = parseUrl(base);
  if (!b) return null;
  if (location.startsWith('//')) return `${b.scheme}:${location}`;
  if (location.startsWith('/')) return `${b.scheme}://${b.host}${location}`;
  const dir = b.path.replace(/[^/]*$/, '');
  return `${b.scheme}://${b.host}${dir}${location}`;
}

/**
 * A request that follows at most MAX_REDIRECTS redirects itself, checking every hop against `allow`.
 * Resolves to the final response (any status) with `res.finalUrl` set — or, when `stopAt(url)` is
 * true for a redirect target, to { stoppedAt: url } without requesting it (short links).
 */
export async function request(ctx, url, { allow, method = 'GET', headers = {}, stopAt = null } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedFetch(current, allow)) throw new HttpError('blocked_host', `not allowed: ${String(current).slice(0, 120)}`);
    if (hop > 0 && stopAt && stopAt(current)) return { stoppedAt: current, ok: true, status: 0 };
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(current, { method, redirect: 'manual', headers: { 'User-Agent': USER_AGENT, ...headers } });
    } catch (err) {
      record(ctx, method, current, 0, t0);
      throw new HttpError('network', (err && err.message) || 'request failed');
    }
    record(ctx, method, current, res.status, t0);
    if (res.status >= 300 && res.status < 400 && header(res, 'location')) {
      current = resolveLocation(current, header(res, 'location'));
      continue;
    }
    res.finalUrl = current;
    return res;
  }
  throw new HttpError('redirects', 'too many redirects');
}

/** GET → parsed JSON; non-2xx → HttpError('status'). */
export async function getJson(ctx, url, opts) {
  const res = await request(ctx, url, { ...opts, headers: { Accept: 'application/json', ...(opts && opts.headers) } });
  if (!res.ok) throw new HttpError('status', `HTTP ${res.status}`, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('parse', 'not JSON');
  }
}

/** GET → text; non-2xx → HttpError('status'). */
export async function getText(ctx, url, opts) {
  const res = await request(ctx, url, { ...opts, headers: { Accept: 'text/html,application/xhtml+xml', ...(opts && opts.headers) } });
  if (!res.ok) throw new HttpError('status', `HTTP ${res.status}`, res.status);
  return { text: await res.text(), finalUrl: res.finalUrl };
}

/**
 * The size of a file in bytes, or null when the server won't say: HEAD first (only when `head` —
 * a HEAD to Snapchat's CDN kills the whole invocation with an uncatchable HTTP 500, measured
 * 2026-11-06), then a one-byte Range request ("bytes 0-0/<total>"). Also returns the content type
 * and whether Range works.
 */
export async function probe(ctx, url, allow, { head = false } = {}) {
  if (head) {
    try {
      const res = await request(ctx, url, { allow, method: 'HEAD' });
      const len = Number(header(res, 'content-length'));
      if (res.ok && len > 0) return { bytes: len, type: header(res, 'content-type'), ranges: /bytes/i.test(header(res, 'accept-ranges') || '') };
    } catch (err) {
      if (err instanceof HttpError && err.kind === 'blocked_host') throw err;
    }
  }
  try {
    const res = await request(ctx, url, { allow, headers: { Range: 'bytes=0-0' } });
    const m = /\/(\d+)\s*$/.exec(header(res, 'content-range') || '');
    if (res.status === 206 && m) return { bytes: Number(m[1]), type: header(res, 'content-type'), ranges: true };
    const len = Number(header(res, 'content-length'));
    if (res.ok && len > 1) return { bytes: len, type: header(res, 'content-type'), ranges: false };
  } catch (err) {
    if (err instanceof HttpError && err.kind === 'blocked_host') throw err;
  }
  return { bytes: null, type: null, ranges: false };
}

async function readAll(res, limit) {
  const parts = [];
  let total = 0;
  for await (const chunk of res.body) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += c.length;
    if (total > limit) throw new HttpError('too_big', `more than ${limit} bytes`);
    parts.push(c);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of parts) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Downloads a file whose size is known: one GET up to FETCH_CHUNK, otherwise Range chunks (only
 * when the server supports ranges). Never more than `max` bytes.
 */
export async function download(ctx, url, allow, { bytes, ranges, max }) {
  if (!bytes || bytes > max) throw new HttpError('too_big', `size ${bytes} over ${max}`);
  if (bytes <= FETCH_CHUNK) {
    const res = await request(ctx, url, { allow });
    if (!res.ok) throw new HttpError('status', `HTTP ${res.status}`, res.status);
    const data = await readAll(res, Math.min(max, bytes + 1024));
    if (data.length < bytes) throw new HttpError('short_read', `${data.length} of ${bytes}`);
    return data;
  }
  if (!ranges) throw new HttpError('too_big', 'large file without range support');
  const out = new Uint8Array(bytes);
  for (let start = 0; start < bytes; start += FETCH_CHUNK) {
    const end = Math.min(bytes, start + FETCH_CHUNK) - 1;
    const res = await request(ctx, url, { allow, headers: { Range: `bytes=${start}-${end}` } });
    if (res.status !== 206) throw new HttpError('status', `range HTTP ${res.status}`, res.status);
    const part = await readAll(res, end - start + 1);
    if (part.length !== end - start + 1) throw new HttpError('short_read', `range ${start}-${end}`);
    out.set(part, start);
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES || e in ENTITIES) return ENTITIES[k] || ENTITIES[e];
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

/** Open Graph / Twitter-card meta tags of an HTML page, attributes in any order (first wins). */
export function metaTags(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const val = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (!key || !val) continue;
    const k = (key[2] ?? key[3]).toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(val[2] ?? val[3]);
  }
  return out;
}

/** Text for a caption from HTML-ish metadata: tags dropped, entities decoded, spaces collapsed. */
export function cleanText(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Errors an adapter's resolve() throws, mapped to what the user is told. */
export class ResolveError extends Error {
  /** code: not_found | private | restricted | login_wall | no_media | file_type | unsupported | unavailable */
  constructor(code, message) {
    super(message || code);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/** oEmbed HTTP errors → ResolveError: 401 private, 403 restricted (embedding off), 400/404/410 not found. */
export function oembedError(err) {
  if (err instanceof HttpError && err.kind === 'status') {
    if (err.status === 401) return new ResolveError('private', err.message);
    if (err.status === 403) return new ResolveError('restricted', err.message);
    if (err.status === 400 || err.status === 404 || err.status === 410) return new ResolveError('not_found', err.message);
  }
  return asResolveError(err);
}

/** A health check that resolves a known public post: { ok, detail }. */
export async function healthOf(run) {
  try {
    const p = await run();
    return { ok: true, detail: clip(p.title || p.details || `${p.items.length} items`, 60) };
  } catch (err) {
    return { ok: false, detail: (err && (err.code || err.message)) || 'error' };
  }
}

/** HttpError → ResolveError: 404/410 = not found, everything else = temporarily unavailable. */
export function asResolveError(err) {
  if (err instanceof ResolveError) return err;
  if (err instanceof HttpError && err.kind === 'status' && (err.status === 404 || err.status === 410)) return new ResolveError('not_found', err.message);
  return new ResolveError('unavailable', (err && err.message) || 'unavailable');
}

/**
 * Expands a short link by following its redirects (every hop on `allow`) until `toRef(url)` returns
 * a ref for the post it leads to; the post page itself is not requested here.
 */
export async function expandShort(ctx, url, allow, toRef) {
  let res;
  try {
    res = await request(ctx, url, { allow, stopAt: (u) => !!toRef(u) });
  } catch (err) {
    throw asResolveError(err);
  }
  if (!res.stoppedAt) throw new ResolveError('unsupported', 'short link did not lead to a post');
  return toRef(res.stoppedAt);
}

/** A ref from a URL string through an adapter's identify(), or null (short links don't count). */
export function refFromUrl(identify, url) {
  const u = parseUrl(url);
  const r = u ? identify(u) : null;
  return r && !r.unsupported && !r.short ? r : null;
}

/** Fields shared by every information card (METADATA_ONLY): no files, a cover by URL at most. */
export function card(platform, method, ref, { title = '', details = null, author = null, account = null, cover = null } = {}) {
  return {
    platform, method, key: ref.key, url: ref.url, meta: true, sensitive: false, items: [],
    title: cleanText(title), details: details ? cleanText(details) : null, author: author || null,
    account: account || ref.account || null, cover: cover && /^https:\/\//i.test(cover) ? cover : null,
  };
}
