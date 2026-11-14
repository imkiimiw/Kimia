// Drafts on the device (brief §9: "Drafts autosave to IndexedDB on the device; nothing leaves the
// device until the user exports"). One static draft (source image + mask + settings) and one
// animated draft (source file(s) + settings); the newest is offered on the Studio's home.
import type { StickerDoc } from '../engine/render';
import type { AnimDoc } from '../engine/anim/compose';
import type { Tab, AnimMode } from './AnimStudio';

const DB = 'wanger-stickers';
const STORE = 'drafts';

export interface StaticDraft {
  at: number;
  src: Blob;
  w: number;
  h: number;
  mask: Uint8ClampedArray;
  doc: Omit<StickerDoc, 'src' | 'mask'>;
}
export interface AnimDraft {
  at: number;
  blobs: Blob[];
  mode: AnimMode;
  tab: Tab;
  emoji: boolean;
  doc: AnimDoc;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null); // private mode / no IndexedDB: drafts are simply off
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as T) : null);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export const saveDraft = (key: 'static' | 'anim', value: StaticDraft | AnimDraft) => run('readwrite', (s) => s.put(value, key));
export const loadDraft = <T extends StaticDraft | AnimDraft>(key: 'static' | 'anim') => run<T>('readonly', (s) => s.get(key) as IDBRequest<T>);
export const clearDraft = (key: 'static' | 'anim') => run('readwrite', (s) => s.delete(key));

/** The settings part of a static document (what changes while editing). */
export const staticSettings = (d: StickerDoc): StaticDraft['doc'] => ({
  rotate: d.rotate, flip: d.flip, shape: d.shape, outline: { ...d.outline }, shadow: d.shadow, adjust: { ...d.adjust },
  texts: d.texts.map((t) => ({ ...t })), decor: d.decor ? { ...d.decor } : null, strokes: (d.strokes || []).map((s) => ({ ...s, points: s.points.slice() })),
});

/** Calls fn at most once per `ms` (the last call wins). */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}
