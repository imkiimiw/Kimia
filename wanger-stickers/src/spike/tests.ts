// The Phase 0 device spikes. Each test returns a plain JSON-able result; heavy libraries are
// loaded only inside the test that needs them (dynamic import → their own chunks).
import { TELEGRAM, WHATSAPP } from '../engine/limits';
import { inspectWebM, inspectWebP } from '../../tgcloud/lib/core/inspect.js';
import { SIDE, ctx2d, drawFrame, frameImageData, loadFont, makeCanvas } from './frames';
import { call, insideTelegram } from './tg';

export type Result = Record<string, unknown>;
export type Preview = (label: string, blob: Blob) => void;

const now = () => performance.now();
const ms = (t0: number) => Math.round(now() - t0);
const heapMB = () => {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
};
const kb = (n: number) => Math.round(n / 102.4) / 10;

/* ---------- 1. VP9 + alpha through WebCodecs, muxed with webm-muxer ---------- */

export async function vp9WebCodecs(preview: Preview): Promise<Result> {
  if (typeof VideoEncoder === 'undefined') return { supported: false, reason: 'no VideoEncoder' };
  const { Muxer, ArrayBufferTarget } = await import('webm-muxer');
  const family = await loadFont();
  const fps = TELEGRAM.video.maxFps;
  const n = (TELEGRAM.video.maxDurationMs / 1000) * fps; // 90 frames
  const canvas = makeCanvas();
  const x = ctx2d(canvas);

  const encodeAt = async (bitrate: number, alpha: 'keep' | 'discard') => {
    const config: VideoEncoderConfig = { codec: 'vp09.00.10.08', width: SIDE, height: SIDE, bitrate, framerate: fps, alpha, bitrateMode: 'variable', latencyMode: 'quality' };
    const sup = await VideoEncoder.isConfigSupported(config);
    if (!sup.supported) return { bitrate, alpha, supported: false };
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: 'V_VP9', width: SIDE, height: SIDE, frameRate: fps, alpha: alpha === 'keep' }, firstTimestampBehavior: 'offset' });
    let sawAlpha = false;
    let err: unknown = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && (meta as { alphaSideData?: unknown }).alphaSideData) sawAlpha = true;
        muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => (err = e),
    });
    enc.configure(config);
    const h0 = heapMB();
    const t0 = now();
    for (let i = 0; i < n; i++) {
      drawFrame(x, i, n, family);
      const frame = new VideoFrame(canvas as CanvasImageSource, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps), alpha });
      enc.encode(frame, { keyFrame: i === 0 });
      frame.close();
      if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    }
    await enc.flush();
    enc.close();
    muxer.finalize();
    const encodeMs = ms(t0);
    if (err) return { bitrate, alpha, error: String(err) };
    const bytes = new Uint8Array(target.buffer);
    const info = inspectWebM(bytes);
    return { bitrate, alpha, encodeMs, heapDeltaMB: h0 === null ? null : (heapMB() ?? 0) - h0, kb: kb(bytes.length), fitsTelegram: bytes.length <= TELEGRAM.video.maxBytes, alphaSideData: sawAlpha, info, _blob: new Blob([bytes], { type: 'video/webm' }) };
  };

  const runs = [];
  for (const [bitrate, alpha] of [[600_000, 'keep'], [400_000, 'keep'], [250_000, 'keep'], [400_000, 'discard']] as const) {
    const r = await encodeAt(bitrate, alpha);
    const { _blob, ...rest } = r as Result & { _blob?: Blob };
    if (_blob && bitrate === 400_000) preview(`VP9 WebCodecs ${bitrate / 1000}k alpha=${alpha}`, _blob);
    runs.push(rest);
  }
  return { supported: true, frames: n, fps, runs };
}

/* ---------- 1b. VP9 + alpha with TWO WebCodecs encoders (colour + alpha plane) and our muxer ---------- */

