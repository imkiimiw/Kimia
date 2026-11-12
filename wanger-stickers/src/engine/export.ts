// Export: render → libwebp (WASM; Safari can't reliably encode WebP from a canvas) with bounded
// size targeting (≤ 6 encodes, brief §10) → the same validator the server runs. Telegram: PNG
// fallback if the WebP encoder can't load. WhatsApp: 512×512 with a margin, ≤ 100 KB, + tray icon.
import { renderSticker, type StickerDoc } from './render';
import { ctx2d, canvasToBlob, makeCanvas, type Canvas } from './image';
import { TELEGRAM, WHATSAPP, SIZE_TARGETING } from './limits';
import { validateTelegramStatic, validateWhatsAppStatic, validateWhatsAppTray } from '../../tgcloud/lib/core/validate.js';

export interface ExportResult {
  bytes: Uint8Array;
  format: 'webp' | 'png';
  width: number;
  height: number;
  quality: number | null;
  encodes: number;
  violations: string[];
}

type WebpEncode = (d: ImageData, o: Record<string, number>) => Promise<ArrayBuffer>;
async function webpEncoder(): Promise<WebpEncode | null> {
  try {
    const mod = await import('@jsquash/webp/encode');
    return mod.default as unknown as WebpEncode;
  } catch {
    return null;
  }
}

/** Quality search (≤ 6 encodes): the highest quality ≤ max bytes, or null. */
async function searchWebp(encode: WebpEncode, img: ImageData, max: number): Promise<{ bytes: Uint8Array; q: number; n: number } | null> {
  let lo = 20;
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
  return best ? { bytes: best, q: bestQ, n } : null;
}

/**
 * WhatsApp static sticker: exactly 512×512, the art centred with a transparent margin (outlines are
 * never clipped), WebP ≤ 100 KB (quality search; WhatsApp has no PNG option).
 */
export async function toWhatsAppStatic(doc: StickerDoc): Promise<ExportResult & { canvas: Canvas }> {
  const r = renderSticker(doc);
  if (!r) throw new Error('EMPTY');
  const canvas = waCanvas(r.canvas);
  const img = ctx2d(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const encode = await webpEncoder();
  if (!encode) throw new Error('NO_WEBP');
  const best = await searchWebp(encode, img, WHATSAPP.static.maxBytes);
  if (!best) throw new Error('TOO_BIG');
  return { bytes: best.bytes, format: 'webp', width: canvas.width, height: canvas.height, quality: best.q, encodes: best.n, violations: validateWhatsAppStatic(best.bytes).violations, canvas };
}

/** Any sticker canvas → 512×512 with the WhatsApp margin. */
export function waCanvas(src: Canvas): Canvas {
  const S = WHATSAPP.static.width;
  const inner = S - WHATSAPP.marginPx * 2;
  const k = Math.min(inner / src.width, inner / src.height);
  const w = Math.round(src.width * k), h = Math.round(src.height * k);
  const out = makeCanvas(S, S);
  const x = ctx2d(out);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src as CanvasImageSource, (S - w) / 2, (S - h) / 2, w, h);
  return out;
}

/** WhatsApp tray icon: PNG, exactly 96×96, ≤ 50 KB, from any sticker frame. */
export async function trayIcon(src: Canvas): Promise<{ bytes: Uint8Array; violations: string[] }> {
  const T = WHATSAPP.tray;
  const out = makeCanvas(T.width, T.height);
  const x = ctx2d(out);
  const k = Math.min(T.width / src.width, T.height / src.height);
  const w = src.width * k, h = src.height * k;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src as CanvasImageSource, (T.width - w) / 2, (T.height - h) / 2, w, h);
  const bytes = new Uint8Array(await (await canvasToBlob(out, 'image/png')).arrayBuffer());
  return { bytes, violations: validateWhatsAppTray(bytes).violations };
}

export async function toTelegramStatic(doc: StickerDoc): Promise<ExportResult> {
  const r = renderSticker(doc);
  if (!r) throw new Error('EMPTY');
  const img = ctx2d(r.canvas, { willReadFrequently: true }).getImageData(0, 0, r.width, r.height);
  const max = TELEGRAM.static.maxBytes;
  const encode = await webpEncoder();
  if (encode) {
    const best = await searchWebp(encode, img, max);
    if (best) {
      const v = validateTelegramStatic(best.bytes, 'webp');
      return { bytes: best.bytes, format: 'webp', width: r.width, height: r.height, quality: best.q, encodes: best.n, violations: v.violations };
    }
  }
  const png = new Uint8Array(await (await canvasToBlob(r.canvas, 'image/png')).arrayBuffer());
  const v = validateTelegramStatic(png, 'png');
  return { bytes: png, format: 'png', width: r.width, height: r.height, quality: null, encodes: 1, violations: v.violations };
}
