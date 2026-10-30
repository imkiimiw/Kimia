/*
 * Message ids Aegis saw in a chat (aegis_msg_log), for scheduled cleanup and self-destructing media
 * or notices. Written only for chats that use one of those; kept 48 h (Telegram lets a bot delete
 * messages only that long).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { MSG_LOG_KEEP_SEC } from '../config.js';
import { nowSec } from '../core/util.js';

export async function add(chatId, msgId, userId, kind, delAt = 0) {
  await db.run(sql`INSERT INTO aegis_msg_log (chat_id, msg_id, user_id, kind, at, del_at) VALUES (${chatId}, ${msgId}, ${userId || 0}, ${kind}, ${nowSec()}, ${delAt})`);
}

/* Messages to clean in a chat since `since` (kinds: null = all but Aegis's own notices). */
export async function since(chatId, sinceSec, kinds, limit = 500) {
  const rows = await db.all(sql`SELECT id, msg_id, kind FROM aegis_msg_log WHERE chat_id = ${chatId} AND at >= ${sinceSec} ORDER BY at LIMIT ${limit}`);
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
}

/* Due self-destructing messages, grouped by chat: { chatId: [msgIds] } (at most `limit` rows). */
export async function due(now, limit = 100) {
  const rows = await db.all(sql`SELECT id, chat_id, msg_id FROM aegis_msg_log WHERE del_at > 0 AND del_at <= ${now} ORDER BY del_at LIMIT ${limit}`);
  const out = new Map();
  for (const r of rows) {
    const c = Number(r.chat_id);
    if (!out.has(c)) out.set(c, []);
    out.get(c).push(Number(r.msg_id));
  }
  return { byChat: out, ids: rows.map((r) => Number(r.id)) };
}

export async function forget(ids) {
  for (const id of ids) await db.run(sql`DELETE FROM aegis_msg_log WHERE id = ${id}`);
}

export async function sweep(now) {
  const r = await db.run(sql`DELETE FROM aegis_msg_log WHERE id IN (SELECT id FROM aegis_msg_log WHERE at < ${now - MSG_LOG_KEEP_SEC} ORDER BY at LIMIT 1000)`);
  return r.rowsAffected;
}

export async function migrate(oldId, newId) {
  await db.run(sql`UPDATE aegis_msg_log SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
