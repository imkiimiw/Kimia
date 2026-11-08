// Worker flows in the bot (C4): image tools on a file card (wi/wo), text → image (wt), the result's
// «⚙️ کار دیگری با نتیجه» button (wf) and cancel (wx). A job is recorded (engine 'worker'), a status
// message is sent, and the job is POSTed to the worker; from then on the worker downloads, processes,
// sends the result and edits that status message. The bot's row is updated lazily (worker.js#syncJob).
import { INPUT_TTL_S, WTEXT_MAX } from './config.js';
import { TYPES } from './detect/types.js';
import * as store from './db/files.js';
import * as state from './db/state.js';
import { addError, countMany } from './db/system.js';
import { expired, loadFile, sendCard } from './files.js';
import { t } from './i18n/index.js';
import { takeJobSlot } from './jobs.js';
import * as log from './log.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import * as W from './wtools.js';
import { clearCache, loadWorker, markDown, request, syncJob } from './worker.js';
import { fileRef, isJobCode, jobCode, ulid } from './util.js';

const L = (ctx, key, vars) => t(ctx.lang, key, vars);
const unavailable = (ctx, ...rows) => ui.plain(L(ctx, 'wt.unavailable'), ...(rows.length ? rows : [[ui.homeBtn(ctx)]]));
const ACTIVE = new Set(['QUEUED', 'DOWNLOADING', 'PROCESSING', 'UPLOADING']);

/** Pure: typed text for a worker tool → { text } | { error, max }. */
export function checkText(raw, max) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: 'empty', max };
  if ([...text].length > max) return { error: 'long', max };
  return { text };
}

/** Worker refusal → the bot's error code (shown with err.<code>). */
export function refusalCode(status, error) {
  if (error === 'USER_BUSY') return 'WORKER_USER_BUSY';
  if (error === 'QUEUE_FULL' || status === 503 || status === 429 || status >= 500) return 'WORKER_BUSY';
  if (error === 'TOO_BIG') return 'TOO_BIG';
  if (error === 'UNKNOWN_OP' || error === 'BAD_INPUT_TYPE' || error === 'BAD_INPUTS') return 'WORKER_UNAVAILABLE';
  return 'INTERNAL';
}

/**
 * Records the job, sends the status message and hands the job to the worker.
 * inputs: [{ file_id, unique, name, type, size, ref }] (empty for text → image).
 */
