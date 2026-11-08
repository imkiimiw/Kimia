// Batches (spec §3 albums, C2): files of an album — or sent while a batch is open — are collected
// into one batch with ONE status message («📥 ۳ فایل دریافت شد») and a «✅ تمام شد، ادامه» button
// (Serverless has no timers to debounce with). Then batch actions: ZIP, one PDF, rename, fix.
// Dangerous and empty files are never part of a batch action.
import { BATCH_COLLECT_S, INPUT_TTL_S } from './config.js';
import * as batches from './db/batches.js';
import * as cards from './cards.js';
import { describe } from './detect/index.js';
import * as store from './db/files.js';
import * as state from './db/state.js';
import { t } from './i18n/index.js';
import { startJob } from './jobs.js';
import { batchNames } from './ops.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { fileRef, tehranDay } from './util.js';

const describeRow = (f) => describe(f.type, f.name);
const usable = (f) => { const d = describeRow(f); return !d.dangerous && d.id !== 'empty'; };
const inputOf = (f) => ({ fileId: f.file_id, uniqueId: f.file_unique_id, size: f.size, type: describeRow(f).id, name: f.name, ref: f.ref });

/**
 * Shows or updates the batch's status message. Parallel album updates: the first message that
 * claims `status_mid` stays, a second one is deleted, the rest edit it.
 */
export async function showStatus(ctx, batchId, chatId) {
  let b = await batches.get(batchId, ctx.user.id);
  if (!b || b.status !== 'collecting') return null;
  const render = async () => { const c = await batches.fileCount(batchId); return cards.batchStatus(ctx, b, c.n, c.bytes); };
  const at = (mid) => ({ chat: { id: chatId }, message_id: mid });
  if (b.status_mid) return tg.edit(ctx, 'batch_status', at(b.status_mid), await render());
  const m = await tg.send(ctx, 'batch_status', chatId, await render());
  if (!m) return null;
  if (await batches.claimStatus(batchId, m.message_id)) {
    // files that arrived while this message was on its way are counted now
    return tg.edit(ctx, 'batch_status', at(m.message_id), await render());
  }
  await tg.remove(ctx, 'batch_status', chatId, m.message_id);
  b = await batches.get(batchId, ctx.user.id);
  return tg.edit(ctx, 'batch_status', at(b.status_mid), await render());
}

/** «📚 چند فایل با هم» on a card: open a batch (or use the open one) with this file in it. */
export async function startFrom(ctx, message, file) {
  if (file.batch_id) return showMenuOrStatus(ctx, message, file.batch_id);
  let b = await batches.open(ctx.user.id, ctx.now, BATCH_COLLECT_S);
  if (!b) {
    await batches.closeStale(ctx.user.id, ctx.now, BATCH_COLLECT_S);
    b = await batches.openOrCreate(ctx.user.id, fileRef(), ctx.now);
  }
  const seq = await batches.reserve(b.id, ctx.limits.BATCH_MAX_FILES, ctx.now);
  if (seq === null) return tg.edit(ctx, 'batch_full', message, ui.plain(t(ctx.lang, 'batch.full', { max: ui.num(ctx, ctx.limits.BATCH_MAX_FILES) }), [ui.homeBtn(ctx)]));
  await store.setFileBatch(file.ref, ctx.user.id, b.id, seq);
  // this card becomes the status message when the batch has none yet
  if (!b.status_mid && (await batches.claimStatus(b.id, message.message_id))) {
    const c = await batches.fileCount(b.id);
    return tg.edit(ctx, 'batch_status', message, cards.batchStatus(ctx, b, c.n, c.bytes));
  }
  await tg.edit(ctx, 'batch_added', message, ui.plain(t(ctx.lang, 'batch.added', { name: file.name })));
  return showStatus(ctx, b.id, message.chat.id);
}

async function showMenuOrStatus(ctx, message, batchId) {
  const b = await batches.get(batchId, ctx.user.id);
  if (!b || b.status === 'cancelled') return tg.edit(ctx, 'batch_gone', message, ui.plain(t(ctx.lang, 'batch.gone'), [ui.homeBtn(ctx)]));
  if (b.status === 'collecting') return showStatus(ctx, b.id, message.chat.id);
  return tg.edit(ctx, 'batch_menu', message, cards.batchMenu(ctx, b, await store.batchFiles(b.id), describeRow));
}

