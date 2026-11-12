// Export: render → libwebp (WASM; Safari can't reliably encode WebP from a canvas) with bounded
// size targeting (≤ 6 encodes, brief §10) → the same validator the server runs. PNG fallback if
// the WebP encoder can't load.
import { renderSticker, type StickerDoc } from './render';
import { ctx2d, canvasToBlob } from './image';
import { TELEGRAM, SIZE_TARGETING } from './limits';
import { validateTelegramStatic } from '../../tgcloud/lib/core/validate.js';

export interface ExportResult {
  bytes: Uint8Array;
  format: 'webp' | 'png';
  width: number;
  height: number;
  quality: number | null;
  encodes: number;
  violations: string[];
}

export async function toTelegramStatic(doc: StickerDoc): Promise<ExportResult> {
  const r = renderSticker(doc);
  if (!r) throw new Error('EMPTY');
  const img = ctx2d(r.canvas, { willReadFrequently: true }).getImageData(0, 0, r.width, r.height);
  const max = TELEGRAM.static.maxBytes;
  let encode: ((d: ImageData, o: Record<string, number>) => Promise<ArrayBuffer>) | null = null;
  try {
    encode = (await import('@jsquash/webp/encode')).default as never;
  } catch {
    encode = null;
  }
  if (encode) {
    let lo = 40;
    let hi = 95;
    let q = 90;
    let best: Uint8Array | null = null;
    let bestQ = 0;
    let n = 0;
    while (n < SIZE_TARGETING.maxQualitySearchEncodes) {
      n++;
      const bytes = new Uint8Array(await encode(img, { quality: q, method: 4, alpha_quality: 100, exact: 0, use_sharp_yuv: 1 }));
      if (bytes.length <= max) {
        best = bytes;
        bestQ = q;
        if (q >= hi || hi - q <= 4) break;
        lo = q;
      } else hi = q;
      q = Math.round((lo + hi) / 2);
      if (hi - lo <= 4 && best) break;
    }
    if (best) {
      const v = validateTelegramStatic(best, 'webp');
      return { bytes: best, format: 'webp', width: r.width, height: r.height, quality: bestQ, encodes: n, violations: v.violations };
    }
  }
  const png = new Uint8Array(await (await canvasToBlob(r.canvas, 'image/png')).arrayBuffer());
  const v = validateTelegramStatic(png, 'png');
  return { bytes: png, format: 'png', width: r.width, height: r.height, quality: null, encodes: 1, violations: v.violations };
}
