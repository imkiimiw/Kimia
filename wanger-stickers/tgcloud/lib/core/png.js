/**
 * A minimal PNG writer (pure): 1-bit greyscale, zlib with STORED deflate blocks (the runtime has no
 * compression API, and a 1-bit QR image is a few KB anyway). Used for QR codes.
 */
import { crc32 } from './zip.js';

function adler32(b) {
  let a = 1, s = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 255;
    out[o++] = part.length >>> 8;
    out[o++] = ~part.length & 255;
    out[o++] = (~part.length >>> 8) & 255;
    out.set(part, o);
    o += part.length;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24;
  out[o++] = (ad >>> 16) & 255;
  out[o++] = (ad >>> 8) & 255;
  out[o++] = ad & 255;
  return out;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * @param {number} w @param {number} h @param {(x: number, y: number) => boolean} light
 * @returns {Uint8Array} a 1-bit greyscale PNG (true = white)
 */
export function png1bit(w, h, light) {
  const rowBytes = Math.ceil(w / 8);
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rowBytes + 1); // filter byte 0
    for (let x = 0; x < w; x++) if (light(x, y)) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A QR (from core/qr.js) as a PNG: `scale` px per module and a 4-module quiet zone. */
export function qrPng(qr, scale = 8) {
  const q = 4;
  const n = (qr.size + q * 2) * scale;
  return png1bit(n, n, (x, y) => {
    const mx = Math.floor(x / scale) - q;
    const my = Math.floor(y / scale) - q;
    return !(mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx]);
  });
}
