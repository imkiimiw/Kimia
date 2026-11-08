// Batches (C2): one open ("collecting") batch per user at a time (a partial unique index), slots
// reserved atomically so parallel album updates can't overfill it.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const COLS = sql`id, user_id, status, slots, status_mid, created_at, updated_at`;

export const get = (id, userId) => db.get(sql`SELECT ${COLS} FROM batches WHERE id = ${id} AND user_id = ${userId}`);

/** The user's open batch, if it took a file in the last `windowS` seconds. */
export function open(userId, now, windowS) {
  return db.get(sql`SELECT ${COLS} FROM batches WHERE user_id = ${userId} AND status = 'collecting' AND updated_at > ${now - windowS}`);
}

/** Closes an open batch that went quiet (so a new one can start). */
export const closeStale = (userId, now, windowS) => db.run(sql`UPDATE batches SET status = 'ready', updated_at = ${now}
  WHERE user_id = ${userId} AND status = 'collecting' AND updated_at <= ${now - windowS}`);

/** Creates the open batch unless one exists (race-safe); → the open batch. */
export async function openOrCreate(userId, id, now) {
  await db.run(sql`INSERT INTO batches (id, user_id, status, slots, created_at, updated_at) VALUES (${id}, ${userId}, 'collecting', 0, ${now}, ${now})
    ON CONFLICT DO NOTHING`);
  return db.get(sql`SELECT ${COLS} FROM batches WHERE user_id = ${userId} AND status = 'collecting'`);
}

/** Reserves the next slot; → seq (1-based) or null when the batch is full or no longer open. */
export async function reserve(id, max, now) {
  const r = await db.run(sql`UPDATE batches SET slots = slots + 1, updated_at = ${now}
    WHERE id = ${id} AND status = 'collecting' AND slots < ${max} RETURNING slots`);
  return r.rows && r.rows[0] ? r.rows[0].slots : null;
}

/** The first caller that sent a status message keeps it; → true if this message is it. */
export async function claimStatus(id, messageId) {
  const r = await db.run(sql`UPDATE batches SET status_mid = ${messageId} WHERE id = ${id} AND status_mid IS NULL`);
  return r.rowsAffected === 1;
}

/** collecting → ready / cancelled; → true if it was collecting (or ready, for cancel). */
export async function setStatus(id, userId, status, now) {
  const r = await db.run(sql`UPDATE batches SET status = ${status}, updated_at = ${now}
    WHERE id = ${id} AND user_id = ${userId} AND status IN ('collecting', 'ready')`);
  return r.rowsAffected === 1;
}

export async function fileCount(id) {
  const r = await db.get(sql`SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files WHERE batch_id = ${id}`);
  return r || { n: 0, bytes: 0 };
}
