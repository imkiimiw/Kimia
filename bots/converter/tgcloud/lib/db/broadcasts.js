// Owner broadcasts: one row each; a lease keeps two batches from running at the same time.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const COLS = sql`id, from_chat_id, message_id, status, cursor, sent, failed, blocked_count, lease_until, created_by, created_at, updated_at`;

export async function create(fromChatId, messageId, by, now) {
  const r = await db.run(sql`INSERT INTO broadcasts (from_chat_id, message_id, status, created_by, created_at, updated_at)
    VALUES (${fromChatId}, ${messageId}, 'draft', ${by}, ${now}, ${now}) RETURNING id`);
  return r.rows[0].id;
}

export const get = (id) => db.get(sql`SELECT ${COLS} FROM broadcasts WHERE id = ${id}`);

/** Moves a broadcast between states; → true if it was in `from`. */
export async function transition(id, from, to, now) {
  const r = await db.run(sql`UPDATE broadcasts SET status = ${to}, updated_at = ${now} WHERE id = ${id} AND status = ${from}`);
  return r.rowsAffected === 1;
}

/** Claims the next batch: only one runner at a time (lease of `leaseS`). */
export async function lease(id, now, leaseS) {
  const r = await db.run(sql`UPDATE broadcasts SET lease_until = ${now + leaseS}, updated_at = ${now}
    WHERE id = ${id} AND status = 'sending' AND lease_until <= ${now} RETURNING ${COLS}`);
  return (r.rows && r.rows[0]) || null;
}

/** Saves progress and releases the lease. */
export function progress(id, { cursor, sent, failed, blocked, done }, now) {
  return db.run(sql`UPDATE broadcasts SET cursor = ${cursor}, sent = sent + ${sent}, failed = failed + ${failed},
    blocked_count = blocked_count + ${blocked}, lease_until = 0, status = ${done ? 'done' : 'sending'}, updated_at = ${now} WHERE id = ${id}`);
}
