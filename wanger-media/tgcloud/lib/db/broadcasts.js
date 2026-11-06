// Broadcast rows. A batch is claimed with a lease (one statement), so two invocations never send
// the same batch; the cursor advances after every single message, so a crash re-sends nothing.
import { db } from 'sdk';
import { sql } from 'sdk/db';

export async function create(by, sourceChat, sourceMessage, now) {
  const r = await db.run(sql`INSERT INTO broadcasts (created_by, source_chat, source_message, status, created_at, updated_at)
    VALUES (${by}, ${sourceChat}, ${sourceMessage}, 'draft', ${now}, ${now}) RETURNING id`);
  return r.rows[0].id;
}

export async function get(id) {
  return db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`);
}

export async function latest(limit = 3) {
  return db.all(sql`SELECT * FROM broadcasts ORDER BY id DESC LIMIT ${limit}`);
}

/** draft → running; false if it wasn't a draft any more (double tap, another admin). */
export async function start(id, progressChat, progressMessage, now) {
  const r = await db.run(sql`UPDATE broadcasts SET status = 'running', progress_chat = ${progressChat}, progress_message = ${progressMessage}, updated_at = ${now}
    WHERE id = ${id} AND status = 'draft'`);
  return r.rowsAffected === 1;
}

export async function cancel(id, now) {
  const r = await db.run(sql`UPDATE broadcasts SET status = 'cancelled', finished_at = ${now}, updated_at = ${now}
    WHERE id = ${id} AND status IN ('draft', 'running')`);
  return r.rowsAffected === 1;
}

/** Claims the next batch: running, lease free, not waiting out a 429. → the row or null. */
export async function claim(id, now, leaseS) {
  const r = await db.run(sql`UPDATE broadcasts SET lease_until = ${now + leaseS}
    WHERE id = ${id} AND status = 'running' AND lease_until < ${now} AND resume_at <= ${now} RETURNING *`);
  return r.rows[0] || null;
}

/** The next users after the cursor — blocked ones included (skipped in code), so reads stay bounded. */
export async function nextUsers(cursor, limit) {
  return db.all(sql`SELECT id, blocked FROM users WHERE id > ${cursor} ORDER BY id LIMIT ${limit}`);
}

export async function advance(id, cursor, delta, now) {
  await db.run(sql`UPDATE broadcasts SET cursor = ${cursor}, sent = sent + ${delta.sent || 0}, failed = failed + ${delta.failed || 0},
    blocked = blocked + ${delta.blocked || 0}, updated_at = ${now} WHERE id = ${id}`);
}

export async function pause(id, resumeAt, now) {
  await db.run(sql`UPDATE broadcasts SET resume_at = ${resumeAt}, lease_until = 0, updated_at = ${now} WHERE id = ${id}`);
}

export async function release(id) {
  await db.run(sql`UPDATE broadcasts SET lease_until = 0 WHERE id = ${id}`);
}

export async function finish(id, now) {
  await db.run(sql`UPDATE broadcasts SET status = 'done', finished_at = ${now}, lease_until = 0, updated_at = ${now} WHERE id = ${id} AND status = 'running'`);
}