async function submit(ctx, message, { op, params, inputs, shownName, chatId, inputType, inputSize }) {
  const slot = await takeJobSlot(ctx);
  if (!slot.ok) {
    const mins = Math.max(1, Math.ceil(slot.retryS / 60));
    return tg.send(ctx, 'job_rate', chatId, { text: L(ctx, 'rate.jobs', { m: ui.num(ctx, mins) }) });
  }
  if (message) await tg.edit(ctx, 'card', message, ui.plain(L(ctx, 'job.started', { op: ui.opLabel(ctx, op), name: shownName })));
  const first = inputs[0] || null;
  const { text: _userText, ...shown } = params; // user text is never stored in the bot's job row
  const job = {
    id: ulid(ctx.nowMs), code: jobCode(), userId: ctx.user.id, operation: op, status: 'QUEUED', engine: 'worker',
    inputType, inputSize, inputFileId: first ? first.file_id : null, inputRef: first ? first.ref : null,
    params: JSON.stringify({ ...shown, ...(first ? { src: first.name, type: first.type, unique: first.unique || null } : {}) }),
    createdAt: ctx.now, startedAt: ctx.now,
  };
  await store.createJob(job);
  const statusMsg = await tg.send(ctx, 'wjob_status', chatId, W.queued(ctx, job.code));
  const logBase = { update_id: ctx.updateId, job_id: job.id, job_code: job.code, user_id: job.userId, operation: op, input_type: inputType, input_size: inputSize };
  const fail = async (code, detail = null) => {
    await store.finishJob(job.id, { status: 'FAILED', errorCode: code, now: ctx.now });
    await countMany([[ctx.day, 'jobs_failed'], [ctx.day, `jobs_failed:${op}`]]);
    if (code === 'INTERNAL' || code === 'WORKER_AUTH') await addError(ctx.now, `worker.${op}`, code, detail, job.code);
    log.warn('job.failed', { ...logBase, status: 'FAILED', error_code: code, engine: 'worker' });
    const text = ui.failure(ctx, code, job.code);
    if (statusMsg) await tg.edit(ctx, 'wjob_status', statusMsg, { text }).catch(() => null);
    return { ok: false, job, code };
  };
  let r;
  try {
    r = await request(ctx, 'POST', '/v1/jobs', {
      job_id: job.id, code: job.code, user_id: job.userId, chat_id: chatId, lang: ctx.lang, op,
      inputs: inputs.map((i) => ({ file_id: i.file_id, name: i.name, type: i.type, size: i.size || 0 })),
      params, status_message_id: statusMsg ? statusMsg.message_id : null, reply_to: null,
    });
  } catch (e) {
    if (e.code === 'UNREACHABLE') await markDown(ctx, 'UNREACHABLE');
    return fail(e.code === 'AUTH' ? 'WORKER_AUTH' : 'WORKER_DOWN');
  }
  if ((r.status === 202 || r.status === 200) && r.data && r.data.job) {
    const pos = r.data.job.position || 0;
    if (pos > 1 && statusMsg) await tg.edit(ctx, 'wjob_status', statusMsg, W.queued(ctx, job.code, pos)).catch(() => null);
    await countMany([[ctx.day, 'jobs_worker'], [ctx.day, `jobs_worker:${op}`]]);
    log.info('job.queued', { ...logBase, status: 'QUEUED', engine: 'worker', position: pos });
    return { ok: true, job };
  }
  const error = r.data && r.data.error;
  const code = refusalCode(r.status, error);
  if (code === 'WORKER_UNAVAILABLE') await clearCache(ctx.now); // its tools changed: re-read them
  return fail(code, error ? `${r.status} ${error}` : `HTTP ${r.status}`);
}

const fileInput = (file, d) => ({ file_id: file.file_id, unique: file.file_unique_id, name: file.name, type: d.id, size: file.size, ref: file.ref });

/** Callback codes wi wo wt wf wx. */
export async function onCallback(ctx, code, args, message) {
  await loadWorker(ctx);
  if (code === 'wi' || code === 'wo') return fileTool(ctx, code, args, message);
  if (code === 'wt') return textToImage(ctx, args, message);
  if (code === 'wf') return more(ctx, args[0], message);
  if (code === 'wx') return cancel(ctx, args[0], message);
  return null;
}

async function fileTool(ctx, code, [ref, sub], message) {
  const loaded = await loadFile(ctx, ref);
  if (!loaded) return tg.edit(ctx, 'card_expired', message, expired(ctx));
  const { file, d } = loaded;
  const show = (view, s) => tg.edit(ctx, view, message, s);
  const tools = () => show('wt_tools', W.toolsScreen(ctx, file, d));
  if (!W.imageToolsOk(ctx, file, d)) return show('wt_off', unavailable(ctx, [ui.backBtn(ctx, 'f', ref), ui.homeBtn(ctx)]));
  if (code === 'wi') {
    if (!sub) return tools();
    if (!W.CATS[sub] || !W.catPresets(ctx, sub, file, d).length) return tools();
    if (W.TEXT_CATS.has(sub)) {
      await state.setPending(ctx.user.id, 'input', 'wtext', { ref, cat: sub }, ctx.now + INPUT_TTL_S);
      return show('wt_ask', W.askText(ctx, file, sub));
    }
    return show('wt_cat', W.catScreen(ctx, file, d, sub));
  }
  if (!W.presetOk(ctx, sub, file, d)) return tools();
  const [op, base, needsText] = W.PRESETS[sub];
  const params = { ...base };
  if (needsText) {
    const cat = sub.split('.')[0];
    const p = await state.getPending(ctx.user.id, 'input', ctx.now);
    if (!p || p.kind !== 'wpos' || p.payload.ref !== ref || p.payload.cat !== cat) {
      await state.setPending(ctx.user.id, 'input', 'wtext', { ref, cat }, ctx.now + INPUT_TTL_S);
      return show('wt_ask', W.askText(ctx, file, cat));
    }
    params.text = p.payload.text;
    await state.clearPending(ctx.user.id, 'input');
  }
  const label = (TYPES[d.id] || TYPES.unknown).label;
  return submit(ctx, message, { op, params, inputs: [fileInput(file, d)], shownName: file.name, chatId: ctx.chatId, inputType: label, inputSize: file.size });
}

