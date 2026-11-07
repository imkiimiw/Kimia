// In-bot jobs (engine 'bot'): rate limits, the result cache, and the runner that downloads the input,
// produces the output and uploads it — all inside one invocation (≤ 20 MB in, measured ≈ 3 s for
// 19 MB). Status machine: DOWNLOADING → PROCESSING → UPLOADING → COMPLETED | FAILED; a job left
// "running" by a dead invocation becomes EXPIRED (lib/db/files.js#expireStale).
import { CACHE_TTL_S, MB, STATUS_MESSAGE_MIN_BYTES, STALE_JOB_S } from './config.js';
import * as store from './db/files.js';
import * as state from './db/state.js';
import { addError, count, countMany } from './db/system.js';
import { TYPES } from './detect/types.js';
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
  const kind = err && err.kind;
  if (kind === 'too_big') return 'TOO_BIG';
  if (kind === 'rate') return 'RATE_LIMITED';
  if (kind === 'blocked') return 'USER_BLOCKED';
  if (step === 'download') return kind === 'bad_file' ? 'FILE_GONE' : 'DOWNLOAD_FAILED';
  if (step === 'upload') return 'UPLOAD_FAILED';
  if (step === 'validate') return 'OUTPUT_INVALID';
  return 'INTERNAL';
}

const cacheKey = (userId, uniqueId, op, outName) => `${userId}:${uniqueId}:${op}:${hash32(outName)}`;

/**
 * Runs a re-upload job (Detect & Fix, rename): the same bytes under `outName`.
 * input: { fileId, uniqueId, size, type (detected id), ref }
 * → { ok, job, ref? (the result's file card), code? }
 */
export async function runRename(ctx, { op, input, outName, chatId, retry = false }) {
  const t0 = Date.now();
  const type = TYPES[input.type] || TYPES.unknown;
  const job = {
    id: ulid(ctx.nowMs),
    code: jobCode(),
    userId: ctx.targetUserId || ctx.user.id,
    operation: op,
    status: 'DOWNLOADING',
    engine: 'bot',
    inputType: type.label,
    inputSize: input.size,
    inputFileId: input.fileId,
    inputRef: input.ref || null,
    params: JSON.stringify({ name: outName, type: input.type, unique: input.uniqueId || null }),
    createdAt: ctx.now,
    startedAt: ctx.now,
  };
  await store.createJob(job);
  const logBase = { update_id: ctx.updateId, job_id: job.id, job_code: job.code, user_id: job.userId, operation: op, input_type: type.label, input_size: input.size };

  const key = input.uniqueId ? cacheKey(job.userId, input.uniqueId, op, outName) : null;
  const caption = ui.resultCaption(ctx, job, outName);
  let statusMsg = null;
  let step = 'download';
  try {
    // an identical request in the last 24 h: answered from the cache, no re-processing (spec §10)
    if (key && !retry) {
      const hit = await store.getCached(key, ctx.now);
      if (hit) {
        // same bytes, new name: the result's card can reuse the input's identity for later caching
        const outRef = fileRef();
        await store.putFile({ ref: outRef, userId: job.userId, fileId: hit.file_id, fileUniqueId: input.uniqueId, kind: 'document', name: hit.name || outName, size: hit.output_size || input.size, type: input.type, createdAt: ctx.now });
        const sent = await tg.sendFileId(ctx, 'job_cached', chatId, hit.file_id, { caption, reply_markup: ui.resultMarkup(ctx, outRef) });
        await finish(ctx, job, 'COMPLETED', { outputType: type.label, outputSize: hit.output_size, outputFileId: hit.file_id });
        log.info('job.cached', { ...logBase, status: 'COMPLETED', duration_ms: Date.now() - t0 });
        return { ok: true, job, cached: true, ref: outRef, messageId: sent && sent.message_id };
      }
    }
    if (input.size >= STATUS_MESSAGE_MIN_BYTES) statusMsg = await tg.send(ctx, 'job_status', chatId, { text: ui.progress(ctx, job, 'DOWNLOADING') });
    else await tg.action(ctx, chatId, 'upload_document');

    const bytes = await tg.download(ctx, 'job_download', input.fileId);
    step = 'validate';
    if (!bytes || bytes.length !== input.size) throw Object.assign(new Error('size mismatch'), { kind: 'validate' });
    if (bytes.length > ctx.limits.MAX_OUTPUT_MB * MB) throw Object.assign(new Error('too big'), { kind: 'too_big' });

    step = 'upload';
    await store.setJobStatus(job.id, 'UPLOADING');
    if (statusMsg) await tg.edit(ctx, 'job_status', statusMsg, { text: ui.progress(ctx, job, 'UPLOADING') });
    const outRef = fileRef();
    const sent = await tg.sendBytes(ctx, 'job_result', chatId, bytes, outName, type.mime, { caption, reply_markup: ui.resultMarkup(ctx, outRef) });
    const doc = sent && sent.document;
    step = 'validate';
    if (!doc || doc.file_size !== bytes.length) throw Object.assign(new Error('upload mismatch'), { kind: 'validate' });
    if (doc.file_name !== outName) log.warn('job.name_changed_by_telegram', logBase);

    // the result gets its own card, so «🔁 کار دیگری با همین فایل» works on it
    await store.putFile({ ref: outRef, userId: job.userId, fileId: doc.file_id, fileUniqueId: doc.file_unique_id, kind: 'document', name: doc.file_name || outName, size: doc.file_size, type: input.type, createdAt: ctx.now });
    if (key) await store.putCached({ key, userId: job.userId, fileId: doc.file_id, name: outName, outputType: type.label, outputSize: doc.file_size, expiresAt: ctx.now + CACHE_TTL_S });
    await finish(ctx, job, 'COMPLETED', { outputType: type.label, outputSize: doc.file_size, outputFileId: doc.file_id });
    if (statusMsg) await tg.edit(ctx, 'job_status', statusMsg, { text: ui.progress(ctx, job, 'COMPLETED') });
    log.info('job.done', { ...logBase, status: 'COMPLETED', output_type: type.label, output_size: doc.file_size, duration_ms: Date.now() - t0 });
    return { ok: true, job, ref: outRef };
  } catch (err) {
    const code = errorCode(step, err);
    await finish(ctx, job, 'FAILED', { errorCode: code });
    await addError(ctx.now, `job.${op}`, code, err && (err.description || err.message), job.code);
    log.warn('job.failed', { ...logBase, status: 'FAILED', error_code: code, kind: err && err.kind, duration_ms: Date.now() - t0 });
    if (code !== 'USER_BLOCKED') {
      const text = ui.failure(ctx, code, job.code);
      if (statusMsg) await tg.edit(ctx, 'job_status', statusMsg, { text }).catch(() => null);
      else await tg.send(ctx, 'job_failed', chatId, { text }).catch(() => null);
    }
    return { ok: false, job, code };
  }
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
