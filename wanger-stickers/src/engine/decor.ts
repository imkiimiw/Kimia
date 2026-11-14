// Templates (Phase 4): vector decorations drawn around or over the art — no image assets, so they
// stay sharp at any size and cost nothing to ship. Some leave room for themselves (`inset`), some
// draw a layer under the art (the polaroid card), the rest draw over it. Their text uses the same
// shaped-text renderer as text layers (Persian joins correctly).
import type { Ctx } from './image';
import { drawText, type TextLayer } from './text';

export const DECORS = ['none', 'bubble', 'thought', 'banner', 'frame', 'polaroid', 'sparkles', 'hearts', 'burst', 'tape'] as const;
export type DecorKind = (typeof DECORS)[number];

export interface Decor {
  kind: DecorKind;
  color: string;
  text: string;
}

export const DECOR_DEFAULT_COLOR: Record<DecorKind, string> = {
  none: '#ffffff', bubble: '#ffffff', thought: '#ffffff', banner: '#e5394b', frame: '#ffffff', polaroid: '#ffffff', sparkles: '#ffd43b', hearts: '#ff4d6d', burst: '#ff9f1c', tape: '#f7e7a1',
};

/** Room (fractions of the canvas) the art must leave free for the decoration. */
export function decorInset(d: Decor | null | undefined): { top: number; right: number; bottom: number; left: number } {
  const z = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!d || d.kind === 'none') return z;
  if (d.kind === 'bubble' || d.kind === 'thought') return { ...z, top: 0.3 };
  if (d.kind === 'banner') return { ...z, bottom: 0.2 };
  if (d.kind === 'polaroid') return { top: 0.07, left: 0.07, right: 0.07, bottom: d.text.trim() ? 0.22 : 0.12 };
  if (d.kind === 'frame') return { top: 0.05, left: 0.05, right: 0.05, bottom: 0.05 };
  return z;
}

const textLayer = (text: string, x: number, y: number, size: number, color: string, maxWidth: number, stroke = ''): TextLayer => ({
  id: 'decor', text, font: 'vazirmatn', size, color, stroke, strokeWidth: stroke ? 3 : 0, shadow: false, x, y, rotation: 0, maxWidth,
});

function roundRect(x: Ctx, a: number, b: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(a + r, b);
  x.arcTo(a + w, b, a + w, b + h, r);
  x.arcTo(a + w, b + h, a, b + h, r);
  x.arcTo(a, b + h, a, b, r);
  x.arcTo(a, b, a + w, b, r);
  x.closePath();
}

function star(x: Ctx, cx: number, cy: number, r: number, points: number, inner: number) {
  x.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 ? r * inner : r;
    const a = (i * Math.PI) / points - Math.PI / 2;
    if (i) x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else x.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  x.closePath();
}

function heart(x: Ctx, cx: number, cy: number, s: number) {
  x.beginPath();
  x.moveTo(cx, cy + s * 0.35);
  x.bezierCurveTo(cx - s * 0.9, cy - s * 0.3, cx - s * 0.35, cy - s * 0.95, cx, cy - s * 0.4);
  x.bezierCurveTo(cx + s * 0.35, cy - s * 0.95, cx + s * 0.9, cy - s * 0.3, cx, cy + s * 0.35);
  x.closePath();
}

/** Parts drawn BEFORE the art (the polaroid card). */
export function drawDecorUnder(x: Ctx, d: Decor | null | undefined, W: number, H: number, scale: number): void {
  if (!d || d.kind !== 'polaroid') return;
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.3)';
  x.shadowBlur = 10 * scale;
  x.shadowOffsetY = 3 * scale;
  x.fillStyle = d.color;
  roundRect(x, 4 * scale, 4 * scale, W - 8 * scale, H - 10 * scale, 10 * scale);
  x.fill();
  x.restore();
}

