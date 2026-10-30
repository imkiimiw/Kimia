/*
 * Timed jobs of a chat (aegis_schedules): the night lock and scheduled cleanup. There is no
 * scheduler, so a job runs when an update arrives after its next_at (lib/jobs.js checks at most
 * once a minute, for every chat); then the next time is set.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { SWEEP_LIMIT } from '../config.js';
import { nowSec } from '../core/util.js';

export async function set(chatId, kind, nextAt) {
  if (!nextAt) {
    await db.run(sql`DELETE FROM aegis_schedules WHERE chat_id = ${chatId} AND kind = ${kind}`);
    return;
  }
  await db.run(sql`INSERT INTO aegis_schedules (chat_id, kind, next_at) VALUES (${chatId}, ${kind}, ${nextAt})
    ON CONFLICT(chat_id, kind) DO UPDATE SET next_at = excluded.next_at`);
}

export const get = (chatId, kind) => db.get(sql`SELECT * FROM aegis_schedules WHERE chat_id = ${chatId} AND kind = ${kind}`);

export async function due(now) {
  return db.all(sql`SELECT * FROM aegis_schedules WHERE next_at <= ${now} ORDER BY next_at LIMIT ${SWEEP_LIMIT}`);
}

/* Claims a due job once (two updates at the same moment don't both run it). */
export async function claim(row, nextAt) {
  const r = await db.run(sql`UPDATE aegis_schedules SET next_at = ${nextAt}, last_at = ${nowSec()} WHERE id = ${row.id} AND next_at = ${row.next_at}`);
  return r.rowsAffected > 0;
}

export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_schedules WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_schedules SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
