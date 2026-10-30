/*
 * The log of sensitive actions (aegis_audit). Append-only: nothing in this project deletes or
 * edits a row. action names: <area>.<verb>, e.g. join.add, join.remove, bc.start, chat.added.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec } from './util.js';

export async function log(actorId, action, { chatId = 0, target = null, details = null } = {}) {
  try {
    await db.run(sql`INSERT INTO aegis_audit (at, actor_id, chat_id, action, target, details)
      VALUES (${nowSec()}, ${Number(actorId) || 0}, ${Number(chatId) || 0}, ${action},
        ${target === null ? null : String(target)}, ${details === null ? null : JSON.stringify(details)})`);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', where: 'audit.log', action, error: String((err && err.message) || err) }));
  }
}

export async function recent(limit = 20) {
  return db.all(sql`SELECT * FROM aegis_audit ORDER BY id DESC LIMIT ${limit}`);
}

export async function forChat(chatId, limit = 20) {
  return db.all(sql`SELECT * FROM aegis_audit WHERE chat_id = ${chatId} ORDER BY at DESC, id DESC LIMIT ${limit}`);
}
