// File intake (spec §3, §4, §6): document, photo, audio, voice, video, video note, animation →
// size check → download (≤ 20 MB) → detection from the bytes → a quick look inside (archive index,
// PDF pages, image size → files.meta) → a file card, or a place in the open batch (albums, C2).
// Then the single-file actions: Detect & Fix, rename, extract, PDF pages, image → PDF, ZIP.
import { BATCH_COLLECT_S, FILE_TTL_S, INPUT_TTL_S, MB } from './config.js';
import { openArchive } from './archive.js';
import * as batch from './batch.js';
import * as batches from './db/batches.js';
import * as cards from './cards.js';
import { detect, describe, extMatches, extOf, storedType } from './detect/index.js';
import * as store from './db/files.js';
import * as state from './db/state.js';
import { count, getSettings, hasSecret } from './db/system.js';
import * as users from './db/users.js';
import { textToDocx } from './docx.js';
import { isToolError } from './errors.js';
import { t } from './i18n/index.js';
import { jpegInfo, pngInfo } from './images.js';
import { startJob, takeIntakeSlot } from './jobs.js';
import * as log from './log.js';
import { defaultName, fixedName, hadSuspiciousChars, renameTo, sanitizeName, splitName } from './names.js';
import { parseRanges, pdfInfo, rangeGroups } from './pdf.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { fileRef, tehranDay } from './util.js';
import { loadWorker } from './worker.js';

/** Gemini state for the cards (C3): a key exists (OCR offered), paid tier (consent wording). */
export async function loadGemini(ctx) {
  if (ctx.gemini) return ctx.gemini;
  const [available, s] = await Promise.all([hasSecret('GEMINI_API_KEY'), getSettings(['gemini.paid'])]);
  ctx.gemini = { available, paid: s['gemini.paid'] === true };
  return ctx.gemini;
}

/** Everything the cards and menus depend on: Gemini (C3) and the worker (C4). */
export async function loadServices(ctx) {
  await Promise.all([loadGemini(ctx), loadWorker(ctx)]);
}

/** Consent given under the free-tier wording covers both tiers; under the paid wording only the paid tier. */
const consented = (ctx) => { const c = ctx.user.s_ocr_consent; return c > 0 || (c < 0 && ctx.gemini.paid); };

/** The file in a message, normalized. → { kind, fileId, uniqueId, size, name, mime } | null */
export function extractFile(m) {
  if (m.document) return { kind: 'document', fileId: m.document.file_id, uniqueId: m.document.file_unique_id, size: m.document.file_size, name: m.document.file_name || null, mime: m.document.mime_type || null };
  if (m.photo && m.photo.length) {
    const p = m.photo.reduce((a, b) => ((b.file_size || b.width * b.height) > (a.file_size || a.width * a.height) ? b : a));
    return { kind: 'photo', fileId: p.file_id, uniqueId: p.file_unique_id, size: p.file_size, name: null, mime: 'image/jpeg' };
  }
  for (const kind of ['audio', 'video', 'animation', 'voice', 'video_note']) {
    const f = m[kind];
    if (f) return { kind, fileId: f.file_id, uniqueId: f.file_unique_id, size: f.file_size, name: f.file_name || null, mime: f.mime_type || null };
  }
  return null;
}

const KIND_NAME = { photo: 'photo', voice: 'voice', video_note: 'video_note', audio: 'audio', video: 'video', animation: 'animation', document: 'file' };
const archiveLimits = (L) => ({ maxEntries: L.ARCHIVE_MAX_ENTRIES, maxUnpacked: L.ARCHIVE_MAX_UNPACKED_MB * MB, maxRatio: L.ARCHIVE_MAX_RATIO });

/** A quick look inside, kept in files.meta: archive index (checked), PDF pages, image size. */
export async function analyze(ctx, bytes, d, name) {
  if (d.dangerous) return null;
  if (cards.EXTRACTABLE.has(d.id) && !(d.info && d.info.encrypted)) {
    try {
      const arc = openArchive(bytes, d.id, name, archiveLimits(ctx.limits));
      const items = arc.entries.map((e, i) => ({ ...e, i })).filter((e) => !e.dir);
      return { archive: { files: items.length, total: arc.total, items: items.slice(0, 1000).map((e) => [e.i, e.name.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'file', e.size]) } };
    } catch (e) {
      if (isToolError(e)) return { archive: { problem: e.code } };
      throw e;
    }
  }
  if (d.id === 'pdf') {
    const info = await pdfInfo(bytes, ctx.limits.PDF_MAX_OBJECTS);
    return { pdf: { pages: info.pages, problem: info.problem } };
  }
  if (d.id === 'jpeg') { const i = jpegInfo(bytes); return i ? { image: { w: i.width, h: i.height, o: i.orientation } } : null; }
  if (d.id === 'png') { const i = pngInfo(bytes); return i ? { image: { w: i.width, h: i.height } } : null; }
  return null;
}

