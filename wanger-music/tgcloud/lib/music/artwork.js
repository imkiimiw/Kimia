// The full-size cover picture embedded in an audio file (pure: no sdk). Telegram keeps only a small
// thumbnail of a song's cover (≤ 320 px), which looks blurry as a channel photo; the file itself
// usually carries the original picture: ID3v2 APIC / PIC (MP3), a FLAC PICTURE block, or an MP4
// `covr` atom (M4A, when its `moov` box comes before the audio). Only the start of the file is read.

/** Telegram's limits for an uploaded photo. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_MAX_SIDES = 10000; // width + height
/** Not worth uploading: Telegram's own thumbnail is already this big. */
export const THUMBNAIL_SIDE = 320;
/** Never read more than this from the start of a file. */
export const READ_CAP = 12 * 1024 * 1024;

/** @typedef {{bytes: Uint8Array, mime: 'image/jpeg'|'image/png', width: number, height: number}} Picture */
/** @typedef {{picture: Picture}|{need: number}|null} Scan */

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const syncsafe = (b, o) => (b[o] & 0x7f) * 0x200000 + (b[o + 1] & 0x7f) * 0x4000 + (b[o + 2] & 0x7f) * 0x80 + (b[o + 3] & 0x7f);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/** Image size from a JPEG's SOF segment or a PNG's IHDR. @returns {{mime: Picture['mime'], width: number, height: number}|null} */
export function imageInfo(b) {
  if (b.length > 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    return { mime: 'image/png', width: u32(b, 16), height: u32(b, 20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const m = b[o + 1];
    if (m === 0xff) { o += 1; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; } // no length
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { mime: 'image/jpeg', height: u16(b, o + 5), width: u16(b, o + 7) };
    }
    if (m === 0xd9 || m === 0xda) return null; // end of image / scan data before any frame header
    o += 2 + u16(b, o + 2);
  }
  return null;
}

/** A picture worth sending as a channel photo: a real JPEG/PNG, bigger than the thumbnail, within Telegram's limits. */
function usable(bytes) {
  const info = imageInfo(bytes);
  if (!info || !info.width || !info.height) return null;
  if (Math.max(info.width, info.height) <= THUMBNAIL_SIDE) return null;
  if (bytes.length > PHOTO_MAX_BYTES || info.width + info.height > PHOTO_MAX_SIDES) return null;
  if (Math.max(info.width, info.height) / Math.min(info.width, info.height) > 20) return null;
  return { bytes, ...info };
}

/** Front cover (type 3) first, then the first picture. @param {{type: number, bytes: Uint8Array}[]} found */
function choose(found) {
  const order = [...found.filter((p) => p.type === 3), ...found.filter((p) => p.type !== 3)];
  for (const p of order) {
    const pic = usable(p.bytes);
    if (pic) return { picture: pic };
  }
  return null;
}

/** Undo ID3 unsynchronisation (0xFF 0x00 → 0xFF). */
function unsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, n);
}

/** End of a text terminated by 0x00 (latin-1 / UTF-8) or 0x00 0x00 on an even offset (UTF-16). */
function textEnd(b, o, wide) {
  if (!wide) {
    const i = b.indexOf(0, o);
    return i < 0 ? -1 : i + 1;
  }
  for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
  return -1;
}

/** APIC (v2.3/2.4) or PIC (v2.2) frame body → {type, bytes}. */
function id3Picture(f, v22) {
  const enc = f[0];
  const wide = enc === 1 || enc === 2;
  let o;
  if (v22) o = 4; // encoding, 3-letter format
  else {
    o = f.indexOf(0, 1) + 1; // MIME type, latin-1
    if (o <= 0) return null;
  }
  const type = f[o];
  const end = textEnd(f, o + 1, wide);
  return end < 0 ? null : { type, bytes: f.subarray(end) };
}

