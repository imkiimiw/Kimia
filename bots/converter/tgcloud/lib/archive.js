// Archives (spec §7.7): read the index first and refuse unsafe archives before extracting anything;
// extract with bounded inflation; build ZIPs. Pure (vendored fflate, no sdk).
//
// Refused (whole archive): more than maxEntries entries, more than maxUnpacked bytes in total, an
// entry ≥ 1 MB whose ratio exceeds maxRatio, absolute paths, `..`, symlinks, hardlinks, device files,
// encrypted entries, unknown compression. Nested archives are returned as files, never opened.
import { Inflate, zipSync } from './vendor/fflate.js';
import { readCentralDirectory } from './detect/zip.js';
import { ToolError } from './errors.js';
import { sanitizeName, splitName } from './names.js';

const MB = 1024 * 1024;
const RATIO_MIN_BYTES = MB; // tiny entries compress absurdly well without being bombs
const enc = new TextEncoder();
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

let CRC = null;
export function crc32(d, c = -1) {
  if (!CRC) { CRC = new Int32Array(256); for (let i = 0; i < 256; i++) { let v = i; for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; CRC[i] = v; } }
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8);
  return c;
}
const crcOf = (d) => (crc32(d) ^ -1) >>> 0;

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Raw DEFLATE → bytes, stopping as soon as the output passes `limit` (a bomb can't make us inflate
 * it all): 16 KB of input can produce at most ~16 MB, so the overshoot is bounded.
 */
export function inflateBounded(data, limit, code = 'ARCHIVE_BOMB') {
  const chunks = [];
  let total = 0;
  let over = false;
  const inf = new Inflate((c) => { if (over) return; total += c.length; if (total > limit) over = true; else chunks.push(c); });
  try {
    for (let i = 0; i < data.length && !over; i += 16384) inf.push(data.subarray(i, i + 16384), i + 16384 >= data.length);
  } catch {
    throw new ToolError('ARCHIVE_DAMAGED');
  }
  if (over) throw new ToolError(code);
  return concat(chunks, total);
}

/** GZIP member → { bytes, name } (name from the FNAME header, if any). */
export function gunzipBounded(b, limit) {
  if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) throw new ToolError('ARCHIVE_DAMAGED');
  const flg = b[3];
  let p = 10;
  if (flg & 4) p += 2 + u16(b, p); // FEXTRA
  let name = null;
  if (flg & 8) { const s = p; while (p < b.length && b[p]) p++; name = new TextDecoder('latin1').decode(b.subarray(s, p)); p++; }
  if (flg & 16) { while (p < b.length && b[p]) p++; p++; } // FCOMMENT
  if (flg & 2) p += 2; // FHCRC
  if (p >= b.length - 8) throw new ToolError('ARCHIVE_DAMAGED');
  const bytes = inflateBounded(b.subarray(p, b.length - 8), limit, 'ARCHIVE_TOO_BIG');
  if (crcOf(bytes) !== u32(b, b.length - 8)) throw new ToolError('ARCHIVE_DAMAGED');
  return { bytes, name };
}

/** A path inside an archive is safe: relative, no `..`, no drive letter, no NUL. */
export function safePath(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  return !n.split('/').some((seg) => seg === '..');
}

function checkTotals(entries, limits) {
  if (entries.length > limits.maxEntries) throw new ToolError('ARCHIVE_TOO_MANY', { max: limits.maxEntries });
  const total = entries.reduce((s, e) => s + (e.dir ? 0 : e.size), 0);
  if (total > limits.maxUnpacked) throw new ToolError('ARCHIVE_TOO_BIG', { mb: Math.round(limits.maxUnpacked / MB) });
  return total;
}