export async function vp9DualAlpha(preview: Preview): Promise<Result> {
  if (typeof VideoEncoder === 'undefined') return { supported: false, reason: 'no VideoEncoder' };
  const { muxWebM } = await import('../engine/webm/mux');
  const family = await loadFont();
  const fps = TELEGRAM.video.maxFps;
  const n = (TELEGRAM.video.maxDurationMs / 1000) * fps;
  const canvas = makeCanvas();
  const x = ctx2d(canvas);
  const aCanvas = makeCanvas();
  const ax = ctx2d(aCanvas);

  const run = async (colorBitrate: number, alphaBitrate: number) => {
    const base = { codec: 'vp09.00.10.08', width: SIDE, height: SIDE, framerate: fps, alpha: 'discard' as const, bitrateMode: 'variable' as const, latencyMode: 'quality' as const };
    const cc: VideoEncoderConfig = { ...base, bitrate: colorBitrate };
    const ac: VideoEncoderConfig = { ...base, bitrate: alphaBitrate };
    if (!(await VideoEncoder.isConfigSupported(cc)).supported) return { supported: false };
    const color: EncodedVideoChunk[] = [];
    const alpha: EncodedVideoChunk[] = [];
    let err: unknown = null;
    const ce = new VideoEncoder({ output: (c) => color.push(c), error: (e) => (err = e) });
    const ae = new VideoEncoder({ output: (c) => alpha.push(c), error: (e) => (err = e) });
    ce.configure(cc);
    ae.configure(ac);
    const t0 = now();
    for (let i = 0; i < n; i++) {
      drawFrame(x, i, n, family);
      const img = x.getImageData(0, 0, SIDE, SIDE);
      const a = ax.createImageData(SIDE, SIDE);
      for (let p = 0; p < img.data.length; p += 4) {
        const v = img.data[p + 3];
        a.data[p] = a.data[p + 1] = a.data[p + 2] = v;
        a.data[p + 3] = 255;
      }
      ax.putImageData(a, 0, 0);
      const ts = Math.round((i * 1e6) / fps);
      const opts = { timestamp: ts, duration: Math.round(1e6 / fps), alpha: 'discard' as const };
      const f1 = new VideoFrame(canvas as CanvasImageSource, opts);
      const f2 = new VideoFrame(aCanvas as CanvasImageSource, opts);
      ce.encode(f1, { keyFrame: i === 0 });
      ae.encode(f2, { keyFrame: i === 0 });
      f1.close();
      f2.close();
      if (ce.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all([ce.flush(), ae.flush()]);
    ce.close();
    ae.close();
    const encodeMs = ms(t0);
    if (err) return { error: String(err) };
    const keyMismatch = color.filter((c, i) => alpha[i] && (c.type === 'key') !== (alpha[i].type === 'key')).length;
    const frames = color.map((c, i) => {
      const d = new Uint8Array(c.byteLength);
      c.copyTo(d);
      const ad = new Uint8Array(alpha[i].byteLength);
      alpha[i].copyTo(ad);
      return { data: d, alpha: ad, timestampMs: c.timestamp / 1000, key: c.type === 'key' };
    });
    const file = muxWebM(frames, { width: SIDE, height: SIDE, fps, alpha: true });
    const info = inspectWebM(file);
    const blob = new Blob([file], { type: 'video/webm' });
    const decoded = await decodeAlpha(blob);
    return { colorBitrate, alphaBitrate, encodeMs, kb: kb(file.length), fitsTelegram: file.length <= TELEGRAM.video.maxBytes, colorKb: kb(frames.reduce((s, f) => s + f.data.length, 0)), alphaKb: kb(frames.reduce((s, f) => s + f.alpha.length, 0)), keyframes: frames.filter((f) => f.key).length, keyMismatch, info, decoded, _blob: blob };
  };

  const runs: Result[] = [];
  for (const [c, a] of [[500_000, 120_000], [350_000, 80_000], [220_000, 60_000]] as const) {
    const r = await run(c, a);
    const { _blob, ...rest } = r as Result & { _blob?: Blob };
    if (_blob && c === 350_000) preview(`VP9 dual-encoder alpha ${c / 1000}k+${a / 1000}k`, _blob);
    runs.push(rest);
  }
  return { frames: n, fps, runs };
}

/** Plays the WebM in a <video> and reads back alpha at a corner (should be 0) and the centre. */
async function decodeAlpha(blob: Blob): Promise<Result> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.src = URL.createObjectURL(blob);
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('video element could not decode the file'));
      setTimeout(() => rej(new Error('decode timeout')), 8000);
    });
    v.currentTime = 0.5;
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 3000);
    });
    const c = document.createElement('canvas');
    c.width = c.height = SIDE;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(v, 0, 0, SIDE, SIDE);
    const corner = x.getImageData(4, 4, 1, 1).data[3];
    const centre = x.getImageData(256, 440, 1, 1).data[3];
    return { playable: true, durationS: Math.round(v.duration * 100) / 100, cornerAlpha: corner, textAlpha: centre, transparent: corner < 16 && centre > 200 };
  } catch (e) {
    return { playable: false, error: (e as Error).message };
  } finally {
    URL.revokeObjectURL(v.src);
  }
}