/** @param {Uint8Array} b starts with "ID3" @returns {Scan} */
function scanId3(b) {
  if (b.length < 10) return { need: 10 };
  const ver = b[3];
  const flags = b[5];
  if (ver < 2 || ver > 4) return null;
  const total = 10 + syncsafe(b, 6);
  if (b.length < total) return { need: total };
  let tag = b.subarray(10, total);
  if ((flags & 0x80) && ver < 4) tag = unsync(tag);
  let o = 0;
  if ((flags & 0x40) && ver === 3) o = 4 + u32(tag, 0);
  if ((flags & 0x40) && ver === 4) o = syncsafe(tag, 0);
  const head = ver === 2 ? 6 : 10;
  const found = [];
  while (o + head <= tag.length) {
    if (tag[o] === 0) break; // padding
    const id = ascii(tag, o, ver === 2 ? 3 : 4);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let size;
    if (ver === 2) size = u24(tag, o + 3);
    else if (ver === 4 && !(tag[o + 4] & 0x80 || tag[o + 5] & 0x80 || tag[o + 6] & 0x80 || tag[o + 7] & 0x80)) size = syncsafe(tag, o + 4);
    else size = u32(tag, o + 4); // v2.3, or a v2.4 writer that forgot syncsafe sizes
    const start = o + head;
    o = start + size;
    if (o > tag.length) break;
    if (id !== 'APIC' && id !== 'PIC') continue;
    let f = tag.subarray(start, o);
    if (ver === 3) {
      const fl = tag[start - 1];
      if (fl & 0xc0) continue; // compressed / encrypted
      if (fl & 0x20) f = f.subarray(1); // group id
    } else if (ver === 4) {
      const fl = tag[start - 1];
      if (fl & 0x0c) continue; // compressed / encrypted
      if (fl & 0x40) f = f.subarray(1);
      if (fl & 0x01) f = f.subarray(4); // data length indicator
      if (fl & 0x02) f = unsync(f);
    }
    const p = id3Picture(f, ver === 2);
    if (p) found.push(p);
  }
  return choose(found);
}

/** @param {Uint8Array} b starts with "fLaC" @returns {Scan} */
function scanFlac(b) {
  const found = [];
  let o = 4;
  for (;;) {
    if (b.length < o + 4) return { need: o + 4 };
    const last = b[o] & 0x80;
    const type = b[o] & 0x7f;
    const len = u24(b, o + 1);
    const start = o + 4;
    if (type === 6) {
      if (b.length < start + len) return { need: start + len };
      const f = b.subarray(start, start + len);
      let p = 4;
      p += 4 + u32(f, p); // MIME type
      p += 4 + u32(f, p); // description
      p += 16; // width, height, depth, colours
      const n = u32(f, p);
      if (p + 4 + n <= f.length) found.push({ type: u32(f, 0), bytes: f.subarray(p + 4, p + 4 + n) });
    }
    o = start + len;
    if (last) return choose(found);
  }
}

/** Child boxes of an MP4 box's payload [from, to). @returns {{type: string, start: number, end: number}[]} */
function boxes(b, from, to) {
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    let head = 8;
    if (size === 1) { size = u32(b, o + 8) * 0x100000000 + u32(b, o + 12); head = 16; }
    if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type: ascii(b, o + 4, 4), start: o + head, end: o + size });
    o += size;
  }
  return out;
}

/** @param {Uint8Array} b an MP4 file (ftyp first) @returns {Scan} */
function scanMp4(b) {
  let o = 0;
  for (;;) {
    if (b.length < o + 16) return { need: o + 16 };
    let size = u32(b, o);
    const type = ascii(b, o + 4, 4);
    if (size === 1) size = u32(b, o + 8) * 0x100000000 + u32(b, o + 12);
    if (type === 'mdat' || size < 8) return null; // the tags come after the audio: not worth reading it all
    if (type !== 'moov') { o += size; continue; }
    if (b.length < o + size) return { need: o + size };
    const child = (box, name) => box && boxes(b, box.start, box.end).find((x) => x.type === name);
    const moov = boxes(b, o, o + size)[0];
    const meta = child(child(moov, 'udta'), 'meta');
    if (!meta) return null;
    // `meta` is a full box (4 bytes of version and flags) in MP4 files; QuickTime writes it without
    const metaBox = u32(b, meta.start) === 0 ? { ...meta, start: meta.start + 4 } : meta;
    const covr = child(child(metaBox, 'ilst'), 'covr');
    if (!covr) return null;
    const found = boxes(b, covr.start, covr.end).filter((x) => x.type === 'data' && x.end - x.start > 8)
      .map((x) => ({ type: 3, bytes: b.subarray(x.start + 8, x.end) })); // 4 bytes type, 4 bytes locale
    return choose(found);
  }
}

