// On-device background removal (DECISIONS D3): onnxruntime-web, WASM, one thread (Telegram opens
// Mini Apps without cross-origin isolation). Models are self-hosted in the static build and loaded
// only when needed; the browser cache keeps them.
//   general: U²-Netp (Apache-2.0), 320×320, ImageNet normalisation — pets, objects, people
//   person:  MODNet q8 (Apache-2.0), 512×512, (x − 0.5) / 0.5 — cleaner edges on people only
import { makeCanvas, ctx2d, type Canvas } from './image';
import { Mask } from './mask';

export type ModelKind = 'general' | 'person';

const MODELS: Record<ModelKind, { url: string; size: number; norm: 'imagenet' | 'half' }> = {
  general: { url: '/assets/models/u2netp-v1.onnx', size: 320, norm: 'imagenet' },
  person: { url: '/assets/models/modnet-q8-v1.onnx', size: 512, norm: 'half' },
};

type Ort = typeof import('onnxruntime-web/wasm');
let ortPromise: Promise<Ort> | null = null;
const sessions = new Map<ModelKind, Promise<import('onnxruntime-web/wasm').InferenceSession>>();

async function ort(): Promise<Ort> {
  ortPromise ??= import('onnxruntime-web/wasm').then((m) => {
    m.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    return m;
  });
  return ortPromise;
}

async function session(kind: ModelKind, onProgress?: (p: number) => void) {
  if (!sessions.has(kind)) {
    sessions.set(kind, (async () => {
      const o = await ort();
      const res = await fetch(MODELS[kind].url);
      if (!res.ok || !res.body) throw new Error(`MODEL_HTTP_${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total && onProgress) onProgress(Math.min(0.99, got / total));
      }
      const bytes = new Uint8Array(got);
      let o2 = 0;
      for (const p of parts) {
        bytes.set(p, o2);
        o2 += p.length;
      }
      return o.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })());
    sessions.get(kind)!.catch(() => sessions.delete(kind));
  }
  return sessions.get(kind)!;
}

/** Runs the model on the image and returns a mask the size of the image. */
export async function removeBackground(src: Canvas, kind: ModelKind = 'general', onProgress?: (p: number) => void): Promise<Mask> {
  const m = MODELS[kind];
  const s = await session(kind, onProgress);
  const o = await ort();
  const S = m.size;
  const small = makeCanvas(S, S);
  const sx = ctx2d(small, { willReadFrequently: true });
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(src as CanvasImageSource, 0, 0, S, S);
  const px = sx.getImageData(0, 0, S, S).data;
  const input = new Float32Array(3 * S * S);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < S * S; i++) {
    for (let c = 0; c < 3; c++) {
      const v = px[i * 4 + c] / 255;
      input[c * S * S + i] = m.norm === 'half' ? (v - 0.5) / 0.5 : (v - mean[c]) / std[c];
    }
  }
  const out = await s.run({ [s.inputNames[0]]: new o.Tensor('float32', input, [1, 3, S, S]) });
  const data = out[s.outputNames[0]].data as Float32Array;
  onProgress?.(1);
  return Mask.fromModel(data, S, S, src.width, src.height);
}
