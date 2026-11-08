// The in-bot operations, one pure function each: (inputs, params, limits) → { outputs, notes }.
// inputs: [{ bytes, name, type (detected id), size }]; outputs: [{ bytes, name, type, meta? }].
// The job runner (lib/jobs.js) downloads, calls run(), validates and delivers; staff retries and the
// tests use the same functions. Never imports sdk.
import { extract, makeZip, openArchive, zipParts } from './archive.js';
import { detect } from './detect/index.js';
import { TYPES } from './detect/types.js';
import { ToolError } from './errors.js';
import { cleanBase, splitName, renameTo, fixedName, sanitizeName } from './names.js';
import { combine, everyN, extractPages, loadPdf, looksLikePdf, parseRanges, rangeGroups, removePages, reorderPages, rotatePages, splitPages } from './pdf.js';
import { NAME_BASE_MAX } from './config.js';

const MB = 1024 * 1024;

/** base + suffix + .ext with the base shortened so Telegram keeps the whole name (≤ 64). */
export function withSuffix(name, suffix, ext) {
  const base = cleanBase(splitName(name).base) || 'file';
  const room = NAME_BASE_MAX - [...suffix].length;
  return `${[...base].slice(0, Math.max(1, room)).join('')}${suffix}.${ext}`;
}

const pad = (n, width) => String(n).padStart(width, '0');
const pdfOut = (bytes, name, pages) => {
  if (!looksLikePdf(bytes)) throw new ToolError('OUTPUT_INVALID');
  return { bytes, name, type: 'pdf', meta: pages ? { pages } : null };
};

function needRanges(params, pageCount) {
  const r = parseRanges(params.ranges, pageCount);
  if (!r.ok) throw new ToolError('PDF_BAD_RANGE', { pages: pageCount });
  return r.pages;
}

/** Output names of a batch rename: prefix / suffix / numbering / normalize. */
export function batchNames(inputs, mode, value) {
  const width = Math.max(2, String(inputs.length).length);
  return inputs.map((f, i) => {
    const d = { id: f.type, dangerous: TYPES[f.type] && TYPES[f.type].dangerous, extOk: true, ext: (TYPES[f.type] && TYPES[f.type].exts[0]) || '' };
    const ext = splitName(f.name).ext;
    if (mode === 'number') return sanitizeName(`${value}_${pad(i + 1, width)}${ext ? `.${ext}` : ''}`, { fallback: `file_${pad(i + 1, width)}` });
    const r = renameTo(f.name, { ...d, extOk: true, nameExt: ext }, { mode, value });
    return r.ok ? r.name : f.name;
  });
}

const limitsOf = (L) => ({ maxEntries: L.ARCHIVE_MAX_ENTRIES, maxUnpacked: L.ARCHIVE_MAX_UNPACKED_MB * MB, maxRatio: L.ARCHIVE_MAX_RATIO });

function outputsFromFiles(files, maxBytes) {
  const outputs = [];
  const notes = [];
  for (const f of files) {
    if (!f.bytes.length) { notes.push({ key: 'note.empty_skipped', vars: { name: f.name } }); continue; }
    if (f.bytes.length > maxBytes) { notes.push({ key: 'note.big_skipped', vars: { name: f.name } }); continue; }
    const d = detect(f.bytes, f.name);
    outputs.push({ bytes: f.bytes, name: f.name, type: d.id });
  }
  return { outputs, notes };
}

