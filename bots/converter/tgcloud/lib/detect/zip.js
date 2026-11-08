// Reads a ZIP's central directory without decompressing anything (detection now, archive limits in
// C2). Pure, bounded: at most `maxEntries` entries are parsed, names are decoded as UTF-8 (flag bit
// 11) or CP437-ish latin1 otherwise.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOC64 = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;

/** Offset of a plausible end-of-central-directory record, or -1. */
export function findEocd(b) {
  const min = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || b[i + 2] !== 0x05 || b[i + 3] !== 0x06) continue;
    const commentLen = u16(b, i + 20);
    if (i + 22 + commentLen > b.length) continue;
    const size = u32(b, i + 12);
    const offset = u32(b, i + 16);
    const total = u16(b, i + 10);
    if (offset === 0xffffffff || size === 0xffffffff || total === 0xffff) return i; // ZIP64: checked later
    if (total === 0 && size === 0) return i; // empty archive
    // the directory sits right before this record; offsets may be shifted when the ZIP was
    // appended to another file (self-extractors, polyglots)
    if (size > i || u32(b, i - size) !== SIG_CD) continue; // not a real directory
    return i;
  }
  return -1;
}

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/**
 * → { ok: true, entries, total, truncated, zip64, cdOffset } | { ok: false, reason }
 * entries: { name, method, flags, encrypted, crc, csize, usize, offset, dir, symlink, unixMode }
 */
export function readCentralDirectory(b, { maxEntries = 5000 } = {}) {
  const e = findEocd(b);
  if (e < 0) return { ok: false, reason: 'no_eocd' };
  let total = u16(b, e + 10);
  let size = u32(b, e + 12);
  let offset = u32(b, e + 16);
  let zip64 = false;
  if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const loc = e - 20;
    if (loc < 0 || u32(b, loc) !== SIG_LOC64) return { ok: false, reason: 'zip64_locator' };
    const rec = u64(b, loc + 8);
    if (rec + 56 > b.length || u32(b, rec) !== SIG_EOCD64) return { ok: false, reason: 'zip64_record' };
    total = u64(b, rec + 32);
    size = u64(b, rec + 40);
    offset = u64(b, rec + 48);
    zip64 = true;
  }
  // where the directory really is; `shift` corrects offsets of a ZIP appended to other data
  let shift = 0;
  if (!zip64 && size <= e && u32(b, e - size) === SIG_CD && e - size !== offset) { shift = e - size - offset; offset = e - size; }
  if (offset + size > b.length) return { ok: false, reason: 'truncated' };
  const entries = [];
  let p = offset;
  const end = offset + size;
  while (p + 46 <= end && entries.length < maxEntries) {
    if (u32(b, p) !== SIG_CD) return { ok: false, reason: 'bad_entry' };
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const crc = u32(b, p + 16);
    let csize = u32(b, p + 20);
    let usize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const madeBy = b[p + 5];
    const ext = u32(b, p + 38);
    let local = u32(b, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > end) return { ok: false, reason: 'bad_entry' };
    const raw = b.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? utf8 : latin1).decode(raw);
    // ZIP64 extra field (0x0001): the 64-bit sizes / offset that were 0xFFFFFFFF
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(b, x);
      const len = u16(b, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff && q + 8 <= x + 4 + len) { usize = u64(b, q); q += 8; }
        if (csize === 0xffffffff && q + 8 <= x + 4 + len) { csize = u64(b, q); q += 8; }
        if (local === 0xffffffff && q + 8 <= x + 4 + len) { local = u64(b, q); }
      }
      x += 4 + len;
    }
    const unixMode = madeBy === 3 ? (ext >>> 16) & 0xffff : 0;
    entries.push({
      name,
      method,
      flags,
      encrypted: !!(flags & 1),
      crc,
      csize,
      usize,
      offset: local + shift,
      dir: name.endsWith('/'),
      symlink: (unixMode & 0xf000) === 0xa000,
      unixMode,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries, total, truncated: entries.length < total, zip64, cdOffset: offset, shift };
}

/** The bytes of a STORED (method 0) entry, e.g. the ODF/EPUB `mimetype` file; null otherwise. */
export function storedEntryBytes(b, entry, max = 256) {
  if (entry.method !== 0 || entry.encrypted) return null;
  const o = entry.offset;
  if (o + 30 > b.length || u32(b, o) !== 0x04034b50) return null;
  const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
  const len = Math.min(entry.csize, max);
  if (start + len > b.length) return null;
  return b.subarray(start, start + len);
}