/** ZIP index with every check (no decompression). → entries [{ name, size, csize, method, dir, offset, crc }] */
export function zipEntries(b, limits) {
  const cd = readCentralDirectory(b, { maxEntries: limits.maxEntries + 1 });
  if (!cd.ok) throw new ToolError('ARCHIVE_DAMAGED');
  if (cd.total > limits.maxEntries) throw new ToolError('ARCHIVE_TOO_MANY', { max: limits.maxEntries });
  const entries = [];
  for (const e of cd.entries) {
    if (!safePath(e.name)) throw new ToolError('ARCHIVE_UNSAFE_PATH');
    if (e.encrypted) throw new ToolError('ARCHIVE_ENCRYPTED');
    const type = e.unixMode & 0xf000;
    if (e.symlink || (e.unixMode && type && type !== 0x8000 && type !== 0x4000)) throw new ToolError('ARCHIVE_LINKS');
    if (!e.dir && e.method !== 0 && e.method !== 8) throw new ToolError('ARCHIVE_UNSUPPORTED');
    if (!e.dir && e.usize >= RATIO_MIN_BYTES && e.usize / Math.max(1, e.csize) > limits.maxRatio) throw new ToolError('ARCHIVE_BOMB');
    entries.push({ name: e.name, size: e.usize, csize: e.csize, method: e.method, dir: e.dir, offset: e.offset, crc: e.crc });
  }
  checkTotals(entries, limits);
  return entries;
}

function zipEntryData(b, e, limit) {
  const o = e.offset;
  if (o + 30 > b.length || u32(b, o) !== 0x04034b50) throw new ToolError('ARCHIVE_DAMAGED');
  const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
  if (start + e.csize > b.length) throw new ToolError('ARCHIVE_DAMAGED');
  const raw = b.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = raw;
  else data = inflateBounded(raw, Math.min(e.size, limit), 'ARCHIVE_DAMAGED'); // more than declared = a lying header
  if (data.length !== e.size || (e.crc != null && crcOf(data) !== e.crc)) throw new ToolError('ARCHIVE_DAMAGED');
  return data;
}

const octal = (b, o, n) => {
  if (b[o] & 0x80) { let v = 0; for (let i = 1; i < n; i++) v = v * 256 + b[o + i]; return v; } // base-256
  const s = new TextDecoder('latin1').decode(b.subarray(o, o + n)).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
};
const cstr = (b, o, n) => { let e = o; while (e < o + n && b[e]) e++; return new TextDecoder('utf-8').decode(b.subarray(o, e)); };

function paxRecords(data) {
  const out = {};
  const s = new TextDecoder('utf-8').decode(data);
  let i = 0;
  while (i < s.length) {
    const sp = s.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(s.slice(i, sp), 10);
    if (!len) break;
    const rec = s.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** TAR index with every check. → entries [{ name, size, dir, offset }] */
export function tarEntries(b, limits) {
  const entries = [];
  let p = 0;
  let longName = null;
  let pax = {};
  while (p + 512 <= b.length) {
    const h = b.subarray(p, p + 512);
    if (h.every((x) => x === 0)) break; // end of archive
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new ToolError('ARCHIVE_DAMAGED');
    const type = String.fromCharCode(h[156] || 48);
    let size = octal(h, 124, 12);
    const dataStart = p + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataStart + size > b.length) throw new ToolError('ARCHIVE_DAMAGED');
    if (type === 'L') { longName = cstr(b, dataStart, size); p = next; continue; }
    if (type === 'x') { pax = paxRecords(b.subarray(dataStart, dataStart + size)); p = next; continue; }
    if (type === 'g') { p = next; continue; }
    const prefix = h[257] === 0x75 && h[258] === 0x73 ? cstr(h, 345, 155) : ''; // "ustar"
    let name = pax.path || longName || (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    if (pax.size) size = parseInt(pax.size, 10);
    longName = null;
    pax = {};
    if (['1', '2', '3', '4', '6', 'K'].includes(type)) throw new ToolError('ARCHIVE_LINKS');
    if (!['0', '7', '5'].includes(type)) throw new ToolError('ARCHIVE_UNSUPPORTED');
    if (!safePath(name)) throw new ToolError('ARCHIVE_UNSAFE_PATH');
    if (name.startsWith('./')) name = name.slice(2);
    if (name) entries.push({ name, size: type === '5' ? 0 : size, dir: type === '5' || name.endsWith('/'), offset: dataStart });
    if (entries.length > limits.maxEntries) throw new ToolError('ARCHIVE_TOO_MANY', { max: limits.maxEntries });
    p = dataStart + Math.ceil(size / 512) * 512;
  }
  checkTotals(entries, limits);
  return entries;
}

const looksTar = (b) => b.length >= 512 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar';

/**
 * Opens an archive's index (spec §7.7: index first). kind: 'zip' | 'tar' | 'gzip'.
 * → { kind, inner: 'tar'|'file'|null, entries, total, raw (tar bytes for tar.gz), single (gz file) }
 */
export function openArchive(bytes, kind, name, limits) {
  if (kind === 'zip') {
    const entries = zipEntries(bytes, limits);
    return { kind, inner: null, entries, total: entries.reduce((s, e) => s + e.size, 0), raw: bytes };
  }
  if (kind === 'tar') {
    const entries = tarEntries(bytes, limits);
    return { kind, inner: null, entries, total: entries.reduce((s, e) => s + e.size, 0), raw: bytes };
  }
  if (kind === 'gzip') {
    const { bytes: out, name: inner } = gunzipBounded(bytes, limits.maxUnpacked);
    if (out.length >= RATIO_MIN_BYTES && out.length / bytes.length > limits.maxRatio) throw new ToolError('ARCHIVE_BOMB');
    if (looksTar(out)) {
      const entries = tarEntries(out, limits);
      return { kind, inner: 'tar', entries, total: entries.reduce((s, e) => s + e.size, 0), raw: out };
    }
    const base = inner || splitName(String(name || 'file').replace(/\.(gz|tgz)$/i, '')).base || 'file';
    return { kind, inner: 'file', entries: [{ name: base, size: out.length, dir: false }], total: out.length, raw: out, single: out };
  }
  throw new ToolError('ARCHIVE_UNSUPPORTED');
}

/** Output names: the last path segment, sanitized, unique within the result. */
export function flatNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const last = String(n).replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'file';
    let out = sanitizeName(last, { fallback: 'file' });
    const key = out.toLowerCase();
    const k = (seen.get(key) || 0) + 1;
    seen.set(key, k);
    if (k > 1) { const { base, ext } = splitName(out); out = `${base} (${k})${ext ? `.${ext}` : ''}`; }
    return out;
  });
}

