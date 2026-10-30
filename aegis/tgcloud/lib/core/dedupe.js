/*
 * Idempotent update handling. Telegram re-delivers an update when a webhook call fails or times
 * out; each update_id is processed once:
 *   begin() → true for the first delivery (row inserted, status 0 = in progress);
 *             false for a duplicate that is done, or still in progress (a concurrent delivery);
 *             true again only if an earlier attempt was left "in progress" for UPDATE_RETRY_SEC
 *             (that invocation died), so a crash doesn't lose the update.
 *   finish() → status 1.
 * Without an update_id (e.g. `tgcloud run` with a bare payload) nothing is checked.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { UPDATE_RETRY_SEC } from '../config.js';
import { nowSec } from './util.js';

export async function begin(updateId) {
  if (!Number.isSafeInteger(updateId)) return true;
  const now = nowSec();
  const r = await db.run(sql`INSERT INTO aegis_updates (update_id, status, at) VALUES (${updateId}, 0, ${now}) ON CONFLICT(update_id) DO NOTHING`);
  if (r.rowsAffected > 0) return true;
  const retry = await db.run(sql`UPDATE aegis_updates SET at = ${now} WHERE update_id = ${updateId} AND status = 0 AND at <= ${now - UPDATE_RETRY_SEC}`);
  return retry.rowsAffected > 0;
}

export async function finish(updateId) {
  if (!Number.isSafeInteger(updateId)) return;
  await db.run(sql`UPDATE aegis_updates SET status = 1 WHERE update_id = ${updateId}`);
}

/* Housekeeping: forget old update ids (a small batch per run). */
export async function sweep(now, keepSec) {
  const r = await db.run(sql`DELETE FROM aegis_updates WHERE update_id IN
    (SELECT update_id FROM aegis_updates WHERE at < ${now - keepSec} ORDER BY at LIMIT 500)`);
  return r.rowsAffected;
}
