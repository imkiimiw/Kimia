// Screenshot to pack (brief §9): find the separate stickers in one image (pure: works on RGBA
// arrays, so it runs in tests too).
// - With transparency: connected components of the alpha channel.
// - Without: estimate the background from the border pixels, threshold the colour distance, close
//   small gaps (dilate → erode), then connected components.
// The mask is analysed at ≤ 512 px for speed; boxes come back in source pixels, padded, in reading
// order (rows top to bottom, then left to right), tiny specks dropped and overlapping boxes merged.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitOptions {
  maxSide?: number; // analysis size (default 512)
  minAreaFrac?: number; // drop components smaller than this share of the image (default 0.004)
  threshold?: number; // colour distance from the background (0–441, default 48)
  padFrac?: number; // padding around each box, share of its size (default 0.04)
  maxBoxes?: number; // default 30 (a WhatsApp pack's maximum)
}

/** True when at least 1 % of the pixels are clearly transparent. */
export function hasTransparency(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): boolean {
  let n = 0;
  const need = Math.max(1, Math.floor(w * h * 0.01));
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 200 && ++n >= need) return true;
  return false;
}

/** Median colour of the border pixels (the background estimate for opaque screenshots). */
export function borderColor(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): [number, number, number] {
  const r: number[] = [], g: number[] = [], b: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r.push(rgba[i]);
    g.push(rgba[i + 1]);
    b.push(rgba[i + 2]);
  };
  const step = Math.max(1, Math.floor(Math.max(w, h) / 200));
  for (let x = 0; x < w; x += step) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    take(0, y);
    take(w - 1, y);
  }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(r), med(g), med(b)];
}

/** Foreground mask (1 = sticker) of a w×h RGBA image. */
export function foregroundMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, threshold = 48): Uint8Array {
  const m = new Uint8Array(w * h);
  if (hasTransparency(rgba, w, h)) {
    for (let p = 0; p < w * h; p++) m[p] = rgba[p * 4 + 3] > 32 ? 1 : 0;
    return m;
  }
  const [br, bg, bb] = borderColor(rgba, w, h);
  const t2 = threshold * threshold;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const dr = rgba[i] - br, dg = rgba[i + 1] - bg, db = rgba[i + 2] - bb;
    m[p] = dr * dr + dg * dg + db * db > t2 ? 1 : 0;
  }
  return close(m, w, h, Math.max(1, Math.round(Math.max(w, h) / 256)));
}

/** Morphological closing with a square of radius r (fills small holes and gaps). */
function close(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(m, w, h, r), w, h, r);
}
function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return sweep(m, w, h, r, 1);
}
function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return sweep(m, w, h, r, 0);
}
/** Separable square max (v = 1) or min (v = 0) filter. */
function sweep(m: Uint8Array, w: number, h: number, r: number, v: 0 | 1): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = v === 0 ? 1 : 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (m[y * w + k] === v) {
          hit = v;
          break;
        }
      }
      tmp[y * w + x] = hit;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let hit = v === 0 ? 1 : 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x] === v) {
          hit = v;
          break;
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

/** Bounding boxes of the 8-connected components of a mask (iterative flood fill). */
export function components(m: Uint8Array, w: number, h: number): (Box & { area: number })[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: (Box & { area: number })[] = [];
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!m[p0] || seen[p0]) continue;
    let sp = 0;
    stack[sp++] = p0;
    seen[p0] = 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (m[q] && !seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

const overlaps = (a: Box, b: Box, gap: number) => a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Merges boxes that overlap or nearly touch (a sticker split by a thin gap stays one). */
export function mergeBoxes(boxes: Box[], gap: number): Box[] {
  let list = boxes.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const next: Box[] = [];
    for (const b of list) {
      const i = next.findIndex((n) => overlaps(n, b, gap));
      if (i >= 0) {
        next[i] = union(next[i], b);
        changed = true;
      } else next.push(b);
    }
    list = next;
  }
  return list;
}

/** Reading order: group into rows by vertical overlap, rows top→bottom, boxes left→right. */
export function readingOrder(boxes: Box[]): Box[] {
  const sorted = boxes.slice().sort((a, b) => a.y - b.y);
  const rows: Box[][] = [];
  for (const b of sorted) {
    const row = rows.find((r) => r.some((o) => b.y < o.y + o.h * 0.6 && o.y < b.y + b.h * 0.6));
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/**
 * Finds the stickers in an image. `rgba` is the full-size image (w×h); analysis runs on a
 * downscaled copy made by nearest sampling.
 */
export function findStickers(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, o: SplitOptions = {}): Box[] {
  const maxSide = o.maxSide ?? 512;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  const small = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / k));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / k));
      const i = (sy * w + sx) * 4;
      small.set(rgba.subarray(i, i + 4), (y * sw + x) * 4);
    }
  }
  const mask = foregroundMask(small, sw, sh, o.threshold ?? 48);
  const minArea = (o.minAreaFrac ?? 0.004) * sw * sh;
  const found = components(mask, sw, sh).filter((c) => c.area >= minArea);
  const merged = mergeBoxes(found, Math.max(2, Math.round(Math.max(sw, sh) * 0.01)));
  const pad = o.padFrac ?? 0.04;
  return readingOrder(merged)
    .slice(0, o.maxBoxes ?? 30)
    .map((b) => {
      const px = Math.round(b.w * pad) + 1, py = Math.round(b.h * pad) + 1;
      const x = Math.max(0, Math.floor((b.x - px) / k));
      const y = Math.max(0, Math.floor((b.y - py) / k));
      return { x, y, w: Math.min(w - x, Math.ceil((b.w + px * 2) / k)), h: Math.min(h - y, Math.ceil((b.h + py * 2) / k)) };
    });
}