/**
 * Extracts files (directories skipped). `only` = list of entry indexes, or null for all.
 * → [{ index, path, name, bytes }] (empty files included: callers decide)
 */
export function extract(arc, limits, only = null) {
  const files = arc.entries.map((e, index) => ({ ...e, index })).filter((e) => !e.dir && (!only || only.includes(e.index)));
  const names = flatNames(files.map((f) => f.name));
  let total = 0;
  return files.map((e, i) => {
    let bytes;
    if (arc.single) bytes = arc.single;
    else if (arc.kind === 'zip') bytes = zipEntryData(arc.raw, e, limits.maxUnpacked - total);
    else bytes = arc.raw.subarray(e.offset, e.offset + e.size);
    total += bytes.length;
    if (total > limits.maxUnpacked) throw new ToolError('ARCHIVE_TOO_BIG', { mb: Math.round(limits.maxUnpacked / MB) });
    return { index: e.index, path: e.name, name: names[i], bytes };
  });
}

/** Types already compressed: stored, not deflated again (saves CPU, the 3-s budget). */
const STORED = new Set(['jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'mp3', 'aac', 'm4a', 'opus', 'vorbis', 'flac', 'mp4', 'mov', 'webm', 'mkv', 'avi', '3gp', 'ogv', 'flv', 'asf', 'zip', 'gzip', 'bz2', 'xz', 'zstd', '7z', 'rar', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'woff', 'woff2', 'pdf']);

/** One ZIP from files [{ name, bytes, type }]; names made unique. */
export function makeZip(files, { level = 6 } = {}) {
  const names = flatNames(files.map((f) => f.name));
  const input = {};
  files.forEach((f, i) => { input[names[i]] = [f.bytes, { level: STORED.has(f.type) ? 0 : level }]; });
  return zipSync(input);
}

/** Store-only ZIP parts, each ≤ maxBytes (spec §7.7 "ZIP parts ≤ 50 MB"). → { parts: Uint8Array[], skipped: [names] } */
export function zipParts(files, maxBytes) {
  const names = flatNames(files.map((f) => f.name));
  const overhead = (n) => 30 + 46 + 2 * enc.encode(n).length + 22;
  const parts = [];
  const skipped = [];
  let cur = {};
  let size = 0;
  files.forEach((f, i) => {
    const need = f.bytes.length + overhead(names[i]);
    if (need > maxBytes) { skipped.push(names[i]); return; }
    if (size + need > maxBytes && size > 0) { parts.push(zipSync(cur)); cur = {}; size = 0; }
    cur[names[i]] = [f.bytes, { level: 0 }];
    size += need;
  });
  if (size > 0) parts.push(zipSync(cur));
  return { parts, skipped };
}
