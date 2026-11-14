// The animated document and its per-frame compositor (browser). A document = source + clip +
// crop + shape + background + text layers (+ Phase 4: motion effect, template, per-frame cut-out).
// Still text is rendered ONCE to a transparent overlay and composited onto every frame (brief §9:
// never FFmpeg drawtext; the browser shapes Persian); animated text is drawn per frame.
// Output geometry per target:
//   telegram  long side exactly 512, the other ≤ 512 (circle / rounded → 512×512)
//   whatsapp  exactly 512×512, the art centred inside a transparent margin
//   gif / mp4 / webp  long side ≤ the chosen size (mp4: even numbers, H.264 needs them)
//   emoji     exactly 100×100 (custom emoji, Phase 4)
import { makeCanvas, ctx2d, type Canvas, type Ctx } from '../image';
import { drawText, type TextLayer } from '../text';
import { decorInset, drawDecorOver, drawDecorUnder, type Decor } from '../decor';
import { motionAt, pivotOf, textAt, graphemes, type EffectKind } from '../effects';
import { TELEGRAM, WHATSAPP } from '../limits';
import type { AnimSource } from './source';
import type { Clip, Plan, PlannedFrame } from './timeline';

export type AnimShape = 'none' | 'circle' | 'rounded';
export type AnimTarget = 'telegram' | 'whatsapp' | 'gif' | 'mp4' | 'webp' | 'emoji';

export interface AnimDoc {
  clip: Clip;
  /** Crop in source fractions (0..1). */
  crop: { x: number; y: number; w: number; h: number };
  shape: AnimShape;
  /** Fill behind the art (null = transparent; MP4 always gets a colour). */
  bg: string | null;
  texts: TextLayer[];
  /** Motion effect over the loop (Phase 4). */
  effect?: { kind: EffectKind; strength: number };
  /** Template (Phase 4). */
  decor?: Decor | null;
  /** Remove the background of every frame (Phase 4, experimental). */
  cutout?: boolean;
}

export function newAnimDoc(clip: Clip, round = false): AnimDoc {
  return { clip, crop: { x: 0, y: 0, w: 1, h: 1 }, shape: round ? 'circle' : 'none', bg: null, texts: [], effect: { kind: 'none', strength: 1 }, decor: null, cutout: false };
}

/** A centred square crop (for "square" and round videos). */
export function squareCrop(src: { width: number; height: number }): AnimDoc['crop'] {
  const s = Math.min(src.width, src.height);
  return { x: (src.width - s) / 2 / src.width, y: (src.height - s) / 2 / src.height, w: s / src.width, h: s / src.height };
}

