/*
 * Images without libraries (Phase 9). An image is { w, h, data } with data = RGBA bytes.
 *   decodeImage   JPEG (baseline and progressive, any sampling, restarts, gray / YCbCr / Adobe CMYK)
 *                 and PNG (every color type and bit depth, palette transparency, interlacing)
 *   encodeJpeg    baseline JPEG, 4:2:0, standard tables, quality 1–100
 *   encodePng     truecolor with adaptive filters, or indexed (≤ 256 colors, with transparency)
 *   encodeGif     animated GIF (one shared palette, LZW, loops)
 *   quantize      median cut to ≤ 256 colors, optional Floyd–Steinberg dithering
 *   ops           resize, fit, rotate, flip, gray, invert, sepia, blur, pixelate, circle, square
 *   qr            QR codes: encode (byte mode, versions 1–40, levels L M Q H) and decode (finder patterns,
 *                 perspective from the alignment pattern, error correction)
 * Pure; everything here must fit the platform's CPU budget (about 3 s per update), so callers keep
 * images small (≤ 1280 px).
 */
import { Bytes, crc32, deflate, inflate } from './files.js';
import { utf8Text } from './util.js';

export const newImage = (w, h) => ({ w, h, data: new Uint8Array(w * h * 4) });
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

export function sniff(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'webp';
  return null;
}

/* Decodes a JPEG or PNG. maxPixels guards the CPU budget. Throws on anything else. */
export function decodeImage(bytes, { maxPixels = 4200000 } = {}) {
  const kind = sniff(bytes);
  if (kind === 'jpeg') return decodeJpeg(bytes, maxPixels);
  if (kind === 'png') return decodePng(bytes, maxPixels);
  throw new Error(`image: unsupported format ${kind || 'unknown'}`);
}

/* ========== JPEG decoder ========== */

const ZZ = new Int32Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);

/* cos table: COS[x * 8 + u] = c(u) / 2 · cos((2x + 1) u π / 16) */
const COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) for (let u = 0; u < 8; u += 1) t[x * 8 + u] = (u ? 1 : Math.SQRT1_2) / 2 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();

/* 16-bit lookup: entry = length << 8 | symbol (0 = no code). */
function jpegHuff(counts, symbols) {
  const table = new Uint16Array(65536);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < counts[len - 1]; i += 1) {
      const sym = symbols[k++];
      const shift = 16 - len;
      const base = code << shift;
      const val = (len << 8) | sym;
      for (let j = 0; j < (1 << shift); j += 1) table[base + j] = val;
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

function decodeJpeg(data, maxPixels) {
  let pos = 2;
  const qt = [];
  const dcT = [];
  const acT = [];
  let frame = null;
  let restart = 0;
  let adobe = null;
  const u16 = () => {
    const v = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    return v;
  };
  while (pos < data.length) {
    if (data[pos] !== 0xFF) {
      pos += 1;
      continue;
    }
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01 || marker === 0xFF) {
      if (marker === 0xFF) pos -= 1;
      continue;
    }
    if (marker === 0xD9) break;
    const len = u16();
    const end = pos + len - 2;
    if (marker === 0xDB) {
      while (pos < end) {
        const pq = data[pos] >> 4;
        const tq = data[pos] & 15;
        pos += 1;
        const t = new Int32Array(64);
        for (let k = 0; k < 64; k += 1) {
          t[ZZ[k]] = pq ? (data[pos] << 8) | data[pos + 1] : data[pos];
          pos += pq ? 2 : 1;
        }
        qt[tq] = t;
      }
    } else if (marker === 0xC4) {
      while (pos < end) {
        const tc = data[pos] >> 4;
        const th = data[pos] & 15;
        const counts = data.subarray(pos + 1, pos + 17);
        let n = 0;
        for (const c of counts) n += c;
        const symbols = data.subarray(pos + 17, pos + 17 + n);
        (tc ? acT : dcT)[th] = jpegHuff(counts, symbols);
        pos += 17 + n;
      }
    } else if (marker >= 0xC0 && marker <= 0xC2) {
      const h = (data[pos + 1] << 8) | data[pos + 2];
      const w = (data[pos + 3] << 8) | data[pos + 4];
      const nc = data[pos + 5];
      if (!w || !h) throw new Error('jpeg: no size');
      if (w * h > maxPixels) throw new Error('jpeg: too large');
      const comps = [];
      for (let i = 0; i < nc; i += 1) {
        const o = pos + 6 + i * 3;
        comps.push({ id: data[o], h: data[o + 1] >> 4, v: data[o + 1] & 15, tq: data[o + 2], pred: 0 });
      }
      frame = { w, h, progressive: marker === 0xC2, comps };
      const hmax = Math.max(...comps.map((c) => c.h));
      const vmax = Math.max(...comps.map((c) => c.v));
      frame.hmax = hmax;
      frame.vmax = vmax;
      frame.mcusX = Math.ceil(w / (8 * hmax));
      frame.mcusY = Math.ceil(h / (8 * vmax));
      for (const c of comps) {
        c.bw = Math.ceil(Math.ceil((w * c.h) / hmax) / 8);
        c.bh = Math.ceil(Math.ceil((h * c.v) / vmax) / 8);
        c.stride = frame.mcusX * c.h;
        c.rows = frame.mcusY * c.v;
        c.coef = new Int16Array(c.stride * c.rows * 64);
      }
    } else if (marker >= 0xC3 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      throw new Error('jpeg: unsupported coding');
    } else if (marker === 0xDD) {
      restart = (data[pos] << 8) | data[pos + 1];
    } else if (marker === 0xEE) {
      if (data[pos] === 0x41 && data[pos + 1] === 0x64 && data[pos + 2] === 0x6F && data[pos + 3] === 0x62 && data[pos + 4] === 0x65) adobe = { transform: data[pos + 11] };
    } else if (marker === 0xDA) {
      if (!frame) throw new Error('jpeg: scan before frame');
      const ns = data[pos];
      const sc = [];
      for (let i = 0; i < ns; i += 1) {
        const id = data[pos + 1 + i * 2];
        const t = data[pos + 2 + i * 2];
        const comp = frame.comps.find((c) => c.id === id);
        if (!comp) throw new Error('jpeg: bad scan component');
        comp.dc = dcT[t >> 4];
        comp.ac = acT[t & 15];
        sc.push(comp);
      }
      const o = pos + 1 + ns * 2;
      const ss = data[o];
      const se = data[o + 1];
      const ah = data[o + 2] >> 4;
      const al = data[o + 2] & 15;
      pos = end;
      pos = decodeScan(data, pos, frame, sc, restart, ss, se, ah, al);
      continue;
    }
    pos = end;
  }
  if (!frame) throw new Error('jpeg: no frame');
  return jpegPixels(frame, qt, adobe);
}