/** Parts drawn AFTER the art. `phase` (0..1) animates sparkles and hearts in animated outputs. */
export function drawDecorOver(x: Ctx, d: Decor | null | undefined, W: number, H: number, scale: number, phase = 0): void {
  if (!d || d.kind === 'none') return;
  const s = Math.min(W, H);
  const lw = Math.max(2, 4 * scale);
  x.save();
  x.lineJoin = 'round';
  switch (d.kind) {
    case 'bubble': {
      const bx = W * 0.08, by = H * 0.02, bw = W * 0.84, bh = H * 0.22;
      roundRect(x, bx, by, bw, bh, bh * 0.35);
      x.moveTo(bx + bw * 0.3, by + bh);
      x.lineTo(bx + bw * 0.24, by + bh + H * 0.07);
      x.lineTo(bx + bw * 0.42, by + bh);
      x.fillStyle = d.color;
      x.strokeStyle = '#111111';
      x.lineWidth = lw;
      x.fill();
      x.stroke();
      if (d.text.trim()) drawText(x, textLayer(d.text, 0.5, (by + bh / 2) / H, 52, '#111111', 0.76), W, H, scale);
      break;
    }
    case 'thought': {
      x.fillStyle = d.color;
      x.strokeStyle = '#111111';
      x.lineWidth = lw;
      x.beginPath();
      x.ellipse(W * 0.5, H * 0.13, W * 0.42, H * 0.11, 0, 0, Math.PI * 2);
      x.fill();
      x.stroke();
      for (const [cx, cy, r] of [[0.3, 0.27, 0.03], [0.24, 0.32, 0.018]]) {
        x.beginPath();
        x.arc(W * cx, H * cy, s * r, 0, Math.PI * 2);
        x.fill();
        x.stroke();
      }
      if (d.text.trim()) drawText(x, textLayer(d.text, 0.5, 0.13, 48, '#111111', 0.72), W, H, scale);
      break;
    }
    case 'banner': {
      const y = H * 0.8, h = H * 0.15, x0 = W * 0.04, w = W * 0.92, fold = W * 0.06;
      x.fillStyle = shade(d.color, -0.25);
      x.fillRect(x0 - fold * 0.2, y + h * 0.2, fold * 1.4, h);
      x.fillRect(x0 + w - fold * 1.2, y + h * 0.2, fold * 1.4, h);
      x.fillStyle = d.color;
      x.beginPath();
      x.moveTo(x0 + fold * 0.6, y);
      x.lineTo(x0 + w - fold * 0.6, y);
      x.lineTo(x0 + w - fold * 0.6, y + h);
      x.lineTo(x0 + fold * 0.6, y + h);
      x.closePath();
      x.fill();
      if (d.text.trim()) drawText(x, textLayer(d.text, 0.5, (y + h / 2) / H, 46, '#ffffff', 0.74), W, H, scale);
      break;
    }
    case 'frame': {
      x.strokeStyle = d.color;
      x.lineWidth = 10 * scale;
      x.shadowColor = 'rgba(0,0,0,0.25)';
      x.shadowBlur = 6 * scale;
      roundRect(x, 8 * scale, 8 * scale, W - 16 * scale, H - 16 * scale, 24 * scale);
      x.stroke();
      break;
    }
    case 'polaroid': {
      if (d.text.trim()) drawText(x, textLayer(d.text, 0.5, 0.88, 44, '#222222', 0.8), W, H, scale);
      break;
    }
    case 'sparkles': {
      const spots = [[0.1, 0.12, 0.07], [0.88, 0.18, 0.05], [0.14, 0.82, 0.05], [0.9, 0.86, 0.07], [0.5, 0.05, 0.035]];
      x.fillStyle = d.color;
      x.strokeStyle = '#ffffff';
      x.lineWidth = lw * 0.6;
      spots.forEach(([cx, cy, r], i) => {
        const tw = 0.75 + 0.25 * Math.sin((phase + i * 0.2) * Math.PI * 2);
        star(x, W * cx, H * cy, s * r * tw, 4, 0.35);
        x.fill();
        x.stroke();
      });
      break;
    }
    case 'hearts': {
      const spots = [[0.12, 0.2, 0.08], [0.86, 0.14, 0.06], [0.1, 0.78, 0.06], [0.9, 0.8, 0.08]];
      x.fillStyle = d.color;
      x.strokeStyle = '#ffffff';
      x.lineWidth = lw * 0.6;
      spots.forEach(([cx, cy, r], i) => {
        const up = Math.sin((phase + i * 0.25) * Math.PI * 2) * 0.02;
        heart(x, W * cx, H * (cy + up), s * r);
        x.fill();
        x.stroke();
      });
      break;
    }
    case 'burst': {
      const cx = W * 0.8, cy = H * 0.18, r = s * 0.17;
      x.fillStyle = d.color;
      x.strokeStyle = '#ffffff';
      x.lineWidth = lw;
      star(x, cx, cy, r, 12, 0.78);
      x.fill();
      x.stroke();
      if (d.text.trim()) drawText(x, { ...textLayer(d.text, cx / W, cy / H, 34, '#ffffff', (r * 1.3) / W), rotation: -12 }, W, H, scale);
      break;
    }
    case 'tape': {
      x.fillStyle = d.color;
      x.globalAlpha = 0.85;
      for (const [cx, cy, a] of [[0.12, 0.08, -0.6], [0.88, 0.08, 0.6]]) {
        x.save();
        x.translate(W * cx, H * cy);
        x.rotate(a);
        x.fillRect(-s * 0.13, -s * 0.035, s * 0.26, s * 0.07);
        x.restore();
      }
      break;
    }
  }
  x.restore();
}

/** A colour lighter (+) or darker (−) by `k` (−1 … 1). */
function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
}
