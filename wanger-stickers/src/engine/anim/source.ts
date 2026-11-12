// Animated sources (browser). One interface for everything the Studio can animate from:
// - video (MP4, MOV, WebM incl. Telegram video stickers with alpha, round videos): an <video>
//   element, seeked to exact times (deterministic, no playback clock; audio never touched);
// - GIF: decoded with omggif (MIT) into full frames, with disposal handled here;
// - TGS (Telegram animated stickers): gunzip (DecompressionStream, fflate fallback) + lottie-web's
//   canvas renderer (MIT, the "light" build without expressions: TGS forbids them);
// - still images (a slideshow of one or more pictures).
// frameAt(ms) draws the frame at that time onto the source's own canvas and returns it.
import { makeCanvas, ctx2d, type Canvas } from '../image';
import { inspectLottie } from '../../../tgcloud/lib/core/inspect.js';

export type SourceKind = 'video' | 'gif' | 'tgs' | 'images';

export interface AnimSource {
  kind: SourceKind;
  width: number;
  height: number;
  durationMs: number;
  /** Native frame rate when the format has one (GIF / TGS); video: undefined. */
  fps?: number;
  /** Whether frames can be transparent (GIF with a transparent index, TGS, WebM with alpha). */
  alpha: boolean;
  frameAt(ms: number): Promise<Canvas>;
  /**
   * Optional: make the frames at these source times fast to read (video: one playback pass that
   * captures them, instead of a seek per frame). Safe to skip; frameAt() works either way.
   */
  prepare?(timesMs: number[], onProgress?: (p: number) => void): Promise<void>;
  close(): void;
}

export interface OpenOptions {
  /** Longest side kept (frames are drawn at most this big; 1080p video → 1024 by default). */
  maxSide?: number;
  /** Per-image duration for a slideshow (ms). */
  slideMs?: number;
}

const fit = (w: number, h: number, max: number) => {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) };
};

/** What a file is, from its first bytes (then its MIME type). */
export async function sniffKind(blob: Blob): Promise<SourceKind | 'image' | null> {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'tgs';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video';
  if (/^video\//.test(blob.type)) return 'video';
  if (/^image\//.test(blob.type) || (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x52 && b[8] === 0x57)) return 'image';
  return null;
}

export async function openSource(blob: Blob, o: OpenOptions = {}): Promise<AnimSource> {
  const kind = await sniffKind(blob);
  if (kind === 'gif') return openGif(blob, o);
  if (kind === 'tgs') return openTgs(blob, o);
  if (kind === 'video') return openVideo(blob, o);
  if (kind === 'image') return openImages([blob], o);
  throw new Error('UNSUPPORTED');
}

/* ------------------------------------------------------------------ video */

export async function openVideo(blob: Blob, o: OpenOptions = {}): Promise<AnimSource> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.src = url;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('VIDEO_TIMEOUT')), 20000);
    v.onloadeddata = () => {
      clearTimeout(t);
      resolve();
    };
    v.onerror = () => {
      clearTimeout(t);
      reject(new Error('DECODE_FAILED'));
    };
  });
  if (!v.videoWidth || !v.videoHeight) throw new Error('DECODE_FAILED');
  const { w, h } = fit(v.videoWidth, v.videoHeight, o.maxSide ?? 720);
  const c = makeCanvas(w, h);
  const x = ctx2d(c, { willReadFrequently: true });
  const durationMs = Number.isFinite(v.duration) ? v.duration * 1000 : 0;
  // WebM may carry alpha (Telegram video stickers): look at the first frame's corner
  x.clearRect(0, 0, w, h);
  x.drawImage(v, 0, 0, w, h);
  const alpha = blob.type === 'video/webm' || (await isWebM(blob)) ? x.getImageData(0, 0, 1, 1).data[3] < 250 || hasAlphaTrack(await blob.slice(0, 4096).arrayBuffer()) : false;
  let last = -1;
  const seek = (sec: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const onSeeked = () => {
        v.removeEventListener('seeked', onSeeked);
        // make sure the new frame is presented before drawing it
        const rvfc = (v as VideoWithRvfc).requestVideoFrameCallback;
        if (rvfc) {
          rvfc.call(v, finish);
          setTimeout(finish, 120);
        } else finish();
      };
      v.addEventListener('seeked', onSeeked);
      setTimeout(finish, 3000);
      v.currentTime = sec;
    });
  // frames captured by prepare(): sorted by media time
  let cache: { m: number; c: Canvas }[] = [];
  const cached = (t: number): Canvas | null => {
    if (!cache.length) return null;
    let lo = 0, hi = cache.length - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cache[mid].m <= t + 2) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k < 0) k = 0;
    // a captured frame further than ~2 source frames away means playback dropped frames there
    return Math.abs(cache[k].m - t) <= 70 || (k + 1 < cache.length && cache[k + 1].m - cache[k].m > 70 && t < cache[k + 1].m) ? cache[k].c : null;
  };
  return {
    kind: 'video',
    width: w,
    height: h,
    durationMs,
    alpha,
    async frameAt(ms: number) {
      const t = Math.max(0, Math.min(ms, Math.max(0, durationMs - 1)));
      const hit = cached(t);
      x.clearRect(0, 0, w, h);
      if (hit) {
        x.drawImage(hit as CanvasImageSource, 0, 0);
        return c;
      }
      if (Math.abs(t / 1000 - last) > 1e-4) {
        await seek(t / 1000 + 1e-4);
        last = t / 1000;
      }
      x.drawImage(v, 0, 0, w, h);
      return c;
    },
    async prepare(timesMs: number[], onProgress?: (p: number) => void) {
      const rvfc = (v as VideoWithRvfc).requestVideoFrameCallback;
      if (!rvfc || !timesMs.length) return;
      const need = [...new Set(timesMs.map((t) => Math.round(Math.max(0, Math.min(t, durationMs - 1)))))].sort((a, b) => a - b);
      const from = need[0];
      const to = need[need.length - 1];
      cache = [];
      await seek(Math.max(0, from - 40) / 1000);
      last = -1;
      let next = 0; // first needed time not yet covered
      await new Promise<void>((resolve) => {
        let stall: ReturnType<typeof setTimeout>;
        const stop = () => {
          clearTimeout(stall);
          v.pause();
          resolve();
        };
        const arm = () => {
          clearTimeout(stall);
          stall = setTimeout(stop, 2500); // no frame for 2.5 s: give up, frameAt() seeks the rest
        };
        const onFrame = (_now: number, meta: { mediaTime: number }) => {
          const m = meta.mediaTime * 1000;
          // keep this frame if it is the last one before a needed time (or covers it)
          if (next < need.length && m >= need[next] - 40) {
            const f = makeCanvas(w, h);
            ctx2d(f).drawImage(v, 0, 0, w, h);
            cache.push({ m, c: f });
            while (next < need.length && need[next] <= m + 20) next++;
            onProgress?.(Math.min(1, next / need.length));
          }
          if (m >= to || next >= need.length || v.ended) return stop();
          arm();
          rvfc.call(v, onFrame);
        };
        rvfc.call(v, onFrame);
        v.playbackRate = to - from > 4000 ? 2 : 1;
        arm();
        v.play().catch(stop);
      });
      cache.sort((a, b) => a.m - b.m);
    },
    close() {
      cache = [];
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
    },
  };
}

