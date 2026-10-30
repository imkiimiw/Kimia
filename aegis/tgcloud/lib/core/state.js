/*
 * Pending multi-step inputs (aegis_states): what a user's next private message means, e.g. the
 * owner was asked for a broadcast message. One state per user; it expires after STATE_TTL_SEC.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { STATE_TTL_SEC } from '../config.js';
import { nowSec, parseJson } from './util.js';

export async function get(userId) {
  const r = await db.get(sql`SELECT * FROM aegis_states WHERE user_id = ${userId}`);
  if (!r) return null;
  if (Number(r.expires_at) < nowSec()) {
    await clear(userId);
    return null;
  }
  return { kind: r.kind, data: parseJson(r.data, {}) };
}

export async function set(userId, kind, data = {}) {
  const exp = nowSec() + STATE_TTL_SEC;
  await db.run(sql`INSERT INTO aegis_states (user_id, kind, data, expires_at) VALUES (${userId}, ${kind}, ${JSON.stringify(data)}, ${exp})
    ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, data = excluded.data, expires_at = excluded.expires_at`);
}

export async function clear(userId) {
  await db.run(sql`DELETE FROM aegis_states WHERE user_id = ${userId}`);
}

export async function sweep(now) {
  const r = await db.run(sql`DELETE FROM aegis_states WHERE user_id IN
    (SELECT user_id FROM aegis_states WHERE expires_at < ${now} LIMIT 200)`);
  return r.rowsAffected;
}
