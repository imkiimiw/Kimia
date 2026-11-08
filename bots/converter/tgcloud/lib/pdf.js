// PDF page tools (spec §5, §7.4): merge, split, extract / remove / reorder / rotate pages, JPG/PNG →
// PDF. Pure (vendored @cantoo/pdf-lib, no sdk). Mandatory on Serverless (docs/LIMITS.md §3):
// load with parseSpeed: Infinity, save with objectsPerTick: Infinity and useObjectStreams: false.
// The cost of parsing follows the object count, so the guard is the trailer's /Size, not MB.
import { PDFDocument, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from './vendor/pdf-lib.js';
import { ToolError } from './errors.js';
import { jpegInfo, pngInfo, orientationMatrix, displayed } from './images.js';
import { asciiDigits } from './util.js';

const LOAD = { parseSpeed: Infinity, updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false };
const SAVE = { objectsPerTick: Infinity, useObjectStreams: false };
export const A4 = [595.28, 841.89];

/** The largest /Size in the trailer area (≈ number of objects), or null. Cheap: last 64 KB only. */
export function objectCount(b) {
  const tail = new TextDecoder('latin1').decode(b.subarray(Math.max(0, b.length - 65536)));
  let max = null;
  for (const m of tail.matchAll(/\/Size\s+(\d+)/g)) { const n = Number(m[1]); if (max === null || n > max) max = n; }
  return max;
}

/** Loads a PDF for editing; refuses encrypted, damaged and too complex ones. */
export async function loadPdf(bytes, maxObjects) {
  const n = objectCount(bytes);
  if (n !== null && n > maxObjects) throw new ToolError('PDF_TOO_COMPLEX');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, LOAD);
  } catch {
    throw new ToolError('PDF_DAMAGED');
  }
  if (doc.isEncrypted) throw new ToolError('PDF_ENCRYPTED');
  if (doc.getPageCount() < 1) throw new ToolError('PDF_DAMAGED');
  return doc;
}

/** What the file card shows: pages, encryption, objects (null pages when it can't be read). */
export async function pdfInfo(bytes, maxObjects) {
  const objects = objectCount(bytes);
  if (objects !== null && objects > maxObjects) return { pages: null, encrypted: false, objects, problem: 'PDF_TOO_COMPLEX' };
  try {
    const doc = await PDFDocument.load(bytes, LOAD);
    return { pages: doc.getPageCount(), encrypted: !!doc.isEncrypted, objects, problem: doc.isEncrypted ? 'PDF_ENCRYPTED' : null };
  } catch {
    return { pages: null, encrypted: false, objects, problem: 'PDF_DAMAGED' };
  }
}

export async function save(doc) {
  const out = await doc.save(SAVE);
  return out;
}

/**
 * Page ranges typed by users: "1-3,7,10-", "-5", Persian digits, "،" commas, dashes of any kind.
 * → { ok: true, pages: [0-based, in typed order] } | { ok: false, error: 'empty'|'syntax'|'out_of_range', page }
 */
export function parseRanges(text, pageCount) {
  const s = asciiDigits(String(text || '')).replace(/[،,;]/g, ',').replace(/[–—−‐]/g, '-').replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'empty' };
  const pages = [];
  for (const part of s.split(',')) {
    if (!part) continue;
    const m = /^(\d*)-(\d*)$/.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return { ok: false, error: 'syntax' };
    let a;
    let b;
    if (m.length === 2) { a = Number(m[1]); b = a; } else {
      if (!m[1] && !m[2]) return { ok: false, error: 'syntax' };
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : pageCount;
    }
    for (const p of [a, b]) if (p < 1 || p > pageCount) return { ok: false, error: 'out_of_range', page: p };
    if (a <= b) for (let p = a; p <= b; p++) pages.push(p - 1);
    else for (let p = a; p >= b; p--) pages.push(p - 1);
  }
  if (!pages.length) return { ok: false, error: 'empty' };
  return { ok: true, pages };
}

/** A new PDF from the given 0-based page indexes of `doc` (duplicates allowed). */
async function copy(doc, indexes) {
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(doc, indexes);
  for (const p of pages) out.addPage(p);
  return out;
}

export async function extractPages(doc, indexes) {
  const uniq = [...new Set(indexes)].sort((a, b) => a - b);
  return save(await copy(doc, uniq));
}

export async function removePages(doc, indexes) {
  const drop = new Set(indexes);
  const keep = doc.getPageIndices().filter((i) => !drop.has(i));
  if (!keep.length) throw new ToolError('PDF_NOTHING_LEFT');
  return save(await copy(doc, keep));
}