/** Batch callback codes: b (done collecting) bm bx bz bp bf bl br. */
export async function onCallback(ctx, code, args, message) {
  const [id, sub] = args;
  const b = await batches.get(id, ctx.user.id);
  const gone = () => tg.edit(ctx, 'batch_gone', message, ui.plain(t(ctx.lang, 'batch.gone'), [ui.homeBtn(ctx)]));
  if (!b || b.status === 'cancelled' || b.created_at < ctx.now - 86400) return gone();
  if (code === 'bx') {
    await batches.setStatus(id, ctx.user.id, 'cancelled', ctx.now);
    return tg.edit(ctx, 'batch_cancel', message, ui.plain(t(ctx.lang, 'batch.cancelled'), [ui.homeBtn(ctx)]));
  }
  if (code === 'b' && b.status === 'collecting') { await batches.setStatus(id, ctx.user.id, 'ready', ctx.now); b.status = 'ready'; }
  const files = await store.batchFiles(id);
  if (!files.length) return gone();
  const ok = files.filter(usable);
  const bytes = ok.reduce((s, f) => s + f.size, 0);
  const tooBig = bytes > ctx.limits.BATCH_TOTAL_MB * 1024 * 1024;
  const menu = () => tg.edit(ctx, 'batch_menu', message, cards.batchMenu(ctx, b, files, describeRow));
  switch (code) {
    case 'b': case 'bm': return menu();
    case 'bl': return tg.edit(ctx, 'batch_list', message, cards.batchList(ctx, b, files));
    case 'bz':
      if (!ok.length || tooBig) return menu();
      return startJob(ctx, message, 'zip', ok.map(inputOf), { name: `files_${tehranDay(ctx.now)}.zip` }, `files_${tehranDay(ctx.now)}.zip`);
    case 'bp': {
      const pdfable = ok.filter((f) => ['pdf', 'jpeg', 'png'].includes(describeRow(f).id));
      if (!pdfable.length || tooBig) return menu();
      const name = `combined_${pdfable.length}.pdf`;
      return startJob(ctx, message, 'pdf_combine', pdfable.map(inputOf), { name }, name);
    }
    case 'bf':
      if (!ok.length || tooBig) return menu();
      return startJob(ctx, message, 'bfix', ok.map(inputOf), {}, t(ctx.lang, 'batch.files', { n: ui.num(ctx, ok.length) }).replace(/<[^>]+>/g, ''));
    case 'br': {
      if (!ok.length || tooBig) return menu();
      if (!sub) return tg.edit(ctx, 'batch_rename', message, cards.batchRenameMenu(ctx, b));
      if (sub === 'z') return startJob(ctx, message, 'brename', ok.map(inputOf), { mode: 'normalize' }, t(ctx.lang, 'batch.files', { n: ui.num(ctx, ok.length) }).replace(/<[^>]+>/g, ''));
      const mode = { p: 'prefix', s: 'suffix', n: 'number' }[sub];
      if (!mode) return menu();
      await state.setPending(ctx.user.id, 'input', 'brename', { batch: id, mode }, ctx.now + INPUT_TTL_S);
      return tg.edit(ctx, 'batch_rename_ask', message, cards.batchPrompt(ctx, b, mode));
    }
    default:
      return menu();
  }
}

/** The typed prefix / suffix / base name of a batch rename. */
export async function onInput(ctx, message, pending) {
  const chatId = message.chat.id;
  const b = await batches.get(pending.payload.batch, ctx.user.id);
  await state.clearPending(ctx.user.id, 'input');
  if (!b || b.status === 'cancelled') return tg.send(ctx, 'batch_gone', chatId, ui.plain(t(ctx.lang, 'batch.gone'), [ui.homeBtn(ctx)]));
  const ok = (await store.batchFiles(b.id)).filter(usable);
  const value = String(message.text || '').trim();
  const names = batchNames(ok.map((f) => ({ name: f.name, type: describeRow(f).id })), pending.payload.mode, value);
  if (!value || names.every((n, i) => n === ok[i].name)) {
    await state.setPending(ctx.user.id, 'input', 'brename', pending.payload, ctx.now + INPUT_TTL_S);
    return tg.send(ctx, 'batch_rename_error', chatId, ui.plain(t(ctx.lang, 'rn.err_empty'), [ui.backBtn(ctx, 'br', b.id), ui.cancelBtn(ctx)]));
  }
  return startJob(ctx, null, 'brename', ok.map(inputOf), { mode: pending.payload.mode, value }, t(ctx.lang, 'batch.files', { n: ui.num(ctx, ok.length) }).replace(/<[^>]+>/g, ''), { chatId });
}
