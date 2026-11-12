// Animated WebP with libwebp's own WebPAnimEncoder (wasm-webp, MIT; libwebp BSD): only changed
// rectangles are stored, so it is ~3× smaller than full frames (SPIKE_REPORT §4.2). Used for
// WhatsApp animated stickers (512×512, ≤ 500 KB, ≤ 10 s, frames ≥ 8 ms, loops forever) with size
// targeting — quality search (≤ 6 encodes), then the WhatsApp frame-rate ladder 15 → 12 → 10 → 8 —
// and for "video → animated WebP" files.
import { WHATSAPP, SIZE_TARGETING, OUTPUT } from '../limits';
import { validateWhatsAppAnimated, validateWebPFile } from '../../../tgcloud/lib/core/validate.js';
import { resampleIndexes } from './timeline';

export interface AnimWebpResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationMs: number;
  quality: number;
  encodes: number;
  violations: string[];
}

type Encode = (w: number, h: number, alpha: boolean, frames: { data: Uint8Array; duration: number; config?: { lossless: number; quality: number } }[]) => Promise<Uint8Array | null>;
let encoder: Promise<Encode> | null = null;
const load = () => (encoder ||= import('wasm-webp').then((m) => m.encodeAnimation as unknown as Encode));

/** Whole-millisecond durations that add up exactly to n × 1000 / fps (never past the limit). */
export function frameDurations(n: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + 1) * 1000) / fps) - Math.floor((i * 1000) / fps));
  return out;
}

async function encodeAt(frames: ImageData[], idx: number[], fps: number, quality: number): Promise<Uint8Array> {
  const enc = await load();
  const d = frameDurations(idx.length, fps);
  const w = frames[0].width, h = frames[0].height;
  const list = idx.map((k, i) => ({ data: new Uint8Array(frames[k].data.buffer, frames[k].data.byteOffset, frames[k].data.byteLength), duration: d[i], config: { lossless: 0, quality } }));
  const out = await enc(w, h, true, list);
  if (!out) throw new Error('ENCODE_FAILED');
  return out;
}

/**
 * WhatsApp animated sticker from frames rendered at `fps` (512×512). Throws 'TOO_BIG' after the
 * whole ladder: the UI asks the user to shorten the clip (never a silent cut).
 */
export async function toWhatsAppAnimated(frames: ImageData[], fps: number, onProgress?: (p: number, note: string) => void): Promise<AnimWebpResult> {
  const A = WHATSAPP.animated;
  if (!frames.length) throw new Error('EMPTY');
  const max = A.maxBytes;
  const ladder = SIZE_TARGETING.waFpsLadder.filter((f) => f <= fps);
  if (!ladder.length) ladder.push(fps);
  let encodes = 0;
  let start = 70; // default quality; lower rungs start from what the last search learned
  for (let step = 0; step < ladder.length; step++) {
    const f = ladder[step];
    const idx = resampleIndexes(frames.length, fps, f);
    // binary search on quality: hi = too big, lo = fits (assumed at 5)
    let lo = 5;
    let hi = 101;
    let q = start;
    let best: { bytes: Uint8Array; q: number } | null = null;
    const budget = step === 0 ? SIZE_TARGETING.maxQualitySearchEncodes : 2;
    for (let n = 0; n < budget; n++) {
      onProgress?.(Math.min(0.95, 0.05 + encodes * 0.12), `q${q} ${f} fps`);
      const bytes = await encodeAt(frames, idx, f, q);
      encodes++;
      if (bytes.length <= max) {
        if (!best || q > best.q) best = { bytes, q };
        lo = q;
        if (n === 0 || hi - lo <= 8) break; // the default fits, or the search is narrow enough
      } else hi = q;
      q = Math.round((lo + hi) / 2);
      if (q <= lo || q >= hi) break;
    }
    if (best) {
      onProgress?.(1, 'done');
      const v = validateWhatsAppAnimated(best.bytes);
      return { bytes: best.bytes, width: frames[0].width, height: frames[0].height, fps: f, frames: idx.length, durationMs: frameDurations(idx.length, f).reduce((a, b) => a + b, 0), quality: best.q, encodes, violations: v.violations };
    }
    start = Math.max(10, Math.round(hi * 0.8)); // fewer frames → the same quality is smaller
  }
  throw new Error('TOO_BIG');
}

/** "Video → animated WebP" as a file (no sticker rules; our 20 MB cap). */
export async function toAnimatedWebpFile(frames: ImageData[], fps: number, quality = 75): Promise<AnimWebpResult> {
  const idx = frames.map((_, i) => i);
  let q = quality;
  for (let n = 0; n < 3; n++) {
    const bytes = await encodeAt(frames, idx, fps, q);
    if (bytes.length <= OUTPUT.webp.maxBytes) {
      return { bytes, width: frames[0].width, height: frames[0].height, fps, frames: idx.length, durationMs: (idx.length * 1000) / fps, quality: q, encodes: n + 1, violations: validateWebPFile(bytes).violations };
    }
    q = Math.max(10, Math.round(q * 0.6));
  }
  throw new Error('TOO_BIG');
}
