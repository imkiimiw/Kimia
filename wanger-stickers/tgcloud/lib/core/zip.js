/**
 * A minimal ZIP writer and reader (pure; "stored" entries only, no compression, no ZIP64).
 *
 * Stickers are already compressed (WebP/PNG), so storing them costs nothing and keeps CPU low on
 * the server (one CRC-32 pass, measured CPU budget ≈ 3 s). Shared by the server (WhatsApp pack
 * export) and the Studio (frames → ZIP). Names are UTF-8 (general-purpose bit 11).
 */

const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** CRC-32 (IEEE 802.3), as ZIP uses it. @param {Uint8Array} b */
export function crc32(b) {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function nameBytes(s) {
  if (enc) return enc.encode(s);
  return new Uint8Array(unescape(encodeURIComponent(s)).split('').map((c) => c.charCodeAt(0)));
}

/** DOS date/time of a unix time (UTC; ZIP has no zone). */
function dosTime(unix) {
  const d = new Date(unix * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export const ZIP_MAX_ENTRIES = 65535;

/**
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @param {number} [unix] modification time written for every entry (default 2026-01-01)
 * @returns {Uint8Array}
 */
export function makeZip(entries, unix = 1767225600) {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error('too many entries');
  const { time, date } = dosTime(unix);
  const names = entries.map((e) => nameBytes(e.name));
  const crcs = entries.map((e) => crc32(e.data));
  let size = 22;
  entries.forEach((e, i) => (size += 30 + names[i].length + e.data.length + 46 + names[i].length));
  if (size > 0xffffffff) throw new Error('zip too big');
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const offsets = [];
  entries.forEach((e, i) => {
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true);
    dv.setUint16(o + 4, 20, true); // version needed
    dv.setUint16(o + 6, 0x0800, true); // UTF-8 names
    dv.setUint16(o + 8, 0, true); // stored
    dv.setUint16(o + 10, time, true);
    dv.setUint16(o + 12, date, true);
    dv.setUint32(o + 14, crcs[i], true);
    dv.setUint32(o + 18, e.data.length, true);
    dv.setUint32(o + 22, e.data.length, true);
    dv.setUint16(o + 26, names[i].length, true);
    dv.setUint16(o + 28, 0, true);
    out.set(names[i], o + 30);
    out.set(e.data, o + 30 + names[i].length);
    o += 30 + names[i].length + e.data.length;
  });
  const cdStart = o;
  entries.forEach((e, i) => {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true); // version made by
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, time, true);
    dv.setUint16(o + 14, date, true);
    dv.setUint32(o + 16, crcs[i], true);
    dv.setUint32(o + 20, e.data.length, true);
    dv.setUint32(o + 24, e.data.length, true);
    dv.setUint16(o + 28, names[i].length, true);
    // extra, comment, disk, internal attrs = 0
    dv.setUint32(o + 38, 0, true); // external attrs
    dv.setUint32(o + 42, offsets[i], true);
    out.set(names[i], o + 46);
    o += 46 + names[i].length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - cdStart, true);
  dv.setUint32(o + 16, cdStart, true);
  return out;
}

/**
 * Reads a ZIP's central directory and returns its STORED entries (any compressed entry or broken
 * structure → { error }). Used to check a frames ZIP before it is sent on.
 * @param {Uint8Array} b
 * @returns {{ error?: string, entries: Array<{ name: string, size: number, data: Uint8Array }> }}
 */
export function readZip(b) {
  const entries = [];
  if (b.length < 22) return { error: 'NOT_ZIP', entries };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let o = b.length - 22; o >= Math.max(0, b.length - 22 - 65535); o--) {
    if (dv.getUint32(o, true) === 0x06054b50) {
      e = o;
      break;
    }
  }
  if (e < 0) return { error: 'NOT_ZIP', entries };
  const n = dv.getUint16(e + 10, true);
  let o = dv.getUint32(e + 16, true);
  const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  for (let i = 0; i < n; i++) {
    if (o + 46 > b.length || dv.getUint32(o, true) !== 0x02014b50) return { error: 'BAD_DIRECTORY', entries };
    const method = dv.getUint16(o + 10, true);
    const crc = dv.getUint32(o + 16, true);
    const csize = dv.getUint32(o + 20, true);
    const size = dv.getUint32(o + 24, true);
    const nl = dv.getUint16(o + 28, true);
    const xl = dv.getUint16(o + 30, true);
    const cl = dv.getUint16(o + 32, true);
    const lo = dv.getUint32(o + 42, true);
    const name = dec ? dec.decode(b.subarray(o + 46, o + 46 + nl)) : String.fromCharCode(...b.subarray(o + 46, o + 46 + nl));
    if (method !== 0 || csize !== size) return { error: 'COMPRESSED', entries };
    if (lo + 30 > b.length || dv.getUint32(lo, true) !== 0x04034b50) return { error: 'BAD_ENTRY', entries };
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    if (start + size > b.length) return { error: 'TRUNCATED', entries };
    const data = b.subarray(start, start + size);
    if (crc32(data) !== crc) return { error: 'CRC', entries };
    entries.push({ name, size, data });
    o += 46 + nl + xl + cl;
  }
  return { entries };
}
