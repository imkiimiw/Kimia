// File type detection from the bytes (spec §6): the filename and Telegram's mime_type are never
// trusted. Leading magic bytes first, then container insides (ZIP central directory, MP4 boxes,
// EBML DocType, Ogg codec, OLE stream names), then text sniffing. Pure.
//
// detect(bytes, name) → { id, label, family, ext, exts, mime, dangerous, polyglot, extOk, nameExt, info }
import { TYPES, SCRIPT_EXTS, isDangerousExt } from './types.js';
import { readCentralDirectory, findEocd, storedEntryBytes } from './zip.js';

const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const startsWith = (b, sig, o = 0) => { if (b.length < o + sig.length) return false; for (let i = 0; i < sig.length; i++) if (sig[i] !== null && b[o + i] !== sig[i]) return false; return true; };
const u32be = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);

/** Lower-case extension of a file name ('' if none). */
export function extOf(name) {
  const s = String(name || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = s.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Index of a byte pattern in b (from `from`), or -1. */
export function indexOfBytes(b, pat, from = 0, to = b.length) {
  const first = pat[0];
  const last = Math.min(to, b.length) - pat.length;
  outer: for (let i = from; i <= last; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

const utf16 = (s) => { const out = []; for (const ch of s) { out.push(ch.charCodeAt(0) & 255, ch.charCodeAt(0) >> 8); } return out; };
const OLE_WORD = utf16('WordDocument');
const OLE_XLS = utf16('Workbook');
const OLE_XLS5 = utf16('Book');
const OLE_PPT = utf16('PowerPoint Document');
const OLE_VBA = utf16('_VBA_PROJECT');
const OLE_MACROS = utf16('Macros');
// MSI root storage CLSID {000C1084-0000-0000-C000-000000000046}
const MSI_CLSID = [0x84, 0x10, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46];

function ole(b, nameExt) {
  const has = (p) => indexOfBytes(b, p) >= 0;
  if (has(MSI_CLSID) || nameExt === 'msi') return { id: 'msi' };
  const macro = has(OLE_VBA) || has(OLE_MACROS);
  if (has(OLE_WORD)) return { id: macro ? 'ole_macro' : 'doc', info: { app: 'word' } };
  if (has(OLE_XLS) || has(OLE_XLS5)) return { id: macro ? 'ole_macro' : 'xls', info: { app: 'excel' } };
  if (has(OLE_PPT)) return { id: macro ? 'ole_macro' : 'ppt', info: { app: 'powerpoint' } };
  return { id: macro ? 'ole_macro' : 'ole' };
}

/** ISO-BMFF (MP4 family): brand, then audio-only vs video by the track handlers in `moov`. */
function isoBmff(b) {
  const major = ascii(b, 8, 4);
  const size = u32be(b, 0);
  const brands = [major];
  for (let o = 16; o + 4 <= Math.min(size, 64, b.length); o += 4) brands.push(ascii(b, o, 4));
  const any = (...xs) => brands.some((x) => xs.includes(x));
  if (any('avif', 'avis')) return { id: 'avif' };
  if (any('heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs')) return { id: 'heic' };
  if (major === 'mif1' || major === 'msf1') return { id: 'heic' };
  if (major === 'qt  ') return { id: 'mov' };
  if (major.startsWith('3gp') || major.startsWith('3g2')) return { id: '3gp' };
  if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return { id: 'm4a' };
  const handlers = mp4Handlers(b);
  if (handlers.size && !handlers.has('vide') && handlers.has('soun')) return { id: 'm4a', info: { by: 'tracks' } };
  return { id: 'mp4', info: handlers.size ? { tracks: [...handlers].join(',') } : null };
}

/** Handler types ('vide', 'soun', …) of the tracks in the top-level `moov` box. Bounded walk. */
export function mp4Handlers(b) {
  const out = new Set();
  const walk = (start, end, path, depth) => {
    let o = start;
    let steps = 0;
    while (o + 8 <= end && steps++ < 4096) {
      let size = u32be(b, o);
      const type = ascii(b, o + 4, 4);
      let header = 8;
      if (size === 1) { if (o + 16 > end) return; size = u32be(b, o + 8) * 0x100000000 + u32be(b, o + 12); header = 16; }
      if (size === 0) size = end - o;
      if (size < header || o + size > end) return;
      if (type === 'hdlr' && path === 'moov/trak/mdia' && o + header + 12 <= end) out.add(ascii(b, o + header + 8, 4));
      if (depth < 3 && ((depth === 0 && type === 'moov') || (depth === 1 && type === 'trak') || (depth === 2 && type === 'mdia'))) {
        walk(o + header, o + size, path ? `${path}/${type}` : type, depth + 1);
      }
      o += size;
    }
  };
  walk(0, b.length, '', 0);
  return out;
}

/** EBML (Matroska / WebM): the DocType element (0x4282) in the header. */
function ebml(b) {
  const i = indexOfBytes(b, [0x42, 0x82], 4, 64);
  if (i >= 0) {
    const lenByte = b[i + 2];
    const len = lenByte & 0x80 ? lenByte & 0x7f : 0;
    const docType = len ? ascii(b, i + 3, len) : '';
    if (docType === 'webm') return { id: 'webm' };
  }
  return { id: 'mkv' };
}

/** Ogg: the first packet names the codec. */
function ogg(b) {
  const segs = b[26];
  const p = 27 + segs;
  if (startsWith(b, [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], p)) return { id: 'opus' }; // OpusHead
  if (ascii(b, p + 1, 6) === 'vorbis') return { id: 'vorbis' };
  if (b[p] === 0x7f && ascii(b, p + 1, 4) === 'FLAC') return { id: 'flac', info: { container: 'ogg' } };
  if (b[p] === 0x80 && ascii(b, p + 1, 6) === 'theora') return { id: 'ogv' };
  return { id: 'vorbis', info: { codec: 'unknown' } };
}

function zipBased(b, nameExt) {
  const cd = readCentralDirectory(b, { maxEntries: 5000 });
  if (!cd.ok) return { id: 'zip', info: { damaged: cd.reason } };
  const names = new Set(cd.entries.map((e) => e.name));
  const mimetype = cd.entries.find((e) => e.name === 'mimetype');
  if (mimetype) {
    const raw = storedEntryBytes(b, mimetype);
    const mt = raw ? ascii(raw, 0, raw.length).trim() : '';
    if (mt === 'application/epub+zip') return { id: 'epub' };
    if (mt === 'application/vnd.oasis.opendocument.text') return { id: 'odt' };
    if (mt === 'application/vnd.oasis.opendocument.spreadsheet') return { id: 'ods' };
    if (mt === 'application/vnd.oasis.opendocument.presentation') return { id: 'odp' };
  }
  const prefix = (p) => cd.entries.some((e) => e.name.startsWith(p));
  const macro = cd.entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name));
  if (names.has('[Content_Types].xml')) {
    if (prefix('word/')) return { id: macro ? 'docm' : 'docx' };
    if (prefix('xl/')) return { id: macro ? 'xlsm' : 'xlsx' };
    if (prefix('ppt/')) return { id: macro ? 'pptm' : 'pptx' };
  }
  if (names.has('AndroidManifest.xml') && (names.has('classes.dex') || nameExt === 'apk')) return { id: 'apk' };
  if (names.has('META-INF/MANIFEST.MF') && cd.entries.some((e) => e.name.endsWith('.class'))) return { id: 'jar' };
  const encrypted = cd.entries.some((e) => e.encrypted);
  return { id: 'zip', info: { entries: cd.total, ...(encrypted ? { encrypted: true } : {}) } };
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** Text sniffing on the first 64 KB (valid UTF-8 or a UTF-16 BOM, no NUL bytes). */
function textual(b, nameExt) {
  let s;
  if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) {
    s = new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(b.subarray(2, 65536));
  } else {
    let head = b.subarray(0, Math.min(b.length, 65536));
    if (head.includes(0)) return null;
    // don't fail on a multi-byte character cut at the 64 KB boundary
    if (b.length > 65536) { let cut = head.length; while (cut > head.length - 4 && (head[cut - 1] & 0xc0) === 0x80) cut--; if (cut > 0 && head[cut - 1] >= 0xc0) cut--; head = head.subarray(0, cut); }
    try { s = utf8Fatal.decode(head); } catch { return null; }
    if (/[\x00-\x08\x0e-\x1a\x1c-\x1f]/.test(s.slice(0, 4096))) return null;
  }
  const t = s.replace(/^\uFEFF/, '').trimStart();
  const low = t.slice(0, 512).toLowerCase();
  if (t.startsWith('#!')) return { id: 'script', info: { shebang: t.slice(2, 40).split('\n')[0].trim() } };
  if (SCRIPT_EXTS.has(nameExt)) return { id: 'script', info: { by: 'extension' } };
  if (t.startsWith('{\\rtf')) return { id: 'rtf' };
  if (low.startsWith('<?xml')) return { id: /<svg[\s>]/.test(low) ? 'svg' : 'xml' };
  if (low.startsWith('<svg')) return { id: 'svg' };
  if (low.startsWith('<!doctype html') || low.startsWith('<html')) return { id: 'html' };
  if (t.startsWith('WEBVTT')) return { id: 'vtt' };
  if (/^\d+\r?\n\d\d:\d\d:\d\d[,.]\d{3} --> /.test(t)) return { id: 'srt' };
  if ((t[0] === '{' || t[0] === '[') && b.length <= 1024 * 1024) {
    try { JSON.parse(s.replace(/^\uFEFF/, '')); return { id: 'json' }; } catch { /* not JSON */ }
  }
  return { id: 'text' };
}

/** Magic-byte checks in order; returns { id, info? } or null. */
function magic(b, nameExt) {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { id: 'jpeg' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { id: 'png' };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { id: 'gif' };
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    const kind = ascii(b, 8, 4);
    if (kind === 'WEBP') return { id: 'webp' };
    if (kind === 'WAVE') return { id: 'wav' };
    if (kind === 'AVI ') return { id: 'avi' };
  }
  if (ascii(b, 4, 4) === 'ftyp') return isoBmff(b);
  if (ascii(b, 0, 5) === '%PDF-') return { id: 'pdf' };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return zipBased(b, nameExt);
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return ole(b, nameExt);
  if (ascii(b, 0, 5) === '{\\rtf') return { id: 'rtf' };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return ebml(b);
  if (ascii(b, 0, 4) === 'OggS' && b.length > 40) return ogg(b);
  if (ascii(b, 0, 4) === 'fLaC') return { id: 'flac' };
  if (ascii(b, 0, 3) === 'ID3') return { id: 'mp3' };
  if (ascii(b, 0, 6) === '#!AMR\n') return { id: 'amr' };
  if (ascii(b, 0, 4) === 'MThd') return { id: 'midi' };
  if (startsWith(b, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return { id: 'asf' };
  if (ascii(b, 0, 3) === 'FLV' && b[3] === 1) return { id: 'flv' };
  if (startsWith(b, [0x1f, 0x8b, 0x08])) return { id: 'gzip' };
  if (ascii(b, 0, 3) === 'BZh' && b[3] >= 0x31 && b[3] <= 0x39) return { id: 'bz2' };
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { id: 'xz' };
  if (startsWith(b, [0x28, 0xb5, 0x2f, 0xfd])) return { id: 'zstd' };
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { id: '7z' };
  if (ascii(b, 0, 7) === 'Rar!\x1a\x07\x00' || ascii(b, 0, 8) === 'Rar!\x1a\x07\x01\x00') return { id: 'rar', info: { version: b[6] === 1 ? 5 : 4 } };
  if (b.length >= 262 && ascii(b, 257, 5) === 'ustar') return { id: 'tar' };
  if (ascii(b, 0, 4) === '8BPS') return { id: 'psd' };
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26 && u32le(b, 2) <= b.length + 16 && u32le(b, 2) >= 26 && u16le(b, 6) === 0 && u16le(b, 8) === 0) return { id: 'bmp' };
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return { id: 'tiff' };
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00]) && b.length >= 22 && u16le(b, 4) > 0 && u16le(b, 4) <= 256 && (b[9] === 0 || b[9] === 255)) return { id: 'ico' };
  if (ascii(b, 0, 16) === 'SQLite format 3\x00') return { id: 'sqlite' };
  if (ascii(b, 0, 4) === 'wOFF') return { id: 'woff' };
  if (ascii(b, 0, 4) === 'wOF2') return { id: 'woff2' };
  if (ascii(b, 0, 4) === 'OTTO') return { id: 'otf' };
  if (startsWith(b, [0x00, 0x01, 0x00, 0x00, 0x00]) && b.length > 12 && ['ttf', 'ttc'].includes(nameExt)) return { id: 'ttf' };
  // executables
  if (ascii(b, 0, 2) === 'MZ') {
    const pe = b.length >= 0x40 ? u32le(b, 0x3c) : 0;
    return { id: 'exe', info: { pe: pe > 0 && pe + 4 <= b.length && ascii(b, pe, 4) === 'PE\x00\x00' } };
  }
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return { id: 'elf' };
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32be(b, 0))) return { id: 'macho' };
  if (u32be(b, 0) === 0xcafebabe && b.length >= 8) return u32be(b, 4) < 0x30 ? { id: 'macho', info: { fat: true } } : { id: 'javaclass' };
  if (ascii(b, 0, 4) === 'dex\n') return { id: 'dex' };
  if (startsWith(b, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return { id: 'lnk' };
  // MPEG audio without an ID3 tag: AAC ADTS (layer 0) or MP3 (layer III); weak, so after the rest
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { id: 'aac' };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 3) === 1 && (b[2] >> 4) !== 15 && (b[2] >> 4) !== 0) return { id: 'mp3' };
  // last: %PDF- within the first KB (readers accept junk before it) and %%EOF near the end — only
  // when no exact signature matched (a ZIP holding a stored PDF must stay a ZIP)
  const at = indexOfBytes(b, [0x25, 0x50, 0x44, 0x46, 0x2d], 0, 1024);
  if (at > 0 && indexOfBytes(b, [0x25, 0x25, 0x45, 0x4f, 0x46], Math.max(0, b.length - 2048)) >= 0) return { id: 'pdf', info: { offset: at } };
  return null;
}

