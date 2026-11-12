// The static sticker pipeline: source + mask → adjustments → rotate / flip → shape (free trim,
// square, circle, rounded) → fit (Telegram: long side exactly 512) with room for the outline →
// outline → drop shadow → text layers. Pure function of the document; the UI never draws stickers.
import { makeCanvas, ctx2d, alphaBounds, type Canvas } from './image';
import type { Mask } from './mask';
import { drawText, type TextLayer } from './text';
import { TELEGRAM } from './limits';

export type Shape = 'free' | 'square' | 'circle' | 'rounded';

export interface StickerDoc {
  src: Canvas; // decoded source, long side ≤ 1024
  mask: Mask;
  rotate: 0 | 90 | 180 | 270;
  flip: boolean;
  shape: Shape;
  outline: { on: boolean; color: string; width: number }; // width in px at 512
  shadow: boolean;
  adjust: { brightness: number; contrast: number; saturation: number }; // 100 = unchanged
  texts: TextLayer[];
}

export function newDoc(src: Canvas, mask: Mask): StickerDoc {
  return {
    src,
    mask,
    rotate: 0,
    flip: false,
    shape: 'free',
    outline: { on: true, color: '#ffffff', width: 10 },
    shadow: true,
    adjust: { brightness: 100, contrast: 100, saturation: 100 },
    texts: [],
  };
}

/** Source with the mask applied, adjusted, rotated and flipped. */
export function cutout(doc: StickerDoc): Canvas {
  const { src } = doc;
  const a = makeCanvas(src.width, src.height);
  const ax = ctx2d(a);
  const { brightness: b, contrast: c, saturation: s } = doc.adjust;
  if (b !== 100 || c !== 100 || s !== 100) ax.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
  ax.drawImage(src as CanvasImageSource, 0, 0);
  ax.filter = 'none';
  ax.globalCompositeOperation = 'destination-in';
  ax.drawImage(doc.mask.toCanvas() as CanvasImageSource, 0, 0);
  ax.globalCompositeOperation = 'source-over';
  const swap = doc.rotate === 90 || doc.rotate === 270;
  const r = makeCanvas(swap ? a.height : a.width, swap ? a.width : a.height);
  const rx = ctx2d(r);
  rx.translate(r.width / 2, r.height / 2);
  rx.rotate((doc.rotate * Math.PI) / 180);
  if (doc.flip) rx.scale(-1, 1);
  rx.drawImage(a as CanvasImageSource, -a.width / 2, -a.height / 2);
  return r;
}

function roundRect(x: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(r, 0);
  x.arcTo(w, 0, w, h, r);
  x.arcTo(w, h, 0, h, r);
  x.arcTo(0, h, 0, 0, r);
  x.arcTo(0, 0, w, 0, r);
  x.closePath();
}

/** The subject cropped to its shape, cached until the mask or the geometry changes. */
const cache = new WeakMap<StickerDoc, { key: string; subject: Canvas | null }>();
function shapedCached(doc: StickerDoc): Canvas | null {
  const key = `${doc.mask.version}|${doc.rotate}|${doc.flip}|${doc.shape}|${doc.adjust.brightness},${doc.adjust.contrast},${doc.adjust.saturation}`;
  const hit = cache.get(doc);
  if (hit && hit.key === key) return hit.subject;
  const subject = shaped(doc);
  cache.set(doc, { key, subject });
  return subject;
}

/** The subject cropped to its shape (no outline yet), at source resolution. */
function shaped(doc: StickerDoc): Canvas | null {
  const c = cutout(doc);
  const b = alphaBounds(c);
  if (!b) return null;
  if (doc.shape === 'free') {
    const t = makeCanvas(b.w, b.h);
    ctx2d(t).drawImage(c as CanvasImageSource, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return t;
  }
  const side = Math.max(b.w, b.h);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const t = makeCanvas(side, side);
  const tx = ctx2d(t);
  if (doc.shape === 'circle') {
    tx.beginPath();
    tx.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
    tx.clip();
  } else if (doc.shape === 'rounded') {
    roundRect(tx, side, side, side * 0.18);
    tx.clip();
  }
  tx.drawImage(c as CanvasImageSource, cx - side / 2, cy - side / 2, side, side, 0, 0, side, side);
  return t;
}

/** Paints `img` filled with `color`, stamped around a circle of radius r (the outline). */
function outlined(img: Canvas, r: number, color: string): Canvas {
  const pad = Math.ceil(r) + 1;
  const out = makeCanvas(img.width + pad * 2, img.height + pad * 2);
  const ox = ctx2d(out);
  if (r > 0) {
    const sil = makeCanvas(img.width, img.height);
    const sx = ctx2d(sil);
    sx.drawImage(img as CanvasImageSource, 0, 0);
    sx.globalCompositeOperation = 'source-in';
    sx.fillStyle = color;
    sx.fillRect(0, 0, sil.width, sil.height);
    const n = Math.max(16, Math.min(48, Math.round(r * 3)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ox.drawImage(sil as CanvasImageSource, pad + Math.cos(a) * r, pad + Math.sin(a) * r);
    }
    ox.drawImage(sil as CanvasImageSource, pad, pad);
  }
  ox.drawImage(img as CanvasImageSource, pad, pad);
  return out;
}

export interface Rendered {
  canvas: Canvas;
  width: number;
  height: number;
}

/**
 * Renders the Telegram static sticker: long side exactly 512, the other ≤ 512, transparent.
 * `side` can be smaller for a fast preview (same geometry, scaled).
 */
export function renderSticker(doc: StickerDoc, side: number = TELEGRAM.static.side): Rendered | null {
  const subject = shapedCached(doc);
  if (!subject) return null;
  const scale512 = side / TELEGRAM.static.side;
  const outlineW = doc.outline.on ? doc.outline.width * scale512 : 0;
  const shadowPad = doc.shadow ? 8 * scale512 : 0;
  const margin = Math.ceil(outlineW + shadowPad + 2 * scale512);
  const inner = side - margin * 2;
  const k = inner / Math.max(subject.width, subject.height);
  const sw = Math.max(1, Math.round(subject.width * k));
  const sh = Math.max(1, Math.round(subject.height * k));
  const scaled = makeCanvas(sw, sh);
  const scx = ctx2d(scaled);
  scx.imageSmoothingQuality = 'high';
  scx.drawImage(subject as CanvasImageSource, 0, 0, sw, sh);
  const withOutline = outlined(scaled, outlineW, doc.outline.color);
  // final canvas: the long side is exactly `side`
  const W = sw >= sh ? side : Math.min(side, sw + margin * 2);
  const H = sh > sw ? side : Math.min(side, sh + margin * 2);
  const out = makeCanvas(W, H);
  const x = ctx2d(out);
  if (doc.shadow) {
    x.shadowColor = 'rgba(0,0,0,0.35)';
    x.shadowBlur = 8 * scale512;
    x.shadowOffsetY = 3 * scale512;
  }
  x.drawImage(withOutline as CanvasImageSource, (W - withOutline.width) / 2, (H - withOutline.height) / 2);
  x.shadowColor = 'transparent';
  for (const t of doc.texts) drawText(x, t, W, H, scale512);
  return { canvas: out, width: W, height: H };
}