function decodeScan(data, start, frame, comps, restart, ss, se, ah, al) {
  let pos = start;
  let buf = 0;
  let cnt = 0;
  let marker = false;
  const fill = () => {
    while (cnt <= 24) {
      let b = 0;
      if (!marker && pos < data.length) {
        b = data[pos];
        if (b === 0xFF) {
          const nxt = data[pos + 1];
          if (nxt === 0x00) pos += 2;
          else {
            marker = true;
            b = 0;
          }
        } else pos += 1;
      }
      buf = (buf << 8) | b;
      cnt += 8;
    }
  };
  const bit = () => {
    if (cnt < 1) fill();
    cnt -= 1;
    return (buf >>> cnt) & 1;
  };
  const receive = (n) => {
    if (!n) return 0;
    if (cnt < n) fill();
    cnt -= n;
    return (buf >>> cnt) & ((1 << n) - 1);
  };
  const extend = (v, n) => (v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decode = (table) => {
    if (cnt < 16) fill();
    const e = table[(buf >>> (cnt - 16)) & 0xFFFF];
    if (!e) throw new Error('jpeg: bad huffman code');
    cnt -= e >> 8;
    return e & 255;
  };
  let eobrun = 0;
  const progressive = frame.progressive;
  const block = (c, off) => {
    const z = c.coef;
    if (!progressive) {
      const t = decode(c.dc);
      c.pred += t ? extend(receive(t), t) : 0;
      z[off] = c.pred;
      for (let k = 1; k < 64;) {
        const rs = decode(c.ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (!s) {
          if (r < 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        z[off + ZZ[k]] = extend(receive(s), s);
        k += 1;
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const t = decode(c.dc);
        c.pred += t ? extend(receive(t), t) : 0;
        z[off] = c.pred * (1 << al);
      } else if (bit()) z[off] |= 1 << al;
      return;
    }
    if (ah === 0) {
      if (eobrun > 0) {
        eobrun -= 1;
        return;
      }
      for (let k = ss; k <= se;) {
        const rs = decode(c.ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (!s) {
          if (r < 15) {
            eobrun = (1 << r) - 1;
            if (r) eobrun += receive(r);
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        z[off + ZZ[k]] = extend(receive(s), s) * (1 << al);
        k += 1;
      }
      return;
    }
    const p1 = 1 << al;
    const m1 = -1 << al;
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k += 1) {
        const rs = decode(c.ac);
        let r = rs >> 4;
        let s = rs & 15;
        if (s) s = bit() ? p1 : m1;
        else if (r !== 15) {
          eobrun = 1 << r;
          if (r) eobrun += receive(r);
          break;
        }
        while (k <= se) {
          const zi = off + ZZ[k];
          if (z[zi] !== 0) {
            if (bit() && (z[zi] & p1) === 0) z[zi] += z[zi] >= 0 ? p1 : m1;
          } else {
            r -= 1;
            if (r < 0) break;
          }
          k += 1;
        }
        if (s && k <= se) z[off + ZZ[k]] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k += 1) {
        const zi = off + ZZ[k];
        if (z[zi] !== 0 && bit() && (z[zi] & p1) === 0) z[zi] += z[zi] >= 0 ? p1 : m1;
      }
      eobrun -= 1;
    }
  };
  const resetAt = () => {
    cnt = 0;
    buf = 0;
    eobrun = 0;
    for (const c of comps) c.pred = 0;
    /* skip to the RST marker and past it */
    while (pos < data.length - 1 && !(data[pos] === 0xFF && data[pos + 1] >= 0xD0 && data[pos + 1] <= 0xD7)) pos += 1;
    if (pos < data.length - 1) pos += 2;
    marker = false;
  };
  for (const c of comps) c.pred = 0;
  let n = 0;
  if (comps.length === 1) {
    const c = comps[0];
    for (let by = 0; by < c.bh; by += 1) {
      for (let bx = 0; bx < c.bw; bx += 1) {
        if (restart && n && n % restart === 0) resetAt();
        block(c, (by * c.stride + bx) * 64);
        n += 1;
      }
    }
  } else {
    for (let my = 0; my < frame.mcusY; my += 1) {
      for (let mx = 0; mx < frame.mcusX; mx += 1) {
        if (restart && n && n % restart === 0) resetAt();
        for (const c of comps) {
          for (let v = 0; v < c.v; v += 1) for (let h = 0; h < c.h; h += 1) block(c, ((my * c.v + v) * c.stride + mx * c.h + h) * 64);
        }
        n += 1;
      }
    }
  }
  /* find the next marker */
  let p = Math.max(start, pos - 2);
  while (p < data.length - 1 && !(data[p] === 0xFF && data[p + 1] !== 0 && !(data[p + 1] >= 0xD0 && data[p + 1] <= 0xD7))) p += 1;
  return p;
}

function jpegPixels(frame, qt, adobe) {
  const { w, h, comps, hmax, vmax } = frame;
  const planes = comps.map((c) => {
    const q = qt[c.tq];
    if (!q) throw new Error('jpeg: missing quantization table');
    const pw = c.stride * 8;
    const ph = c.rows * 8;
    const out = new Uint8Array(pw * ph);
    const tmp = new Float64Array(64);
    const coef = new Float64Array(64);
    for (let by = 0; by < c.rows; by += 1) {
      for (let bx = 0; bx < c.stride; bx += 1) {
        const off = (by * c.stride + bx) * 64;
        for (let i = 0; i < 64; i += 1) coef[i] = c.coef[off + i] * q[i];
        for (let y = 0; y < 8; y += 1) {
          for (let x = 0; x < 8; x += 1) {
            let s = 0;
            for (let u = 0; u < 8; u += 1) s += COS[x * 8 + u] * coef[y * 8 + u];
            tmp[y * 8 + x] = s;
          }
        }
        for (let x = 0; x < 8; x += 1) {
          for (let y = 0; y < 8; y += 1) {
            let s = 0;
            for (let v = 0; v < 8; v += 1) s += COS[y * 8 + v] * tmp[v * 8 + x];
            out[(by * 8 + y) * pw + bx * 8 + x] = clamp8(s + 128.5);
          }
        }
      }
    }
    const sx = c.h / hmax;
    const sy = c.v / vmax;
    return { out, pw, sx, sy, cw: Math.ceil(w * sx), ch: Math.ceil(h * sy), full: sx === 1 && sy === 1 };
  });
  /* subsampled planes are interpolated (bilinear), the others read directly */
  const value = (p, x, y) => {
    if (p.full) return p.out[y * p.pw + x];
    const fx = Math.max(0, Math.min(p.cw - 1, (x + 0.5) * p.sx - 0.5));
    const fy = Math.max(0, Math.min(p.ch - 1, (y + 0.5) * p.sy - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(p.cw - 1, x0 + 1);
    const y1 = Math.min(p.ch - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const o = p.out;
    const top = o[y0 * p.pw + x0] * (1 - tx) + o[y0 * p.pw + x1] * tx;
    const bot = o[y1 * p.pw + x0] * (1 - tx) + o[y1 * p.pw + x1] * tx;
    return top * (1 - ty) + bot * ty;
  };
  const img = newImage(w, h);
  const d = img.data;
  const n = comps.length;
  const transform = adobe ? adobe.transform : (n === 3 ? 1 : 0);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const vals = planes.map((p) => value(p, x, y));
      const o = (y * w + x) * 4;
      let r;
      let g;
      let b;
      if (n === 1) {
        r = vals[0];
        g = r;
        b = r;
      } else if (n === 3 || n === 4) {
        if (transform) {
          const Y = vals[0];
          const cb = vals[1] - 128;
          const cr = vals[2] - 128;
          r = clamp8(Y + 1.402 * cr);
          g = clamp8(Y - 0.344136 * cb - 0.714136 * cr);
          b = clamp8(Y + 1.772 * cb);
        } else {
          [r, g, b] = vals;
        }
        if (n === 4) {
          const k = vals[3];
          if (transform) {
            r = clamp8(((255 - r) * k) / 255);
            g = clamp8(((255 - g) * k) / 255);
            b = clamp8(((255 - b) * k) / 255);
          } else if (adobe) {
            r = clamp8((r * k) / 255);
            g = clamp8((g * k) / 255);
            b = clamp8((b * k) / 255);
          } else {
            r = clamp8(((255 - r) * (255 - k)) / 255);
            g = clamp8(((255 - g) * (255 - k)) / 255);
            b = clamp8(((255 - b) * (255 - k)) / 255);
          }
        }
      } else throw new Error('jpeg: unsupported components');
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return img;
}

/* ========== PNG decoder ========== */

function decodePng(bytes, maxPixels) {
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = new Bytes(bytes.length);
  const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  while (pos + 8 <= bytes.length) {
    const len = u32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { w: u32(pos + 8), h: u32(pos + 12), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.bytes(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || !ihdr.w || !ihdr.h) throw new Error('png: no header');
  const { w, h, depth, color, interlace } = ihdr;
  if (w * h > maxPixels) throw new Error('png: too large');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('png: unsupported');
  const raw = inflate(idat.done(), { max: (w * channels * depth / 8 + 2) * h * 2 + 1024 });
  const bpp = Math.max(1, (channels * depth) >> 3);
  const img = newImage(w, h);
  let off = 0;
  const pass = (x0, y0, dx, dy) => {
    const pw = Math.ceil((w - x0) / dx);
    const ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const rowLen = Math.ceil((pw * channels * depth) / 8);
    let prior = new Uint8Array(rowLen);
    for (let r = 0; r < ph; r += 1) {
      const ft = raw[off];
      const line = raw.slice(off + 1, off + 1 + rowLen);
      off += 1 + rowLen;
      for (let i = 0; i < rowLen; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prior[i];
        const c = i >= bpp ? prior[i - bpp] : 0;
        let v = line[i];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        }
        line[i] = v & 255;
      }
      prior = line;
      const y = y0 + r * dy;
      const sample = (i) => {
        if (depth === 8) return line[i];
        if (depth === 16) return line[i * 2];
        const per = 8 / depth;
        const byte = line[Math.floor(i / per)];
        const shift = 8 - depth * ((i % per) + 1);
        return (byte >> shift) & ((1 << depth) - 1);
      };
      const raw16 = (i) => (depth === 16 ? (line[i * 2] << 8) | line[i * 2 + 1] : sample(i));
      const scale = (v) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
      for (let k = 0; k < pw; k += 1) {
        const x = x0 + k * dx;
        const o = (y * w + x) * 4;
        const d = img.data;
        if (color === 3) {
          const idx = sample(k);
          d[o] = palette ? palette[idx * 3] : 0;
          d[o + 1] = palette ? palette[idx * 3 + 1] : 0;
          d[o + 2] = palette ? palette[idx * 3 + 2] : 0;
          d[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (color === 0) {
          const g = scale(sample(k));
          d[o] = g;
          d[o + 1] = g;
          d[o + 2] = g;
          d[o + 3] = trns && raw16(k) === ((trns[0] << 8) | trns[1]) ? 0 : 255;
        } else if (color === 4) {
          d[o] = sample(k * 2);
          d[o + 1] = d[o];
          d[o + 2] = d[o];
          d[o + 3] = sample(k * 2 + 1);
        } else if (color === 2) {
          d[o] = sample(k * 3);
          d[o + 1] = sample(k * 3 + 1);
          d[o + 2] = sample(k * 3 + 2);
          d[o + 3] = trns && trns.length >= 6 && raw16(k * 3) === ((trns[0] << 8) | trns[1]) && raw16(k * 3 + 1) === ((trns[2] << 8) | trns[3])
            && raw16(k * 3 + 2) === ((trns[4] << 8) | trns[5]) ? 0 : 255;
        } else {
          d[o] = sample(k * 4);
          d[o + 1] = sample(k * 4 + 1);
          d[o + 2] = sample(k * 4 + 2);
          d[o + 3] = sample(k * 4 + 3);
        }
      }
    }
  };
  if (interlace) {
    for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) pass(x0, y0, dx, dy);
  } else pass(0, 0, 1, 1);
  return img;
}

/* ========== encoders ========== */

/* PNG: truecolor RGBA (adaptive filter per row) or, with { palette, indices, transparent }, indexed. */
export function encodePng(img, indexed = null, level = 6) {
  const { w, h } = img;
  const out = new Bytes(w * h + 1024);
  out.bytes(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const chunk = (type, body) => {
    out.u32be(body.length);
    const start = out.len;
    out.ascii(type);
    out.bytes(body);
    out.u32be(crc32(out.buf, start, out.len));
  };
  const hdr = new Bytes(13);
  hdr.u32be(w);
  hdr.u32be(h);
  hdr.bytes(new Uint8Array([8, indexed ? 3 : 6, 0, 0, 0]));
  chunk('IHDR', hdr.done());
  let raw;
  if (indexed) {
    const pal = new Uint8Array(indexed.palette.length * 3);
    indexed.palette.forEach((c, i) => pal.set([c[0], c[1], c[2]], i * 3));
    chunk('PLTE', pal);
    if (indexed.transparent >= 0) {
      const t = new Uint8Array(indexed.transparent + 1).fill(255);
      t[indexed.transparent] = 0;
      chunk('tRNS', t);
    }
    raw = new Uint8Array((w + 1) * h);
    for (let y = 0; y < h; y += 1) raw.set(indexed.indices.subarray(y * w, y * w + w), y * (w + 1) + 1);
  } else {
    const stride = w * 4;
    raw = new Uint8Array((stride + 1) * h);
    const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
    const d = img.data;
    for (let y = 0; y < h; y += 1) {
      const row = y * stride;
      const up = (y - 1) * stride;
      let best = 0;
      let bestSum = Infinity;
      for (let f = 0; f < 5; f += 1) {
        const c = cand[f];
        let sum = 0;
        for (let i = 0; i < stride; i += 1) {
          const x = d[row + i];
          const a = i >= 4 ? d[row + i - 4] : 0;
          const b = y ? d[up + i] : 0;
          const cc = i >= 4 && y ? d[up + i - 4] : 0;
          let v;
          if (f === 0) v = x;
          else if (f === 1) v = x - a;
          else if (f === 2) v = x - b;
          else if (f === 3) v = x - ((a + b) >> 1);
          else {
            const p = a + b - cc;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - cc);
            v = x - (pa <= pb && pa <= pc ? a : (pb <= pc ? b : cc));
          }
          v &= 255;
          c[i] = v;
          sum += v < 128 ? v : 256 - v;
        }
        if (sum < bestSum) {
          bestSum = sum;
          best = f;
        }
      }
      raw[y * (stride + 1)] = best;
      raw.set(cand[best], y * (stride + 1) + 1);
    }
  }
  chunk('IDAT', deflate(raw, level));
  chunk('IEND', new Uint8Array(0));
  return out.done();
}

const STD_LUM_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const STD_CHR_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
const DC_LUM = [[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const DC_CHR = [[0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const AC_LUM = [[0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa]];
const AC_CHR = [[0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa]];

function encTable([counts, symbols]) {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < counts[len - 1]; i += 1) {
      code[symbols[k]] = c;
      size[symbols[k]] = len;
      c += 1;
      k += 1;
    }
    c <<= 1;
  }
  return { code, size };
}
const ENC_TABLES = { dcl: encTable(DC_LUM), dcc: encTable(DC_CHR), acl: encTable(AC_LUM), acc: encTable(AC_CHR) };

/* Baseline JPEG, YCbCr 4:2:0. */
export function encodeJpeg(img, quality = 85) {
  const q = Math.max(1, Math.min(100, quality | 0));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  const qtab = (std) => std.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
  const ql = qtab(STD_LUM_Q);
  const qc = qtab(STD_CHR_Q);
  const { w, h, data } = img;
  const out = new Bytes(w * h + 2048);
  const marker = (m, body) => {
    out.byte(0xFF);
    out.byte(m);
    if (body) {
      out.byte(((body.length + 2) >> 8) & 255);
      out.byte((body.length + 2) & 255);
      out.bytes(body);
    }
  };
  marker(0xD8);
  marker(0xE0, new Uint8Array([0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const dqt = new Uint8Array(130);
  dqt[0] = 0;
  dqt[65] = 1;
  for (let k = 0; k < 64; k += 1) {
    dqt[1 + k] = ql[ZZ[k]];
    dqt[66 + k] = qc[ZZ[k]];
  }
  marker(0xDB, dqt);
  marker(0xC0, new Uint8Array([8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  const dht = [];
  for (const [cls, id, t] of [[0, 0, DC_LUM], [1, 0, AC_LUM], [0, 1, DC_CHR], [1, 1, AC_CHR]]) dht.push((cls << 4) | id, ...t[0], ...t[1]);
  marker(0xC4, new Uint8Array(dht));
  marker(0xDA, new Uint8Array([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]));
  let acc = 0;
  let nbits = 0;
  const put = (v, n) => {
    acc = (acc << n) | (v & ((1 << n) - 1));
    nbits += n;
    while (nbits >= 8) {
      const b = (acc >>> (nbits - 8)) & 255;
      out.byte(b);
      if (b === 0xFF) out.byte(0);
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;
  };
  const blk = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coded = new Int32Array(64);
  const preds = [0, 0, 0];
  const encodeBlock = (ci, qt, dc, ac) => {
    for (let u = 0; u < 8; u += 1) {
      for (let y = 0; y < 8; y += 1) {
        let s = 0;
        for (let x = 0; x < 8; x += 1) s += COS[x * 8 + u] * blk[y * 8 + x];
        tmp[y * 8 + u] = s;
      }
    }
    for (let v = 0; v < 8; v += 1) {
      for (let u = 0; u < 8; u += 1) {
        let s = 0;
        for (let y = 0; y < 8; y += 1) s += COS[y * 8 + v] * tmp[y * 8 + u];
        coded[v * 8 + u] = Math.round(s / qt[v * 8 + u]);
      }
    }
    const diff = coded[0] - preds[ci];
    preds[ci] = coded[0];
    const bitsOf = (v) => {
      let a = Math.abs(v);
      let n = 0;
      while (a) {
        n += 1;
        a >>= 1;
      }
      return n;
    };
    const vbits = (v, n) => (v >= 0 ? v : v + (1 << n) - 1);
    const ds = bitsOf(diff);
    put(dc.code[ds], dc.size[ds]);
    if (ds) put(vbits(diff, ds), ds);
    let run = 0;
    for (let k = 1; k < 64; k += 1) {
      const v = coded[ZZ[k]];
      if (!v) {
        run += 1;
        continue;
      }
      while (run > 15) {
        put(ac.code[0xF0], ac.size[0xF0]);
        run -= 16;
      }
      const s = bitsOf(v);
      const sym = (run << 4) | s;
      put(ac.code[sym], ac.size[sym]);
      put(vbits(v, s), s);
      run = 0;
    }
    if (run) put(ac.code[0], ac.size[0]);
  };
  const px = (x, y) => {
    const o = (Math.min(h - 1, y) * w + Math.min(w - 1, x)) * 4;
    const a = data[o + 3] / 255;
    /* transparent pixels on white */
    return [data[o] * a + 255 * (1 - a), data[o + 1] * a + 255 * (1 - a), data[o + 2] * a + 255 * (1 - a)];
  };
  for (let my = 0; my < h; my += 16) {
    for (let mx = 0; mx < w; mx += 16) {
      const cb = new Float64Array(64);
      const cr = new Float64Array(64);
      for (let by = 0; by < 2; by += 1) {
        for (let bx = 0; bx < 2; bx += 1) {
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) {
              const [r, g, b] = px(mx + bx * 8 + x, my + by * 8 + y);
              blk[y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
              const ci = ((by * 8 + y) >> 1) * 8 + ((bx * 8 + x) >> 1);
              cb[ci] += (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
              cr[ci] += (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
            }
          }
          encodeBlock(0, ql, ENC_TABLES.dcl, ENC_TABLES.acl);
        }
      }
      blk.set(cb);
      encodeBlock(1, qc, ENC_TABLES.dcc, ENC_TABLES.acc);
      blk.set(cr);
      encodeBlock(2, qc, ENC_TABLES.dcc, ENC_TABLES.acc);
    }
  }
  if (nbits) put(0x7F, 8 - nbits);
  marker(0xD9);
  return out.done();
}

/* ========== colors ========== */

/*
 * Median cut to at most n colors (pixels with alpha < 128 get their own transparent entry).
 * Gives { palette: [[r, g, b]], indices, transparent }.
 */
export function quantize(img, n = 256, { dither = false } = {}) {
  const { w, h, data } = img;
  const hist = new Uint32Array(32768);
  let hasAlpha = false;
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    if (data[o + 3] < 128) {
      hasAlpha = true;
      continue;
    }
    hist[((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3)] += 1;
  }
  const colors = [];
  for (let k = 0; k < 32768; k += 1) if (hist[k]) colors.push(k);
  const want = Math.max(1, n - (hasAlpha ? 1 : 0));
  let boxes = [colors];
  const ch = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  while (boxes.length < want) {
    let bi = -1;
    let bestRange = 0;
    let bestCh = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      if (boxes[i].length < 2) continue;
      for (let c = 0; c < 3; c += 1) {
        let lo = 31;
        let hi = 0;
        for (const k of boxes[i]) {
          const v = ch(k, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        let pop = 0;
        for (const k of boxes[i]) pop += hist[k];
        const score = (hi - lo) * Math.sqrt(pop);
        if (score > bestRange) {
          bestRange = score;
          bi = i;
          bestCh = c;
        }
      }
    }
    if (bi < 0) break;
    const box = boxes[bi].sort((a, b) => ch(a, bestCh) - ch(b, bestCh));
    let total = 0;
    for (const k of box) total += hist[k];
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += hist[box[i]];
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes = [...boxes.slice(0, bi), box.slice(0, cut), box.slice(cut), ...boxes.slice(bi + 1)];
  }
  const palette = boxes.filter((b) => b.length).map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let t = 0;
    for (const k of b) {
      const c = hist[k];
      r += ((k >> 10) * 8 + 4) * c;
      g += (((k >> 5) & 31) * 8 + 4) * c;
      bl += ((k & 31) * 8 + 4) * c;
      t += c;
    }
    return [Math.round(r / t), Math.round(g / t), Math.round(bl / t)];
  });
  if (!palette.length) palette.push([0, 0, 0]);
  const transparent = hasAlpha ? palette.length : -1;
  if (hasAlpha) palette.push([0, 0, 0]);
  const solid = hasAlpha ? palette.length - 1 : palette.length;
  const near = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (near[k] >= 0) return near[k];
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < solid; i += 1) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    near[k] = best;
    return best;
  };
  const indices = new Uint8Array(w * h);
  if (!dither) {
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 4;
      indices[i] = data[o + 3] < 128 ? transparent : nearest(data[o], data[o + 1], data[o + 2]);
    }
  } else {
    const err = new Float32Array((w + 2) * 2 * 3);
    for (let y = 0; y < h; y += 1) {
      const cur = (y & 1) * (w + 2) * 3;
      const nxt = ((y + 1) & 1) * (w + 2) * 3;
      err.fill(0, nxt, nxt + (w + 2) * 3);
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 4;
        if (data[o + 3] < 128) {
          indices[y * w + x] = transparent;
          continue;
        }
        const e = cur + (x + 1) * 3;
        const r = clamp8(data[o] + err[e]);
        const g = clamp8(data[o + 1] + err[e + 1]);
        const b = clamp8(data[o + 2] + err[e + 2]);
        const pi = nearest(r, g, b);
        indices[y * w + x] = pi;
        const p = palette[pi];
        const er = [r - p[0], g - p[1], b - p[2]];
        for (let c = 0; c < 3; c += 1) {
          err[e + 3 + c] += (er[c] * 7) / 16;
          err[nxt + x * 3 + c] += (er[c] * 3) / 16;
          err[nxt + (x + 1) * 3 + c] += (er[c] * 5) / 16;
          err[nxt + (x + 2) * 3 + c] += er[c] / 16;
        }
      }
    }
  }
  return { palette, indices, transparent };
}

/* Animated GIF: frames [{ img, delay (1/100 s) }], all the size of the first; one palette for all. */
export function encodeGif(frames, { loop = 0, dither = true } = {}) {
  const { w, h } = frames[0].img;
  /* the palette from a sample of every frame */
  const sample = newImage(w, Math.min(h * frames.length, 4096));
  const rowsPer = Math.max(1, Math.floor(sample.h / frames.length));
  frames.forEach((f, i) => {
    for (let r = 0; r < rowsPer && i * rowsPer + r < sample.h; r += 1) {
      const sy = Math.floor((r * h) / rowsPer);
      sample.data.set(f.img.data.subarray(sy * w * 4, sy * w * 4 + w * 4), (i * rowsPer + r) * w * 4);
    }
  });
  const base = quantize(sample, 256);
  const palette = base.palette.slice(0, 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const out = new Bytes(w * h * frames.length);
  out.ascii('GIF89a');
  out.u16le(w);
  out.u16le(h);
  out.byte(0xF7);
  out.byte(0);
  out.byte(0);
  for (const c of palette) out.bytes(new Uint8Array(c));
  out.bytes(new Uint8Array([0x21, 0xFF, 0x0B]));
  out.ascii('NETSCAPE2.0');
  out.bytes(new Uint8Array([3, 1, loop & 255, (loop >> 8) & 255, 0]));
  for (const f of frames) {
    const idx = mapToPalette(f.img, base, dither);
    out.bytes(new Uint8Array([0x21, 0xF9, 4, base.transparent >= 0 ? 0x09 : 0x08, f.delay & 255, (f.delay >> 8) & 255, Math.max(0, base.transparent), 0]));
    out.byte(0x2C);
    out.u16le(0);
    out.u16le(0);
    out.u16le(w);
    out.u16le(h);
    out.byte(0);
    out.byte(8);
    const lzw = lzwEncode(idx, 8);
    for (let i = 0; i < lzw.length; i += 255) {
      const n = Math.min(255, lzw.length - i);
      out.byte(n);
      out.bytes(lzw.subarray(i, i + n));
    }
    out.byte(0);
  }
  out.byte(0x3B);
  return out.done();
}

function mapToPalette(img, q, dither) {
  const solid = q.transparent >= 0 ? q.palette.length - 1 : q.palette.length;
  const near = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (near[k] >= 0) return near[k];
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < solid; i += 1) {
      const p = q.palette[i];
      const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    near[k] = best;
    return best;
  };
  const { w, h, data } = img;
  const out = new Uint8Array(w * h);
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 128 && q.transparent >= 0) {
        out[y * w + x] = q.transparent;
        continue;
      }
      const t = dither ? (bayer[(y & 3) * 4 + (x & 3)] - 7.5) * 1.6 : 0;
      out[y * w + x] = nearest(clamp8(data[o] + t), clamp8(data[o + 1] + t), clamp8(data[o + 2] + t));
    }
  }
  return out;
}

function lzwEncode(indices, minCode) {
  const out = new Bytes(indices.length);
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let next = eoi + 1;
  let dict = new Map();
  let acc = 0;
  let n = 0;
  const emit = (code) => {
    acc |= code << n;
    n += size;
    while (n >= 8) {
      out.byte(acc & 255);
      acc >>>= 8;
      n -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      if (next === 1 << size && size < 12) size += 1;
      next += 1;
    } else {
      emit(clear);
      dict = new Map();
      size = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (n > 0) out.byte(acc & 255);
  return out.done();
}

/* ========== operations ========== */

/* Area average when shrinking, bilinear when growing. */
export function resize(img, nw, nh) {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  const out = newImage(nw, nh);
  const { w, h, data } = img;
  const d = out.data;
  if (nw <= w && nh <= h) {
    const sx = w / nw;
    const sy = h / nh;
    for (let y = 0; y < nh; y += 1) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < nw; x += 1) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let c = 0;
        for (let yy = y0; yy < y1; yy += 1) {
          for (let xx = x0; xx < x1; xx += 1) {
            const o = (yy * w + xx) * 4;
            const al = data[o + 3];
            r += data[o] * al;
            g += data[o + 1] * al;
            b += data[o + 2] * al;
            a += al;
            c += 1;
          }
        }
        const o = (y * nw + x) * 4;
        if (a) {
          d[o] = Math.round(r / a);
          d[o + 1] = Math.round(g / a);
          d[o + 2] = Math.round(b / a);
        }
        d[o + 3] = Math.round(a / c);
      }
    }
    return out;
  }
  for (let y = 0; y < nh; y += 1) {
    const fy = Math.max(0, Math.min(h - 1, ((y + 0.5) * h) / nh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < nw; x += 1) {
      const fx = Math.max(0, Math.min(w - 1, ((x + 0.5) * w) / nw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * nw + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const a = data[(y0 * w + x0) * 4 + c] * (1 - tx) + data[(y0 * w + x1) * 4 + c] * tx;
        const b = data[(y1 * w + x0) * 4 + c] * (1 - tx) + data[(y1 * w + x1) * 4 + c] * tx;
        d[o + c] = Math.round(a * (1 - ty) + b * ty);
      }
    }
  }
  return out;
}

/* Scales so the longer side is `max` (only down unless grow). */
export function fit(img, max, grow = false) {
  const k = max / Math.max(img.w, img.h);
  if (k >= 1 && !grow) return img;
  return resize(img, img.w * k, img.h * k);
}

export function rotate(img, deg) {
  const { w, h, data } = img;
  const turns = (((deg / 90) % 4) + 4) % 4;
  if (!turns) return img;
  const out = turns === 2 ? newImage(w, h) : newImage(h, w);
  const d = out.data;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let nx;
      let ny;
      if (turns === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      d.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * out.w + nx) * 4);
    }
  }
  return out;
}

export function flip(img, horizontal = true) {
  const { w, h, data } = img;
  const out = newImage(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = horizontal ? w - 1 - x : x;
      const sy = horizontal ? y : h - 1 - y;
      out.data.set(data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return out;
}

function perPixel(img, fn) {
  const out = newImage(img.w, img.h);
  const s = img.data;
  const d = out.data;
  for (let o = 0; o < s.length; o += 4) {
    const [r, g, b] = fn(s[o], s[o + 1], s[o + 2]);
    d[o] = clamp8(r);
    d[o + 1] = clamp8(g);
    d[o + 2] = clamp8(b);
    d[o + 3] = s[o + 3];
  }
  return out;
}

export const gray = (img) => perPixel(img, (r, g, b) => {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [y, y, y];
});
export const invert = (img) => perPixel(img, (r, g, b) => [255 - r, 255 - g, 255 - b]);
export const sepia = (img) => perPixel(img, (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b]);

/* Three box blurs ≈ a Gaussian of radius r. */
export function blur(img, r = 0) {
  const radius = Math.max(1, Math.round(r || Math.max(img.w, img.h) / 120));
  let cur = img;
  const pass = (src, horizontal) => {
    const { w, h, data } = src;
    const out = newImage(w, h);
    const d = out.data;
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let l = 0; l < lines; l += 1) {
      const idx = (i) => (horizontal ? (l * w + i) * 4 : (i * w + l) * 4);
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let i = -radius; i <= radius; i += 1) sum += data[idx(Math.max(0, Math.min(len - 1, i))) + c];
        for (let i = 0; i < len; i += 1) {
          d[idx(i) + c] = Math.round(sum / (2 * radius + 1));
          sum += data[idx(Math.min(len - 1, i + radius + 1)) + c] - data[idx(Math.max(0, i - radius)) + c];
        }
      }
    }
    return out;
  };
  for (let k = 0; k < 3; k += 1) cur = pass(pass(cur, true), false);
  return cur;
}

export function pixelate(img, size = 0) {
  const s = Math.max(2, size || Math.round(Math.max(img.w, img.h) / 48));
  const small = resize(img, Math.max(1, img.w / s), Math.max(1, img.h / s));
  const out = newImage(img.w, img.h);
  for (let y = 0; y < img.h; y += 1) {
    const sy = Math.min(small.h - 1, Math.floor((y * small.h) / img.h));
    for (let x = 0; x < img.w; x += 1) {
      const sx = Math.min(small.w - 1, Math.floor((x * small.w) / img.w));
      out.data.set(small.data.subarray((sy * small.w + sx) * 4, (sy * small.w + sx) * 4 + 4), (y * img.w + x) * 4);
    }
  }
  return out;
}

/* A centered square crop with everything outside the circle transparent (soft edge). */
export function circle(img) {
  const s = Math.min(img.w, img.h);
  const out = newImage(s, s);
  const ox = Math.floor((img.w - s) / 2);
  const oy = Math.floor((img.h - s) / 2);
  const rad = s / 2;
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const so = ((y + oy) * img.w + x + ox) * 4;
      const o = (y * s + x) * 4;
      out.data.set(img.data.subarray(so, so + 4), o);
      const dist = Math.hypot(x + 0.5 - rad, y + 0.5 - rad);
      const a = Math.max(0, Math.min(1, rad - dist));
      out.data[o + 3] = Math.round(out.data[o + 3] * a);
    }
  }
  return out;
}

/* Pads to a square on `bg` (default white). */
export function square(img, bg = [255, 255, 255, 255]) {
  const s = Math.max(img.w, img.h);
  const out = newImage(s, s);
  for (let i = 0; i < s * s; i += 1) out.data.set(bg, i * 4);
  const ox = Math.floor((s - img.w) / 2);
  const oy = Math.floor((s - img.h) / 2);
  for (let y = 0; y < img.h; y += 1) out.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((y + oy) * s + ox) * 4);
  return out;
}

/* ========== qr (QR codes) ========== */

export const qr = (() => {
  const ECL = { L: { f: 1, i: 0 }, M: { f: 0, i: 1 }, Q: { f: 3, i: 2 }, H: { f: 2, i: 3 } };
  /* per version 1–40, per level L M Q H */
  const ECC_PER_BLOCK = [
    [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const BLOCKS = [
    [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 256) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  }
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

  const rawModules = (ver) => {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  };
  const dataCodewords = (ver, e) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e][ver - 1] * BLOCKS[e][ver - 1];
  const alignPositions = (ver) => {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let p = ver * 4 + 10; out.length < n; p -= step) out.splice(1, 0, p);
    return out;
  };
  const generator = (deg) => {
    const g = new Uint8Array(deg);
    g[deg - 1] = 1;
    let root = 1;
    for (let i = 0; i < deg; i += 1) {
      for (let j = 0; j < deg; j += 1) {
        g[j] = mul(g[j], root);
        if (j + 1 < deg) g[j] ^= g[j + 1];
      }
      root = mul(root, 2);
    }
    return g;
  };
  const remainder = (data, g) => {
    const r = new Uint8Array(g.length);
    for (const b of data) {
      const f = b ^ r[0];
      r.copyWithin(0, 1);
      r[r.length - 1] = 0;
      for (let i = 0; i < g.length; i += 1) r[i] ^= mul(g[i], f);
    }
    return r;
  };
  const formatWord = (e, mask) => {
    const data = (ECL[e].f << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  };
  const versionWord = (ver) => {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (ver << 12) | rem;
  };

  /* The function patterns of a version: { size, fn (1 = function module), dark (their colors) }. */
  function layout(ver) {
    const size = ver * 4 + 17;
    const fn = new Uint8Array(size * size);
    const dark = new Uint8Array(size * size);
    const set = (x, y, v) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      fn[y * size + x] = 1;
      dark[y * size + x] = v ? 1 : 0;
    };
    for (let i = 0; i < size; i += 1) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    const al = alignPositions(ver);
    for (let i = 0; i < al.length; i += 1) {
      for (let j = 0; j < al.length; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    /* format areas (reserved) and the dark module */
    for (let i = 0; i <= 8; i += 1) {
      if (!fn[8 * size + i]) set(i, 8, 0);
      if (!fn[i * size + 8]) set(8, i, 0);
    }
    for (let i = 0; i < 8; i += 1) {
      set(size - 1 - i, 8, 0);
      set(8, size - 1 - i, 0);
    }
    set(8, size - 8, 1);
    if (ver >= 7) {
      const vw = versionWord(ver);
      for (let i = 0; i < 18; i += 1) {
        const b = (vw >>> i) & 1;
        const a = size - 11 + (i % 3);
        const c = Math.floor(i / 3);
        set(a, c, b);
        set(c, a, b);
      }
    }
    return { size, fn, dark };
  }
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const zigzag = (size, fn, visit) => {
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? size - 1 - vert : vert;
          if (!fn[y * size + x]) visit(x, y, i++);
        }
      }
    }
  };
  const formatCells = (size) => {
    const a = [];
    const b = [];
    for (let i = 0; i <= 5; i += 1) a.push([8, i]);
    a.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i += 1) a.push([14 - i, 8]);
    for (let i = 0; i < 8; i += 1) b.push([size - 1 - i, 8]);
    for (let i = 8; i < 15; i += 1) b.push([8, size - 15 + i]);
    return [a, b];
  };
  const blocksOf = (ver, e) => {
    const nb = BLOCKS[e][ver - 1];
    const ecc = ECC_PER_BLOCK[e][ver - 1];
    const raw = Math.floor(rawModules(ver) / 8);
    const shortLen = Math.floor(raw / nb);
    const numShort = nb - (raw % nb);
    return { nb, ecc, raw, shortLen, numShort };
  };
  const charBits = (mode, ver) => {
    const t = ver <= 9 ? 0 : (ver <= 26 ? 1 : 2);
    return { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16], 8: [8, 10, 12] }[mode][t];
  };

  /* Text → { size, modules (Uint8Array, 1 = dark) }. Byte mode (UTF-8). */
  function encode(text, level = 'M') {
    const e = ECL[level] ? ECL[level].i : 1;
    const lv = ECL[level] ? level : 'M';
    const bytes = [];
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else bytes.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    let ver = 1;
    for (; ver <= 40; ver += 1) if (4 + charBits(4, ver) + bytes.length * 8 <= dataCodewords(ver, e) * 8) break;
    if (ver > 40) throw new Error('qr: too long');
    const cap = dataCodewords(ver, e) * 8;
    const bits = [];
    const push = (v, n) => {
      for (let i = n - 1; i >= 0; i -= 1) bits.push((v >>> i) & 1);
    };
    push(4, 4);
    push(bytes.length, charBits(4, ver));
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, cap - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const data = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i += 1) data[i >>> 3] |= bits[i] << (7 - (i & 7));
    const { nb, ecc, raw, shortLen, numShort } = blocksOf(ver, e);
    const g = generator(ecc);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i += 1) {
      const len = shortLen - ecc + (i < numShort ? 0 : 1);
      const dat = data.slice(k, k + len);
      k += len;
      blocks.push([...dat, ...(i < numShort ? [0] : []), ...remainder(dat, g)]);
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i += 1) {
      for (let j = 0; j < blocks.length; j += 1) if (i !== shortLen - ecc || j >= numShort) all.push(blocks[j][i]);
    }
    if (all.length !== raw) throw new Error('qr: internal size');
    const { size, fn, dark } = layout(ver);
    const base = dark.slice();
    zigzag(size, fn, (x, y, i) => {
      if (i < all.length * 8) base[y * size + x] = (all[i >>> 3] >>> (7 - (i & 7))) & 1;
    });
    let best = null;
    let bestPenalty = Infinity;
    for (let m = 0; m < 8; m += 1) {
      const mod = base.slice();
      for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fn[y * size + x] && MASKS[m](x, y)) mod[y * size + x] ^= 1;
      const fw = formatWord(lv, m);
      const [ca, cb] = formatCells(size);
      for (let i = 0; i < 15; i += 1) {
        mod[ca[i][1] * size + ca[i][0]] = (fw >>> i) & 1;
        mod[cb[i][1] * size + cb[i][0]] = (fw >>> i) & 1;
      }
      const p = penalty(mod, size);
      if (p < bestPenalty) {
        bestPenalty = p;
        best = mod;
      }
    }
    return { size, version: ver, modules: best };
  }

  /* The mask penalty (rules 1–4 of the standard, rule 3 simplified); any mask is valid, this only picks the cleanest. */
  function penalty(m, size) {
    let p = 0;
    const at = (x, y) => m[y * size + x];
    for (let pass = 0; pass < 2; pass += 1) {
      for (let a = 0; a < size; a += 1) {
        let run = 0;
        let prev = -1;
        let line = '';
        for (let b = 0; b < size; b += 1) {
          const c = pass ? at(a, b) : at(b, a);
          line += c;
          if (c === prev) {
            run += 1;
            if (run === 5) p += 3;
            else if (run > 5) p += 1;
          } else {
            prev = c;
            run = 1;
          }
        }
        for (let i = line.indexOf('1011101'); i >= 0; i = line.indexOf('1011101', i + 1)) {
          if (line.slice(Math.max(0, i - 4), i) === '0000' || line.slice(i + 7, i + 11) === '0000') p += 40;
        }
      }
    }
    for (let y = 0; y + 1 < size; y += 1) for (let x = 0; x + 1 < size; x += 1) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p += 3;
    }
    let darkN = 0;
    for (const v of m) darkN += v;
    p += Math.floor(Math.abs(darkN * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  }

  /* Draws a code: `scale` pixels per module and a quiet zone of `margin` modules. */
  function render(code, scale = 8, margin = 4) {
    const n = (code.size + margin * 2) * scale;
    const img = newImage(n, n);
    img.data.fill(255);
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        if (!code.modules[y * code.size + x]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          const row = ((y + margin) * scale + dy) * n;
          for (let dx = 0; dx < scale; dx += 1) {
            const o = (row + (x + margin) * scale + dx) * 4;
            img.data[o] = 0;
            img.data[o + 1] = 0;
            img.data[o + 2] = 0;
          }
        }
      }
    }
    return img;
  }

  /* ---------- decoding ---------- */

  /* Reed–Solomon: corrects `cw` (data + ecc) in place; false when it can't. */
  function correct(cw, ecc) {
    const n = cw.length;
    const synd = new Uint8Array(ecc);
    let bad = false;
    for (let i = 0; i < ecc; i += 1) {
      let s = 0;
      const a = EXP[i];
      for (let k = 0; k < n; k += 1) s = mul(s, a) ^ cw[k];
      synd[i] = s;
      if (s) bad = true;
    }
    if (!bad) return true;
    let C = [1];
    let B = [1];
    let L = 0;
    let m = 1;
    let b = 1;
    for (let r = 0; r < ecc; r += 1) {
      let d = synd[r];
      for (let i = 1; i <= L; i += 1) d ^= mul(C[i] || 0, synd[r - i]);
      if (!d) {
        m += 1;
        continue;
      }
      const T = C.slice();
      const coef = div(d, b);
      const need = B.length + m;
      while (C.length < need) C.push(0);
      for (let i = 0; i < B.length; i += 1) C[i + m] ^= mul(coef, B[i]);
      if (2 * L <= r) {
        L = r + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else m += 1;
    }
    if (L * 2 > ecc) return false;
    const pos = [];
    for (let i = 0; i < n; i += 1) {
      const xinv = EXP[(255 - (n - 1 - i)) % 255];
      let v = 0;
      for (let k = C.length - 1; k >= 0; k -= 1) v = mul(v, xinv) ^ C[k];
      if (!v) pos.push(i);
    }
    if (pos.length !== L) return false;
    const omega = new Uint8Array(ecc);
    for (let i = 0; i < ecc; i += 1) {
      let v = 0;
      for (let j = 0; j <= i && j < C.length; j += 1) v ^= mul(C[j], synd[i - j]);
      omega[i] = v;
    }
    for (const i of pos) {
      const xpow = (n - 1 - i) % 255;
      const xinv = EXP[(255 - xpow) % 255];
      let num = 0;
      for (let k = ecc - 1; k >= 0; k -= 1) num = mul(num, xinv) ^ omega[k];
      let den = 0;
      for (let k = 1; k < C.length; k += 2) {
        let t = C[k];
        for (let q = 0; q < k - 1; q += 1) t = mul(t, xinv);
        den ^= t;
      }
      if (!den) return false;
      cw[i] ^= mul(EXP[xpow], div(num, den));
    }
    for (let i = 0; i < ecc; i += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s = mul(s, EXP[i]) ^ cw[k];
      if (s) return false;
    }
    return true;
  }

  /* Reads the data of a sampled grid (1 = dark). Gives the text or null. */
  function readGrid(grid, size) {
    const ver = (size - 17) / 4;
    if (!Number.isInteger(ver) || ver < 1 || ver > 40) return null;
    const [ca, cb] = formatCells(size);
    const read = (cells) => cells.reduce((v, [x, y], i) => v | (grid[y * size + x] << i), 0);
    const fa = read(ca);
    const fb = read(cb);
    let fmt = null;
    let bestD = 4;
    for (const lv of ['L', 'M', 'Q', 'H']) {
      for (let mk = 0; mk < 8; mk += 1) {
        const w = formatWord(lv, mk);
        for (const got of [fa, fb]) {
          let d = 0;
          for (let x = w ^ got; x; x &= x - 1) d += 1;
          if (d < bestD) {
            bestD = d;
            fmt = { lv, mk };
          }
        }
      }
    }
    if (!fmt) return null;
    const e = ECL[fmt.lv].i;
    const { fn } = layout(ver);
    const { nb, ecc, raw, shortLen, numShort } = blocksOf(ver, e);
    const all = new Uint8Array(raw);
    zigzag(size, fn, (x, y, i) => {
      if (i >= raw * 8) return;
      const bit = grid[y * size + x] ^ (MASKS[fmt.mk](x, y) ? 1 : 0);
      if (bit) all[i >>> 3] |= 1 << (7 - (i & 7));
    });
    const blocks = [];
    for (let j = 0; j < nb; j += 1) blocks.push([]);
    let k = 0;
    for (let i = 0; i < shortLen + 1; i += 1) {
      for (let j = 0; j < nb; j += 1) {
        if (i === shortLen - ecc && j < numShort) continue;
        if (k < raw) blocks[j].push(all[k++]);
      }
    }
    const data = [];
    for (let j = 0; j < nb; j += 1) {
      const cw = Uint8Array.from(blocks[j]);
      if (!correct(cw, ecc)) return null;
      const dlen = cw.length - ecc;
      for (let i = 0; i < dlen; i += 1) data.push(cw[i]);
    }
    let bit = 0;
    const take = (n) => {
      let v = 0;
      for (let i = 0; i < n; i += 1) {
        const b = bit >>> 3;
        v = (v << 1) | (b < data.length ? (data[b] >>> (7 - (bit & 7))) & 1 : 0);
        bit += 1;
      }
      return v;
    };
    const parts = [];
    const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
    while (bit + 4 <= data.length * 8) {
      const mode = take(4);
      if (mode === 0) break;
      if (mode === 7) {
        const first = take(8);
        if ((first & 0x80) === 0) continue;
        if ((first & 0xC0) === 0x80) take(8);
        else take(16);
        continue;
      }
      if (![1, 2, 4].includes(mode)) break;
      const count = take(charBits(mode, ver));
      if (mode === 1) {
        let s = '';
        let left = count;
        while (left >= 3) {
          s += String(take(10)).padStart(3, '0');
          left -= 3;
        }
        if (left === 2) s += String(take(7)).padStart(2, '0');
        else if (left === 1) s += String(take(4));
        parts.push(s);
      } else if (mode === 2) {
        let s = '';
        let left = count;
        while (left >= 2) {
          const v = take(11);
          s += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
          left -= 2;
        }
        if (left) s += ALNUM[take(6)];
        parts.push(s);
      } else {
        const b = new Uint8Array(count);
        for (let i = 0; i < count; i += 1) b[i] = take(8);
        let s;
        try {
          s = utf8Text(b);
        } catch {
          s = String.fromCharCode(...b);
        }
        parts.push(s);
      }
    }
    return parts.join('');
  }

  /* Dark/light per pixel, thresholded against the local mean (works for screenshots and photos). */
  function binarize(img) {
    const { w, h, data } = img;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 4;
      const a = data[o + 3] / 255;
      lum[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) * a + 255 * (1 - a);
    }
    const ii = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y += 1) {
      let row = 0;
      for (let x = 0; x < w; x += 1) {
        row += lum[y * w + x];
        ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
      }
    }
    const r = Math.max(4, Math.round(Math.min(w, h) / 16));
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const sum = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const v = lum[y * w + x];
        bin[y * w + x] = v < mean - 4 || v < 60 ? 1 : 0;
      }
    }
    return bin;
  }

  /* runs of 1:1:3:1:1 (finder) or 1:1:1 (alignment) within tolerance */
  const ratioOk = (runs, ratio, slack = 0.6) => {
    const total = runs.reduce((a, b) => a + b, 0);
    const units = ratio.reduce((a, b) => a + b, 0);
    if (total < units) return false;
    const m = total / units;
    return runs.every((v, i) => Math.abs(v - ratio[i] * m) <= m * slack * (ratio[i] === 3 ? 2.5 : 1) + 0.5);
  };

  /* Five runs (dark, light, dark, light, dark) through (cx, cy) along (dx, dy); null if the pattern doesn't fit. */
  function crossRuns(bin, w, h, cx, cy, dx, dy, maxRun) {
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : bin[y * w + x]);
    if (at(cx, cy) !== 1) return null;
    const side = (sx, sy) => {
      const runs = [0, 0, 0];
      const colors = [1, 0, 1];
      let x = cx;
      let y = cy;
      let state = 0;
      for (;;) {
        const v = at(x, y);
        if (v === colors[state]) {
          runs[state] += 1;
          if (runs[state] > maxRun) return null;
          x += sx;
          y += sy;
        } else if (state < 2 && v !== -1) state += 1;
        else if (state === 2 && runs[2] > 0) return runs;
        else return null;
      }
    };
    const a = side(-dx, -dy);
    const b = side(dx, dy);
    if (!a || !b) return null;
    return { runs: [a[2], a[1], a[0] + b[0] - 1, b[1], b[2]], center: (b[0] - a[0]) / 2 };
  }

  function findFinders(bin, w, h) {
    const found = [];
    const step = Math.max(1, Math.floor(h / 400));
    for (let y = 0; y < h; y += step) {
      const runs = [];
      let start = 0;
      for (let x = 1; x <= w; x += 1) {
        if (x === w || bin[y * w + x] !== bin[y * w + start]) {
          runs.push({ c: bin[y * w + start], len: x - start, start });
          start = x;
        }
      }
      for (let i = 0; i + 4 < runs.length; i += 1) {
        if (runs[i].c !== 1) continue;
        const five = runs.slice(i, i + 5).map((r) => r.len);
        if (!ratioOk(five, [1, 1, 3, 1, 1])) continue;
        const total = five.reduce((a, b) => a + b, 0);
        const cx = Math.round(runs[i + 2].start + runs[i + 2].len / 2 - 0.5);
        const vr = crossRuns(bin, w, h, cx, y, 0, 1, total);
        if (!vr || !ratioOk(vr.runs, [1, 1, 3, 1, 1])) continue;
        const cy = Math.round(y + vr.center);
        const hr = crossRuns(bin, w, h, cx, cy, 1, 0, total * 2);
        if (!hr || !ratioOk(hr.runs, [1, 1, 3, 1, 1])) continue;
        const dr = crossRuns(bin, w, h, Math.round(cx + hr.center), cy, 1, 1, total * 2);
        if (!dr || !ratioOk(dr.runs, [1, 1, 3, 1, 1], 0.8)) continue;
        const fx = cx + hr.center + 0.5;
        const fy = cy + 0.5;
        const m = (hr.runs.reduce((a, b) => a + b, 0) + vr.runs.reduce((a, b) => a + b, 0)) / 14;
        const near = found.find((f) => Math.hypot(f.x - fx, f.y - fy) < f.m * 3 && Math.abs(f.m - m) < f.m * 0.8);
        if (near) {
          near.x = (near.x * near.n + fx) / (near.n + 1);
          near.y = (near.y * near.n + fy) / (near.n + 1);
          near.m = (near.m * near.n + m) / (near.n + 1);
          near.n += 1;
        } else found.push({ x: fx, y: fy, m, n: 1 });
      }
    }
    return found.sort((a, b) => b.n - a.n).slice(0, 12);
  }

  /* Perspective transforms (zxing's method): square ↔ quad, then quad → quad. */
  function squareToQuad(p) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    const dx3 = x0 - x1 + x2 - x3;
    const dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    const a13 = (dx3 * dy2 - dx2 * dy3) / den;
    const a23 = (dx1 * dy3 - dx3 * dy1) / den;
    return [x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0, y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0, a13, a23, 1];
  }
  const adjoint = ([a11, a21, a31, a12, a22, a32, a13, a23, a33]) => [a22 * a33 - a23 * a32, a23 * a31 - a21 * a33, a21 * a32 - a22 * a31,
    a13 * a32 - a12 * a33, a11 * a33 - a13 * a31, a12 * a31 - a11 * a32, a12 * a23 - a13 * a22, a13 * a21 - a11 * a23, a11 * a22 - a12 * a21];
  const times = (a, o) => {
    const [a11, a21, a31, a12, a22, a32, a13, a23, a33] = a;
    const [b11, b21, b31, b12, b22, b32, b13, b23, b33] = o;
    return [a11 * b11 + a21 * b12 + a31 * b13, a11 * b21 + a21 * b22 + a31 * b23, a11 * b31 + a21 * b32 + a31 * b33,
      a12 * b11 + a22 * b12 + a32 * b13, a12 * b21 + a22 * b22 + a32 * b23, a12 * b31 + a22 * b32 + a32 * b33,
      a13 * b11 + a23 * b12 + a33 * b13, a13 * b21 + a23 * b22 + a33 * b23, a13 * b31 + a23 * b32 + a33 * b33];
  };
  const quadToQuad = (src, dst) => times(squareToQuad(dst), adjoint(squareToQuad(src)));
  const apply = (t, x, y) => {
    const den = t[6] * x + t[7] * y + t[8];
    return [(t[0] * x + t[1] * y + t[2]) / den, (t[3] * x + t[4] * y + t[5]) / den];
  };

  /* Samples every module's center; src: the four reference points in module coordinates, dst: in the image. */
  function sampleGrid(bin, w, h, size, src, dst) {
    const t = quadToQuad(src, dst);
    const grid = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const [px, py] = apply(t, x + 0.5, y + 0.5);
        const ix = Math.floor(px);
        const iy = Math.floor(py);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
        grid[y * size + x] = bin[iy * w + ix];
      }
    }
    return grid;
  }

  function findAlignment(bin, w, h, ex, ey, m) {
    const r = Math.max(3, Math.round(m * 4));
    let best = null;
    for (let y = Math.max(0, Math.round(ey - r)); y <= Math.min(h - 1, Math.round(ey + r)); y += 1) {
      for (let x = Math.max(0, Math.round(ex - r)); x <= Math.min(w - 1, Math.round(ex + r)); x += 1) {
        if (bin[y * w + x] !== 1) continue;
        const hr = crossRuns(bin, w, h, x, y, 1, 0, Math.ceil(m * 2.2));
        if (!hr || !ratioOk(hr.runs.slice(1, 4), [1, 1, 1], 0.7)) continue;
        const vr = crossRuns(bin, w, h, x, y, 0, 1, Math.ceil(m * 2.2));
        if (!vr || !ratioOk(vr.runs.slice(1, 4), [1, 1, 1], 0.7)) continue;
        const cx = x + hr.center + 0.5;
        const cy = y + vr.center + 0.5;
        const d = Math.hypot(cx - ex, cy - ey);
        if (!best || d < best.d) best = { x: cx, y: cy, d };
      }
    }
    return best;
  }

  /* Image → the text of a QR code in it, or null. */
  function decode(img) {
    const { w, h } = img;
    const bin = binarize(img);
    const cands = findFinders(bin, w, h);
    if (cands.length < 3) return null;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const tries = [];
    for (let i = 0; i < cands.length; i += 1) for (let j = i + 1; j < cands.length; j += 1) for (let k = j + 1; k < cands.length; k += 1) {
      const pts = [cands[i], cands[j], cands[k]];
      const ms = pts.map((p) => p.m);
      if (Math.max(...ms) > Math.min(...ms) * 1.6) continue;
      const opp = [dist(pts[1], pts[2]), dist(pts[0], pts[2]), dist(pts[0], pts[1])];
      const ci = opp.indexOf(Math.max(...opp));
      const corner = pts[ci];
      const others = pts.filter((_, n) => n !== ci);
      const l1 = dist(corner, others[0]);
      const l2 = dist(corner, others[1]);
      if (Math.max(l1, l2) > Math.min(l1, l2) * 1.4) continue;
      if (Math.abs(opp[ci] - Math.hypot(l1, l2)) > opp[ci] * 0.15) continue;
      if (Math.min(l1, l2) < 7 * Math.min(...ms)) continue;
      /* how far from a right isosceles triangle of equal finders (smaller is better) */
      const err = Math.abs(l1 - l2) / Math.max(l1, l2) + Math.abs(opp[ci] - Math.hypot(l1, l2)) / opp[ci] + (Math.max(...ms) - Math.min(...ms)) / Math.max(...ms);
      tries.push({ pts: [corner, ...others], err });
    }
    tries.sort((a, b) => a.err - b.err);
    for (const tri of tries.slice(0, 8)) {
      const [tl, a, b] = tri.pts;
      const cross = (a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x);
      const tr = cross > 0 ? a : b;
      const bl = cross > 0 ? b : a;
      const m = (tl.m + tr.m + bl.m) / 3;
      const est = (dist(tr, tl) + dist(bl, tl)) / 2 / m + 7;
      const v0 = Math.round((est - 17) / 4);
      for (const ver of [v0, v0 - 1, v0 + 1, v0 - 2, v0 + 2]) {
        if (ver < 1 || ver > 40) continue;
        const size = ver * 4 + 17;
        const s1 = size - 3.5;
        const candidates = [];
        if (ver >= 2) {
          const k = (size - 10) / (size - 7);
          const ex = tl.x + (tr.x - tl.x) * k + (bl.x - tl.x) * k;
          const ey = tl.y + (tr.y - tl.y) * k + (bl.y - tl.y) * k;
          const ap = findAlignment(bin, w, h, ex, ey, m);
          if (ap) candidates.push([[3.5, 3.5, s1, 3.5, size - 6.5, size - 6.5, 3.5, s1], [tl.x, tl.y, tr.x, tr.y, ap.x, ap.y, bl.x, bl.y]]);
        }
        candidates.push([[3.5, 3.5, s1, 3.5, s1, s1, 3.5, s1], [tl.x, tl.y, tr.x, tr.y, tr.x + bl.x - tl.x, tr.y + bl.y - tl.y, bl.x, bl.y]]);
        for (const [src, dst] of candidates) {
          const grid = sampleGrid(bin, w, h, size, src, dst);
          if (!grid) continue;
          const text = readGrid(grid, size);
          if (text !== null && text !== '') return text;
        }
      }
    }
    return null;
  }

  return { encode, render, decode, readGrid, correct, layout };
})();
