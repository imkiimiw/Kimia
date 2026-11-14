// Telegram video stickers: VP9 in WebM, no audio, ≤ 3 s, ≤ 30 fps, ≤ 256 KB, long side 512.
// WebCodecs encodes VP9; where it can't keep alpha (Chromium today) the alpha plane goes through
// a SECOND encoder as luma and our muxer writes WebM's standard alpha layout (BlockAdditions,
// AlphaMode = 1) — SPIKE_REPORT §4.1. Size targeting (brief §10, DECISIONS D2): bitrate search
// (≤ 6 encodes; WebCodecs has no two-pass), then the frame-rate ladder 30 → 24 → 20 → 15, then the
// caller asks the user to shorten. Every result goes through the server's own validator.
import { muxWebM, type WebMFrame } from '../webm/mux';
import { TELEGRAM, SIZE_TARGETING } from '../limits';
import { validateTelegramVideo, validateCustomEmojiVideo } from '../../../tgcloud/lib/core/validate.js';
import { resampleIndexes } from './timeline';
import { bleed, framesHaveAlpha } from './compose';

const CODECS = ['vp09.00.30.08', 'vp09.00.10.08', 'vp09.00.21.08'];

export interface VideoResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationMs: number;
  bitrate: number;
  alpha: boolean;
  encodes: number;
  violations: string[];
}

/** The first VP9 codec string this device's WebCodecs accepts for w×h, or null. */
export async function vp9Codec(w: number, h: number, fps = 30): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of CODECS) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 400_000, framerate: fps });
      if (s.supported) return codec;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

interface Prepared {
  w: number;
  h: number;
  color: ImageBitmap[];
  alpha: ImageBitmap[] | null;
}

/** Colour frames (with the transparent area bled) and, when needed, the alpha plane as grey. */
async function prepare(frames: ImageData[]): Promise<Prepared> {
  const w = frames[0].width;
  const h = frames[0].height;
  const withAlpha = framesHaveAlpha(frames);
  const color: ImageBitmap[] = [];
  const alpha: ImageBitmap[] = [];
  for (const f of frames) {
    color.push(await createImageBitmap(withAlpha ? bleed(new ImageData(new Uint8ClampedArray(f.data), w, h)) : f));
    if (withAlpha) {
      const a = new ImageData(w, h);
      const s = f.data;
      const d = a.data;
      for (let i = 0; i < s.length; i += 4) {
        d[i] = d[i + 1] = d[i + 2] = s[i + 3];
        d[i + 3] = 255;
      }
      alpha.push(await createImageBitmap(a));
    }
  }
  return { w, h, color, alpha: withAlpha ? alpha : null };
}

async function encodeOnce(p: Prepared, idx: number[], fps: number, codec: string, bitrate: number): Promise<Uint8Array> {
  const base = { codec, width: p.w, height: p.h, framerate: fps, bitrateMode: 'variable' as const, latencyMode: 'quality' as const, alpha: 'discard' as const };
  const color: EncodedVideoChunk[] = [];
  const alpha: EncodedVideoChunk[] = [];
  let err: unknown = null;
  const ce = new VideoEncoder({ output: (c) => color.push(c), error: (e) => (err = e) });
  ce.configure({ ...base, bitrate: Math.round(p.alpha ? bitrate * 0.8 : bitrate) });
  const ae = p.alpha ? new VideoEncoder({ output: (c) => alpha.push(c), error: (e) => (err = e) }) : null;
  if (ae) ae.configure({ ...base, bitrate: Math.max(40_000, Math.round(bitrate * 0.2)) });
  // VideoFrame from an ImageBitmap works everywhere WebCodecs does
  const dur = Math.round(1e6 / fps);
  for (let i = 0; i < idx.length; i++) {
    const ts = Math.round((i * 1e6) / fps);
    const key = i === 0;
    const f1 = new VideoFrame(p.color[idx[i]], { timestamp: ts, duration: dur, alpha: 'discard' });
    ce.encode(f1, { keyFrame: key });
    f1.close();
    if (ae && p.alpha) {
      const f2 = new VideoFrame(p.alpha[idx[i]], { timestamp: ts, duration: dur, alpha: 'discard' });
      ae.encode(f2, { keyFrame: key });
      f2.close();
    }
    if (ce.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 0));
  }
  await ce.flush();
  if (ae) await ae.flush();
  ce.close();
  if (ae) ae.close();
  if (err) throw err;
  if (color.length !== idx.length || (ae && alpha.length !== idx.length)) throw new Error('ENCODER_DROPPED_FRAMES');
  const frames: WebMFrame[] = color.map((c, i) => {
    const data = new Uint8Array(c.byteLength);
    c.copyTo(data);
    let a: Uint8Array | undefined;
    if (ae) {
      a = new Uint8Array(alpha[i].byteLength);
      alpha[i].copyTo(a);
    }
    // a frame is a keyframe only when both planes are (the alpha stream must restart too)
    return { data, alpha: a, timestampMs: (i * 1000) / fps, key: c.type === 'key' && (!ae || alpha[i].type === 'key') };
  });
  frames[0].key = true;
  return muxWebM(frames, { width: p.w, height: p.h, fps, alpha: !!ae });
}

