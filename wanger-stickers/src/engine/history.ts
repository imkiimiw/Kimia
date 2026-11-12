// Undo / redo for the editor (≥ 50 steps, brief §9). A snapshot holds the mask bytes and the
// small parts of the document; the source image is shared (it never changes).
import type { StickerDoc } from './render';

type Snap = Omit<StickerDoc, 'src' | 'mask'> & { mask: Uint8ClampedArray };

const snap = (d: StickerDoc): Snap => ({
  rotate: d.rotate,
  flip: d.flip,
  shape: d.shape,
  outline: { ...d.outline },
  shadow: d.shadow,
  adjust: { ...d.adjust },
  texts: d.texts.map((t) => ({ ...t })),
  mask: d.mask.data.slice(),
});

export class History {
  private past: Snap[] = [];
  private future: Snap[] = [];
  readonly limit: number;
  constructor(limit = 60) {
    this.limit = limit;
  }
  /** Call BEFORE changing the document. */
  push(d: StickerDoc): void {
    this.past.push(snap(d));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  undo(d: StickerDoc): boolean {
    const s = this.past.pop();
    if (!s) return false;
    this.future.push(snap(d));
    apply(d, s);
    return true;
  }
  redo(d: StickerDoc): boolean {
    const s = this.future.pop();
    if (!s) return false;
    this.past.push(snap(d));
    apply(d, s);
    return true;
  }
}

function apply(d: StickerDoc, s: Snap) {
  d.rotate = s.rotate;
  d.flip = s.flip;
  d.shape = s.shape;
  d.outline = { ...s.outline };
  d.shadow = s.shadow;
  d.adjust = { ...s.adjust };
  d.texts = s.texts.map((t) => ({ ...t }));
  d.mask.data.set(s.mask);
}
