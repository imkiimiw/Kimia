// H.264 MP4 without sound (Telegram shows it as a GIF via sendAnimation): WebCodecs avc1 +
// mp4-muxer (MIT). Frames stream straight from the renderer into the encoder (one pass, no
// stored frames), on an opaque background (MP4 has no alpha).
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { OUTPUT } from '../limits';
import { validateMp4Animation } from '../../../tgcloud/lib/core/validate.js';
import type { Renderer } from './compose';
import type { Plan } from './timeline';

const CODECS = ['avc1.42001f', 'avc1.4d001f', 'avc1.640028', 'avc1.42002a'];

export async function h264Codec(w: number, h: number, fps: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of CODECS) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 1_000_000, framerate: fps, avc: { format: 'avc' } })).supported) return codec;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface Mp4Result {
  bytes: Uint8Array;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  violations: string[];
}

export async function toMp4(r: Renderer, plan: Plan, onProgress?: (p: number) => void): Promise<Mp4Result> {
  const { w, h } = r.size;
  const fps = plan.fps;
  const codec = await h264Codec(w, h, fps);
  if (!codec) throw new Error('NO_H264');
  // ≈ 0.12 bits per pixel per frame: clean for stickers and screen captures, far under 20 MB
  const bitrate = Math.max(300_000, Math.min(8_000_000, Math.round(w * h * fps * 0.12)));
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let err: unknown = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (err = e) });
  enc.configure({ codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' });
  const dur = Math.round(1e6 / fps);
  const keyEvery = Math.max(1, Math.round(fps * 2));
  for (let i = 0; i < plan.frames.length; i++) {
    const c = await r.draw(plan.frames[i]);
    const f = new VideoFrame(c as CanvasImageSource, { timestamp: Math.round((i * 1e6) / fps), duration: dur, alpha: 'discard' });
    enc.encode(f, { keyFrame: i % keyEvery === 0 });
    f.close();
    if (enc.encodeQueueSize > 6) await new Promise((res) => setTimeout(res, 0));
    if (onProgress && i % 5 === 0) onProgress((i + 1) / plan.frames.length);
    if (err) break;
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
  muxer.finalize();
  const bytes = new Uint8Array(target.buffer);
  if (bytes.length > OUTPUT.animation.maxBytes) throw new Error('TOO_BIG');
  return { bytes, width: w, height: h, fps, durationMs: plan.durationMs, violations: validateMp4Animation(bytes).violations };
}