/* ---------- 2. Static WebP: libwebp WASM (jsquash) vs canvas ---------- */

export async function webpStatic(preview: Preview): Promise<Result> {
  const img = await frameImageData(0, 1);
  const t0 = now();
  const { default: encode } = await import('@jsquash/webp/encode');
  const loadMs = ms(t0);
  const out: Result = { loadMs };
  for (const q of [90, 75, 50]) {
    const t1 = now();
    const buf = new Uint8Array(await encode(img, { quality: q, method: 4, alpha_quality: 100, exact: 0 }));
    const info = inspectWebP(buf);
    out[`q${q}`] = { ms: ms(t1), kb: kb(buf.length), fitsTelegram: buf.length <= TELEGRAM.static.maxBytes, fitsWhatsApp: buf.length <= WHATSAPP.static.maxBytes, info };
    if (q === 75) preview('WebP libwebp q75', new Blob([buf], { type: 'image/webp' }));
  }
  const t2 = now();
  const buf = new Uint8Array(await encode(img, { lossless: 1, quality: 75, method: 4 }));
  out.lossless = { ms: ms(t2), kb: kb(buf.length), info: inspectWebP(buf) };
  // canvas encoder (unreliable on Safari: it silently returns PNG)
  const c = document.createElement('canvas');
  c.width = c.height = SIDE;
  c.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8));
  out.canvasToBlob = blob ? { type: blob.type, kb: kb(blob.size) } : null;
  return out;
}

/* ---------- 3. Animated WebP: libwebp per frame + our muxer ---------- */

export async function webpAnimated(preview: Preview): Promise<Result> {
  const { default: encode } = await import('@jsquash/webp/encode');
  const { muxAnimatedWebP } = await import('../engine/webp/animmux');
  const results: Result[] = [];
  for (const [seconds, fps, q] of [[3, 15, 60], [6, 12, 50], [10, 10, 45]] as const) {
    const n = seconds * fps;
    const h0 = heapMB();
    const t0 = now();
    const frames = [];
    for (let i = 0; i < n; i++) {
      const img = await frameImageData(i, n);
      frames.push({ webp: new Uint8Array(await encode(img, { quality: q, method: 2, alpha_quality: 90 })), durationMs: Math.round(1000 / fps) });
    }
    const file = muxAnimatedWebP(frames, SIDE, SIDE, 0);
    const info = inspectWebP(file);
    results.push({ seconds, fps, quality: q, frames: n, encodeMs: ms(t0), heapDeltaMB: h0 === null ? null : (heapMB() ?? 0) - h0, kb: kb(file.length), fitsWhatsApp: file.length <= WHATSAPP.animated.maxBytes, info: { ...info, chunks: undefined } });
    if (seconds === 3) preview('Animated WebP 3 s', new Blob([file.slice()], { type: 'image/webp' }));
  }
  return { runs: results };
}

/* ---------- 3b. Animated WebP with libwebp's own WebPAnimEncoder (wasm-webp, MIT; libwebp BSD) ---------- */

export async function webpAnimLibwebp(preview: Preview): Promise<Result> {
  const t0 = now();
  const { encodeAnimation, encoderVersion } = await import('wasm-webp');
  const version = await encoderVersion();
  const loadMs = ms(t0);
  const runs: Result[] = [];
  for (const [seconds, fps, q] of [[3, 15, 60], [3, 10, 45], [6, 12, 50], [10, 10, 45], [10, 8, 30]] as const) {
    const n = seconds * fps;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const img = await frameImageData(i, n);
      frames.push({ data: new Uint8Array(img.data.buffer.slice(0)), duration: Math.round(1000 / fps), config: { lossless: 0, quality: q } });
    }
    const t1 = now();
    const out = await encodeAnimation(SIDE, SIDE, true, frames);
    const encodeMs = ms(t1);
    if (!out) {
      runs.push({ seconds, fps, quality: q, error: 'encoder returned null' });
      continue;
    }
    runs.push({ seconds, fps, quality: q, frames: n, encodeMs, kb: kb(out.length), fitsWhatsApp: out.length <= WHATSAPP.animated.maxBytes, info: { ...inspectWebP(out), chunks: undefined } });
    if (seconds === 3 && fps === 10) preview('Animated WebP (WebPAnimEncoder) 3 s', new Blob([out.slice()], { type: 'image/webp' }));
  }
  return { libwebp: version, loadMs, runs };
}

