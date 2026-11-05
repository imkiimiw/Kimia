/*
 * A channel's crisis mode (aegis_crises): one row per crisis, with what was changed and saved so
 * «End crisis» can put it back (settings, demoted admins and their rights, the discussion group's lock).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec, parseJson } from '../core/util.js';

export async function active(chatId) {
  return db.get(sql`SELECT * FROM aegis_crises WHERE chat_id = ${chatId} AND ended_at = 0 ORDER BY id DESC LIMIT 1`);
}

export async function last(chatId) {
  return db.get(sql`SELECT * FROM aegis_crises WHERE chat_id = ${chatId} ORDER BY id DESC LIMIT 1`);
}

/* Starts one (only if none is active). Gives the id, or 0 when one already runs. */
export async function start(chatId, byId, saved) {
  if (await active(chatId)) return 0;
  const r = await db.run(sql`INSERT INTO aegis_crises (chat_id, by_id, saved, started_at) VALUES (${chatId}, ${byId}, ${JSON.stringify(saved)}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

export async function update(id, saved, report) {
  await db.run(sql`UPDATE aegis_crises SET saved = ${JSON.stringify(saved)}, report = ${JSON.stringify(report)} WHERE id = ${id}`);
}

/* Ends it once. Gives the row (with saved parsed) or null. */
export async function end(id, byId) {
  const r = await db.run(sql`UPDATE aegis_crises SET ended_at = ${nowSec()}, ended_by = ${byId} WHERE id = ${id} AND ended_at = 0`);
  if (!r.rowsAffected) return null;
  const row = await db.get(sql`SELECT * FROM aegis_crises WHERE id = ${id}`);
  return { ...row, saved: parseJson(row.saved, {}), report: parseJson(row.report, {}) };
}

export async function migrate(oldId, newId) {
  await db.run(sql`UPDATE aegis_crises SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
