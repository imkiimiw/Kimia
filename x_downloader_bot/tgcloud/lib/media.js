// Media bytes: size probing, downloading (Range chunks above sdk fetch's 30 MB response cap) and
// choosing a video quality. Only twimg hosts are ever requested (lib/x_api.js isAllowedMediaUrl),
// and the final URL after redirects is checked again.
import { fetch } from 'sdk';
import { AUTO_MAX_SIDE, CHUNK_SIZE, FETCH_MAX, UPLOAD_MAX } from './config.js';
import { isAllowedMediaUrl } from './x_api.js';

const HEADERS = { 'User-Agent': 'XMediaTelegramBot/1.0 (Telegram Serverless)' };

export class MediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // blocked_host / http / too_big / binary / short_read
  }
}

function checkFinalUrl(res, url) {
  const final = res && res.url ? res.url : url;
  if (!isAllowedMediaUrl(final)) throw new MediaError('blocked_host', `redirected off twimg: ${final}`);
}

function header(res, name) {
  try {
    return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
  } catch {
    return null;
  }
}

/** Discards a response body we don't need, so the connection can be released. */
async function drain(res) {
  try {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
  } catch {
    // nothing to do
  }
}

/**
 * The file's size in bytes, or null if the server won't say. A HEAD request first; if that gives
 * no length, a one-byte Range request ("bytes 0-0/<total>").
 */
export async function probeSize(url) {
  if (!isAllowedMediaUrl(url)) throw new MediaError('blocked_host', `not a twimg URL: ${url}`);
  try {
    const res = await fetch(url, { method: 'HEAD', headers: HEADERS });
    checkFinalUrl(res, url);
    const len = Number(header(res, 'content-length'));
    if (res.ok && len > 0) return len;
  } catch (err) {
    if (err instanceof MediaError) throw err;
  }
  const res = await fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-0' } });
  checkFinalUrl(res, url);
  const range = header(res, 'content-range');
  const len = Number(header(res, 'content-length'));
  await drain(res);
  const m = range && /\/(\d+)\s*$/.exec(range);
  if (res.status === 206 && m) return Number(m[1]);
  if (res.ok && len > 1) return len;
  return null;
}

/** Reads a whole binary body as Uint8Array (sdk fetch streams Uint8Array chunks). */
async function readBytes(res, expected) {
  const parts = [];
  let total = 0;
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of res.body) {
      if (typeof chunk === 'string') throw new MediaError('binary', 'response body arrives as text');
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      parts.push(bytes);
      total += bytes.length;
      if (total > UPLOAD_MAX + 1024 * 1024) throw new MediaError('too_big', 'body larger than expected');
    }
  } else if (typeof res.arrayBuffer === 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    parts.push(buf);
    total = buf.length;
  } else {
    throw new MediaError('binary', 'no binary reader on the response');
  }
  if (expected && total !== expected) throw new MediaError('short_read', `got ${total} of ${expected} bytes`);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Downloads a twimg file. Up to FETCH_MAX in one request; bigger files (up to UPLOAD_MAX) in
 * CHUNK_SIZE Range requests, each its own response under the 30 MB cap.
 */
export async function download(url, knownSize) {
  if (!isAllowedMediaUrl(url)) throw new MediaError('blocked_host', `not a twimg URL: ${url}`);
  const total = knownSize || (await probeSize(url));
  if (total && total > UPLOAD_MAX) throw new MediaError('too_big', `${total} bytes`);
  if (!total || total <= FETCH_MAX) {
    const res = await fetch(url, { headers: HEADERS });
    checkFinalUrl(res, url);
    if (!res.ok) {
      await drain(res);
      throw new MediaError('http', `HTTP ${res.status}`);
    }
    return readBytes(res, total || null);
  }
  const out = new Uint8Array(total);
  for (let start = 0; start < total; start += CHUNK_SIZE) {
    const end = Math.min(total, start + CHUNK_SIZE) - 1;
    const res = await fetch(url, { headers: { ...HEADERS, Range: `bytes=${start}-${end}` } });
    checkFinalUrl(res, url);
    if (res.status !== 206) {
      await drain(res);
      throw new MediaError('http', `Range ${start}-${end}: HTTP ${res.status}`);
    }
    out.set(await readBytes(res, end - start + 1), start);
  }
  return out;
}

// ---------- choosing a video quality ----------

/** Shorter side in pixels: 720x1280 -> 720 (shown as "720p"). */
export function shortSide(v) {
  return v.w && v.h ? Math.min(v.w, v.h) : 0;
}

export function qualityLabel(v) {
  const s = shortSide(v);
  return s ? `${s}p` : v.bitrate ? `${Math.round(v.bitrate / 1000)}kbps` : 'MP4';
}

/** Probes a variant's size once and remembers it on the variant (persisted with the post). */
export async function ensureSize(v, changed) {
  if (typeof v.size === 'number' && v.size > 0) return v.size;
  try {
    const n = await probeSize(v.url);
    if (n) {
      v.size = n;
      if (changed) changed.dirty = true;
    }
    return n;
  } catch (err) {
    if (err instanceof MediaError && err.code === 'blocked_host') throw err;
    return null;
  }
}

/**
 * Picks the variant for a quality mode, falling back to lower qualities until one fits `maxBytes`:
 *   best — the highest quality that fits;
 *   auto — the highest quality up to 720p that fits (if none up to 720p fits, a lower one; if
 *          the post has nothing at or below 720p, the smallest that fits);
 *   low  — the smallest variant.
 * Returns { variant } or { tooBig: true, smallest } when even the smallest is above maxBytes.
 * A variant whose size can't be learned is tried as fitting (the download re-checks).
 */
export async function chooseVariant(item, mode, maxBytes, changed) {
  const vs = item.variants || [];
  if (!vs.length) return { tooBig: false, variant: null };
  let order;
  if (mode === 'low') {
    order = [...vs].reverse();
  } else if (mode === 'auto') {
    const capped = vs.filter((v) => !shortSide(v) || shortSide(v) <= AUTO_MAX_SIDE);
    order = capped.length ? capped : [...vs].reverse();
  } else {
    order = vs;
  }
  // (Variants above 720p are bigger than the ones below, so "auto" never needs to look above.)
  for (const v of order) {
    const n = await ensureSize(v, changed);
    if (!n || n <= maxBytes) return { variant: v };
  }
  return { tooBig: true, smallest: vs[vs.length - 1] };
}
