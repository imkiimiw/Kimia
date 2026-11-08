// User-facing screens: { text (Telegram HTML), reply_markup }. Pure: never imports `sdk`.
// Navigation edits the same message; every screen below the home has Back and Cancel/Home (spec §4).
// The callback_data codes are listed in lib/router.js.
import { t, tp } from './i18n/index.js';
import { btn, urlBtn, kb, grid } from './codec.js';
import { faDigits, formatBytes, esc } from './util.js';
import { TZ_OFFSET_S, WANGER_LINKS, HISTORY_PAGE } from './config.js';

const screen = (text, ...rows) => ({ text, reply_markup: rows.length ? kb(...rows) : undefined });

export const num = (ctx, n) => (ctx.digits ? faDigits(n) : String(n));
/** "2.4 MB" — with Persian digits also the Persian decimal separator (۲٫۴ MB). */
export const size = (ctx, bytes) => (ctx.digits ? faDigits(formatBytes(bytes).replace(/(\d)\.(\d)/, '$1\u066b$2')) : formatBytes(bytes));
const L = (ctx, key, vars) => t(ctx.lang, key, vars);
const P = (ctx, key, vars) => tp(ctx.lang, key, vars);

/** Gregorian → Jalali (the well-known jalaali algorithm). */
export function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

/** Date and time in Tehran: Jalali for Persian, ISO-like for English. */
export function dateTime(ctx, tS) {
  const d = new Date((tS + TZ_OFFSET_S) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  if (ctx.lang === 'fa') {
    const [y, m, day] = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    return num(ctx, `${y}/${p2(m)}/${p2(day)} ${hm}`);
  }
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hm}`;
}

const homeBtn = (ctx) => btn(P(ctx, 'btn.home'), 'h');
const backBtn = (ctx, ...to) => btn(P(ctx, 'btn.back'), ...to);
const cancelBtn = (ctx) => btn(P(ctx, 'btn.cancel'), 'x');

// ---- menus ----
export function home(ctx, { greet = false } = {}) {
  const text = (greet ? `${L(ctx, 'home.hello', { name: (ctx.from && ctx.from.first_name) || '' })}\n\n` : '') + L(ctx, 'home.text', { mb: num(ctx, ctx.limits.MAX_INPUT_MB) });
  const items = [
    (ctx.gemini && ctx.gemini.available) || offlineOcr(ctx) ? btn(P(ctx, 'menu.ocr'), 'm', 'ocr') : null,
    ctx.worker && ctx.worker.available ? btn(P(ctx, 'menu.image'), 'm', 'image') : null,
    btn(P(ctx, 'menu.pdf'), 'm', 'pdf'),
    btn(P(ctx, 'menu.zip'), 'm', 'zip'),
    btn(P(ctx, 'menu.tools'), 'm', 'tools'),
    btn(P(ctx, 'menu.history'), 'hi', 0),
    btn(P(ctx, 'menu.settings'), 'm', 'set'),
    btn(P(ctx, 'menu.help'), 'm', 'help'),
    btn(P(ctx, 'menu.bots'), 'm', 'bots'),
    ctx.actor !== 'user' ? btn(P(ctx, 'menu.panel'), 'p') : null,
  ];
  const rows = grid(items);
  if (greet && ctx.lang === 'fa') rows.push([btn('🌐 English', 'L', 'en', 'h')]);
  return screen(text, ...rows);
}

export const tools = (ctx) => screen(L(ctx, 'tools.text', { mb: num(ctx, ctx.limits.MAX_INPUT_MB) }), [homeBtn(ctx)]);
export const ocrTools = (ctx) => screen([
  ctx.gemini && ctx.gemini.available ? L(ctx, 'ocr.text', { pages: num(ctx, ctx.limits.GEMINI_PDF_MAX_PAGES), n: num(ctx, ctx.limits.GEMINI_USER_DAILY) }) : L(ctx, 'ocr.text_head'),
  offlineOcr(ctx) ? L(ctx, 'ocr.text_offline', { pages: num(ctx, (ctx.worker && ctx.worker.ocrMaxPages) || 20) }) : null,
].filter(Boolean).join('\n\n'), [homeBtn(ctx)]);
export const pdfTools = (ctx) => screen(L(ctx, 'pdf.text', { mb: num(ctx, ctx.limits.MAX_INPUT_MB), n: num(ctx, ctx.limits.BATCH_MAX_FILES) }), [homeBtn(ctx)]);
export const zipTools = (ctx) => screen(L(ctx, 'zip.text', { mb: num(ctx, ctx.limits.ARCHIVE_MAX_UNPACKED_MB), n: num(ctx, ctx.limits.ARCHIVE_MAX_ENTRIES), total: num(ctx, ctx.limits.BATCH_TOTAL_MB) }), [homeBtn(ctx)]);
export const help = (ctx) => screen(L(ctx, 'help.text', { mb: num(ctx, ctx.limits.MAX_INPUT_MB), n: num(ctx, ctx.limits.BATCH_MAX_FILES), total: num(ctx, ctx.limits.BATCH_TOTAL_MB) }), [btn(P(ctx, 'btn.privacy'), 'm', 'privacy'), homeBtn(ctx)]);
export const privacy = (ctx) => screen(L(ctx, 'privacy.text', { days: num(ctx, ctx.limits.JOB_HISTORY_DAYS) }), [btn(P(ctx, 'btn.delete_data'), 'dd'), homeBtn(ctx)]);
export const deleteConfirm = (ctx) => screen(L(ctx, 'delete.confirm'), [btn(P(ctx, 'btn.delete_yes'), 'dd', 'y'), btn(P(ctx, 'btn.no'), 'h')]);
export const deleted = (ctx) => screen(L(ctx, 'delete.done'));

export function bots(ctx) {
  const rows = WANGER_LINKS.map((l) => [urlBtn(P(ctx, `bots.${l.key}`, { username: l.username }), `https://t.me/${l.username}`)]);
  return screen(L(ctx, 'bots.text'), ...rows, [homeBtn(ctx)]);
}

