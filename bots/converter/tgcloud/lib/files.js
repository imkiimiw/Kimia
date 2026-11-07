// File intake (spec §3, §4, §6): document, photo, audio, voice, video, video note, animation →
// size check → download (≤ 20 MB) → detection from the bytes → a file card with the actions that
// exist. Then Detect & Fix and the safe renames, which run as jobs (lib/jobs.js).
import { FILE_TTL_S, INPUT_TTL_S, MB } from './config.js';
import { detect, describe, extMatches, extOf, storedType } from './detect/index.js';
import * as store from './db/files.js';
import * as state from './db/state.js';
import { count } from './db/system.js';
import { t } from './i18n/index.js';
import { runRename, takeIntakeSlot, takeJobSlot } from './jobs.js';
import * as log from './log.js';
import { defaultName, fixedName, hadSuspiciousChars, renameTo, sanitizeName, splitName } from './names.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { fileRef } from './util.js';

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

/** A received file → its card. */
export async function intake(ctx, message, file) {
  const chatId = message.chat.id;
  const max = ctx.limits.MAX_INPUT_MB * MB;
  if (file.size && file.size > max) {
    await count(ctx.day, 'intake_too_big');
    return tg.send(ctx, 'intake_too_big', chatId, { text: t(ctx.lang, 'intake.too_big', { mb: ui.num(ctx, ctx.limits.MAX_INPUT_MB), size: ui.size(ctx, file.size) }) });
  }
  const slot = await takeIntakeSlot(ctx);
  if (!slot.ok) return tg.send(ctx, 'intake_rate', chatId, { text: t(ctx.lang, 'rate.intake', { s: ui.num(ctx, slot.retryS) }) });

  await tg.action(ctx, chatId, 'typing');
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
  const row = { ref: fileRef(), userId: ctx.user.id, fileId: file.fileId, fileUniqueId: file.uniqueId, kind: file.kind, name, size: bytes.length, type: storedType(d), createdAt: ctx.now };
  await store.putFile(row);
  await count(ctx.day, 'intake');
  log.info('intake', { update_id: ctx.updateId, user_id: ctx.user.id, input_type: d.label, input_size: bytes.length });
  return tg.send(ctx, 'card', chatId, ui.card(ctx, { ...row, ref: row.ref }, d, { suspicious: hadSuspiciousChars(file.name) }));
}

/** The file behind a card ref (owner-checked and not expired), with its detection. */
async function loadFile(ctx, ref) {
  const f = await store.getFile(ref, ctx.user.id);
  if (!f || f.created_at < ctx.now - FILE_TTL_S) return null;
  return { file: { ...f, fileId: f.file_id }, d: describe(f.type, f.name) };
}

const expired = (ctx) => ui.plain(t(ctx.lang, 'card.expired'), [ui.homeBtn(ctx)]);

/** Callback codes of the file flow: f, fn, fx, rn, re. */
export async function onCallback(ctx, code, args, message) {
  const [ref, sub] = args;
  const loaded = await loadFile(ctx, ref);
  if (!loaded) return tg.edit(ctx, 'card_expired', message, expired(ctx));
  const { file, d } = loaded;
  switch (code) {
    case 'f':
      await state.clearPending(ctx.user.id, 'input');
      return tg.edit(ctx, 'card', message, ui.card(ctx, file, d));
    case 'fn':
      return tg.edit(ctx, 'card', message, ui.cardNoFix(ctx, file, d));
    case 'fx': {
      if (d.dangerous || d.extOk || d.id === 'unknown' || d.id === 'empty') return tg.edit(ctx, 'card', message, ui.card(ctx, file, d));
      return startJob(ctx, message, file, d, 'fix', fixedName(file.name, d));
    }
    case 'rn': {
      if (d.dangerous || d.id === 'empty') return tg.edit(ctx, 'card', message, ui.card(ctx, file, d));
      if (!sub) return tg.edit(ctx, 'rename', message, ui.renameMenu(ctx, file, d));
      if (sub === 'e') return tg.edit(ctx, 'rename_ext', message, ui.extMenu(ctx, file, d, splitName(file.name).ext));
      if (sub === 'z') return applyRename(ctx, message, file, d, { mode: 'normalize' });
      const mode = { n: 'name', p: 'prefix', s: 'suffix' }[sub];
      if (!mode) return null;
      await state.setPending(ctx.user.id, 'input', 'rename', { ref: file.ref, mode, mid: message.message_id }, ctx.now + INPUT_TTL_S);
      return tg.edit(ctx, 'rename_ask', message, ui.inputPrompt(ctx, file, mode));
    }
    case 're':
      return applyRename(ctx, message, file, d, { mode: 'ext', value: sub });
    default:
      return null;
  }
}

/** A typed answer for a pending rename (new name / prefix / suffix). */
export async function onInput(ctx, message, pending) {
  const loaded = await loadFile(ctx, pending.payload.ref);
  if (!loaded) { await state.clearPending(ctx.user.id, 'input'); return tg.send(ctx, 'card_expired', message.chat.id, expired(ctx)); }
  const { file, d } = loaded;
  const text = String(message.text || '');
  const r = renameTo(file.name, d, { mode: pending.payload.mode, value: text });
  if (!r.ok) return tg.send(ctx, 'rename_error', message.chat.id, ui.plain(t(ctx.lang, `rn.err_${r.error}`), [ui.backBtn(ctx, 'rn', file.ref), ui.cancelBtn(ctx)]));
  await state.clearPending(ctx.user.id, 'input');
  return startJob(ctx, null, file, d, 'rename', r.name, message.chat.id);
}

async function applyRename(ctx, message, file, d, op) {
  const r = renameTo(file.name, d, op);
  if (!r.ok) {
    await tg.answer(ctx, ctx.cqId, t(ctx.lang, `rn.err_${r.error}`).replace(/<[^>]+>/g, ''));
    ctx.answered = true;
    return null;
  }
  return startJob(ctx, message, file, d, 'rename', r.name);
}

/** Rate limit → job. The card message turns into a short "working on it" line first. */
async function startJob(ctx, message, file, d, op, outName, chatIdOverride) {
  const chatId = chatIdOverride || message.chat.id;
  const slot = await takeJobSlot(ctx);
  if (!slot.ok) {
    const mins = Math.max(1, Math.ceil(slot.retryS / 60));
    return tg.send(ctx, 'job_rate', chatId, { text: t(ctx.lang, 'rate.jobs', { m: ui.num(ctx, mins) }) });
  }
  if (message) await tg.edit(ctx, 'card', message, ui.plain(t(ctx.lang, 'job.started', { op: ui.opLabel(ctx, op), name: outName })));
  const r = await runRename(ctx, { op, input: { fileId: file.fileId, uniqueId: file.file_unique_id, size: file.size, type: d.id, ref: file.ref }, outName, chatId });
  return r;
}