/* ---------- 4. ffmpeg.wasm single-thread core (GPL build — SPIKE ONLY, loaded from a CDN) ---------- */

const FFMPEG_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

export async function ffmpegWasm(preview: Preview): Promise<Result> {
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const { toBlobURL } = await import('@ffmpeg/util');
  const ff = new FFmpeg();
  const logs: string[] = [];
  ff.on('log', ({ message }) => logs.length < 400 && logs.push(message));
  const t0 = now();
  await ff.load({ coreURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.js`, 'text/javascript'), wasmURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.wasm`, 'application/wasm') });
  const loadMs = ms(t0);
  const family = await loadFont();
  const fps = 30;
  const n = 90;
  const c = makeCanvas();
  const x = ctx2d(c);
  const t1 = now();
  for (let i = 0; i < n; i++) {
    drawFrame(x, i, n, family);
    const blob = c instanceof OffscreenCanvas ? await c.convertToBlob({ type: 'image/png' }) : await new Promise<Blob>((r) => (c as HTMLCanvasElement).toBlob((b) => r(b!), 'image/png'));
    await ff.writeFile(`f${String(i).padStart(3, '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
  }
  const framesMs = ms(t1);
  const out: Result = { loadMs, writeFramesMs: framesMs };
  const h0 = heapMB();
  const t2 = now();
  const code = await ff.exec(['-framerate', String(fps), '-i', 'f%03d.png', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '400k', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '0', '-an', 'out.webm']);
  out.vp9 = { exit: code, encodeMs: ms(t2), heapDeltaMB: h0 === null ? null : (heapMB() ?? 0) - h0 };
  if (code === 0) {
    const data = (await ff.readFile('out.webm')) as Uint8Array;
    Object.assign(out.vp9 as Result, { kb: kb(data.length), info: inspectWebM(data) });
    preview('VP9 ffmpeg.wasm 400k', new Blob([data.slice()], { type: 'video/webm' }));
  }
  const t3 = now();
  const code2 = await ff.exec(['-framerate', String(fps), '-i', 'f%03d.png', '-vf', 'fps=15', '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '60', '-loop', '0', '-an', 'out.webp']);
  out.animatedWebp = { exit: code2, encodeMs: ms(t3) };
  if (code2 === 0) {
    const data = (await ff.readFile('out.webp')) as Uint8Array;
    Object.assign(out.animatedWebp as Result, { kb: kb(data.length), info: inspectWebP(data) });
  }
  if (code !== 0 || code2 !== 0) out.logTail = logs.slice(-15);
  ff.terminate();
  return out;
}

/* ---------- 5. Background removal on the device (onnxruntime-web, WASM, 1 thread) ---------- */

export const MODELS = {
  // Apache-2.0 (Hugging Face model card). Portrait matting.
  modnet_q8: { url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_quantized.onnx', size: 512, norm: 'modnet' as const },
  // U²-Netp, Apache-2.0 weights (xuebinqin/U-2-Net); self-hosted in the static build by `npm run spike:assets`.
  u2netp: { url: '/spike/models/u2netp.onnx', size: 320, norm: 'imagenet' as const },
};

export async function segmentation(preview: Preview, model: keyof typeof MODELS, file?: File | null): Promise<Result> {
  const m = MODELS[model];
  const ort = await import('onnxruntime-web/wasm');
  // the ORT wasm (≈ 15 MB) is self-hosted from the build: this also tests static hosting of a large file
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const t0 = now();
  const res = await fetch(m.url);
  if (!res.ok) return { model, error: `model HTTP ${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const downloadMs = ms(t0);
  const h0 = heapMB();
  const t1 = now();
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const sessionMs = ms(t1);

  // input image: the user's photo if picked, else the synthetic frame on a busy background
  const S = m.size;
  const src = makeCanvas(S, S);
  const sx = ctx2d(src);
  let source: ImageBitmap | null = null;
  if (file) {
    source = await createImageBitmap(file);
    sx.drawImage(source, 0, 0, S, S);
  } else {
    const g = sx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#2a7');
    g.addColorStop(1, '#fd4');
    sx.fillStyle = g;
    sx.fillRect(0, 0, S, S);
    const f = makeCanvas();
    drawFrame(ctx2d(f), 0, 1, await loadFont());
    sx.drawImage(f as CanvasImageSource, 0, 0, S, S);
  }
  const px = sx.getImageData(0, 0, S, S).data;
  const input = new Float32Array(3 * S * S);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < S * S; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const v = px[i * 4 + ch] / 255;
      input[ch * S * S + i] = m.norm === 'modnet' ? (v - 0.5) / 0.5 : (v - mean[ch]) / std[ch];
    }
  }
  const t2 = now();
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) };
  const outMap = await session.run(feeds);
  const inferMs = ms(t2);
  const mask = outMap[session.outputNames[0]].data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < S * S; i++) {
    lo = Math.min(lo, mask[i]);
    hi = Math.max(hi, mask[i]);
  }
  // cut-out preview at the model's resolution
  const cut = sx.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) cut.data[i * 4 + 3] = Math.round(((mask[i] - lo) / (hi - lo || 1)) * 255);
  const outC = makeCanvas(S, S);
  ctx2d(outC).putImageData(cut, 0, 0);
  const blob = outC instanceof OffscreenCanvas ? await outC.convertToBlob({ type: 'image/png' }) : await new Promise<Blob>((r) => (outC as HTMLCanvasElement).toBlob((b) => r(b!), 'image/png'));
  preview(`Cut-out ${model}`, blob);
  await session.release();
  source?.close();
  return { model, modelMB: Math.round(bytes.length / 104857.6) / 10, downloadMs, sessionMs, inferMs, inputSize: S, threads: ort.env.wasm.numThreads, heapDeltaMB: h0 === null ? null : (heapMB() ?? 0) - h0, maskRange: [lo, hi], userPhoto: !!file };
}