/** A second container hiding behind the first one (e.g. a JPEG with a ZIP appended). */
function polyglot(b, id) {
  const t = TYPES[id];
  if (!t || ['zip', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'odt', 'ods', 'odp', 'epub', 'apk', 'jar'].includes(id)) return null;
  if (t.family === 'text' || id === 'empty' || id === 'unknown') return null;
  if (b.length >= 22 && findEocd(b) >= 0) {
    const cd = readCentralDirectory(b, { maxEntries: 50 });
    if (cd.ok && cd.total > 0) return 'zip';
  }
  return null;
}

/**
 * Detects the type of `bytes`; `name` (the user's file name) only breaks ties that bytes can't
 * (MSI vs other OLE files, scripts in plain text) and is compared afterwards for Detect & Fix.
 */
export function detect(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const nameExt = extOf(name);
  let r;
  if (!b.length) r = { id: 'empty' };
  else r = magic(b, nameExt) || textual(b, nameExt) || { id: 'unknown' };
  const t = TYPES[r.id];
  const poly = polyglot(b, r.id);
  const dangerous = t.dangerous || (poly ? 'polyglot' : null);
  return {
    id: r.id,
    label: t.label,
    family: t.family,
    ext: t.exts[0] || '',
    exts: t.exts,
    mime: t.mime,
    dangerous: dangerous || null,
    polyglot: poly,
    nameExt,
    extOk: extMatches(r.id, nameExt),
    info: r.info || null,
  };
}

