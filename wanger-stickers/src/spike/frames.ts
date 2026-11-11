// Synthetic test material: a 512x512 transparent animation (a bouncing outlined blob + Persian and
// English text), so every device encodes exactly the same content.
import vazirUrl from '@fontsource/vazirmatn/files/vazirmatn-arabic-700-normal.woff2?url';

export const SIDE = 512;
let fontReady: Promise<string> | null = null;

/** Loads Vazirmatn through FontFace (the way the Studio will). Resolves to the family name used. */
export function loadFont(): Promise<string> {
  fontReady ??= (async () => {
    try {
      const face = new FontFace('Vazirmatn', `url(${vazirUrl})`, { weight: '700' });
      await face.load();
      document.fonts.add(face);
      return 'Vazirmatn';
    } catch {
      return 'sans-serif';
    }
  })();
  return fontReady;
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(w = SIDE, h = SIDE): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: OffscreenCanvas | HTMLCanvasElement): Ctx2D {
  const x = c.getContext('2d', { alpha: true }) as Ctx2D | null;
  if (!x) throw new Error('2D canvas unavailable');
  return x;
}

/** Draws frame i of n (t in 0..1) on a transparent canvas. */
export function drawFrame(x: Ctx2D, i: number, n: number, family: string): void {
  const t = i / n;
  x.clearRect(0, 0, SIDE, SIDE);
  const cx = 256 + Math.sin(t * Math.PI * 2) * 120;
  const cy = 230 + Math.cos(t * Math.PI * 4) * 60;
  const r = 110 + Math.sin(t * Math.PI * 2) * 20;
  // white outline + soft shadow, like a real sticker
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.35)';
  x.shadowBlur = 12;
  x.shadowOffsetY = 4;
  x.beginPath();
  x.arc(cx, cy, r + 10, 0, Math.PI * 2);
  x.fillStyle = '#fff';
  x.fill();
  x.restore();
  const g = x.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, r);
  g.addColorStop(0, `hsl(${(t * 360) | 0} 90% 65%)`);
  g.addColorStop(1, `hsl(${((t * 360 + 120) % 360) | 0} 80% 40%)`);
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.fillStyle = g;
  x.fill();
  // Persian + English text, shaped by the browser (direction = rtl)
  x.font = `700 54px ${family}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  if ('direction' in x) (x as CanvasRenderingContext2D).direction = 'rtl';
  x.lineJoin = 'round';
  x.lineWidth = 10;
  x.strokeStyle = '#fff';
  const text = 'سلام Wanger ۱۲۳';
  x.strokeText(text, 256, 440);
  x.fillStyle = '#222';
  x.fillText(text, 256, 440);
}

export async function frameImageData(i: number, n: number): Promise<ImageData> {
  const family = await loadFont();
  const c = makeCanvas();
  const x = ctx2d(c);
  drawFrame(x, i, n, family);
  return x.getImageData(0, 0, SIDE, SIDE);
}