/* ---------- 6. Persian text shaping on canvas (visual check) ---------- */

export async function persianText(preview: Preview): Promise<Result> {
  const family = await loadFont();
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 220;
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 512, 220);
  x.fillStyle = '#111';
  x.textAlign = 'right';
  const lines = ['می\u200cخواهم استیکر بسازم', 'پک «گربه\u200cهای Wanger» ۲۰۲۶', 'English + فارسی 123 ۴۵۶'];
  lines.forEach((t, i) => {
    x.direction = 'rtl';
    x.font = `700 34px ${family}`;
    x.fillText(t, 496, 60 + i * 64);
  });
  preview('Persian text (check joining and order by eye)', await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png')));
  return { family, direction: x.direction, note: 'Check by eye: letters joined, ZWNJ in «می\u200cخواهم», Latin and digits in the right place.' };
}

/* ---------- 7. Endpoint request / response sizes (inside Telegram only) ---------- */

export async function endpointLimits(): Promise<Result> {
  if (!insideTelegram()) return { skipped: 'open the page inside Telegram (the endpoints need init data)' };
  const KB = 1024;
  const req: Result[] = [];
  for (const size of [64 * KB, 256 * KB, 512 * KB, 1024 * KB, 2048 * KB, 4096 * KB, 8192 * KB]) {
    const t0 = now();
    try {
      const r = await call<{ received: number }>('spike_echo', { b64: 'A'.repeat(size) });
      req.push({ kb: size / KB, ok: r.received === size, ms: ms(t0) });
    } catch (e) {
      req.push({ kb: size / KB, ok: false, ms: ms(t0), error: (e as Error).message });
      break;
    }
  }
  const res: Result[] = [];
  for (const size of [256 * KB, 1024 * KB, 4096 * KB, 8192 * KB, 16384 * KB]) {
    const t0 = now();
    try {
      const r = await call<{ pad: string }>('spike_echo', { want: size });
      res.push({ kb: size / KB, ok: r.pad.length === size, ms: ms(t0) });
    } catch (e) {
      res.push({ kb: size / KB, ok: false, ms: ms(t0), error: (e as Error).message });
      break;
    }
  }
  return { request: req, response: res };
}

/* ---------- 8. Static hosting: can large files be served from the build? ---------- */

export async function staticHosting(): Promise<Result> {
  const out: Result[] = [];
  let list: number[] = [];
  try {
    list = (await (await fetch('/spike/blobs.json', { cache: 'no-store' })).json()) as number[];
  } catch {
    return { skipped: 'no /spike/blobs.json — build with `npm run spike:assets` first' };
  }
  for (const mb of list) {
    const t0 = now();
    try {
      const r = await fetch(`/spike/blob-${mb}mb.json`, { cache: 'no-store' });
      const n = r.ok ? (await r.arrayBuffer()).byteLength : 0;
      out.push({ mb, status: r.status, ok: n === mb * 1048576, ms: ms(t0), mbps: n ? Math.round((n * 8) / 1048.576 / Math.max(1, ms(t0))) / 1 : 0 });
    } catch (e) {
      out.push({ mb, ok: false, error: (e as Error).message });
    }
  }
  return { files: out };
}