/**
 * A received file → its card, or a place in the open batch. An album (media_group_id) opens a
 * batch; while a batch is open (BATCH_COLLECT_S), every new file joins it.
 */
export async function intake(ctx, message, file) {
  const chatId = message.chat.id;
  const mg = message.media_group_id || null;
  const once = (key) => (mg ? state.claimOnce(ctx.user.id, `${key}:${mg}`, ctx.now + 600) : Promise.resolve(true));
  const max = ctx.limits.MAX_INPUT_MB * MB;
  if (file.size && file.size > max) {
    await count(ctx.day, 'intake_too_big');
    return tg.send(ctx, 'intake_too_big', chatId, { text: t(ctx.lang, 'intake.too_big', { mb: ui.num(ctx, ctx.limits.MAX_INPUT_MB), size: ui.size(ctx, file.size) }) });
  }
  const slot = await takeIntakeSlot(ctx);
  if (!slot.ok) {
    if (await once('rate')) await tg.send(ctx, 'intake_rate', chatId, { text: t(ctx.lang, 'rate.intake', { s: ui.num(ctx, slot.retryS) }) });
    return null;
  }

  // batch: the open one, or a new one for an album
  let b = await batches.open(ctx.user.id, ctx.now, BATCH_COLLECT_S);
  if (!b && mg) {
    await batches.closeStale(ctx.user.id, ctx.now, BATCH_COLLECT_S);
    b = await batches.openOrCreate(ctx.user.id, fileRef(), ctx.now);
  }
  let seq = null;
  if (b) {
    seq = await batches.reserve(b.id, ctx.limits.BATCH_MAX_FILES, ctx.now);
    if (seq === null) {
      if (await once('full')) await tg.send(ctx, 'batch_full', chatId, { text: t(ctx.lang, 'batch.full', { max: ui.num(ctx, ctx.limits.BATCH_MAX_FILES) }) });
      b = null;
    }
  }

  if (!b) await tg.action(ctx, chatId, 'typing');
  let bytes;
  try {
    bytes = await tg.download(ctx, 'intake_download', file.fileId);
  } catch (err) {
    log.warn('intake_download_failed', { update_id: ctx.updateId, user_id: ctx.user.id, kind: err && err.kind });
    const key = err && err.kind === 'too_big' ? 'intake.too_big' : 'intake.failed';
    return tg.send(ctx, 'intake_failed', chatId, { text: t(ctx.lang, key, { mb: ui.num(ctx, ctx.limits.MAX_INPUT_MB), size: file.size ? ui.size(ctx, file.size) : '—' }) });
  }
  const d0 = detect(bytes, file.name || '');
  const fallback = defaultName(KIND_NAME[file.kind], d0, message.date || ctx.now);
  const name = file.name ? sanitizeName(file.name, { fallback }) : fallback;
  const nameExt = extOf(name);
  const d = { ...d0, nameExt, extOk: extMatches(d0.id, nameExt) };
  const meta = (await analyze(ctx, bytes, d, name)) || {};
  const row = { ref: fileRef(), userId: ctx.user.id, fileId: file.fileId, fileUniqueId: file.uniqueId, kind: file.kind, name, size: bytes.length, type: storedType(d), createdAt: ctx.now, meta, batchId: b ? b.id : null, seq };
  await store.putFile(row);
  await count(ctx.day, 'intake');
  log.info('intake', { update_id: ctx.updateId, user_id: ctx.user.id, input_type: d.label, input_size: bytes.length });
  if (b) return batch.showStatus(ctx, b.id, chatId);
  await loadServices(ctx);
  return tg.send(ctx, 'card', chatId, cards.card(ctx, row, d, { suspicious: hadSuspiciousChars(file.name) }));
}

