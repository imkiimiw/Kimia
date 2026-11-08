// In-bot jobs (engine 'bot'): rate limits, the result cache, and the runner — download the inputs
// (≤ 4 at a time), run the operation (lib/ops.js), validate and deliver the outputs, all inside one
// invocation. Status machine: DOWNLOADING → PROCESSING → UPLOADING → COMPLETED | FAILED; a job left
// "running" by a dead invocation becomes EXPIRED (lib/db/files.js#expireStale).
// Delivery: ≤ maxSeparate outputs as separate documents (each with «🔁» to its own card), more as
// store-only ZIP parts ≤ 50 MB; batch renames as document albums.
import { CACHE_TTL_S, MB, STATUS_MESSAGE_MIN_BYTES, STALE_JOB_S } from './config.js';
import { zipParts } from './archive.js';
import * as store from './db/files.js';
import * as state from './db/state.js';
import { addError, count, countMany } from './db/system.js';
import { TYPES } from './detect/types.js';
import { isToolError } from './errors.js';
import { OPS } from './ops.js';
import { splitName } from './names.js';
import { t } from './i18n/index.js';
import * as log from './log.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { fileRef, hash32, jobCode, ulid } from './util.js';

/**
 * Takes one job from the user's rate limits (spec §9: RATE_BURST_PER_MIN, RATE_JOBS_PER_HOUR; staff
 * unlimited). Fixed clock windows; one atomic upsert each. → { ok } | { ok: false, retryS }
 */
export async function takeJobSlot(ctx) {
  if (ctx.actor !== 'user') return { ok: true };
  const uid = ctx.user.id;
  const minute = Math.floor(ctx.now / 60);
  const hour = Math.floor(ctx.now / 3600);
  if (!(await state.take(uid, `m:${minute}`, ctx.limits.RATE_BURST_PER_MIN, (minute + 2) * 60))) {
    return { ok: false, retryS: (minute + 1) * 60 - ctx.now };
  }
  if (!(await state.take(uid, `h:${hour}`, ctx.limits.RATE_JOBS_PER_HOUR, (hour + 1) * 3600 + 60))) {
    await state.giveBack(uid, `m:${minute}`);
    return { ok: false, retryS: (hour + 1) * 3600 - ctx.now };
  }
  return { ok: true };
}

/** Files received per minute (detection downloads the file). Staff unlimited. */
export async function takeIntakeSlot(ctx) {
  if (ctx.actor !== 'user') return { ok: true };
  const minute = Math.floor(ctx.now / 60);
  if (await state.take(ctx.user.id, `i:${minute}`, ctx.limits.RATE_INTAKE_PER_MIN, (minute + 2) * 60)) return { ok: true };
  return { ok: false, retryS: (minute + 1) * 60 - ctx.now };
}

/** Error code for a failure at a step (spec §4: friendly text + job code; no stack traces). */
export function errorCode(step, err) {
  if (isToolError(err)) return err.code;
  const kind = err && err.kind;
  if (kind === 'too_big') return 'TOO_BIG';
  if (kind === 'rate') return 'RATE_LIMITED';
  if (kind === 'blocked') return 'USER_BLOCKED';
  if (step === 'download') return kind === 'bad_file' ? 'FILE_GONE' : 'DOWNLOAD_FAILED';
  if (step === 'upload') return 'UPLOAD_FAILED';
  if (step === 'validate') return 'OUTPUT_INVALID';
  return 'INTERNAL';
}

/** Runs fn over items with at most `limit` in flight (Telegram downloads: 4, measured in C0). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const label = (inputs) => (inputs.length === 1 ? (TYPES[inputs[0].type] || TYPES.unknown).label : `${inputs.length} files`);

/**
 * Runs operation `op` (lib/ops.js) on inputs [{ fileId, uniqueId, size, type, name, ref }].
 * → { ok, job, refs (cards of the delivered outputs), code? }
 */
