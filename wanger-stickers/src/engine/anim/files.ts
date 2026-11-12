// Simple outputs from rendered frames: a ZIP of PNG frames (stored entries, the same writer the
// server uses) and single PNG frames.
import { makeZip } from '../../../tgcloud/lib/core/zip.js';
import { makeCanvas, ctx2d, canvasToBlob } from '../image';
import { OUTPUT } from '../limits';
import type { Renderer } from './compose';
import type { Plan } from './timeline';

export async function framesZip(r: Renderer, plan: Plan, onProgress?: (p: number) => void): Promise<Uint8Array> {
  const n = Math.min(plan.frames.length, OUTPUT.zip.maxEntries);
  const entries: { name: string; data: Uint8Array }[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const c = await r.draw(plan.frames[i]);
    const data = new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer());
    total += data.length;
    if (total > OUTPUT.zip.maxBytes - 1024 * 64) throw new Error('TOO_BIG');
    entries.push({ name: `frame_${String(i + 1).padStart(3, '0')}.png`, data });
    if (onProgress && i % 5 === 0) onProgress((i + 1) / n);
  }
  return makeZip(entries, Math.floor(Date.now() / 1000));
}

/** A copy of one rendered frame (e.g. the first frame → the static editor or a tray icon). */
export async function frameCanvas(r: Renderer, f: Plan['frames'][number]) {
  const c = await r.draw(f);
  const out = makeCanvas(c.width, c.height);
  ctx2d(out).drawImage(c as CanvasImageSource, 0, 0);
  return out;
}