/** The file behind a card ref (owner-checked, not expired) with its detection. */
export async function loadFile(ctx, ref) {
  const f = await store.getFile(ref, ctx.user.id);
  if (!f || f.created_at < ctx.now - FILE_TTL_S) return null;
  return { file: { ...f, fileId: f.file_id }, d: describe(f.type, f.name) };
}

const INSPECTED = new Set(['pdf', 'zip', 'tar', 'gzip', 'jpeg', 'png']);
const NEEDS_META = new Set(['f', 'fm', 'fn', 'ax', 'al', 'ae', 'pd', 'pr', 'ps', 'pi', 'oc', 'oy']);

/**
 * Files that were never looked inside (results of jobs, files from before C2) are inspected once,
 * when their card is opened: one download, then the meta is stored.
 */
async function ensureMeta(ctx, file, d) {
  if (file.meta || d.dangerous || !INSPECTED.has(d.id)) return file.meta || {};
  let meta = {};
  try {
    const bytes = await tg.download(ctx, 'inspect_download', file.file_id);
    meta = (await analyze(ctx, bytes, d, file.name)) || {};
  } catch (err) {
    if (!isToolError(err)) log.warn('inspect_failed', { update_id: ctx.updateId, user_id: ctx.user.id, kind: err && err.kind });
    return {};
  }
  await store.setFileMeta(file.ref, ctx.user.id, meta);
  return meta;
}

/** A file's card as a new message (results registered later, e.g. a worker's output). */
export async function sendCard(ctx, ref, chatId) {
  const loaded = await loadFile(ctx, ref);
  if (!loaded) return tg.send(ctx, 'card_expired', chatId, expired(ctx));
  const { file, d } = loaded;
  file.meta = await ensureMeta(ctx, file, d);
  await loadServices(ctx);
  return tg.send(ctx, 'card', chatId, cards.card(ctx, file, d));
}

export const expired = (ctx) => ui.plain(t(ctx.lang, 'card.expired'), [ui.homeBtn(ctx)]);
const inputOf = (file, d) => ({ fileId: file.file_id, uniqueId: file.file_unique_id, size: file.size, type: d.id, name: file.name, ref: file.ref });
const usable = (d) => !d.dangerous && d.id !== 'empty';

