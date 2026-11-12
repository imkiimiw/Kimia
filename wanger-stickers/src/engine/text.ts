// Text layers drawn by the browser's own text engine (Persian shaping + bidi), with bundled OFL
// fonts loaded through FontFace. Each layer's base direction comes from its first strong
// character (Persian → rtl, Latin → ltr), so mixed text keeps the order a reader expects
// (SPIKE_REPORT §4.3 #5).
import vazirAr from '@fontsource/vazirmatn/files/vazirmatn-arabic-700-normal.woff2?url';
import vazirLat from '@fontsource/vazirmatn/files/vazirmatn-latin-700-normal.woff2?url';
import lalezarAr from '@fontsource/lalezar/files/lalezar-arabic-400-normal.woff2?url';
import lalezarLat from '@fontsource/lalezar/files/lalezar-latin-400-normal.woff2?url';
import interLat from '@fontsource/inter/files/inter-latin-800-normal.woff2?url';
import type { Ctx } from './image';
import { baseDirection } from './direction';
export { baseDirection };

const ARABIC = 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

export const FONTS = {
  vazirmatn: { family: 'WS Vazirmatn', weight: '700', faces: [[vazirAr, ARABIC], [vazirLat, LATIN]] },
  lalezar: { family: 'WS Lalezar', weight: '400', faces: [[lalezarAr, ARABIC], [lalezarLat, LATIN]] },
  inter: { family: 'WS Inter', weight: '800', faces: [[interLat, LATIN]] },
} as const;
export type FontKey = keyof typeof FONTS;

const loaded = new Map<FontKey, Promise<void>>();
export function loadFont(key: FontKey): Promise<void> {
  if (!loaded.has(key)) {
    const f = FONTS[key];
    loaded.set(key, Promise.all(f.faces.map(async ([url, range]) => {
      const face = new FontFace(f.family, `url(${url})`, { weight: f.weight, unicodeRange: range });
      await face.load();
      document.fonts.add(face);
    })).then(() => undefined).catch(() => undefined));
  }
  return loaded.get(key)!;
}

export interface TextLayer {
  id: string;
  text: string;
  font: FontKey;
  size: number; // px at the 512 canvas
  color: string;
  stroke: string; // outline colour ('' = none)
  strokeWidth: number;
  shadow: boolean;
  x: number; // centre, 0..1 of the sticker canvas
  y: number;
  rotation: number; // degrees
}

/** Draws a (possibly multi-line) text layer centred at its position. scale = canvas px per 512-px unit. */
export function drawText(x: Ctx, layer: TextLayer, W: number, H: number, scale: number): void {
  if (!layer.text.trim()) return;
  const f = FONTS[layer.font];
  const size = layer.size * scale;
  const lines = layer.text.split('\n');
  x.save();
  x.translate(layer.x * W, layer.y * H);
  x.rotate((layer.rotation * Math.PI) / 180);
  x.font = `${f.weight} ${size}px "${f.family}", system-ui, sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  (x as CanvasRenderingContext2D).direction = baseDirection(layer.text);
  x.lineJoin = 'round';
  x.miterLimit = 2;
  const lh = size * 1.25;
  const top = -((lines.length - 1) * lh) / 2;
  if (layer.shadow) {
    x.shadowColor = 'rgba(0,0,0,0.45)';
    x.shadowBlur = 6 * scale;
    x.shadowOffsetY = 2 * scale;
  }
  lines.forEach((line, i) => {
    const y = top + i * lh;
    if (layer.stroke && layer.strokeWidth > 0) {
      x.lineWidth = layer.strokeWidth * 2 * scale;
      x.strokeStyle = layer.stroke;
      x.strokeText(line, 0, y);
      x.shadowColor = 'transparent';
    }
    x.fillStyle = layer.color;
    x.fillText(line, 0, y);
  });
  x.restore();
}

/** Approximate box of a layer (for hit-testing), in canvas px. */
export function textBox(x: Ctx, layer: TextLayer, W: number, H: number, scale: number) {
  const f = FONTS[layer.font];
  x.save();
  x.font = `${f.weight} ${layer.size * scale}px "${f.family}", system-ui, sans-serif`;
  const lines = layer.text.split('\n');
  const w = Math.max(...lines.map((l) => x.measureText(l).width), 10);
  x.restore();
  const h = lines.length * layer.size * scale * 1.25;
  return { cx: layer.x * W, cy: layer.y * H, w: w + layer.strokeWidth * 2 * scale, h };
}
