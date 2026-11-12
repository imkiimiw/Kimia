// Decoding and canvases (no React, Telegram or i18n imports: the engine is reusable).

export type Canvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export function ctx2d(c: Canvas, opts: CanvasRenderingContext2DSettings = {}): Ctx {
  const x = c.getContext('2d', { alpha: true, ...opts }) as Ctx | null;
  if (!x) throw new Error('2D canvas unavailable');
  return x;
}

/** Decodes an image (EXIF orientation applied) and downsizes it so the long side ≤ maxSide. */
export async function loadImage(blob: Blob, maxSide = 1024): Promise<Canvas> {
  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // e.g. HEIC on iOS: the <img> element decodes what createImageBitmap refuses
    src = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('DECODE_FAILED'));
      img.src = URL.createObjectURL(blob);
    });
  }
  const w0 = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h0 = 'naturalHeight' in src ? src.naturalHeight : src.height;
  if (!w0 || !h0) throw new Error('DECODE_FAILED');
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const c = makeCanvas(w, h);
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src as CanvasImageSource, 0, 0, w, h);
  if ('close' in src) src.close();
  return c;
}

export async function canvasToBlob(c: Canvas, type = 'image/png', quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('ENCODE_FAILED'))), type, quality));
}

/** Bounding box of pixels with alpha > threshold, or null when empty. */
export function alphaBounds(c: Canvas, threshold = 8): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h } = c;
  const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
