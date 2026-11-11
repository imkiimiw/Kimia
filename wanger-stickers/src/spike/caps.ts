// What this webview can do. Capability detection is how the engine will pick an encoder per device.
import { tg } from './tg';

// (module (func (result v128) i32.const 0 i32x4.splat)) — validates only where WASM SIMD exists
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

async function canvasWebP(): Promise<boolean> {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

async function vp9(alpha: 'keep' | 'discard'): Promise<boolean | string> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const r = await VideoEncoder.isConfigSupported({ codec: 'vp09.00.10.08', width: 512, height: 512, bitrate: 400_000, framerate: 30, alpha });
    return !!r.supported;
  } catch (e) {
    return String((e as Error).message);
  }
}

async function h264(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return !!(await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 512, height: 512, bitrate: 800_000, framerate: 30 })).supported;
  } catch {
    return false;
  }
}

export async function capabilities(): Promise<Record<string, unknown>> {
  const w = tg();
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown };
  const perf = performance as Performance & { memory?: { jsHeapSizeLimit: number } };
  const c2d = document.createElement('canvas').getContext('2d');
  return {
    telegram: w ? { platform: w.platform, version: w.version, colorScheme: w.colorScheme, inside: !!w.initData } : null,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    deviceMemoryGB: nav.deviceMemory ?? null,
    jsHeapLimitMB: perf.memory ? Math.round(perf.memory.jsHeapSizeLimit / 1048576) : null,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
    crossOriginIsolated: self.crossOriginIsolated ?? false,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    wasmSimd: typeof WebAssembly !== 'undefined' && WebAssembly.validate(SIMD),
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    createImageBitmap: typeof createImageBitmap !== 'undefined',
    canvasDirection: !!c2d && 'direction' in c2d,
    canvasWebPEncode: await canvasWebP(),
    fontFace: typeof FontFace !== 'undefined',
    webCodecs: { VideoEncoder: typeof VideoEncoder !== 'undefined', VideoDecoder: typeof VideoDecoder !== 'undefined', ImageDecoder: typeof (self as unknown as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined' },
    vp9EncodeAlpha: await vp9('keep'),
    vp9EncodeNoAlpha: await vp9('discard'),
    h264Encode: await h264(),
    decompressionStream: typeof DecompressionStream !== 'undefined',
    compressionStream: typeof CompressionStream !== 'undefined',
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
    webgpu: !!nav.gpu,
    indexedDB: typeof indexedDB !== 'undefined',
    worker: typeof Worker !== 'undefined',
  };
}
