// C2 sample files built in code: real ZIPs (deflate), TARs (incl. links/devices/long names), gzip,
// PDFs made with pdf-lib, JPEGs with EXIF orientation, PNGs. No binary fixtures in the repository.
import { zipSync, gzipSync, zlibSync, strToU8 } from '../../tgcloud/lib/vendor/fflate.js';
import { PDFDocument, StandardFonts } from '../../tgcloud/lib/vendor/pdf-lib.js';
import { crc32 } from './fixtures.mjs';

const enc = new TextEncoder();
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export const zipOf = (files, level = 6) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [typeof v === 'string' ? strToU8(v) : v, { level }]])));

/** A TAR. entries: [{ name, data?, type? ('0' file, '5' dir, '1' hardlink, '2' symlink, '3' char dev, 'x' pax), linkname?, prefix? }] */
export function tarOf(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data || new Uint8Array(0);
    const h = new Uint8Array(512);
    h.set(enc.encode(e.name).subarray(0, 100), 0);
    h.set(enc.encode('0000644\0'), 100);
    h.set(enc.encode('0000000\0'), 108);
    h.set(enc.encode('0000000\0'), 116);
    h.set(enc.encode(`${data.length.toString(8).padStart(11, '0')}\0`), 124);
    h.set(enc.encode('00000000000\0'), 136);
    h[156] = (e.type || '0').charCodeAt(0);
    if (e.linkname) h.set(enc.encode(e.linkname), 157);
    h.set(enc.encode('ustar\x0000'), 257);
    if (e.prefix) h.set(enc.encode(e.prefix), 345);
    for (let i = 148; i < 156; i++) h[i] = 32;
    let sum = 0;
    for (const x of h) sum += x;
    h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return concat(...blocks);
}

/** A pax header block that sets a long path for the next entry. */
export function paxPath(path) {
  const rec = (k, v) => { let len = k.length + v.length + 3; len += String(len).length; if (String(len).length !== String(len - String(len).length).length) len++; return `${len} ${k}=${v}\n`; };
  return { name: 'PaxHeader', type: 'x', data: rec('path', path) };
}

export const gzipOf = (data, name) => gzipSync(data, { level: 6, filename: name });

/** A real text PDF with `pages` pages (page i shows "Page i"). */
export async function pdfOf(pages, { size = [300, 400] } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage(size).drawText(`Page ${i}`, { x: 20, y: 20, size: 18, font });
  return doc.save({ objectsPerTick: Infinity, useObjectStreams: false });
}

/** A tiny baseline JPEG (from Pillow, 64×32) with an optional EXIF orientation. */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAgAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzVLP2qdLP2rXSz9qnSz9q9+WJPPoYsyUs/arCWftWsln7VYSz9q55Yk9mhizISz9qsJZ+1ayWftVhLP2rmliT2qGLMlLP2qdLP2rXSz9qnSz9q5pYk9mhizISz9qsJZ+1ayWftVhLP2rnliT8IoYsyEs/arCWftWsln7VYSz9q55Yk9mhizISz9qsJZ+1a6WftU6WftXNLEntUMWZKWftU6WftWuln7VYSz9q5pYk9qhiz//Z';
export function jpegOf(orientation = 1) {
  const b = Uint8Array.from(Buffer.from(JPEG_B64, 'base64'));
  if (orientation === 1) return b;
  // APP1 Exif, little endian TIFF, IFD0 with one entry 0x0112 = orientation
  const tiff = [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const payload = [...enc.encode('Exif'), 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
  return concat(b.subarray(0, 2), Uint8Array.from(app1), b.subarray(2));
}

/** A real RGB PNG w×h (gradient). */
export function pngOf(w, h) {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { let p = y * (w * 3 + 1); raw[p++] = 0; for (let x = 0; x < w; x++) { raw[p++] = x & 255; raw[p++] = y & 255; raw[p++] = (x ^ y) & 255; } }
  const chunk = (type, data) => {
    const td = concat(enc.encode(type), data);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(td));
    return concat(len, td, crc);
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  return concat(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0)));
}

export { concat };
