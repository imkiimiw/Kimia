// File card and the screens of the file tools (rename, archives, PDF pages, batches). Pure.
// The card shows what was detected and at most 6 actions, then «بیشتر ▸» (spec §4). An action is
// offered only when it can work on this file (type, size, its index / page count in files.meta).
import { t, tp } from './i18n/index.js';
import { btn, kb, grid } from './codec.js';
import { allowedExts, splitName } from './names.js';
import { TYPES } from './detect/types.js';
import { LIST_PAGE } from './config.js';
import { num, size, homeBtn, backBtn, cancelBtn } from './ui.js';
import { imageToolsOk, offlineOcrOk, unlockOk } from './wtools.js';

const screen = (text, ...rows) => ({ text, reply_markup: rows.length ? kb(...rows) : undefined });
const L = (ctx, key, vars) => t(ctx.lang, key, vars);
const P = (ctx, key, vars) => tp(ctx.lang, key, vars);

export const EXTRACTABLE = new Set(['zip', 'tar', 'gzip']);
const FAMILY = new Set(['image', 'pdf', 'document', 'text', 'archive', 'audio', 'video', 'font', 'data', 'executable', 'unknown']);
const PER_PAGE = 6;

/** OCR with Gemini (C3): a key is set, the type is one Gemini reads, the size fits a request. */
export function aiOcrable(ctx, file, d) {
  if (!ctx.gemini || !ctx.gemini.available || d.dangerous) return false;
  if (file.size > ctx.limits.GEMINI_MAX_MB * 1024 * 1024) return false;
  if (['jpeg', 'png', 'webp', 'heic'].includes(d.id)) return true;
  const m = file.meta || {};
  return d.id === 'pdf' && !!(m.pdf && m.pdf.pages && !m.pdf.problem && m.pdf.pages <= ctx.limits.GEMINI_PDF_MAX_PAGES);
}

/** The offline engine (Tesseract on the worker, C5) can read this file too. */
export const offlineAlso = (ctx, file, d) => offlineOcrOk(ctx, file, d);

/**
 * Which engine the OCR button uses for this file (spec §7.1: «دقیق (هوش مصنوعی)» or «آفلاین» in the
 * settings; 'auto' = AI first, offline when the AI can't take this file or its quota is used up).
 * → 'ai' | 'offline' | null (no OCR for this file).
 */
export function ocrEngine(ctx, file, d) {
  const ai = aiOcrable(ctx, file, d);
  const aiReady = ai && !(ctx.gemini && ctx.gemini.exhausted);
  const off = offlineOcrOk(ctx, file, d);
  const pref = ctx.user && ctx.user.s_ocr;
  if (pref === 'offline') return off ? 'offline' : ai ? 'ai' : null;
  if (pref === 'ai') return ai && (aiReady || !off) ? 'ai' : off ? 'offline' : null;
  return aiReady ? 'ai' : off ? 'offline' : ai ? 'ai' : null;
}

export const ocrable = (ctx, file, d) => ocrEngine(ctx, file, d) !== null;