/** The worker's Tesseract is there (C5). */
export const offlineOcr = (ctx) => !!(ctx.worker && ctx.worker.available && ctx.worker.ops.has('ocr'));
export const OCR_ENGINES = ['auto', 'ai', 'offline'];

export function settings(ctx) {
  const lang = P(ctx, `lang.${ctx.lang}`);
  const digits = P(ctx, ctx.digits ? 'set.on' : 'set.off');
  const ai = !!(ctx.gemini && ctx.gemini.available);
  const off = offlineOcr(ctx);
  const engine = OCR_ENGINES.includes(ctx.user && ctx.user.s_ocr) ? ctx.user.s_ocr : 'auto';
  const ocrLang = (ctx.user && ctx.user.s_ocr_lang) || 'auto';
  return screen(L(ctx, 'set.text'),
    [btn(P(ctx, 'set.lang', { value: lang }), 'm', 'lang')],
    [btn(P(ctx, 'set.digits', { value: digits }), 's', 'dg')],
    ai && off ? [btn(P(ctx, 'set.ocr_engine', { value: P(ctx, `set.engine_${engine}`) }), 's', 'oe')] : null,
    off ? [btn(P(ctx, 'set.ocr_lang', { value: P(ctx, `ocrlang.${ocrLang}`) }), 's', 'ol')] : null,
    [homeBtn(ctx)]);
}

/** Offline OCR language: auto (script detection → Persian first) or one of the worker's languages. */
export function ocrLangs(ctx) {
  const cur = (ctx.user && ctx.user.s_ocr_lang) || 'auto';
  const langs = ['auto', ...((ctx.worker && ctx.worker.ocrLangs) || []).filter((l) => l !== 'osd')];
  return screen(L(ctx, 'set.ocr_lang_pick'),
    ...grid(langs.map((l) => btn(`${l === cur ? '✓ ' : ''}${P(ctx, `ocrlang.${l}`)}`, 's', 'ol', l))),
    [backBtn(ctx, 'm', 'set')]);
}

