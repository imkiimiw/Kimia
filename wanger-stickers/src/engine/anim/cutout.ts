// Background removal on animated clips (Phase 4, experimental — brief §9: "max 3 s at 512 px, only
// on capable devices"). The same U²-Netp model as stills runs on frames sampled at 6 fps; every
// output frame uses the nearest sampled mask, so a 3 s clip costs ≈ 19 inferences.
import { removeBackground } from '../segment';
import type { Canvas } from '../image';
import type { AnimSource } from './source';
import type { MaskAt } from './compose';

export const CUTOUT = Object.freeze({ maxClipMs: 3000, sampleFps: 6, minMemoryGb: 4, minCores: 4 }); // 6 fps: ≈ 19 inferences for 3 s (≈ 2 s each in a desktop Chromium, single-thread WASM)

/** Phones with ≥ 4 GB and ≥ 4 cores (where the browser tells; unknown counts as capable). */
export function canCutoutVideo(): boolean {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  return (mem === undefined || mem >= CUTOUT.minMemoryGb) && (!cores || cores >= CUTOUT.minCores);
}

/** Runs the model on sampled frames of the span the plan reads; returns a lookup by source time. */
export async function prepareCutout(src: AnimSource, times: number[], onProgress?: (p: number) => void): Promise<MaskAt> {
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  if (hi - lo > CUTOUT.maxClipMs * 4 + 1) throw new Error('CUTOUT_TOO_LONG'); // speed up to 4× is still ≤ 3 s of output
  const step = 1000 / CUTOUT.sampleFps;
  const samples: number[] = [];
  for (let t = lo; t <= hi + 0.5; t += step) samples.push(t);
  if (!samples.length || samples[samples.length - 1] < hi) samples.push(hi);
  await src.prepare?.(samples);
  const masks: { t: number; c: Canvas }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const frame = await src.frameAt(samples[i]);
    // the source reuses its canvas: run the model on a snapshot
    const snap = document.createElement('canvas');
    snap.width = frame.width;
    snap.height = frame.height;
    snap.getContext('2d')!.drawImage(frame as CanvasImageSource, 0, 0);
    const m = await removeBackground(snap, 'general');
    masks.push({ t: samples[i], c: m.toCanvas() });
    onProgress?.((i + 1) / samples.length);
  }
  return (t: number) => {
    let best = masks[0];
    for (const m of masks) if (Math.abs(m.t - t) < Math.abs(best.t - t)) best = m;
    return best ? best.c : null;
  };
}