/** The one-time OCR consent (spec §7.1), worded after Google's terms for the tier in use. */
export function ocrConsent(ctx, file, offline = false) {
  return screen(L(ctx, ctx.gemini && ctx.gemini.paid ? 'ocr.consent_paid' : 'ocr.consent_free'),
    [btn(P(ctx, 'ocr.agree'), 'oy', file.ref)], offline ? [btn(P(ctx, 'ocr.use_offline'), 'ox', file.ref)] : null,
    [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);
}

/** The actions a file offers, in display order. */
export function fileOps(ctx, file, d) {
  if (d.dangerous || d.id === 'empty') return [];
  const m = file.meta || {};
  const ref = file.ref;
  const ops = [];
  if (EXTRACTABLE.has(d.id) && m.archive && !m.archive.problem && m.archive.files > 0) ops.push(btn(P(ctx, 'op.extract'), 'ax', ref));
  if (d.id === 'pdf' && m.pdf && m.pdf.pages && !m.pdf.problem) {
    ops.push(btn(P(ctx, 'op.pdf_extract'), 'pd', ref, 'x'), btn(P(ctx, 'op.pdf_remove'), 'pd', ref, 'd'), btn(P(ctx, 'op.pdf_rotate'), 'pd', ref, 'r'));
    if (m.pdf.pages > 1) ops.push(btn(P(ctx, 'op.pdf_reorder'), 'pd', ref, 'o'), btn(P(ctx, 'op.pdf_split'), 'pd', ref, 's'));
  }
  if (unlockOk(ctx, file, d)) ops.unshift(btn(P(ctx, 'op.unlock'), 'wo', ref, 'pu'));
  else if (imageToolsOk(ctx, file, d)) ops.unshift(btn(P(ctx, d.id === 'pdf' ? 'op.wpdf' : 'op.wimage'), 'wi', ref));
  if (ocrable(ctx, file, d)) ops.unshift(btn(P(ctx, 'op.ocr'), 'oc', ref));
  if (d.id === 'jpeg' || (d.id === 'png' && m.image && m.image.w * m.image.h <= ctx.limits.PNG_MAX_PIXELS)) ops.push(btn(P(ctx, 'op.pdf_combine'), 'pi', ref));
  ops.push(btn(P(ctx, 'op.rename'), 'rn', ref));
  ops.push(btn(P(ctx, 'op.zip'), 'pz', ref));
  ops.push(btn(P(ctx, 'op.batch'), 'bn', ref));
  return ops;
}

/** «🖼 تصویر دریافت شد — JPEG، 2.4 MB» + notes + «چه کاری انجام بدهم؟» with the actions. */
export function card(ctx, file, d, { suspicious = false, page = 1, noFix = false } = {}) {
  const m = file.meta || {};
  const family = FAMILY.has(d.family) ? d.family : 'unknown';
  const head = d.id === 'pdf' && m.pdf && m.pdf.pages
    ? L(ctx, 'card.pdf_pages', { pages: num(ctx, m.pdf.pages), size: size(ctx, file.size) })
    : L(ctx, `card.${family}`, { type: d.label, size: size(ctx, file.size) });
  const lines = [head, L(ctx, 'card.name', { name: file.name })];
  if (suspicious) lines.push(L(ctx, 'card.rtlo'));
  if (d.dangerous === 'polyglot') lines.push(L(ctx, 'card.polyglot'));
  else if (d.dangerous) lines.push(L(ctx, 'card.dangerous'));
  else if (d.id === 'empty') lines.push(L(ctx, 'card.empty'));
  else if (d.id === 'unknown') lines.push(L(ctx, 'card.unknown_note'));
  else if (!d.extOk && !noFix) lines.push(L(ctx, 'card.mismatch', { type: d.label, ext: d.nameExt ? `.${d.nameExt}` : P(ctx, 'card.no_ext'), fix: `.${d.ext}` }));
  if (m.archive && m.archive.problem) lines.push(L(ctx, `why.${m.archive.problem}`, { n: num(ctx, ctx.limits.ARCHIVE_MAX_ENTRIES), mb: num(ctx, ctx.limits.ARCHIVE_MAX_UNPACKED_MB) }));
  else if (m.archive && !d.dangerous) lines.push(L(ctx, 'card.archive_info', { n: num(ctx, m.archive.files), size: size(ctx, m.archive.total) }));
  else if (d.info && d.info.encrypted) lines.push(L(ctx, 'card.encrypted'));
  if (d.family === 'archive' && !EXTRACTABLE.has(d.id) && !d.dangerous) lines.push(L(ctx, 'card.no_extract'));
  if (m.pdf && m.pdf.problem) lines.push(L(ctx, `why.${m.pdf.problem}`));
  if (d.id === 'png' && m.image && m.image.w * m.image.h > ctx.limits.PNG_MAX_PIXELS) lines.push(L(ctx, 'card.png_big', { mp: num(ctx, Math.round(ctx.limits.PNG_MAX_PIXELS / 1e6)) }));
  if (file.kind === 'photo') lines.push(L(ctx, 'card.photo_tip'));
  if (file.kind === 'animation') lines.push(L(ctx, 'card.gif_tip'));
  const rows = [];
  const ops = fileOps(ctx, file, d);
  if (ops.length) {
    if (!d.extOk && !noFix && d.id !== 'unknown' && page === 1) rows.push([btn(P(ctx, 'card.fix_yes'), 'fx', file.ref), btn(P(ctx, 'card.fix_no'), 'fn', file.ref)]);
    else lines.push(L(ctx, 'card.ask'));
    const pages = Math.ceil(ops.length / PER_PAGE);
    const shown = ops.length > PER_PAGE + 1 ? ops.slice((page - 1) * PER_PAGE, page * PER_PAGE) : ops;
    rows.push(...grid(shown));
    if (ops.length > PER_PAGE + 1 && page < pages) rows.push([btn(P(ctx, 'card.more'), 'fm', file.ref)]);
    if (page > 1) rows.push([backBtn(ctx, 'f', file.ref)]);
  }
  rows.push([homeBtn(ctx), cancelBtn(ctx)]);
  return screen(lines.join('\n'), ...rows);
}

// ---- rename ----
export function renameMenu(ctx, file, d) {
  const exts = allowedExts(d);
  return screen(L(ctx, 'rn.text', { name: file.name }),
    [btn(P(ctx, 'rn.name'), 'rn', file.ref, 'n')],
    [btn(P(ctx, 'rn.prefix'), 'rn', file.ref, 'p'), btn(P(ctx, 'rn.suffix'), 'rn', file.ref, 's')],
    [btn(P(ctx, 'rn.normalize'), 'rn', file.ref, 'z'), exts.length > 1 ? btn(P(ctx, 'rn.ext'), 'rn', file.ref, 'e') : null],
    [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);
}

export function extMenu(ctx, file, d) {
  const current = splitName(file.name).ext;
  const buttons = allowedExts(d).map((e) => btn(`.${e}${e === current ? ' ✓' : ''}`, 're', file.ref, e));
  return screen(L(ctx, 'rn.ext_text', { name: file.name }), ...grid(buttons, 3), [backBtn(ctx, 'rn', file.ref), cancelBtn(ctx)]);
}

export const renamePrompt = (ctx, file, mode) => screen(L(ctx, `rn.ask_${mode}`, { name: file.name }), [backBtn(ctx, 'rn', file.ref), cancelBtn(ctx)]);

// ---- archives ----
export function extractChoice(ctx, file) {
  return screen(L(ctx, 'arc.many', { n: num(ctx, file.meta.archive.files) }),
    [btn(P(ctx, 'arc.all_zip'), 'ax', file.ref, 'z')],
    [btn(P(ctx, 'arc.pick'), 'al', file.ref, 0)],
    [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);
}

export function entryList(ctx, file, page) {
  const items = file.meta.archive.items || [];
  const pages = Math.max(1, Math.ceil(items.length / LIST_PAGE));
  const p = Math.max(0, Math.min(page, pages - 1));
  const rows = items.slice(p * LIST_PAGE, (p + 1) * LIST_PAGE).map(([index, name, bytes]) => [btn(`📄 ${[...name].slice(0, 28).join('')} · ${size(ctx, bytes)}`, 'ae', file.ref, index)]);
  const nav = [p > 0 ? btn(P(ctx, 'list.prev'), 'al', file.ref, p - 1) : null, p + 1 < pages ? btn(P(ctx, 'list.next'), 'al', file.ref, p + 1) : null];
  return screen(L(ctx, 'arc.list', { page: num(ctx, p + 1), pages: num(ctx, pages), n: num(ctx, items.length) }), ...rows, nav, [backBtn(ctx, 'ax', file.ref), cancelBtn(ctx)]);
}

// ---- PDF ----
export const pdfPrompt = (ctx, file, op) => screen(L(ctx, `pdf.ask_${op}`, { pages: num(ctx, file.meta.pdf.pages), name: file.name }), [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);

export function rotateMenu(ctx, file, withRanges = null) {
  const s = withRanges ? 'p' : 'a';
  return screen(L(ctx, withRanges ? 'pdf.rotate_some' : 'pdf.rotate', { ranges: withRanges || '', name: file.name }),
    [btn('↻ 90°', 'pr', file.ref, 90, s), btn('↺ 90°', 'pr', file.ref, 270, s), btn('180°', 'pr', file.ref, 180, s)],
    withRanges ? null : [btn(P(ctx, 'pdf.only_some'), 'pd', file.ref, 'R')],
    [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);
}

export function splitMenu(ctx, file) {
  const pages = file.meta.pdf.pages;
  const max = ctx.limits.PDF_MAX_PARTS;
  const opts = [1, 2, 5, 10].filter((n) => Math.ceil(pages / n) >= 2 && Math.ceil(pages / n) <= max)
    .map((n) => btn(P(ctx, n === 1 ? 'pdf.split_each' : 'pdf.split_n', { n: num(ctx, n), parts: num(ctx, Math.ceil(pages / n)) }), 'ps', file.ref, n));
  return screen(L(ctx, 'pdf.split', { pages: num(ctx, pages) }), ...grid(opts), [btn(P(ctx, 'pdf.split_ranges'), 'ps', file.ref, 'r')], [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);
}

// ---- batches ----
export function batchStatus(ctx, batch, n, bytes) {
  return screen(L(ctx, 'batch.collecting', { n: num(ctx, n), size: size(ctx, bytes), max: num(ctx, ctx.limits.BATCH_MAX_FILES) }),
    [btn(P(ctx, 'batch.done'), 'b', batch.id)], [btn(P(ctx, 'btn.cancel'), 'bx', batch.id)]);
}

/** Batch menu: summary by family, skipped dangerous files, the batch actions that apply. */
export function batchMenu(ctx, batch, files, describeFn) {
  const ds = files.map((f) => describeFn(f));
  const ok = files.filter((_, i) => !ds[i].dangerous && ds[i].id !== 'empty');
  const bytes = ok.reduce((s, f) => s + f.size, 0);
  const fam = {};
  ds.forEach((d) => { if (!d.dangerous && d.id !== 'empty') fam[d.family] = (fam[d.family] || 0) + 1; });
  const lines = [L(ctx, 'batch.head', { n: num(ctx, files.length), size: size(ctx, bytes) })];
  lines.push(Object.entries(fam).map(([f, c]) => `• ${num(ctx, c)} ${P(ctx, `fam.${f}`)}`).join('  '));
  const skipped = files.length - ok.length;
  if (skipped) lines.push(L(ctx, 'batch.skipped', { n: num(ctx, skipped) }));
  const tooBig = bytes > ctx.limits.BATCH_TOTAL_MB * 1024 * 1024;
  if (tooBig) lines.push(L(ctx, 'batch.too_big', { mb: num(ctx, ctx.limits.BATCH_TOTAL_MB) }));
  const pdfable = ok.filter((f, i) => ['pdf', 'jpeg', 'png'].includes(describeFn(f).id));
  const mismatch = ok.some((f) => { const d = describeFn(f); return !d.extOk && d.id !== 'unknown'; });
  const rows = [];
  if (ok.length && !tooBig) {
    rows.push([btn(P(ctx, 'batch.zip'), 'bz', batch.id), pdfable.length ? btn(P(ctx, 'batch.pdf', { n: num(ctx, pdfable.length) }), 'bp', batch.id) : null]);
    rows.push([btn(P(ctx, 'batch.rename'), 'br', batch.id), mismatch ? btn(P(ctx, 'batch.fix'), 'bf', batch.id) : null]);
  }
  rows.push([btn(P(ctx, 'batch.list'), 'bl', batch.id)]);
  rows.push([homeBtn(ctx), btn(P(ctx, 'batch.close'), 'bx', batch.id)]);
  return screen(lines.join('\n'), ...rows);
}

export function batchList(ctx, batch, files) {
  const rows = files.map((f) => [btn(`${(TYPES[(f.type || '').split(/[!#]/)[0]] || TYPES.unknown).label} · ${[...f.name].slice(0, 26).join('')}`, 'f', f.ref)]);
  return screen(L(ctx, 'batch.list_head', { n: num(ctx, files.length) }), ...rows, [backBtn(ctx, 'bm', batch.id)]);
}

export function batchRenameMenu(ctx, batch) {
  return screen(L(ctx, 'batch.rename_head'),
    [btn(P(ctx, 'rn.prefix'), 'br', batch.id, 'p'), btn(P(ctx, 'rn.suffix'), 'br', batch.id, 's')],
    [btn(P(ctx, 'batch.number'), 'br', batch.id, 'n'), btn(P(ctx, 'rn.normalize'), 'br', batch.id, 'z')],
    [backBtn(ctx, 'bm', batch.id), cancelBtn(ctx)]);
}

export const batchPrompt = (ctx, batch, mode) => screen(L(ctx, `batch.ask_${mode}`), [backBtn(ctx, 'br', batch.id), cancelBtn(ctx)]);