export function language(ctx, back = 'set') {
  const mark = (l) => (ctx.lang === l ? ' ✓' : '');
  return screen(L(ctx, 'lang.pick'),
    [btn(`فارسی${mark('fa')}`, 'L', 'fa', back), btn(`English${mark('en')}`, 'L', 'en', back)],
    [back === 'set' ? backBtn(ctx, 'm', 'set') : homeBtn(ctx)]);
}

// ---- gate screens ----
export function join(ctx, missing) {
  const rows = missing.filter((c) => c.username).map((c) => [urlBtn(`📢 ${c.title || '@' + c.username}`, `https://t.me/${c.username}`)]);
  return screen(L(ctx, 'join.text'), ...rows, [btn(P(ctx, 'join.check'), 'j')]);
}
export const banned = (ctx) => screen(L(ctx, 'gate.banned'));
export const maintenance = (ctx) => screen(L(ctx, 'gate.maintenance'));

// ---- jobs ----
export const opLabel = (ctx, op) => P(ctx, `op.${op}`);
export const statusLabel = (ctx, s) => P(ctx, `status.${s}`);

/** Caption of a result file. */
export const resultCaption = (ctx, job, name) => L(ctx, 'job.done', { name, code: job.code });
export const resultMarkup = (ctx, ref) => kb([btn(P(ctx, 'job.again'), 'f', ref)]);
export const progress = (ctx, job, status) => L(ctx, 'job.progress', { status: statusLabel(ctx, status), code: job.code });
export const failure = (ctx, code, jobCode, vars = {}) => L(ctx, `err.${code}`, { ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'number' ? num(ctx, v) : v])), code: jobCode });
export const groupDone = (ctx, job, n) => L(ctx, 'job.group_done', { n: num(ctx, n), code: job.code });
export const escName = (name) => esc(name);
export { P };
export const ocrHead = (ctx, job, script) => L(ctx, 'ocr.head', { script: P(ctx, `ocr.script_${script}`), code: job.code });

export function statusScreen(ctx, job) {
  if (!job) return screen(L(ctx, 'status.none'), [homeBtn(ctx)]);
  const lines = [
    L(ctx, 'status.head', { code: job.code, op: opLabel(ctx, job.operation) }),
    L(ctx, 'status.state', { status: statusLabel(ctx, job.status) }),
    L(ctx, 'status.input', { type: job.input_type || '—', size: job.input_size ? size(ctx, job.input_size) : '—' }),
  ];
  if (job.output_size) lines.push(L(ctx, 'status.output', { type: job.output_type || '—', size: size(ctx, job.output_size) }));
  if (job.error_code) lines.push(L(ctx, 'status.error', { error: job.error_code }));
  lines.push(L(ctx, 'status.time', { time: dateTime(ctx, job.created_at) }));
  return screen(lines.join('\n'), [btn(P(ctx, 'menu.history'), 'hi', 0), homeBtn(ctx)]);
}

const ICON = { COMPLETED: '✅', FAILED: '❌', CANCELLED: '🚫', EXPIRED: '⌛' };

export function history(ctx, rows, page, total) {
  if (!rows.length && page === 0) return screen(L(ctx, 'hist.empty', { days: num(ctx, ctx.limits.JOB_HISTORY_DAYS) }), [homeBtn(ctx)]);
  const lines = [L(ctx, 'hist.head', { days: num(ctx, ctx.limits.JOB_HISTORY_DAYS) })];
  for (const j of rows) {
    lines.push(`${ICON[j.status] || '⏳'} <code>${esc(j.code)}</code> · ${esc(opLabel(ctx, j.operation))} · ${esc(j.input_type || '')} · ${esc(dateTime(ctx, j.created_at))}`);
  }
  lines.push(L(ctx, 'hist.hint'));
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const nav = [
    page > 0 ? btn(P(ctx, 'hist.newer'), 'hi', page - 1) : null,
    page + 1 < pages ? btn(P(ctx, 'hist.older'), 'hi', page + 1) : null,
  ];
  return screen(lines.join('\n'), nav, [homeBtn(ctx)]);
}

export const plain = (text, ...rows) => screen(text, ...rows);
export { homeBtn, backBtn, cancelBtn };