/**
 * frames: rendered at `fps` (normally 30). Returns the best file that fits 256 KB, or throws
 * 'TOO_BIG' after the whole ladder (the UI then asks to shorten or simplify).
 */
export async function toTelegramVideo(frames: ImageData[], fps: number, onProgress?: (p: number, note: string) => void, kind: 'sticker' | 'emoji' = 'sticker'): Promise<VideoResult> {
  const V = TELEGRAM.video;
  if (!frames.length) throw new Error('EMPTY');
  const w = frames[0].width;
  const h = frames[0].height;
  const codec = await vp9Codec(w, h, fps);
  if (!codec) throw new Error('NO_VP9');
  onProgress?.(0.02, 'prepare');
  const p = await prepare(frames);
  const target = V.maxBytes * 0.96;
  const ladder = SIZE_TARGETING.fpsLadder.filter((f) => f <= Math.min(fps, V.maxFps));
  if (!ladder.length) ladder.push(Math.min(fps, V.maxFps));
  let encodes = 0;
  let bitrate = 0;
  try {
    for (let step = 0; step < ladder.length; step++) {
      const f = ladder[step];
      const idx = resampleIndexes(frames.length, fps, f);
      const seconds = idx.length / f;
      // a 100×100 emoji needs far fewer bits than its 256 KB cap allows
      if (!bitrate) bitrate = Math.round(((target * 8) / seconds) * 0.85 * (kind === 'emoji' ? 0.25 : 1));
      let best: { bytes: Uint8Array; bitrate: number } | null = null;
      const budget = step === 0 ? SIZE_TARGETING.maxQualitySearchEncodes : 2;
      for (let n = 0; n < budget; n++) {
        onProgress?.(Math.min(0.95, 0.1 + encodes * 0.12), `encode ${f} fps`);
        const bytes = await encodeOnce(p, idx, f, codec, bitrate);
        encodes++;
        if (bytes.length <= V.maxBytes) {
          if (!best || bytes.length > best.bytes.length) best = { bytes, bitrate };
          // well under the limit: one try at a higher bitrate for quality, then stop
          if (bytes.length < target * 0.6 && n < budget - 1 && best.bitrate === bitrate) {
            bitrate = Math.round(bitrate * Math.min(1.8, (target / bytes.length) * 0.85));
            continue;
          }
          break;
        }
        bitrate = Math.round(bitrate * (target / bytes.length) * 0.9);
      }
      if (best) {
        const v = kind === 'emoji' ? validateCustomEmojiVideo(best.bytes) : validateTelegramVideo(best.bytes);
        onProgress?.(1, 'done');
        return { bytes: best.bytes, width: w, height: h, fps: f, frames: idx.length, durationMs: (idx.length * 1000) / f, bitrate: best.bitrate, alpha: !!p.alpha, encodes, violations: v.violations };
      }
    }
  } finally {
    p.color.forEach((b) => b.close());
    p.alpha?.forEach((b) => b.close());
  }
  throw new Error('TOO_BIG');
}
