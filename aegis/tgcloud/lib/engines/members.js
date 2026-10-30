/*
 * When members joined a group (aegis_members), for locks that apply to new members only. A row is
 * written when Telegram reports the join (chat_member, or the join service message) and removed
 * when the member leaves. Someone Aegis never saw join counts as an old member.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec } from '../core/util.js';

export async function joined(chatId, userId, at = nowSec()) {
  await db.run(sql`INSERT INTO aegis_members (chat_id, user_id, joined_at) VALUES (${chatId}, ${userId}, ${at})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET joined_at = excluded.joined_at`);
}

export async function left(chatId, userId) {
  await db.run(sql`DELETE FROM aegis_members WHERE chat_id = ${chatId} AND user_id = ${userId}`);
}

export async function joinedAt(chatId, userId) {
  const r = await db.get(sql`SELECT joined_at FROM aegis_members WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  return r ? Number(r.joined_at) : 0;
}

/* The latest joins Aegis saw (newest first). */
export async function recent(chatId, limit = 10) {
  return db.all(sql`SELECT user_id, joined_at FROM aegis_members WHERE chat_id = ${chatId} ORDER BY joined_at DESC LIMIT ${limit}`);
}

export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_members WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_members SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