export interface Size {
  w: number;
  h: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output canvas size for a target. `side` = long side for gif / mp4 / webp. */
export function outputSize(doc: AnimDoc, src: { width: number; height: number }, target: AnimTarget, side = 480): Size {
  const cw = doc.crop.w * src.width;
  const ch = doc.crop.h * src.height;
  const square = doc.shape !== 'none';
  const aspect = square ? 1 : cw / ch;
  if (target === 'whatsapp') return { w: WHATSAPP.animated.width, h: WHATSAPP.animated.height };
  if (target === 'emoji') return { w: TELEGRAM.customEmoji.width, h: TELEGRAM.customEmoji.height };
  if (doc.decor && doc.decor.kind !== 'none' && target === 'telegram') return { w: TELEGRAM.video.side, h: TELEGRAM.video.side };
  if (target === 'telegram') {
    const S = TELEGRAM.video.side;
    return aspect >= 1 ? { w: S, h: Math.max(1, Math.min(S, Math.round(S / aspect))) } : { w: Math.max(1, Math.min(S, Math.round(S * aspect))), h: S };
  }
  const long = Math.max(16, Math.min(side, Math.round(Math.max(cw, ch))));
  const w = aspect >= 1 ? long : long * aspect;
  const h = aspect >= 1 ? long / aspect : long;
  return target === 'mp4' ? { w: even(w), h: even(h) } : { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function shapePath(x: Ctx, s: AnimShape, ax: number, ay: number, aw: number, ah: number) {
  x.beginPath();
  if (s === 'circle') x.ellipse(ax + aw / 2, ay + ah / 2, aw / 2, ah / 2, 0, 0, Math.PI * 2);
  else {
    const r = Math.min(aw, ah) * 0.18;
    x.moveTo(ax + r, ay);
    x.arcTo(ax + aw, ay, ax + aw, ay + ah, r);
    x.arcTo(ax + aw, ay + ah, ax, ay + ah, r);
    x.arcTo(ax, ay + ah, ax, ay, r);
    x.arcTo(ax, ay, ax + aw, ay, r);
    x.closePath();
  }
}

export interface Renderer {
  size: Size;
  /** Draws one planned frame onto the renderer's canvas and returns it. */
  draw(f: PlannedFrame): Promise<Canvas>;
}

/** Per-frame cut-out masks (alpha canvases) by source time, from anim/cutout.ts. */
export type MaskAt = (t: number) => Canvas | null;

/**
 * A renderer for one (document, target, size). `opaqueBg` forces a background colour (MP4 has no
 * alpha). Static layers (text without animation, the template's still parts) are drawn once.
 */
export function makeRenderer(src: AnimSource, doc: AnimDoc, target: AnimTarget, size: Size, opaqueBg?: string, maskAt?: MaskAt): Renderer {
  const out = makeCanvas(size.w, size.h);
  const x = ctx2d(out, { willReadFrequently: true });
  const scale = Math.max(size.w, size.h) / 512;
  // the art rectangle inside the output (the WhatsApp margin and the template's room)
  const margin = target === 'whatsapp' ? WHATSAPP.marginPx * scale : 0;
  const decor = doc.decor && doc.decor.kind !== 'none' ? doc.decor : null;
  const ins = decorInset(decor);
  const cw = doc.crop.w * src.width;
  const ch = doc.crop.h * src.height;
  const aspect = doc.shape !== 'none' ? 1 : cw / ch;
  const boxX = size.w * ins.left + margin;
  const boxY = size.h * ins.top + margin;
  const boxW = size.w * (1 - ins.left - ins.right) - margin * 2;
  const boxH = size.h * (1 - ins.top - ins.bottom) - margin * 2;
  const k = Math.min(boxW / aspect, boxH);
  const aw = k * aspect;
  const ah = k;
  const ax = boxX + (boxW - aw) / 2;
  const ay = boxY + (boxH - ah) / 2;
  // for a square shape on a non-square crop: cover the square with the crop's centre
  const sx = doc.crop.x * src.width, sy = doc.crop.y * src.height;
  let srcRect = { x: sx, y: sy, w: cw, h: ch };
  if (doc.shape !== 'none' && Math.abs(cw - ch) > 0.5) {
    const s2 = Math.min(cw, ch);
    srcRect = { x: sx + (cw - s2) / 2, y: sy + (ch - s2) / 2, w: s2, h: s2 };
  }
  const effect = doc.effect && doc.effect.kind !== 'none' ? doc.effect : null;
  const animText = doc.texts.some((t) => t.anim && t.anim !== 'none' && t.text.trim());
  const animDecor = !!decor && (decor.kind === 'sparkles' || decor.kind === 'hearts');
  // still text and template drawn once
  const overlay = makeCanvas(size.w, size.h);
  const ox = ctx2d(overlay);
  if (!animText && !animDecor) {
    drawDecorOver(ox, decor, size.w, size.h, scale);
    for (const t of doc.texts) drawText(ox, t, size.w, size.h, scale);
  }
  const hasOverlay = !animText && !animDecor && (!!decor || doc.texts.some((t) => t.text.trim()));
  const cut = doc.cutout && maskAt ? makeCanvas(src.width, src.height) : null;
  const cutX = cut ? ctx2d(cut) : null;

  const paint = (frame: Canvas, t: number, alpha: number) => {
    let img: Canvas = frame;
    if (cut && cutX && maskAt) {
      const m = maskAt(t);
      if (m) {
        cutX.globalCompositeOperation = 'copy';
        cutX.drawImage(frame as CanvasImageSource, 0, 0, cut.width, cut.height);
        cutX.globalCompositeOperation = 'destination-in';
        cutX.drawImage(m as CanvasImageSource, 0, 0, cut.width, cut.height);
        cutX.globalCompositeOperation = 'source-over';
        img = cut;
      }
    }
    x.globalAlpha = alpha;
    x.drawImage(img as CanvasImageSource, srcRect.x, srcRect.y, srcRect.w, srcRect.h, ax, ay, aw, ah);
    x.globalAlpha = 1;
  };

  return {
    size,
    async draw(f: PlannedFrame) {
      const phase = f.phase ?? 0;
      x.clearRect(0, 0, size.w, size.h);
      if (opaqueBg) {
        x.fillStyle = opaqueBg;
        x.fillRect(0, 0, size.w, size.h);
      }
      drawDecorUnder(x, decor, size.w, size.h, scale);
      x.save();
      if (effect) {
        const mo = motionAt(effect.kind, phase, effect.strength);
        const px = ax + aw / 2;
        const py = pivotOf(effect.kind) === 'top' ? ay : ay + ah / 2;
        x.translate(px + mo.dx * aw, py + mo.dy * ah);
        x.rotate(mo.rotate);
        x.scale(mo.scale, mo.scale);
        x.translate(-px, -py);
        x.globalAlpha = mo.alpha;
        if (mo.glow > 0) {
          x.shadowColor = `rgba(255,255,255,${0.95 * mo.glow})`;
          x.shadowBlur = 24 * scale * mo.glow;
        }
      }
      if (doc.shape !== 'none') {
        shapePath(x, doc.shape, ax, ay, aw, ah);
        x.clip();
      }
      if (doc.bg) {
        x.fillStyle = doc.bg;
        x.fillRect(ax, ay, aw, ah);
      }
      x.imageSmoothingQuality = 'high';
      paint(await src.frameAt(f.t), f.t, 1);
      if (f.mix && f.mix.w > 0) paint(await src.frameAt(f.mix.t), f.mix.t, f.mix.w);
      x.restore();
      if (hasOverlay) x.drawImage(overlay as CanvasImageSource, 0, 0);
      else if (animText || animDecor) {
        drawDecorOver(x, decor, size.w, size.h, scale, phase);
        for (const t of doc.texts) {
          const a = t.anim && t.anim !== 'none' ? textAt(t.anim, phase, graphemes(t.text).length) : undefined;
          drawText(x, t, size.w, size.h, scale, a);
        }
      }
      return out;
    },
  };
}

/** Every source time a plan reads (for AnimSource.prepare). */
export const planTimes = (plan: Plan) => plan.frames.flatMap((f) => (f.mix ? [f.t, f.mix.t] : [f.t]));

/** Renders every planned frame to RGBA (for encoders that need several passes). */
export async function renderAll(r: Renderer, plan: Plan, onProgress?: (p: number) => void): Promise<ImageData[]> {
  const frames: ImageData[] = [];
  for (let i = 0; i < plan.frames.length; i++) {
    const c = await r.draw(plan.frames[i]);
    frames.push(ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, r.size.w, r.size.h));
    if (onProgress && (i % 5 === 0 || i === plan.frames.length - 1)) onProgress((i + 1) / plan.frames.length);
  }
  return frames;
}

/** True when any frame has a pixel that isn't fully opaque. */
export function framesHaveAlpha(frames: ImageData[]): boolean {
  for (const f of frames) {
    const d = f.data;
    for (let i = 3; i < d.length; i += 16) if (d[i] < 255) return true;
  }
  return false;
}

/**
 * Colour bleed for lossy codecs (DECISIONS D2): fully transparent pixels next to the art take the
 * neighbouring colour (one 3×3 pass), the rest take the frame's mean colour, so compression never
 * smears black into the outline. Works in place on a copy the caller owns.
 */
export function bleed(f: ImageData): ImageData {
  const { width: w, height: h } = f;
  const d = f.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) {
    if (d[i + 3] > 128) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
  }
  const mr = n ? r / n : 128, mg = n ? g / n : 128, mb = n ? b / n : 128;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] !== 0) continue;
      let best = -1;
      for (let dy = -1; dy <= 1 && best < 0; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 4;
          if (src[j + 3] > 0) {
            best = j;
            break;
          }
        }
      }
      if (best >= 0) {
        d[i] = src[best];
        d[i + 1] = src[best + 1];
        d[i + 2] = src[best + 2];
      } else {
        d[i] = mr;
        d[i + 1] = mg;
        d[i + 2] = mb;
      }
    }
  }
  return f;
}
