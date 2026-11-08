// Worker tools in the bot (C4): presets (a short id in callback_data → worker op + params) and the
// screens of the image tools and text → image. Pure: never imports `sdk`. Only what the worker
// reported in /v1/capabilities is offered (canRun below).
import { t, tp } from './i18n/index.js';
import { btn, kb, grid } from './codec.js';
import { WTEXT_MAX } from './config.js';
import { num, homeBtn, backBtn, cancelBtn } from './ui.js';

const L = (ctx, key, vars) => t(ctx.lang, key, vars);
const P = (ctx, key, vars) => tp(ctx.lang, key, vars);
const screen = (text, ...rows) => ({ text, reply_markup: rows.length ? kb(...rows) : undefined });

export const IMAGE_TYPES = new Set(['jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'avif', 'heic']);
const FORMATS = ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'avif', 'heic'];
const SAME = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp', tiff: 'tiff', ico: 'ico', avif: 'avif', heic: 'heic' };

/** preset → [worker op, params, needs typed text?] */
export const PRESETS = {
  ...Object.fromEntries(FORMATS.map((f) => [`cv.${f}`, ['img.cv', { format: f }]])),
  'rs.25': ['img.rs', { mode: 'percent', percent: 25 }],
  'rs.50': ['img.rs', { mode: 'percent', percent: 50 }],
  'rs.75': ['img.rs', { mode: 'percent', percent: 75 }],
  'rs.w720': ['img.rs', { mode: 'width', width: 720 }],
  'rs.w1080': ['img.rs', { mode: 'width', width: 1080 }],
  'rs.w1920': ['img.rs', { mode: 'width', width: 1920 }],
  'rs.s512': ['img.rs', { mode: 'fit', width: 512, height: 512 }],
  'cr.11': ['img.cr', { ratio: '1:1' }],
  'cr.45': ['img.cr', { ratio: '4:5' }],
  'cr.43': ['img.cr', { ratio: '4:3' }],
  'cr.34': ['img.cr', { ratio: '3:4' }],
  'cr.169': ['img.cr', { ratio: '16:9' }],
  'cr.916': ['img.cr', { ratio: '9:16' }],
  'ro.90': ['img.ro', { angle: 90 }],
  'ro.180': ['img.ro', { angle: 180 }],
  'ro.270': ['img.ro', { angle: 270 }],
  'fl.h': ['img.fl', { axis: 'h' }],
  'fl.v': ['img.fl', { axis: 'v' }],
  'cp.hi': ['img.cp', { quality: 85 }],
  'cp.md': ['img.cp', { quality: 70 }],
  'cp.lo': ['img.cp', { quality: 50 }],
  'cp.wp': ['img.cp', { quality: 75, format: 'webp' }],
  sm: ['img.sm', {}],
  gr: ['img.gr', {}],
  bl: ['img.bl', { radius: 4 }],
  'bl.x': ['img.bl', { radius: 12 }],
  sh: ['img.sh', {}],
  sep: ['img.cm', { mode: 'sepia' }],
  inv: ['img.cm', { mode: 'invert' }],
  bw: ['img.cm', { mode: 'bw' }],
  'wm.br': ['img.wm', { position: 'br' }, true],
  'wm.bl': ['img.wm', { position: 'bl' }, true],
  'wm.c': ['img.wm', { position: 'c' }, true],
  'wm.t': ['img.wm', { position: 'tile' }, true],
  'tx.t': ['img.tx', { position: 'top' }, true],
  'tx.b': ['img.tx', { position: 'bottom' }, true],
  'tx.c': ['img.tx', { position: 'center' }, true],
  // PDF (C5)
  pt: ['pdf.tx', {}],
  'pi.150': ['pdf.im', { dpi: 150, format: 'jpg' }],
  'pi.300': ['pdf.im', { dpi: 300, format: 'jpg' }],
  'pi.150p': ['pdf.im', { dpi: 150, format: 'png' }],
  'pc.hi': ['pdf.cp', { level: 'hi' }],
  'pc.md': ['pdf.cp', { level: 'md' }],
  'pc.lo': ['pdf.cp', { level: 'lo' }],
  'pw.d': ['pdf.wm', { position: 'diag' }, true],
  'pw.b': ['pdf.wm', { position: 'bottom' }, true],
  'pw.t': ['pdf.wm', { position: 'top' }, true],
  pu: ['pdf.ul', {}, 'password'],
};

/** Categories of the image tools screen, in display order → the presets they list. */
export const CATS = {
  cv: FORMATS.map((f) => `cv.${f}`),
  rs: ['rs.25', 'rs.50', 'rs.75', 'rs.w720', 'rs.w1080', 'rs.w1920', 'rs.s512'],
  cr: ['cr.11', 'cr.45', 'cr.43', 'cr.34', 'cr.169', 'cr.916'],
  ro: ['ro.90', 'ro.180', 'ro.270', 'fl.h', 'fl.v'],
  cp: ['cp.hi', 'cp.md', 'cp.lo', 'cp.wp'],
  fx: ['gr', 'bl', 'bl.x', 'sh', 'sep', 'inv', 'bw'],
  sm: ['sm'],
  wm: ['wm.br', 'wm.bl', 'wm.c', 'wm.t'],
  tx: ['tx.b', 'tx.t', 'tx.c'],
  pu: ['pu'],
  pt: ['pt'],
  pi: ['pi.150', 'pi.300', 'pi.150p'],
  pc: ['pc.md', 'pc.lo', 'pc.hi'],
  pw: ['pw.d', 'pw.b', 'pw.t'],
};
export const TEXT_CATS = new Set(['wm', 'tx', 'pw']);
/** Categories with one preset: the tools screen runs it directly. */
export const DIRECT_CATS = new Set(['sm', 'pt', 'pu']);
const PDF_IMAGES_MAX_PAGES = 50;

export const THEMES = ['light', 'dark', 'sepia', 'ocean', 'sunset', 'forest', 'rose', 'night'];
export const SIZES = ['square', 'post', 'story', 'wide'];

/** Can the worker run `op` on a file of this type (null: no input file) and size? */
export function canRun(ctx, op, type, size = 0) {
  const w = ctx.worker;
  if (!w || !w.available || !w.ops.has(op)) return false;
  if (type !== null && !(w.inputs[op] || []).includes(type)) return false;
  return !size || size <= w.maxMb * 1024 * 1024;
}

/** Encrypted: the detector's flag, or what the intake inspection found (files.meta.pdf.problem). */
const encrypted = (d, file = null) => !!(d.info && d.info.encrypted) || !!(file && file.meta && file.meta.pdf && file.meta.pdf.problem === 'PDF_ENCRYPTED');
const pdfPages = (file) => (file.meta && file.meta.pdf && file.meta.pdf.pages) || 0;

/** Is this preset offered for this file? (the op exists, reads this type, writes the format) */
export function presetOk(ctx, preset, file, d) {
  const p = PRESETS[preset];
  if (!p || !canRun(ctx, p[0], d.id, file.size)) return false;
  if (p[0].startsWith('pdf.')) {
    if (p[0] === 'pdf.ul') return encrypted(d, file); // an encrypted PDF offers only «🔓 باز کردن با رمز»
    if (encrypted(d, file)) return false;
    if (p[0] === 'pdf.im' && pdfPages(file) > PDF_IMAGES_MAX_PAGES) return false;
    return true;
  }
  if (p[0] === 'img.cv') return ctx.worker.write.includes(p[1].format) && SAME[d.id] !== p[1].format;
  if (preset === 'cp.wp') return ctx.worker.write.includes('webp') && d.id !== 'webp';
  return true;
}

export const catPresets = (ctx, cat, file, d) => (CATS[cat] || []).filter((p) => presetOk(ctx, p, file, d));

/** The worker tools (image or PDF) are offered on this file's card. */
export const imageToolsOk = (ctx, file, d) => !d.dangerous && (IMAGE_TYPES.has(d.id) || d.id === 'pdf') && Object.keys(CATS).some((c) => catPresets(ctx, c, file, d).length);

/** «🔓 باز کردن با رمز» is the one thing to do with an encrypted PDF. */
export const unlockOk = (ctx, file, d) => d.id === 'pdf' && presetOk(ctx, 'pu', file, d);

/** Offline OCR (Tesseract on the worker): images it reads, PDFs up to its page limit. */
export function offlineOcrOk(ctx, file, d) {
  if (d.dangerous || !canRun(ctx, 'ocr', d.id, file.size)) return false;
  if (d.id !== 'pdf') return true;
  return !encrypted(d, file) && pdfPages(file) > 0 && pdfPages(file) <= ((ctx.worker && ctx.worker.ocrMaxPages) || 20);
}

export const ttiOk = (ctx) => canRun(ctx, 'tti', null);

export function presetLabel(ctx, preset) {
  const [kind, arg] = preset.split('.');
  if (kind === 'cv') return `🔁 ${arg.toUpperCase()}`;
  if (kind === 'rs') {
    if (arg.startsWith('w')) return P(ctx, 'wt.rs_w', { n: num(ctx, arg.slice(1)) });
    if (arg.startsWith('s')) return P(ctx, 'wt.rs_box', { n: num(ctx, arg.slice(1)) });
    return P(ctx, 'wt.rs_pct', { n: num(ctx, arg) });
  }
  if (kind === 'cr') return `▭ ${PRESETS[preset][1].ratio}`;
  if (kind === 'ro') return P(ctx, 'wt.ro', { deg: num(ctx, arg) });
  return P(ctx, `wt.${preset.replace('.', '_')}`);
}

/** «🖼 ابزار عکس» for a file: the categories that have something to offer. */
export function toolsScreen(ctx, file, d) {
  const items = Object.keys(CATS).filter((c) => catPresets(ctx, c, file, d).length)
    .map((c) => (DIRECT_CATS.has(c) ? btn(P(ctx, `wt.cat_${c}`), 'wo', file.ref, CATS[c][0]) : btn(P(ctx, `wt.cat_${c}`), 'wi', file.ref, c)));
  return screen(L(ctx, d.id === 'pdf' ? 'wt.head_pdf' : 'wt.head', { name: file.name }), ...grid(items), [backBtn(ctx, 'f', file.ref), homeBtn(ctx)]);
}

export function catScreen(ctx, file, d, cat) {
  const items = catPresets(ctx, cat, file, d).map((p) => btn(presetLabel(ctx, p), 'wo', file.ref, p));
  return screen(L(ctx, `wt.pick_${cat}`, { name: file.name }), ...grid(items, cat === 'cv' ? 3 : 2), [backBtn(ctx, 'wi', file.ref), homeBtn(ctx)]);
}

export function askText(ctx, file, cat) {
  return screen(L(ctx, `wt.ask_${cat}`, { max: num(ctx, WTEXT_MAX[cat]) }), [backBtn(ctx, 'wi', file.ref), cancelBtn(ctx)]);
}

/** The PDF password prompt: the user's message is deleted on arrival and the password never stored. */
export const askPassword = (ctx, file) => screen(L(ctx, 'wt.ask_pu', { name: file.name }), [backBtn(ctx, 'f', file.ref), cancelBtn(ctx)]);

export function positionScreen(ctx, ref, cat) {
  const items = (CATS[cat] || []).filter((p) => canRun(ctx, PRESETS[p][0], null)).map((p) => btn(presetLabel(ctx, p), 'wo', ref, p));
  return screen(L(ctx, 'wt.pos_head'), ...grid(items), [backBtn(ctx, 'wi', ref), cancelBtn(ctx)]);
}

// ---- text → image ----
export const ttiAsk = (ctx) => screen(L(ctx, 'wt.ask_tti', { max: num(ctx, WTEXT_MAX.tti) }), [homeBtn(ctx)]);

export function themeScreen(ctx) {
  return screen(L(ctx, 'wt.theme_head'), ...grid(THEMES.map((th) => btn(P(ctx, `wt.theme_${th}`), 'wt', 't', th))), [cancelBtn(ctx)]);
}

export function sizeScreen(ctx, theme) {
  return screen(L(ctx, 'wt.size_head', { theme: P(ctx, `wt.theme_${theme}`) }),
    ...grid(SIZES.map((s) => btn(P(ctx, `wt.size_${s}`), 'wt', 'g', theme, s))), [backBtn(ctx, 'wt', 'b'), cancelBtn(ctx)]);
}

/** The menu screen «🖼 ابزار عکس»: what the worker can do right now. */
export function imageMenu(ctx) {
  const items = [ttiOk(ctx) ? btn(P(ctx, 'menu.tti'), 'wt') : null];
  return screen(L(ctx, ctx.worker && ctx.worker.available ? 'wt.menu_text' : 'wt.menu_off', { mb: num(ctx, ctx.worker ? ctx.worker.maxMb : 20) }), ...grid(items), [homeBtn(ctx)]);
}

/** The status message a worker job starts with (the worker edits it from then on). */
export function queued(ctx, code, pos = 0) {
  const status = pos > 1 ? P(ctx, 'wt.queued_pos', { pos: num(ctx, pos) }) : P(ctx, 'status.QUEUED');
  return screen(L(ctx, 'job.progress', { status, code }), [btn(P(ctx, 'wt.cancel_btn'), 'wx', code)]);
}