type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };

async function isWebM(blob: Blob) {
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}
/** AlphaMode = 1 (0x53C0 0x81 0x01) in the WebM header. */
function hasAlphaTrack(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf);
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x53 && b[i + 1] === 0xc0 && b[i + 2] === 0x81 && b[i + 3] === 0x01) return true;
  return false;
}

/* ------------------------------------------------------------------ GIF */

export async function openGif(blob: Blob, o: OpenOptions = {}): Promise<AnimSource> {
  const { GifReader } = (await import('omggif')) as unknown as { GifReader: new (b: Uint8Array) => GifReaderT };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const r = new GifReader(bytes);
  const W = r.width, H = r.height;
  const n = Math.min(r.numFrames(), 1000);
  if (!n) throw new Error('DECODE_FAILED');
  // compose every frame fully (disposal 2 = clear the rect, 3 = restore the previous picture)
  const frames: ImageData[] = [];
  const starts: number[] = [];
  let pixels = new Uint8ClampedArray(W * H * 4);
  let t = 0;
  let alpha = false;
  for (let i = 0; i < n; i++) {
    const info = r.frameInfo(i);
    const before = info.disposal === 3 ? pixels.slice() : null;
    r.decodeAndBlitFrameRGBA(i, pixels as unknown as Uint8Array);
    frames.push(new ImageData(pixels.slice(), W, H));
    starts.push(t);
    t += Math.max(20, (info.delay || 10) * 10); // browsers play < 20 ms as 100 ms; we use ≥ 20
    if (info.transparent_index !== null && info.transparent_index !== undefined) alpha = true;
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height; y++) pixels.fill(0, (y * W + info.x) * 4, (y * W + info.x + info.width) * 4);
    } else if (info.disposal === 3 && before) pixels = before;
  }
  const durationMs = t;
  const { w, h } = fit(W, H, o.maxSide ?? 1024);
  const raw = makeCanvas(W, H);
  const rx = ctx2d(raw);
  const c = makeCanvas(w, h);
  const x = ctx2d(c);
  let shown = -1;
  const avgMs = durationMs / n;
  return {
    kind: 'gif',
    width: w,
    height: h,
    durationMs,
    fps: Math.min(50, Math.round(1000 / avgMs)),
    alpha,
    async frameAt(ms: number) {
      const tt = ((ms % durationMs) + durationMs) % durationMs;
      let i = 0;
      let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= tt) {
          i = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (i !== shown) {
        rx.putImageData(frames[i], 0, 0);
        x.clearRect(0, 0, w, h);
        x.imageSmoothingQuality = 'high';
        x.drawImage(raw as CanvasImageSource, 0, 0, w, h);
        shown = i;
      }
      return c;
    },
    close() {
      frames.length = 0;
    },
  };
}

