// The cut-out mask: one alpha byte per source pixel. Background removal fills it, the erase /
// restore brush edits it, and the renderer applies it.
import { makeCanvas, ctx2d, type Canvas } from './image';

export class Mask {
  readonly w: number;
  readonly h: number;
  data: Uint8ClampedArray;

  constructor(w: number, h: number, fill = 255) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h).fill(fill);
  }

  clone(): Mask {
    const m = new Mask(this.w, this.h);
    m.data.set(this.data);
    return m;
  }

  /** From a model's output (any size, values 0..1 or arbitrary range), resized to w×h. */
  static fromModel(out: Float32Array, mw: number, mh: number, w: number, h: number): Mask {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < out.length; i++) {
      if (out[i] < lo) lo = out[i];
      if (out[i] > hi) hi = out[i];
    }
    const span = hi - lo || 1;
    const small = makeCanvas(mw, mh);
    const sx = ctx2d(small);
    const img = sx.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) {
      const v = Math.round(((out[i] - lo) / span) * 255);
      img.data[i * 4 + 3] = v;
    }
    sx.putImageData(img, 0, 0);
    const big = makeCanvas(w, h);
    const bx = ctx2d(big, { willReadFrequently: true });
    bx.imageSmoothingQuality = 'high';
    bx.drawImage(small as CanvasImageSource, 0, 0, w, h);
    const d = bx.getImageData(0, 0, w, h).data;
    const m = new Mask(w, h);
    // a gentle contrast curve: clean background, solid subject, soft edge
    for (let i = 0; i < w * h; i++) {
      const a = d[i * 4 + 3] / 255;
      const s = a < 0.15 ? 0 : a > 0.85 ? 1 : (a - 0.15) / 0.7;
      m.data[i] = Math.round(s * 255);
    }
    return m;
  }

  /**
   * A round brush stroke segment from (x0,y0) to (x1,y1) in mask pixels.
   * mode erase → towards 0, restore → towards 255; softness 0 (hard) … 1 (very soft).
   */
  stroke(x0: number, y0: number, x1: number, y1: number, radius: number, softness: number, mode: 'erase' | 'restore'): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, radius / 3)));
    for (let s = 0; s <= steps; s++) this.dab(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, radius, softness, mode);
  }

  private dab(cx: number, cy: number, r: number, softness: number, mode: 'erase' | 'restore'): void {
    const r2 = r * r;
    const inner = r * (1 - Math.min(0.95, Math.max(0, softness)));
    const xa = Math.max(0, Math.floor(cx - r));
    const xb = Math.min(this.w - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r));
    const yb = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2);
        const k = d <= inner ? 1 : 1 - (d - inner) / (r - inner || 1);
        const i = y * this.w + x;
        const v = this.data[i];
        this.data[i] = mode === 'erase' ? v * (1 - k) : v + (255 - v) * k;
      }
    }
  }

  /** The mask as an alpha-only canvas (for destination-in compositing). */
  toCanvas(): Canvas {
    const c = makeCanvas(this.w, this.h);
    const x = ctx2d(c);
    const img = x.createImageData(this.w, this.h);
    for (let i = 0; i < this.data.length; i++) img.data[i * 4 + 3] = this.data[i];
    x.putImageData(img, 0, 0);
    return c;
  }

  /** True when nothing has been removed yet. */
  get full(): boolean {
    for (let i = 0; i < this.data.length; i += 97) if (this.data[i] !== 255) return false;
    return true;
  }
}