/** Typed text: watermark / text on image (kinds wtext, wpos) and text → image (tti, ttio). */
export async function onInput(ctx, message, pending) {
  await loadWorker(ctx);
  const chatId = message.chat.id;
  const tti = pending.kind === 'tti' || pending.kind === 'ttio';
  const max = tti ? WTEXT_MAX.tti : WTEXT_MAX[pending.payload.cat];
  const v = checkText(message.text, max || 100);
  const retryRows = tti ? [[ui.cancelBtn(ctx)]] : [[ui.backBtn(ctx, 'wi', pending.payload.ref), ui.cancelBtn(ctx)]];
  if (v.error) return tg.send(ctx, 'wt_text_error', chatId, ui.plain(L(ctx, `wt.text_${v.error}`, { max: ui.num(ctx, v.max) }), ...retryRows));
  if (tti) {
    if (!W.ttiOk(ctx)) { await state.clearPending(ctx.user.id, 'input'); return tg.send(ctx, 'wt_off', chatId, unavailable(ctx)); }
    await state.setPending(ctx.user.id, 'input', 'ttio', { text: v.text }, ctx.now + INPUT_TTL_S);
    return tg.send(ctx, 'wt_theme', chatId, W.themeScreen(ctx));
  }
  const { ref, cat } = pending.payload;
  if (!(await loadFile(ctx, ref))) { await state.clearPending(ctx.user.id, 'input'); return tg.send(ctx, 'card_expired', chatId, expired(ctx)); }
  await state.setPending(ctx.user.id, 'input', 'wpos', { ref, cat, text: v.text }, ctx.now + INPUT_TTL_S);
  return tg.send(ctx, 'wt_pos', chatId, W.positionScreen(ctx, ref, cat));
}

async function textToImage(ctx, [step, theme, size], message) {
  const show = (view, s) => tg.edit(ctx, view, message, s);
  if (!W.ttiOk(ctx)) { await state.clearPending(ctx.user.id, 'input'); return show('wt_off', unavailable(ctx)); }
  const ask = async () => {
    await state.setPending(ctx.user.id, 'input', 'tti', {}, ctx.now + INPUT_TTL_S);
    return show('wt_tti_ask', W.ttiAsk(ctx));
  };
  if (!step) return ask();
  const p = await state.getPending(ctx.user.id, 'input', ctx.now);
  if (!p || p.kind !== 'ttio' || !p.payload || !p.payload.text) return ask();
  if (step === 'b') return show('wt_theme', W.themeScreen(ctx));
  if (!W.THEMES.includes(theme)) return show('wt_theme', W.themeScreen(ctx));
  if (step === 't') return show('wt_size', W.sizeScreen(ctx, theme));
  if (step !== 'g' || !W.SIZES.includes(size)) return show('wt_size', W.sizeScreen(ctx, theme));
  await state.clearPending(ctx.user.id, 'input');
  const text = p.payload.text;
  const bytes = new TextEncoder().encode(text).length;
  return submit(ctx, message, { op: 'tti', params: { text, theme, preset: size }, inputs: [], shownName: ui.P(ctx, `wt.size_${size}`), chatId: ctx.chatId, inputType: 'TEXT', inputSize: bytes });
}

