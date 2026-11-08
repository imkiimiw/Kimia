// Received files (the state behind a file card) and jobs. Index-backed, LIMITed queries.
import { db } from 'sdk';
import { sql } from 'sdk/db';

// ---- files ----
export function putFile(f) {
  return db.run(sql`INSERT INTO files (ref, user_id, file_id, file_unique_id, kind, name, size, type, created_at, meta, batch_id, seq)
    VALUES (${f.ref}, ${f.userId}, ${f.fileId}, ${f.fileUniqueId}, ${f.kind}, ${f.name}, ${f.size}, ${f.type}, ${f.createdAt},
      ${f.meta ? JSON.stringify(f.meta) : null}, ${f.batchId || null}, ${f.seq ?? null})`);
}

const FILE_COLS = sql`ref, user_id, file_id, file_unique_id, kind, name, size, type, created_at, meta, batch_id, seq`;
const parsed = (r) => {
  if (!r) return r;
  let meta = null;
  try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
  return { ...r, meta };
};

/** A file card's row, only for its owner. */
export async function getFile(ref, userId) {
  return parsed(await db.get(sql`SELECT ${FILE_COLS} FROM files WHERE ref = ${ref} AND user_id = ${userId}`));
}

/** The files of a batch, in the order they arrived (≤ 50: the batch limit is lower). */
export async function batchFiles(batchId) {
  return (await db.all(sql`SELECT ${FILE_COLS} FROM files WHERE batch_id = ${batchId} ORDER BY seq LIMIT 50`)).map(parsed);
}

/** Stores what a later look inside found ({} = nothing to know). */
export const setFileMeta = (ref, userId, meta) => db.run(sql`UPDATE files SET meta = ${JSON.stringify(meta || {})} WHERE ref = ${ref} AND user_id = ${userId}`);

/** Moves a received file into a batch (the «📚 چند فایل با هم» button). */
export const setFileBatch = (ref, userId, batchId, seq) => db.run(sql`UPDATE files SET batch_id = ${batchId}, seq = ${seq} WHERE ref = ${ref} AND user_id = ${userId}`);

// ---- jobs ----
const JOB_COLS = sql`id, code, user_id, operation, status, engine, input_type, input_size, input_file_id, input_ref, params,
  output_type, output_size, output_file_id, error_code, created_at, started_at, finished_at`;

export function createJob(j) {
  return db.run(sql`INSERT INTO jobs (id, code, user_id, operation, status, engine, input_type, input_size, input_file_id, input_ref, params, created_at, started_at)
    VALUES (${j.id}, ${j.code}, ${j.userId}, ${j.operation}, ${j.status}, ${j.engine}, ${j.inputType}, ${j.inputSize}, ${j.inputFileId}, ${j.inputRef}, ${j.params}, ${j.createdAt}, ${j.startedAt})`);
}

export const setJobStatus = (id, status) => db.run(sql`UPDATE jobs SET status = ${status} WHERE id = ${id}`);

export function finishJob(id, { status, outputType = null, outputSize = null, outputFileId = null, errorCode = null, now }) {
  return db.run(sql`UPDATE jobs SET status = ${status}, output_type = ${outputType}, output_size = ${outputSize},
    output_file_id = ${outputFileId}, error_code = ${errorCode}, finished_at = ${now} WHERE id = ${id}`);
}

/** A job by its display code — only the owner's (spec §2: never someone else's job). */
export const jobByCode = (code, userId) => db.get(sql`SELECT ${JOB_COLS} FROM jobs WHERE code = ${code} AND user_id = ${userId}`);
/** Staff lookups (panel retry) by internal id. */
export const jobById = (id) => db.get(sql`SELECT ${JOB_COLS} FROM jobs WHERE id = ${id}`);

export const latestJob = (userId) => db.get(sql`SELECT ${JOB_COLS} FROM jobs WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`);

/** History page (newest first) within the retention window. */
export function jobsPage(userId, since, limit, offset) {
  return db.all(sql`SELECT ${JOB_COLS} FROM jobs WHERE user_id = ${userId} AND created_at >= ${since}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`);
}

/** How many history entries exist (bounded: at most `cap` index entries are read). */
export async function jobsCount(userId, since, cap = 200) {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM jobs WHERE user_id = ${userId} AND created_at >= ${since} LIMIT ${cap})`);
  return r ? r.n : 0;
}

const ACTIVE = sql`('QUEUED', 'DOWNLOADING', 'PROCESSING', 'UPLOADING')`;

/** Jobs still marked as running (status index). */
export const activeJobs = (limit = 10) => db.all(sql`SELECT ${JOB_COLS} FROM jobs WHERE status IN ${ACTIVE} ORDER BY created_at DESC LIMIT ${limit}`);
export const failedJobs = (limit = 10) => db.all(sql`SELECT ${JOB_COLS} FROM jobs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT ${limit}`);

/** In-bot jobs whose invocation died mid-way: still "running" long after they started. */
export async function expireStale(before) {
  const r = await db.run(sql`UPDATE jobs SET status = 'EXPIRED', error_code = 'INTERRUPTED', finished_at = ${before}
    WHERE id IN (SELECT id FROM jobs WHERE status IN ${ACTIVE} AND created_at < ${before} AND engine = 'bot' ORDER BY created_at LIMIT 200)`);
  return r.rowsAffected;
}

/** Worker jobs (C4) are updated lazily from the worker's answer. */
export function syncWorkerJob(id, { status, outputType = null, outputSize = null, outputFileId = null, errorCode = null, finishedAt = null }) {
  return db.run(sql`UPDATE jobs SET status = ${status}, output_type = ${outputType}, output_size = ${outputSize},
    output_file_id = ${outputFileId}, error_code = ${errorCode}, finished_at = ${finishedAt} WHERE id = ${id} AND engine = 'worker'`);
}

/** Unfinished worker jobs created before `before`, oldest first. */
export const activeWorkerJobs = (limit, before) => db.all(sql`SELECT ${JOB_COLS} FROM jobs
  WHERE status IN ${ACTIVE} AND created_at < ${before} AND engine = 'worker' ORDER BY created_at LIMIT ${limit}`);

/** A user's latest jobs (for /cancel without a code). */
export const recentJobs = (userId, limit = 5) => db.all(sql`SELECT ${JOB_COLS} FROM jobs WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`);

// ---- result cache (24 h) ----
export const getCached = (key, now) => db.get(sql`SELECT key, file_id, name, output_type, output_size FROM result_cache WHERE key = ${key} AND expires_at > ${now}`);
export function putCached(c) {
  return db.run(sql`INSERT INTO result_cache (key, user_id, file_id, name, output_type, output_size, expires_at)
    VALUES (${c.key}, ${c.userId}, ${c.fileId}, ${c.name}, ${c.outputType}, ${c.outputSize}, ${c.expiresAt})
    ON CONFLICT (key) DO UPDATE SET file_id = excluded.file_id, expires_at = excluded.expires_at`);
}
export const dropCached = (key) => db.run(sql`DELETE FROM result_cache WHERE key = ${key}`);