interface GifReaderT {
  width: number;
  height: number;
  numFrames(): number;
  frameInfo(i: number): { x: number; y: number; width: number; height: number; delay: number; disposal: number; transparent_index: number | null };
  decodeAndBlitFrameRGBA(i: number, pixels: Uint8Array): void;
}

/* ------------------------------------------------------------------ TGS (Lottie) */

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const { gunzipSync } = await import('fflate');
  return gunzipSync(bytes);
}

export async function openTgs(blob: Blob, o: OpenOptions = {}): Promise<AnimSource> {
  const json = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(await blob.arrayBuffer()))));
  const info = inspectLottie(json);
  if (info.error) throw new Error('DECODE_FAILED');
  const lottie = (await import('lottie-web/build/player/lottie_light_canvas')).default as unknown as LottieT;
  const side = Math.min(o.maxSide ?? 512, 512);
  const c = document.createElement('canvas');
  c.width = side;
  c.height = side;
  const ctx = c.getContext('2d')!;
  // no container: with one, lottie-web makes its own canvas and ignores `context`
  const anim = lottie.loadAnimation({
    renderer: 'canvas',
    loop: false,
    autoplay: false,
    animationData: json,
    rendererSettings: { context: ctx, clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' },
  });
  await new Promise<void>((resolve) => {
    if (anim.isLoaded) resolve();
    else anim.addEventListener('DOMLoaded', () => resolve());
    setTimeout(resolve, 3000);
  });
  const frames = Math.max(1, info.frames!);
  const fps = info.fps!;
  // lottie skips rendering a frame it thinks is already shown, so draw frame 0 explicitly once
  anim.goToAndStop(Math.min(1, frames - 1), true);
  anim.goToAndStop(0, true);
  let shown = 0;
  return {
    kind: 'tgs',
    width: side,
    height: side,
    durationMs: (frames * 1000) / fps,
    fps: Math.round(fps),
    alpha: true,
    async frameAt(ms: number) {
      const f = Math.min(frames - 1, Math.max(0, Math.floor((ms * fps) / 1000)));
      if (f !== shown) {
        anim.goToAndStop(f, true); // clearCanvas: lottie clears before drawing
        shown = f;
      }
      return c;
    },
    close() {
      anim.destroy();
    },
  };
}

interface LottieT {
  loadAnimation(o: Record<string, unknown>): { isLoaded: boolean; addEventListener(e: string, f: () => void): void; goToAndStop(v: number, isFrame: boolean): void; destroy(): void };
}

/* ------------------------------------------------------------------ still images (slideshow) */

export async function openImages(blobs: Blob[], o: OpenOptions = {}): Promise<AnimSource> {
  const { loadImage } = await import('../image');
  const imgs: Canvas[] = [];
  for (const b of blobs) imgs.push(await loadImage(b, o.maxSide ?? 1024));
  const W = Math.max(...imgs.map((i) => i.width));
  const H = Math.max(...imgs.map((i) => i.height));
  const slide = Math.max(20, o.slideMs ?? 1000);
  const c = makeCanvas(W, H);
  const x = ctx2d(c);
  let shown = -1;
  return {
    kind: 'images',
    width: W,
    height: H,
    durationMs: blobs.length === 1 ? 3000 : slide * imgs.length,
    alpha: true,
    async frameAt(ms: number) {
      const i = imgs.length === 1 ? 0 : Math.min(imgs.length - 1, Math.floor(Math.max(0, ms) / slide));
      if (i !== shown) {
        const im = imgs[i];
        x.clearRect(0, 0, W, H);
        const k = Math.min(W / im.width, H / im.height);
        x.drawImage(im as CanvasImageSource, (W - im.width * k) / 2, (H - im.height * k) / 2, im.width * k, im.height * k);
        shown = i;
      }
      return c;
    },
    close() {
      imgs.length = 0;
    },
  };
}