/** Callback codes of the file flow: f fm fn fx rn re ax al ae pz pd pr ps pi bn. */
export async function onCallback(ctx, code, args, message) {
  const [ref, sub, extra] = args;
  const loaded = await loadFile(ctx, ref);
  if (!loaded) return tg.edit(ctx, 'card_expired', message, expired(ctx));
  const { file, d } = loaded;
  if (NEEDS_META.has(code)) file.meta = await ensureMeta(ctx, file, d);
  await loadServices(ctx);
  const show = (view, s) => tg.edit(ctx, view, message, s);
  const back = () => show('card', cards.card(ctx, file, d));
  const meta = file.meta || {};
  switch (code) {
    case 'f':
      await state.clearPending(ctx.user.id, 'input');
      return back();
    case 'fm': return show('card', cards.card(ctx, file, d, { page: 2 }));
    case 'fn': return show('card', cards.card(ctx, file, d, { noFix: true }));
    case 'fx':
      if (!usable(d) || d.extOk || d.id === 'unknown') return back();
      return startJob(ctx, message, 'fix', [inputOf(file, d)], { name: fixedName(file.name, d) }, fixedName(file.name, d));
    case 'rn': {
      if (!usable(d)) return back();
      if (!sub) return show('rename', cards.renameMenu(ctx, file, d));
      if (sub === 'e') return show('rename_ext', cards.extMenu(ctx, file, d));
      if (sub === 'z') return applyRename(ctx, message, file, d, { mode: 'normalize' });
      const mode = { n: 'name', p: 'prefix', s: 'suffix' }[sub];
      if (!mode) return null;
      await state.setPending(ctx.user.id, 'input', 'rename', { ref: file.ref, mode }, ctx.now + INPUT_TTL_S);
      return show('rename_ask', cards.renamePrompt(ctx, file, mode));
    }
    case 're': return applyRename(ctx, message, file, d, { mode: 'ext', value: sub });
    case 'pz':
      if (!usable(d)) return back();
      return startJob(ctx, message, 'zip', [inputOf(file, d)], { name: `${splitName(file.name).base || 'file'}.zip` }, `${splitName(file.name).base || 'file'}.zip`);
    case 'ax': {
      if (!usable(d) || !meta.archive || meta.archive.problem || !cards.EXTRACTABLE.has(d.id)) return back();
      if (sub === 'z') return startJob(ctx, message, 'extract_zip', [inputOf(file, d)], {}, file.name);
      if (meta.archive.files > 10) return show('extract_choice', cards.extractChoice(ctx, file));
      return startJob(ctx, message, 'extract', [inputOf(file, d)], {}, file.name);
    }
    case 'al':
      if (!meta.archive || meta.archive.problem) return back();
      return show('extract_list', cards.entryList(ctx, file, Number(sub) || 0));
    case 'ae': {
      const item = meta.archive && (meta.archive.items || []).find(([i]) => i === Number(sub));
      if (!item) return back();
      return startJob(ctx, message, 'extract_one', [inputOf(file, d)], { index: item[0] }, item[1], { keepMessage: true });
    }
    case 'pi':
      if (!usable(d) || !['jpeg', 'png'].includes(d.id)) return back();
      return startJob(ctx, message, 'pdf_combine', [inputOf(file, d)], {}, `${splitName(file.name).base || 'file'}.pdf`);
    case 'pd': {
      if (!usable(d) || d.id !== 'pdf' || !meta.pdf || !meta.pdf.pages || meta.pdf.problem) return back();
      if (sub === 'r') return show('pdf_rotate', cards.rotateMenu(ctx, file));
      if (sub === 's') return show('pdf_split', cards.splitMenu(ctx, file));
      const op = { x: 'x', d: 'd', o: 'o', R: 'r' }[sub];
      if (!op) return back();
      await state.setPending(ctx.user.id, 'input', 'pdf', { ref: file.ref, op }, ctx.now + INPUT_TTL_S);
      return show('pdf_ask', cards.pdfPrompt(ctx, file, op));
    }
    case 'pr': {
      if (d.id !== 'pdf' || !meta.pdf || !meta.pdf.pages || meta.pdf.problem) return back();
      const deg = Number(sub);
      if (![90, 180, 270].includes(deg)) return back();
      let ranges = null;
      if (extra === 'p') {
        const p = await state.getPending(ctx.user.id, 'input', ctx.now);
        if (!p || p.kind !== 'pdfrot' || p.payload.ref !== file.ref) return show('pdf_rotate', cards.rotateMenu(ctx, file));
        ranges = p.payload.ranges;
        await state.clearPending(ctx.user.id, 'input');
      }
      return startJob(ctx, message, 'pdf_rotate', [inputOf(file, d)], ranges ? { deg, ranges } : { deg }, file.name);
    }
    case 'ps': {
      if (d.id !== 'pdf' || !meta.pdf || !meta.pdf.pages || meta.pdf.problem) return back();
      if (sub === 'r') {
        await state.setPending(ctx.user.id, 'input', 'pdf', { ref: file.ref, op: 's' }, ctx.now + INPUT_TTL_S);
        return show('pdf_ask', cards.pdfPrompt(ctx, file, 's'));
      }
      const n = Number(sub);
      if (![1, 2, 5, 10].includes(n)) return back();
      return startJob(ctx, message, 'pdf_split', [inputOf(file, d)], { mode: 'n', n }, file.name);
    }
    case 'bn':
      if (!usable(d)) return back();
      return batch.startFrom(ctx, message, file);
    case 'oc': case 'oy': {
      if (!cards.ocrable(ctx, file, d)) return back();
      if (code === 'oy') {
        const value = ctx.gemini.paid ? -ctx.now : ctx.now;
        await users.setSetting(ctx.user.id, 'ocrConsent', value, ctx.now);
        ctx.user.s_ocr_consent = value;
      }
      if (!consented(ctx)) return show('ocr_consent', cards.ocrConsent(ctx, file));
      return startJob(ctx, message, 'ocr', [inputOf(file, d)], {}, file.name);
    }
    default:
      return null;
  }
}