/**
 * Looks for the cover picture in the first bytes of an audio file.
 * @param {Uint8Array} b the bytes read so far, from the file's start
 * @returns {Scan} the picture; or how many bytes are needed to decide; or null (none worth using)
 */
export function scanCover(b) {
  if (b.length < 12) return { need: 12 };
  if (ascii(b, 0, 3) === 'ID3') return scanId3(b);
  if (ascii(b, 0, 4) === 'fLaC') return scanFlac(b);
  if (ascii(b, 4, 4) === 'ftyp') return scanMp4(b);
  return null;
}

const STANDARD_KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

/** "320kbps" from the audio's bytes (the file minus its tags) and length; a VBR file gets its average. */
function kbpsLabel(audioBytes, duration, prefix = '') {
  if (!(audioBytes > 0) || !(duration > 0)) return '';
  const kbps = (audioBytes * 8) / duration / 1000;
  if (kbps < 16 || kbps > 400) return ''; // a wrong length or size
  const near = STANDARD_KBPS.reduce((a, b) => (Math.abs(b - kbps) < Math.abs(a - kbps) ? b : a));
  return `${prefix}${Math.abs(near - kbps) / near <= 0.06 ? near : Math.round(kbps)}kbps`;
}

/**
 * The file's quality label: "FLAC", "320kbps" (MP3: size without the ID3 tag ÷ length), "AAC 256kbps"
 * (M4A: the mdat box ÷ length), '' when unknown. An MP3 needs only its first 12 bytes.
 * @param {Uint8Array} b @param {number} fileSize @param {number} duration seconds
 * @returns {{label: string}|{need: number}}
 */
export function scanQuality(b, fileSize, duration) {
  if (b.length < 12) return { need: 12 };
  if (ascii(b, 0, 4) === 'fLaC') return { label: 'FLAC' };
  if (ascii(b, 0, 3) === 'ID3') return { label: kbpsLabel(fileSize - (10 + syncsafe(b, 6) + (b[5] & 0x10 ? 10 : 0)), duration) };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { label: kbpsLabel(fileSize, duration) }; // an MPEG frame, no tag
  if (ascii(b, 4, 4) !== 'ftyp') return { label: '' };
  for (let o = 0; ;) {
    if (b.length < o + 16) return { need: o + 16 };
    let size = u32(b, o);
    if (size === 1) size = u32(b, o + 8) * 0x100000000 + u32(b, o + 12);
    if (ascii(b, o + 4, 4) === 'mdat') return { label: kbpsLabel(size === 0 ? fileSize - o : size, duration, 'AAC ') };
    if (size < 8) return { label: '' };
    o += size;
  }
}

/**
 * Reads chunks of a file from its start only as far as `scan` needs (≤ cap bytes).
 * @template {object} T
 * @param {AsyncIterable<Uint8Array>} chunks @param {(b: Uint8Array) => (T|{need: number}|null)} scan
 * @returns {Promise<T|null>} null: nothing found, past the cap, or the file ended first
 */
export async function readScan(chunks, scan, cap = READ_CAP) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let have = 0;
  let need = 12;
  const joined = () => {
    if (parts.length > 1) {
      const all = new Uint8Array(have);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      parts.splice(0, parts.length, all);
    }
    return parts[0] || new Uint8Array(0);
  };
  for await (const chunk of chunks) {
    parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    have += chunk.length;
    while (have >= need) {
      const r = scan(joined());
      if (!r) return null;
      const more = /** @type {any} */ (r).need;
      if (typeof more !== 'number') return /** @type {T} */ (r);
      if (more > cap) return null;
      need = more;
    }
  }
  return null;
}

/** The cover picture of a file's chunks (≤ cap bytes read). @returns {Promise<Picture|null>} */
export async function readCover(chunks, cap = READ_CAP) {
  const r = await readScan(chunks, scanCover, cap);
  return r && 'picture' in r ? r.picture : null;
}

/** The quality label of a file's chunks ('' when unknown). */
export async function readQuality(chunks, fileSize, duration) {
  const r = await readScan(chunks, (b) => scanQuality(b, fileSize, duration), 4 * 1024 * 1024);
  return r ? r.label : '';
}