export async function runJob(ctx, { op, inputs, params = {}, chatId, retry = false }) {
  const def = OPS[op];
  const t0 = Date.now();
  const total = inputs.reduce((s, i) => s + (i.size || 0), 0);
  const first = inputs[0];
  const stored = {
    ...params,
    ...(inputs.length === 1 ? { src: first.name, type: first.type, unique: first.uniqueId || null } : { inputs: inputs.map(({ fileId, uniqueId, size, type, name }) => ({ fileId, uniqueId, size, type, name })) }),
  };
  const job = {
    id: ulid(ctx.nowMs),
    code: jobCode(),
    userId: ctx.targetUserId || ctx.user.id,
    operation: op,
    status: 'DOWNLOADING',
    engine: 'bot',
    inputType: label(inputs),
    inputSize: total,
    inputFileId: first.fileId,
    inputRef: inputs.length === 1 ? first.ref || null : null,
    params: JSON.stringify(stored),
    createdAt: ctx.now,
    startedAt: ctx.now,
  };
  await store.createJob(job);
  const logBase = { update_id: ctx.updateId, job_id: job.id, job_code: job.code, user_id: job.userId, operation: op, input_type: job.inputType, input_size: total };

  const key = def.cacheable && inputs.length === 1 && first.uniqueId ? `${job.userId}:${first.uniqueId}:${op}:${hash32(JSON.stringify(params))}` : null;
  let statusMsg = null;
  let step = 'download';
  const setStatus = async (s) => {
    if (s !== 'DOWNLOADING') await store.setJobStatus(job.id, s);
    if (statusMsg) await tg.edit(ctx, 'job_status', statusMsg, { text: ui.progress(ctx, job, s) });
  };
  try {
    if (key && !retry) {
      const hit = await store.getCached(key, ctx.now);
      if (hit) {
        const outRef = fileRef();
        const type = hit.output_type || first.type;
        await store.putFile({ ref: outRef, userId: job.userId, fileId: hit.file_id, fileUniqueId: `${first.uniqueId}:${op}`, kind: 'document', name: hit.name, size: hit.output_size || 0, type, createdAt: ctx.now });
        await tg.sendFileId(ctx, 'job_cached', chatId, hit.file_id, { caption: ui.resultCaption(ctx, job, hit.name), reply_markup: ui.resultMarkup(ctx, outRef) });
        await finish(ctx, job, 'COMPLETED', { outputType: (TYPES[type] || TYPES.unknown).label, outputSize: hit.output_size, outputFileId: hit.file_id });
        log.info('job.cached', { ...logBase, status: 'COMPLETED', duration_ms: Date.now() - t0 });
        return { ok: true, job, cached: true, refs: [outRef] };
      }
    }
    if (inputs.length > 1 || total >= STATUS_MESSAGE_MIN_BYTES || def.heavy) statusMsg = await tg.send(ctx, 'job_status', chatId, { text: ui.progress(ctx, job, 'DOWNLOADING') });
    else await tg.action(ctx, chatId, 'upload_document');

    const blobs = await mapLimit(inputs, 4, async (i) => {
      const bytes = await tg.download(ctx, 'job_download', i.fileId);
      if (!bytes || (i.size && bytes.length !== i.size)) throw Object.assign(new Error('size mismatch'), { kind: 'validate' });
      return { bytes, name: i.name, type: i.type, size: bytes.length };
    });

    step = 'process';
    await setStatus('PROCESSING');
    const result = await def.run(blobs, params, ctx.limits);
    const notes = [...(result.notes || [])];
    let outputs = result.outputs;

    step = 'validate';
    const maxOut = ctx.limits.MAX_OUTPUT_MB * MB;
    for (const o of outputs) {
      if (!o.bytes || !o.bytes.length) throw Object.assign(new Error('empty output'), { kind: 'validate' });
      if (o.bytes.length > maxOut) {
        if (outputs.length === 1) throw Object.assign(new Error('too big'), { kind: 'too_big' });
        notes.push({ key: 'note.big_skipped', vars: { name: o.name } });
      }
    }
    outputs = outputs.filter((o) => o.bytes.length <= maxOut);
    if (!outputs.length) throw Object.assign(new Error('nothing to send'), { kind: 'validate' });
    const max = def.maxSeparate ?? 5;
    if (def.delivery !== 'group' && outputs.length > max) {
      const base = splitName((inputs.length === 1 ? first.name : 'files') || 'files').base || 'files';
      const { parts, skipped } = zipParts(outputs, maxOut);
      for (const name of skipped) notes.push({ key: 'note.big_skipped', vars: { name } });
      outputs = parts.map((bytes, i) => ({ bytes, name: parts.length === 1 ? `${base}_files.zip` : `${base}_files_part${i + 1}.zip`, type: 'zip' }));
    }

    step = 'upload';
    await setStatus('UPLOADING');
    const refs = [];
    const sent = [];
    let groupText = null;
    const noteText = notes.length ? notes.slice(0, 15).map((n) => t(ctx.lang, n.key, n.vars)).join('\n') : '';
    if (def.delivery === 'group' && outputs.length > 1) {
      for (const chunk of tg.albumChunks(outputs)) {
        const msgs = await tg.sendGroup(ctx, 'job_result', chatId, chunk, (o) => (TYPES[o.type] || TYPES.unknown).mime);
        msgs.forEach((m, k) => sent.push({ doc: m && m.document, out: chunk[k] }));
      }
      // the status message (always there for several inputs) becomes the summary; else a new one
      groupText = [ui.groupDone(ctx, job, outputs.length), noteText].filter(Boolean).join('\n');
      if (!statusMsg) await tg.send(ctx, 'job_done', chatId, { text: groupText });
    } else {
      for (let i = 0; i < outputs.length; i++) {
        const o = outputs[i];
        const ref = fileRef();
        const last = i === outputs.length - 1;
        const caption = last ? [ui.resultCaption(ctx, job, o.name), noteText].filter(Boolean).join('\n').slice(0, 1000) : `<code>${ui.escName(o.name)}</code>`;
        const m = await tg.sendBytes(ctx, 'job_result', chatId, o.bytes, o.name, (TYPES[o.type] || TYPES.unknown).mime, { caption, reply_markup: ui.resultMarkup(ctx, ref) });
        sent.push({ doc: m && m.document, out: o, ref });
        refs.push(ref);
      }
    }

    step = 'validate';
    let outSize = 0;
    for (const s of sent) {
      if (!s.doc || s.doc.file_size !== s.out.bytes.length) throw Object.assign(new Error('upload mismatch'), { kind: 'validate' });
      if (s.doc.file_name !== s.out.name) log.warn('job.name_changed_by_telegram', logBase);
      outSize += s.doc.file_size;
      // each result gets its own card, so «🔁 کار دیگری با همین فایل» works on it
      await store.putFile({ ref: s.ref || fileRef(), userId: job.userId, fileId: s.doc.file_id, fileUniqueId: s.doc.file_unique_id, kind: 'document', name: s.doc.file_name || s.out.name, size: s.doc.file_size, type: s.out.type, createdAt: ctx.now, meta: s.out.meta || null });
    }
    const one = sent.length === 1 ? sent[0] : null;
    if (key && one) await store.putCached({ key, userId: job.userId, fileId: one.doc.file_id, name: one.out.name, outputType: one.out.type, outputSize: one.doc.file_size, expiresAt: ctx.now + CACHE_TTL_S });
    const outType = one ? (TYPES[one.out.type] || TYPES.unknown).label : `${sent.length} files`;
    await finish(ctx, job, 'COMPLETED', { outputType: outType, outputSize: outSize, outputFileId: one ? one.doc.file_id : null });
    if (statusMsg) await tg.edit(ctx, 'job_status', statusMsg, { text: groupText || ui.progress(ctx, job, 'COMPLETED') });
    log.info('job.done', { ...logBase, status: 'COMPLETED', output_type: outType, output_size: outSize, duration_ms: Date.now() - t0 });
    return { ok: true, job, refs };
  } catch (err) {
    const code = errorCode(step, err);
    await finish(ctx, job, 'FAILED', { errorCode: code });
    await addError(ctx.now, `job.${op}`, code, isToolError(err) ? null : err && (err.description || err.message), job.code);
    log.warn('job.failed', { ...logBase, status: 'FAILED', error_code: code, kind: err && err.kind, duration_ms: Date.now() - t0 });
    if (code !== 'USER_BLOCKED') {
      const text = ui.failure(ctx, code, job.code, isToolError(err) ? err.vars : {});
      if (statusMsg) await tg.edit(ctx, 'job_status', statusMsg, { text }).catch(() => null);
      else await tg.send(ctx, 'job_failed', chatId, { text }).catch(() => null);
    }
    return { ok: false, job, code };
  }
}

