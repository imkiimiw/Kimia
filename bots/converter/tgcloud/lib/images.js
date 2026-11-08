// Image headers without decoding (JPEG / PNG → PDF needs size, orientation, megapixels). Pure.

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

/** EXIF orientation (1–8) from an APP1 segment, or 1. */
function exifOrientation(b, start, len) {
  if (String.fromCharCode(...b.subarray(start, start + 4)) !== 'Exif') return 1;
  const t = start + 6;
  const le = b[t] === 0x49;
  const r16 = (o) => (le ? b[o] | (b[o + 1] << 8) : u16be(b, o));
  const r32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : u32be(b, o));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > start + len) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= start + len; i++) {
    const e = ifd + 2 + i * 12;
    if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}

/** → { width, height, components, orientation, progressive } | null */
export function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  let orientation = 1;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { p += m === 0xff ? 1 : 2; continue; }
    const len = u16be(b, p + 2);
    if (m === 0xe1 && orientation === 1) orientation = exifOrientation(b, p + 4, len - 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) {
      if (p + 9 >= b.length) return null;
      return { height: u16be(b, p + 5), width: u16be(b, p + 7), components: b[p + 9], orientation, progressive: m === 0xc2 };
    }
    if (m === 0xda || m === 0xd9) return null; // scan started before any frame header: broken
    p += 2 + len;
  }
  return null;
}

/** → { width, height, bitDepth, colorType, interlace } | null */
export function pngInfo(b) {
  if (b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50 || String.fromCharCode(...b.subarray(12, 16)) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20), bitDepth: b[24], colorType: b[25], interlace: b[28] };
}

/**
 * The PDF transformation matrix [a b c d e f] that draws an image (unit square) into the box
 * (x, y, dw, dh) the way its EXIF orientation says it should be seen. For 5–8 the box is the
 * rotated (displayed) size.
 */
export function orientationMatrix(o, x, y, dw, dh) {
  switch (o) {
    case 2: return [-dw, 0, 0, dh, x + dw, y];
    case 3: return [-dw, 0, 0, -dh, x + dw, y + dh];
    case 4: return [dw, 0, 0, -dh, x, y + dh];
    case 5: return [0, -dh, -dw, 0, x + dw, y + dh];
    case 6: return [0, -dh, dw, 0, x, y + dh];
    case 7: return [0, dh, dw, 0, x, y];
    case 8: return [0, dh, -dw, 0, x + dw, y];
    default: return [dw, 0, 0, dh, x, y];
  }
}

/** Displayed size after orientation (5–8 swap width and height). */
export const displayed = (w, h, o) => (o >= 5 && o <= 8 ? [h, w] : [w, h]);
