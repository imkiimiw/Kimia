// GIF output (gifenc, MIT): one palette per frame (≤ 256 colours), 1-bit transparency when the
// document is transparent (each frame clears the previous one), loops forever. GIF delays are
// in 1/100 s, so the frame rate is snapped to a whole delay (e.g. 15 fps → 70 ms).
import gifenc from 'gifenc';
import { OUTPUT } from '../limits';
import { ctx2d } from '../image';
import { validateGif } from '../../../tgcloud/lib/core/validate.js';
import type { Renderer } from './compose';
import type { Plan } from './timeline';

const { GIFEncoder, quantize, applyPalette } = gifenc as unknown as {
  GIFEncoder: () => { writeFrame: (index: Uint8Array, w: number, h: number, o: Record<string, unknown>) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (rgba: Uint8ClampedArray | Uint8Array, max: number, o?: Record<string, unknown>) => number[][];
  applyPalette: (rgba: Uint8ClampedArray | Uint8Array, palette: number[][], format?: string) => Uint8Array;
};

/** The GIF frame delay (ms, a multiple of 10, ≥ 20) closest to 1000 / fps. */
export const gifDelay = (fps: number) => Math.max(OUTPUT.gif.minDelayMs, Math.round(1000 / fps / 10) * 10);

export interface GifResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  frames: number;
  delayMs: number;
  violations: string[];
}

/** `plan` must already be at 1000 / gifDelay(fps) frames per second (see gifPlanFps). */
export async function toGif(r: Renderer, plan: Plan, transparent: boolean, onProgress?: (p: number) => void): Promise<GifResult> {
  const { w, h } = r.size;
  const delay = gifDelay(plan.fps);
  const enc = GIFEncoder();
  for (let i = 0; i < plan.frames.length; i++) {
    const c = await r.draw(plan.frames[i]);
    const rgba = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    if (transparent) {
      const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true, clearAlpha: true, clearAlphaThreshold: 96 });
      const index = applyPalette(rgba, palette, 'rgba4444');
      const ti = palette.findIndex((p) => p[3] === 0);
      enc.writeFrame(index, w, h, { palette, delay, repeat: 0, transparent: ti >= 0, transparentIndex: Math.max(0, ti), dispose: 2 });
    } else {
      const palette = quantize(rgba, 256);
      enc.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay, repeat: 0 });
    }
    if (onProgress && i % 3 === 0) onProgress((i + 1) / plan.frames.length);
    if (i % 4 === 3) await new Promise((res) => setTimeout(res, 0)); // keep the UI responsive
  }
  enc.finish();
  const bytes = enc.bytes();
  if (bytes.length > OUTPUT.gif.maxBytes) throw new Error('TOO_BIG');
  return { bytes, width: w, height: h, frames: plan.frames.length, delayMs: delay, violations: validateGif(bytes).violations };
}

/** The frame rate a GIF plan should use for a wanted fps (whole 10 ms delays). */
export const gifPlanFps = (fps: number) => 1000 / gifDelay(fps);