function typeByName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  for (const [id, ty] of Object.entries(TYPES)) if (ty.exts && ty.exts.includes(ext)) return id;
  return 'unknown';
}

/**
 * «⚙️ کار دیگری با نتیجه»: the result becomes a file card. The document on the pressed message is
 * the result itself (no download, works even if the worker is down); a summary message without a
 * document takes the outputs from the worker.
 */
async function more(ctx, code, message) {
  if (!isJobCode(code)) return null;
  const job = await store.jobByCode(code, ctx.user.id);
  if (!job || job.engine !== 'worker') return tg.send(ctx, 'wt_gone', ctx.chatId, ui.plain(L(ctx, 'wt.result_gone'), [ui.homeBtn(ctx)]));
  const { remote } = await syncJob(ctx, job);
  const doc = message && message.document;
  let outs = [];
  if (doc) {
    const match = remote && (remote.outputs || []).find((o) => o.file_unique_id === doc.file_unique_id);
    outs = [{ file_id: doc.file_id, file_unique_id: doc.file_unique_id, name: doc.file_name || (match && match.name) || 'file', size: doc.file_size || 0, type: (match && match.type) || typeByName(doc.file_name) }];
  } else if (remote && remote.outputs) {
    outs = remote.outputs.filter((o) => o.file_id).slice(0, 10);
  }
  if (!outs.length) return tg.send(ctx, 'wt_gone', ctx.chatId, ui.plain(L(ctx, 'wt.result_gone'), [ui.homeBtn(ctx)]));
  const refs = [];
  for (const o of outs) {
    const ref = fileRef();
    await store.putFile({ ref, userId: ctx.user.id, fileId: o.file_id, fileUniqueId: o.file_unique_id || `${job.code}:${refs.length}`, kind: 'document', name: o.name, size: o.size || 0, type: o.type in TYPES ? o.type : typeByName(o.name), createdAt: ctx.now, meta: null });
    refs.push(ref);
  }
  return sendCard(ctx, refs[0], ctx.chatId);
}

/** Cancel a worker job: the button on its status message, or /cancel (lib/router.js). */
export async function cancel(ctx, code, message = null) {
  const reply = (key, vars = {}) => (message ? tg.edit(ctx, 'wt_cancel', message, ui.plain(L(ctx, key, vars))) : tg.send(ctx, 'wt_cancel', ctx.chatId, ui.plain(L(ctx, key, vars), [ui.homeBtn(ctx)])));
  const job = isJobCode(code) ? await store.jobByCode(code, ctx.user.id) : null;
  if (!job || job.engine !== 'worker') return reply('wt.cancel_none');
  if (!ACTIVE.has(job.status)) return reply('wt.cancel_final', { code: job.code, status: ui.statusLabel(ctx, job.status) });
  let r;
  try {
    r = await request(ctx, 'DELETE', `/v1/jobs/${job.id}?user_id=${job.user_id}`);
  } catch {
    return reply('wt.cancel_unreachable', { code: job.code });
  }
  const w = r.status === 200 && r.data && r.data.job;
  if (!w) return reply('wt.cancel_unreachable', { code: job.code });
  if (w.status === 'CANCELLED') {
    await store.syncWorkerJob(job.id, { status: 'CANCELLED', finishedAt: ctx.now });
    // the worker edits the status message itself; a /cancel gets a short confirmation
    return message ? null : reply('wt.cancelled', { code: job.code });
  }
  if (w.cancel_requested && ACTIVE.has(w.status)) return message ? null : reply('wt.cancelling', { code: job.code });
  await syncJob(ctx, job);
  return reply('wt.cancel_final', { code: job.code, status: ui.statusLabel(ctx, w.status) });
}

/** /cancel without a code: the newest unfinished worker job of the user, if any. */
export async function latestActive(ctx) {
  const rows = await store.recentJobs(ctx.user.id, 5);
  return rows.find((j) => j.engine === 'worker' && ACTIVE.has(j.status)) || null;
}