// ---------------------------------------------------------------- 🧹 clean tags (owner's idea, 2026-11-23)
// Files from other channels carry their names and links in the ID3 tags (title, comment, album…),
// which players show. cleanMp3 keeps the audio frames as they are and replaces every tag with a
// fresh ID3v2.3 one: title, artist, album, and the original cover picture.

/** A plausible MPEG audio frame header at `i` (sync, a real layer, bitrate and sample rate). */
const mpegFrameAt = (b, i) => b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 && ((b[i + 1] >> 1) & 3) !== 0
  && (b[i + 2] >> 4) !== 15 && (b[i + 2] >> 4) !== 0 && ((b[i + 2] >> 2) & 3) !== 3;

/** ID3v2.3 frame: 4-letter id, plain size, no flags. */
function id3Frame(id, body) {
  const out = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  out.set([(body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff], 4);
  out.set(body, 10);
  return out;
}

/** A text frame in UTF-16 with a BOM (Persian titles survive every player). */
function id3Text(id, text) {
  const s = String(text);
  const body = new Uint8Array(3 + s.length * 2);
  body.set([1, 0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    body[3 + 2 * i] = c & 0xff;
    body[4 + 2 * i] = c >> 8;
  }
  return id3Frame(id, body);
}

/** APIC: latin-1 MIME type, front cover, empty description. @param {Picture} pic */
function apicFrame(pic) {
  const mime = pic.mime;
  const body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + pic.bytes.length);
  let o = 1;
  for (let i = 0; i < mime.length; i++) body[o++] = mime.charCodeAt(i);
  body[o++] = 0;
  body[o++] = 3;
  body[o++] = 0;
  body.set(pic.bytes, o);
  return id3Frame('APIC', body);
}

/**
 * The MP3 with its tags replaced (pure). null when the bytes don't look like an MP3 we can safely
 * rewrite (then the file is sent as it is).
 * @param {Uint8Array} b the whole file @param {{title?: string|null, artist?: string|null, album?: string|null}} meta
 * @returns {Uint8Array|null}
 */
export function cleanMp3(b, meta) {
  if (!b || b.length < 1024) return null;
  let start = 0;
  while (start + 10 <= b.length && ascii(b, start, 3) === 'ID3') start += 10 + syncsafe(b, start + 6) + (b[start + 5] & 0x10 ? 10 : 0);
  // a few bytes of padding or junk may sit between the tag and the first frame
  let audio = -1;
  for (let i = start; i < Math.min(b.length - 4, start + 65536); i++) {
    if (mpegFrameAt(b, i)) { audio = i; break; }
  }
  if (audio < 0) return null;
  let end = b.length;
  if (end - 128 > audio && ascii(b, end - 128, 3) === 'TAG') end -= 128; // ID3v1
  if (end - 32 > audio && ascii(b, end - 32, 8) === 'APETAGEX') {
    const size = b[end - 20] | (b[end - 19] << 8) | (b[end - 18] << 16) | (b[end - 17] << 24); // APEv2 footer: tag size without the header
    const withHeader = size + ((b[end - 9] & 0x80) ? 32 : 0);
    if (withHeader > 0 && end - withHeader > audio) end -= withHeader;
  }
  const cover = scanCover(b);
  const frames = [];
  if (meta.title) frames.push(id3Text('TIT2', meta.title));
  if (meta.artist) frames.push(id3Text('TPE1', meta.artist));
  if (meta.album) frames.push(id3Text('TALB', meta.album));
  if (cover && 'picture' in cover && cover.picture) frames.push(apicFrame(cover.picture));
  const tagSize = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(10 + tagSize + (end - audio));
  out.set([0x49, 0x44, 0x33, 3, 0, 0, (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f]);
  let o = 10;
  for (const f of frames) { out.set(f, o); o += f.length; }
  out.set(b.subarray(audio, end), o);
  return out;
}

/** A JPEG Telegram accepts as an audio thumbnail (≤ 320 px, ≤ 200 kB)? */
export function thumbnailOk(bytes) {
  const info = bytes && bytes.length <= 200 * 1024 ? imageInfo(bytes) : null;
  return Boolean(info && info.mime === 'image/jpeg' && Math.max(info.width, info.height) <= THUMBNAIL_SIDE);
}