/** Typed answers: rename (new name / prefix / suffix) and PDF page ranges. */
export async function onInput(ctx, message, pending) {
  const loaded = await loadFile(ctx, pending.payload.ref);
  if (!loaded) { await state.clearPending(ctx.user.id, 'input'); return tg.send(ctx, 'card_expired', message.chat.id, expired(ctx)); }
  const { file, d } = loaded;
  const text = String(message.text || '');
  const chatId = message.chat.id;
  if (pending.kind === 'rename') {
    const r = renameTo(file.name, d, { mode: pending.payload.mode, value: text });
    if (!r.ok) return tg.send(ctx, 'rename_error', chatId, ui.plain(t(ctx.lang, `rn.err_${r.error}`), [ui.backBtn(ctx, 'rn', file.ref), ui.cancelBtn(ctx)]));
    await state.clearPending(ctx.user.id, 'input');
    return startJob(ctx, null, 'rename', [inputOf(file, d)], { name: r.name }, r.name, { chatId });
  }
  // PDF ranges (pdf: x extract, d remove, o reorder, r rotate-some, s split by ranges; pdfrot: retyped)
  const pages = file.meta && file.meta.pdf && file.meta.pdf.pages;
  if (!pages) { await state.clearPending(ctx.user.id, 'input'); return tg.send(ctx, 'card', chatId, cards.card(ctx, file, d)); }
  const op = pending.kind === 'pdfrot' ? 'r' : pending.payload.op;
  const check = op === 's' ? rangeGroups(text, pages) : parseRanges(text, pages);
  const retry = (key, vars = {}) => tg.send(ctx, 'pdf_range_error', chatId, ui.plain(t(ctx.lang, key, { pages: ui.num(ctx, pages), ...vars }), [ui.backBtn(ctx, 'f', file.ref), ui.cancelBtn(ctx)]));
  if (!check.ok) return check.error === 'out_of_range' ? retry('pdf.err_range', { page: ui.num(ctx, check.page) }) : retry('pdf.err_syntax');
  if (op === 'd' && new Set(check.pages).size >= pages) return retry('pdf.err_all');
  if (op === 's' && check.groups.length < 2) return retry('pdf.err_one_part');
  if (op === 'r') {
    await state.setPending(ctx.user.id, 'input', 'pdfrot', { ref: file.ref, ranges: text }, ctx.now + INPUT_TTL_S);
    return tg.send(ctx, 'pdf_rotate', chatId, cards.rotateMenu(ctx, file, text));
  }
  await state.clearPending(ctx.user.id, 'input');
  const job = { x: ['pdf_extract', { ranges: text }], d: ['pdf_remove', { ranges: text }], o: ['pdf_reorder', { ranges: text }], s: ['pdf_split', { mode: 'ranges', ranges: text }] }[op];
  return startJob(ctx, null, job[0], [inputOf(file, d)], job[1], file.name, { chatId });
}

async function applyRename(ctx, message, file, d, op) {
  const r = renameTo(file.name, d, op);
  if (!r.ok) {
    await tg.answer(ctx, ctx.cqId, t(ctx.lang, `rn.err_${r.error}`).replace(/<[^>]+>/g, ''));
    ctx.answered = true;
    return null;
  }
  return startJob(ctx, message, 'rename', [inputOf(file, d)], { name: r.name }, r.name);
}

/**
 * «📄 DOCX» under an OCR result: the text comes from the message itself (short results) or from the
 * .txt document it carries (long ones) — the bot never stores OCR text.
 */
export async function onDocx(ctx, message) {
  let text = null;
  let base = `ocr_${tehranDay(ctx.now)}`;
  if (message && message.document) {
    try {
      const bytes = await tg.download(ctx, 'docx_download', message.document.file_id);
      text = new TextDecoder('utf-8').decode(bytes).replace(/^\ufeff/, '');
      base = splitName(message.document.file_name || base).base || base;
    } catch {
      text = null;
    }
  } else if (message && message.text) {
    const i = message.text.indexOf('\n\n');
    text = i >= 0 ? message.text.slice(i + 2) : null;
  }
  if (!text || !text.trim()) return tg.send(ctx, 'docx_gone', ctx.chatId, ui.plain(t(ctx.lang, 'ocr.docx_gone')));
  const slot = await takeIntakeSlot(ctx);
  if (!slot.ok) return tg.send(ctx, 'intake_rate', ctx.chatId, { text: t(ctx.lang, 'rate.intake', { s: ui.num(ctx, slot.retryS) }) });
  await tg.action(ctx, ctx.chatId, 'upload_document');
  return tg.sendBytes(ctx, 'docx', ctx.chatId, textToDocx(text), `${base}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
