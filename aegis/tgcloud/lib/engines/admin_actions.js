/*
 * Destructive admin actions seen in a chat (aegis_admin_actions): bans and removals of members,
 * demotions of other admins — whether done in Telegram (chat_member updates) or through Aegis's
 * moderation commands. Anti-betrayal (engines/betrayal.js) counts them per admin in a window.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec } from '../core/util.js';

export async function record(chatId, actorId, targetId, kind) {
  await db.run(sql`INSERT INTO aegis_admin_actions (chat_id, actor_id, target_id, kind, at) VALUES (${chatId}, ${actorId}, ${targetId}, ${kind}, ${nowSec()})`);
}

export async function since(chatId, actorId, from) {
  return db.all(sql`SELECT * FROM aegis_admin_actions WHERE chat_id = ${chatId} AND actor_id = ${actorId} AND at >= ${from} ORDER BY at LIMIT 500`);
}

export async function sweep(now, keepSec) {
  const r = await db.run(sql`DELETE FROM aegis_admin_actions WHERE id IN (SELECT id FROM aegis_admin_actions WHERE at < ${now - keepSec} ORDER BY at LIMIT 500)`);
  return r.rowsAffected;
}