/** The typed order first, then every page not mentioned, in its original order. */
export async function reorderPages(doc, indexes) {
  const seen = new Set();
  const order = [];
  for (const i of indexes) if (!seen.has(i)) { seen.add(i); order.push(i); }
  for (const i of doc.getPageIndices()) if (!seen.has(i)) order.push(i);
  return save(await copy(doc, order));
}

/** Rotates the given pages (null = all) by deg (90, 180, 270), on top of their current rotation. */
export async function rotatePages(doc, indexes, deg) {
  const pages = doc.getPages();
  const set = indexes ? new Set(indexes) : null;
  pages.forEach((p, i) => {
    if (set && !set.has(i)) return;
    const cur = p.getRotation().angle || 0;
    p.setRotation(degrees((((cur + deg) % 360) + 360) % 360));
  });
  return save(doc);
}

/** Split into groups of 0-based indexes → one PDF each. */
export async function splitPages(doc, groups) {
  const out = [];
  for (const g of groups) out.push(await save(await copy(doc, g)));
  return out;
}

/** Groups for splitting: every `n` pages. */
export function everyN(pageCount, n) {
  const groups = [];
  for (let i = 0; i < pageCount; i += n) groups.push(Array.from({ length: Math.min(n, pageCount - i) }, (_, k) => i + k));
  return groups;
}

/** Groups for splitting by typed ranges: each comma-separated range is one part. */
export function rangeGroups(text, pageCount) {
  const groups = [];
  const s = asciiDigits(String(text || '')).replace(/[،;]/g, ',');
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const r = parseRanges(part, pageCount);
    if (!r.ok) return r;
    groups.push(r.pages);
  }
  return groups.length ? { ok: true, groups } : { ok: false, error: 'empty' };
}

/** Adds an image as an A4 page (portrait or landscape by its shape), fitted and centered. */
async function addImagePage(out, item) {
  let img;
  let w;
  let h;
  let o = 1;
  if (item.type === 'jpeg') {
    const info = jpegInfo(item.bytes);
    if (!info) throw new ToolError('IMAGE_DAMAGED');
    try { img = await out.embedJpg(item.bytes); } catch { throw new ToolError('IMAGE_DAMAGED'); }
    w = info.width; h = info.height; o = info.orientation;
  } else {
    if (!pngInfo(item.bytes)) throw new ToolError('IMAGE_DAMAGED');
    try { img = await out.embedPng(item.bytes); } catch { throw new ToolError('IMAGE_DAMAGED'); }
    w = img.width; h = img.height;
  }
  const [dw0, dh0] = displayed(w, h, o);
  const [pw, ph] = dw0 > dh0 ? [A4[1], A4[0]] : A4;
  const scale = Math.min(pw / dw0, ph / dh0);
  const dw = dw0 * scale;
  const dh = dh0 * scale;
  const x = (pw - dw) / 2;
  const y = (ph - dh) / 2;
  const page = out.addPage([pw, ph]);
  const name = page.node.newXObject('Image', img.ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...orientationMatrix(o, x, y, dw, dh)), drawObject(name), popGraphicsState());
}

/**
 * One PDF from items in order: PDFs (all pages) and JPEG/PNG images (one A4 page each).
 * items: [{ type: 'pdf'|'jpeg'|'png', bytes }]
 */
export async function combine(items, { maxObjects, maxPixels }) {
  const px = items.filter((i) => i.type === 'png').reduce((s, i) => { const info = pngInfo(i.bytes); return s + (info ? info.width * info.height : 0); }, 0);
  if (px > maxPixels) throw new ToolError('IMAGE_TOO_BIG', { mp: Math.round(maxPixels / 1e6) });
  const objects = items.filter((i) => i.type === 'pdf').reduce((s, i) => s + (objectCount(i.bytes) || 0), 0);
  if (objects > maxObjects) throw new ToolError('PDF_TOO_COMPLEX');
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const item of items) {
    if (item.type === 'pdf') {
      const doc = await loadPdf(item.bytes, maxObjects);
      const pages = await out.copyPages(doc, doc.getPageIndices());
      for (const p of pages) out.addPage(p);
    } else {
      await addImagePage(out, item);
    }
  }
  return { bytes: await save(out), pages: out.getPageCount() };
}

/** Quick output check: a PDF header, an end marker, and something in between. */
export function looksLikePdf(b) {
  if (!b || b.length < 64) return false;
  const head = new TextDecoder('latin1').decode(b.subarray(0, 8));
  const tail = new TextDecoder('latin1').decode(b.subarray(Math.max(0, b.length - 1024)));
  return head.startsWith('%PDF-') && tail.includes('%%EOF');
}
