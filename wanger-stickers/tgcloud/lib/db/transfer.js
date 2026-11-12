// SQL for the Studio's transfer protocol: jobs (+ job_chunks) and uploads (+ upload_chunks).
// Every query filters by the owner (tg_id) or a random token; chunks are raw blobs < 1 MB each.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;

export const transfer = {
  createJob: (j) => db.run(sql`
    INSERT INTO jobs (id, tg_id, source_file_id, source_kind, mime, size, chunks, status, created_at, expires_at)
    VALUES (${j.id}, ${j.tg_id}, ${j.file_id}, ${j.kind}, ${j.mime}, ${j.size}, 0, 'new', ${j.now}, ${j.expires})
    RETURNING *`).then(first),
  getJob: (id, userId, now) => db.get(sql`SELECT * FROM jobs WHERE id = ${id} AND tg_id = ${userId} AND expires_at > ${now}`),
  /** new → ready once, with the number of stored chunks (a second downloader loses the race). */
  markReady: (id, chunks, size) => db.run(sql`UPDATE jobs SET status = 'ready', chunks = ${chunks}, size = ${size} WHERE id = ${id} AND status = 'new' RETURNING *`).then(first),
  putJobChunk: (id, idx, data) => db.run(sql`INSERT INTO job_chunks (job_id, idx, data) VALUES (${id}, ${idx}, ${data}) ON CONFLICT (job_id, idx) DO NOTHING`),
  jobChunk: (id, idx) => db.get(sql`SELECT data FROM job_chunks WHERE job_id = ${id} AND idx = ${idx}`).then((r) => (r ? r.data : null)),
  markUsed: (id) => db.run(sql`UPDATE jobs SET status = 'used' WHERE id = ${id}`),

  createUpload: (u) => db.run(sql`
    INSERT INTO uploads (upload_id, tg_id, kind, format, total_size, sha256, chunks, status, created_at, expires_at)
    VALUES (${u.id}, ${u.tg_id}, ${u.kind}, ${u.format}, ${u.size}, ${u.sha256}, ${u.chunks}, 'open', ${u.now}, ${u.expires})
    RETURNING *`).then(first),
  getUpload: (id, userId, now) => db.get(sql`SELECT * FROM uploads WHERE upload_id = ${id} AND tg_id = ${userId} AND expires_at > ${now}`),
  openUploadsOf: (userId, now) => db.get(sql`SELECT count(*) AS n FROM uploads WHERE tg_id = ${userId} AND status = 'open' AND expires_at > ${now}`).then((r) => (r ? r.n : 0)),
  putUploadChunk: (id, idx, data) => db.run(sql`INSERT INTO upload_chunks (upload_id, idx, data) VALUES (${id}, ${idx}, ${data}) ON CONFLICT (upload_id, idx) DO UPDATE SET data = excluded.data`),
  uploadChunk: (id, idx) => db.get(sql`SELECT data FROM upload_chunks WHERE upload_id = ${id} AND idx = ${idx}`).then((r) => (r ? r.data : null)),
  countUploadChunks: (id) => db.get(sql`SELECT count(*) AS n FROM upload_chunks WHERE upload_id = ${id}`).then((r) => (r ? r.n : 0)),
  /** open → committed once (a retried commit after success does nothing). */
  claimCommit: (id) => db.run(sql`UPDATE uploads SET status = 'committed' WHERE upload_id = ${id} AND status = 'open' RETURNING *`).then(first),
  reopen: (id) => db.run(sql`UPDATE uploads SET status = 'open' WHERE upload_id = ${id} AND status = 'committed'`),
  dropUploadChunks: (id) => db.run(sql`DELETE FROM upload_chunks WHERE upload_id = ${id}`),

  /** Housekeeping: expired jobs/uploads and their chunks (children first, ≤ 5000 rows each). */
  async pruneExpired(now) {
    const a = await db.run(sql`DELETE FROM job_chunks WHERE (job_id, idx) IN (SELECT c.job_id, c.idx FROM job_chunks c JOIN jobs j ON j.id = c.job_id WHERE j.expires_at <= ${now} LIMIT 5000)`);
    const b = await db.run(sql`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE expires_at <= ${now} AND NOT EXISTS (SELECT 1 FROM job_chunks c WHERE c.job_id = jobs.id) LIMIT 5000)`);
    const c = await db.run(sql`DELETE FROM upload_chunks WHERE (upload_id, idx) IN (SELECT c.upload_id, c.idx FROM upload_chunks c JOIN uploads u ON u.upload_id = c.upload_id WHERE u.expires_at <= ${now} OR u.status = 'committed' LIMIT 5000)`);
    const d = await db.run(sql`DELETE FROM uploads WHERE upload_id IN (SELECT upload_id FROM uploads WHERE expires_at <= ${now} AND NOT EXISTS (SELECT 1 FROM upload_chunks c WHERE c.upload_id = uploads.upload_id) LIMIT 5000)`);
    return a.rowsAffected + b.rowsAffected + c.rowsAffected + d.rowsAffected;
  },
  deleteOfUser: async (userId) => {
    await db.run(sql`DELETE FROM job_chunks WHERE job_id IN (SELECT id FROM jobs WHERE tg_id = ${userId} LIMIT 500)`);
    await db.run(sql`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE tg_id = ${userId} LIMIT 500)`);
    await db.run(sql`DELETE FROM upload_chunks WHERE upload_id IN (SELECT upload_id FROM uploads WHERE tg_id = ${userId} LIMIT 500)`);
    await db.run(sql`DELETE FROM uploads WHERE upload_id IN (SELECT upload_id FROM uploads WHERE tg_id = ${userId} LIMIT 500)`);
  },
};
