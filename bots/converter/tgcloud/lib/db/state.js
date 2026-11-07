// Pending per-user state (awaited text input, forced-join resume) and rate-limit counters.
import { db } from 'sdk';
import { sql } from 'sdk/db';

// ---- pending actions: slot 'input' | 'resume' ----
export async function getPending(userId, slot, now) {
  const r = await db.get(sql`SELECT kind, payload FROM pending_actions WHERE user_id = ${userId} AND slot = ${slot} AND expires_at > ${now}`);
  if (!r) return null;
  let payload = null;
  try { payload = r.payload ? JSON.parse(r.payload) : null; } catch { payload = null; }
  return { kind: r.kind, payload };
}

export function setPending(userId, slot, kind, payload, expiresAt) {
  return db.run(sql`INSERT INTO pending_actions (user_id, slot, kind, payload, expires_at) VALUES (${userId}, ${slot}, ${kind}, ${JSON.stringify(payload ?? null)}, ${expiresAt})
    ON CONFLICT (user_id, slot) DO UPDATE SET kind = excluded.kind, payload = excluded.payload, expires_at = excluded.expires_at`);
}

/** Removes and returns the pending action in one statement (a resume runs once). */
export async function takePending(userId, slot, now) {
  const r = await db.run(sql`DELETE FROM pending_actions WHERE user_id = ${userId} AND slot = ${slot} RETURNING kind, payload, expires_at`);
  const row = r.rows && r.rows[0];
  if (!row || row.expires_at <= now) return null;
  let payload = null;
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
  return { kind: row.kind, payload };
}

export const clearPending = (userId, slot) => db.run(sql`DELETE FROM pending_actions WHERE user_id = ${userId} AND slot = ${slot}`);

// ---- rate limits ----
/**
 * Atomically takes one unit from a bucket that allows `limit` per window. One upsert: the row is
 * created or incremented only while below the limit, so parallel requests can't overshoot.
 * → true if allowed.
 */
export async function take(userId, bucket, limit, expiresAt) {
  const r = await db.run(sql`INSERT INTO rate_counters (user_id, bucket, n, expires_at) VALUES (${userId}, ${bucket}, 1, ${expiresAt})
    ON CONFLICT (user_id, bucket) DO UPDATE SET n = n + 1 WHERE rate_counters.n < ${limit}`);
  return r.rowsAffected === 1;
}

/** Gives a unit back (when a later check refused the request). */
export const giveBack = (userId, bucket) => db.run(sql`UPDATE rate_counters SET n = n - 1 WHERE user_id = ${userId} AND bucket = ${bucket} AND n > 0`);