/** Detect & Fix / rename: the same bytes under `outName` (kept for callers from C1). */
export function runRename(ctx, { op, input, outName, chatId, retry = false }) {
  return runJob(ctx, { op, inputs: [input], params: { name: outName }, chatId, retry });
}

/** Rebuilds a stored job's inputs and params (staff retry). */
export function jobInputs(job) {
  let p = {};
  try { p = job.params ? JSON.parse(job.params) : {}; } catch { p = {}; }
  const { src, type, unique, inputs, ...params } = p;
  const list = inputs || [{ fileId: job.input_file_id, uniqueId: unique || null, size: job.input_size, type: type || 'unknown', name: src || params.name || 'file', ref: job.input_ref }];
  return { inputs: list, params };
}

async function finish(ctx, job, status, out) {
  await store.finishJob(job.id, { status, now: ctx.now, ...out });
  job.status = status;
  const k = status === 'COMPLETED' ? 'jobs_done' : 'jobs_failed';
  await countMany([[ctx.day, k], [ctx.day, `${k}:${job.operation}`]]);
}

/** Housekeeping hook: marks in-bot jobs whose invocation died as EXPIRED. */
export async function expireStale(ctx) {
  const n = await store.expireStale(ctx.now - STALE_JOB_S);
  if (n) await count(ctx.day, 'jobs_expired', n);
  return n;
}

/** Rate limit → job. The card turns into a short "↪️ action: name" line first (unless keepMessage). */
export async function startJob(ctx, message, op, inputs, params, shownName, { chatId: chatIdOverride, keepMessage = false } = {}) {
  const chatId = chatIdOverride || message.chat.id;
  const slot = await takeJobSlot(ctx);
  if (!slot.ok) {
    const mins = Math.max(1, Math.ceil(slot.retryS / 60));
    return tg.send(ctx, 'job_rate', chatId, { text: t(ctx.lang, 'rate.jobs', { m: ui.num(ctx, mins) }) });
  }
  if (message && !keepMessage) await tg.edit(ctx, 'card', message, ui.plain(t(ctx.lang, 'job.started', { op: ui.opLabel(ctx, op), name: shownName })));
  return runJob(ctx, { op, inputs, params, chatId });
}