export const OPS = {
  fix: { cacheable: true, run: async ([f], p) => ({ outputs: [{ bytes: f.bytes, name: p.name, type: f.type }] }) },
  rename: { cacheable: true, run: async ([f], p) => ({ outputs: [{ bytes: f.bytes, name: p.name, type: f.type }] }) },

  zip: {
    cacheable: true,
    run: async (inputs, p, L) => {
      const total = inputs.reduce((s, f) => s + f.bytes.length, 0);
      if (total > L.MAX_OUTPUT_MB * MB) throw new ToolError('OUTPUT_TOO_BIG', { mb: L.MAX_OUTPUT_MB });
      const bytes = makeZip(inputs.map((f) => ({ name: f.name, bytes: f.bytes, type: f.type })));
      if (bytes.length > L.MAX_OUTPUT_MB * MB) throw new ToolError('OUTPUT_TOO_BIG', { mb: L.MAX_OUTPUT_MB });
      return { outputs: [{ bytes, name: p.name, type: 'zip' }] };
    },
  },

  extract: {
    heavy: true,
    maxSeparate: 10,
    run: async ([f], p, L) => {
      const arc = openArchive(f.bytes, f.type, f.name, limitsOf(L));
      return outputsFromFiles(extract(arc, limitsOf(L)), L.MAX_OUTPUT_MB * MB);
    },
  },
  extract_one: {
    heavy: true,
    run: async ([f], p, L) => {
      const arc = openArchive(f.bytes, f.type, f.name, limitsOf(L));
      const files = extract(arc, limitsOf(L), [Number(p.index)]);
      if (!files.length) throw new ToolError('ARCHIVE_ENTRY_GONE');
      const r = outputsFromFiles(files, L.MAX_OUTPUT_MB * MB);
      if (!r.outputs.length) throw new ToolError(files[0].bytes.length ? 'OUTPUT_TOO_BIG' : 'ARCHIVE_ENTRY_EMPTY', { mb: L.MAX_OUTPUT_MB });
      return r;
    },
  },
  extract_zip: {
    heavy: true,
    maxSeparate: 50,
    run: async ([f], p, L) => {
      const arc = openArchive(f.bytes, f.type, f.name, limitsOf(L));
      const files = extract(arc, limitsOf(L)).filter((x) => x.bytes.length);
      const { parts, skipped } = zipParts(files, L.MAX_OUTPUT_MB * MB);
      const base = splitName(f.name.replace(/\.tar\.gz$/i, '.tgz')).base;
      const outputs = parts.map((bytes, i) => ({ bytes, name: parts.length === 1 ? withSuffix(base, '', 'zip') : withSuffix(base, `_part${i + 1}`, 'zip'), type: 'zip' }));
      return { outputs, notes: skipped.map((name) => ({ key: 'note.big_skipped', vars: { name } })) };
    },
  },

  pdf_extract: {
    heavy: true,
    cacheable: true,
    run: async ([f], p, L) => {
      const doc = await loadPdf(f.bytes, L.PDF_MAX_OBJECTS);
      const pages = needRanges(p, doc.getPageCount());
      const bytes = await extractPages(doc, pages);
      return { outputs: [pdfOut(bytes, withSuffix(f.name, '_pages', 'pdf'), new Set(pages).size)] };
    },
  },
  pdf_remove: {
    heavy: true,
    cacheable: true,
    run: async ([f], p, L) => {
      const doc = await loadPdf(f.bytes, L.PDF_MAX_OBJECTS);
      const pages = needRanges(p, doc.getPageCount());
      const left = doc.getPageCount() - new Set(pages).size;
      return { outputs: [pdfOut(await removePages(doc, pages), withSuffix(f.name, '_edited', 'pdf'), left)] };
    },
  },
  pdf_reorder: {
    heavy: true,
    cacheable: true,
    run: async ([f], p, L) => {
      const doc = await loadPdf(f.bytes, L.PDF_MAX_OBJECTS);
      const n = doc.getPageCount();
      return { outputs: [pdfOut(await reorderPages(doc, needRanges(p, n)), withSuffix(f.name, '_reordered', 'pdf'), n)] };
    },
  },
  pdf_rotate: {
    heavy: true,
    cacheable: true,
    run: async ([f], p, L) => {
      const doc = await loadPdf(f.bytes, L.PDF_MAX_OBJECTS);
      const n = doc.getPageCount();
      const pages = p.ranges ? needRanges(p, n) : null;
      const deg = Number(p.deg);
      if (![90, 180, 270].includes(deg)) throw new ToolError('INTERNAL');
      return { outputs: [pdfOut(await rotatePages(doc, pages, deg), withSuffix(f.name, '_rotated', 'pdf'), n)] };
    },
  },
  pdf_split: {
    heavy: true,
    maxSeparate: 5,
    run: async ([f], p, L) => {
      const doc = await loadPdf(f.bytes, L.PDF_MAX_OBJECTS);
      const n = doc.getPageCount();
      let groups;
      if (p.mode === 'ranges') {
        const r = rangeGroups(p.ranges, n);
        if (!r.ok) throw new ToolError('PDF_BAD_RANGE', { pages: n });
        groups = r.groups;
      } else groups = everyN(n, Math.max(1, Number(p.n) || 1));
      if (groups.length > L.PDF_MAX_PARTS) throw new ToolError('PDF_TOO_MANY_PARTS', { max: L.PDF_MAX_PARTS });
      if (groups.length < 2) throw new ToolError('PDF_ONE_PART');
      const parts = await splitPages(doc, groups);
      const width = Math.max(2, String(parts.length).length);
      return { outputs: parts.map((bytes, i) => pdfOut(bytes, withSuffix(f.name, `_part${pad(i + 1, width)}`, 'pdf'), groups[i].length)) };
    },
  },
  /** One PDF from PDFs and JPEG/PNG images, in order (single image → PDF, or a whole batch). */
  pdf_combine: {
    heavy: true,
    cacheable: true,
    run: async (inputs, p, L) => {
      const items = inputs.map((f) => {
        if (!['pdf', 'jpeg', 'png'].includes(f.type)) throw new ToolError('PDF_INPUT_TYPE');
        return { type: f.type, bytes: f.bytes };
      });
      const r = await combine(items, { maxObjects: L.PDF_MAX_OBJECTS, maxPixels: L.PNG_MAX_PIXELS });
      if (r.bytes.length > L.MAX_OUTPUT_MB * MB) throw new ToolError('OUTPUT_TOO_BIG', { mb: L.MAX_OUTPUT_MB });
      const name = inputs.length === 1 ? withSuffix(inputs[0].name, '', 'pdf') : sanitizeName(p.name || `combined_${inputs.length}.pdf`);
      return { outputs: [pdfOut(r.bytes, name, r.pages)] };
    },
  },

  brename: {
    delivery: 'group',
    run: async (inputs, p) => {
      const names = batchNames(inputs, p.mode, p.value);
      return { outputs: inputs.map((f, i) => ({ bytes: f.bytes, name: names[i], type: f.type })) };
    },
  },
  bfix: {
    delivery: 'group',
    run: async (inputs) => {
      const outputs = [];
      for (const f of inputs) {
        const d = detect(f.bytes, f.name);
        if (!d.dangerous && !d.extOk && d.id !== 'unknown' && d.id !== 'empty') outputs.push({ bytes: f.bytes, name: fixedName(f.name, d), type: d.id });
      }
      if (!outputs.length) throw new ToolError('NOTHING_TO_FIX');
      return { outputs };
    },
  },
};

export const opExists = (op) => Object.prototype.hasOwnProperty.call(OPS, op);