/**
 * Does the name's extension describe the detected type? Text accepts any text-like extension;
 * unknown/empty files have nothing to compare. A dangerous extension on a harmless file is a
 * mismatch (Detect & Fix proposes the true one).
 */
export function extMatches(id, nameExt) {
  const t = TYPES[id];
  if (!t || id === 'unknown' || id === 'empty') return true;
  if (!nameExt) return false;
  if (isDangerousExt(nameExt) && !t.dangerous) return false;
  if (t.exts.includes(nameExt)) return true;
  if (t.family === 'text' && !t.dangerous) return nameExt === 'txt' || (id === 'text' && !isBinaryExt(nameExt));
  return false;
}

/** Extensions that belong to binary formats: a plain-text file named like that is mislabeled. */
function isBinaryExt(ext) {
  for (const [id, t] of Object.entries(TYPES)) {
    if (t.family !== 'text' && id !== 'script' && t.exts.includes(ext)) return true;
  }
  return false;
}

/** Compact form kept in files.type: id, '!zip' for a polyglot, '#enc' for encrypted entries. */
export function storedType(d) {
  return `${d.id}${d.polyglot ? `!${d.polyglot}` : ''}${d.info && d.info.encrypted ? '#enc' : ''}`;
}

/** Rebuilds a detect() result from storedType() + the file name (no bytes needed). */
export function describe(stored, name = '') {
  const m = /^([a-z0-9_]+)(?:!([a-z0-9]+))?(#enc)?$/.exec(String(stored || ''));
  const id = m && TYPES[m[1]] ? m[1] : 'unknown';
  const t = TYPES[id];
  const poly = m && m[2] ? m[2] : null;
  const nameExt = extOf(name);
  return {
    id,
    label: t.label,
    family: t.family,
    ext: t.exts[0] || '',
    exts: t.exts,
    mime: t.mime,
    dangerous: t.dangerous || (poly ? 'polyglot' : null),
    polyglot: poly,
    nameExt,
    extOk: extMatches(id, nameExt),
    info: m && m[3] ? { encrypted: true } : null,
  };
}
