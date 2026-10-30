/*
 * Small per-chat records of Phase 6: members' flags (forced join passed, members added, last message
 * for slow mode), reports, forum topics Aegis knows of, and anonymous admins' commands waiting for a
 * confirmation.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec, parseJson } from '../core/util.js';

/* ---------- member flags ---------- */

export async function flags(chatId, userId) {
  return (await db.get(sql`SELECT * FROM aegis_member_flags WHERE chat_id = ${chatId} AND user_id = ${userId}`)) || { fj_ok_at: 0, adds: 0, last_at: 0 };
}

export async function setFjOk(chatId, userId) {
  await db.run(sql`INSERT INTO aegis_member_flags (chat_id, user_id, fj_ok_at) VALUES (${chatId}, ${userId}, ${nowSec()})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET fj_ok_at = excluded.fj_ok_at`);
}

export async function addAdds(chatId, userId, n) {
  await db.run(sql`INSERT INTO aegis_member_flags (chat_id, user_id, adds) VALUES (${chatId}, ${userId}, ${n})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET adds = aegis_member_flags.adds + excluded.adds`);
}

/* Records this message's time; gives the previous one (slow mode). */
export async function touchLast(chatId, userId) {
  const now = nowSec();
  const before = await db.get(sql`SELECT last_at FROM aegis_member_flags WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  await db.run(sql`INSERT INTO aegis_member_flags (chat_id, user_id, last_at) VALUES (${chatId}, ${userId}, ${now})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET last_at = excluded.last_at`);
  return before ? Number(before.last_at) : 0;
}

/* ---------- reports ---------- */

export async function addReport(chatId, reporterId, targetId, msgId, snippet, reason) {
  const r = await db.run(sql`INSERT INTO aegis_reports (chat_id, reporter_id, target_id, msg_id, snippet, reason, at)
    VALUES (${chatId}, ${reporterId}, ${targetId}, ${msgId}, ${snippet}, ${reason}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

export const report = (id) => db.get(sql`SELECT * FROM aegis_reports WHERE id = ${id}`);

export async function lastReportAt(chatId, reporterId) {
  const r = await db.get(sql`SELECT at FROM aegis_reports WHERE chat_id = ${chatId} AND reporter_id = ${reporterId} ORDER BY at DESC LIMIT 1`);
  return r ? Number(r.at) : 0;
}

export async function handleReport(id, status, byId) {
  const r = await db.run(sql`UPDATE aegis_reports SET status = ${status}, handled_by = ${byId}, handled_at = ${nowSec()} WHERE id = ${id} AND status = 'open'`);
  return r.rowsAffected > 0;
}

export async function recentReports(chatId, limit = 10) {
  return db.all(sql`SELECT * FROM aegis_reports WHERE chat_id = ${chatId} ORDER BY at DESC, id DESC LIMIT ${limit}`);
}

/* ---------- topics ---------- */

export async function topic(chatId, threadId) {
  return db.get(sql`SELECT * FROM aegis_topics WHERE chat_id = ${chatId} AND thread_id = ${threadId}`);
}

export async function topicsOf(chatId) {
  return db.all(sql`SELECT * FROM aegis_topics WHERE chat_id = ${chatId} ORDER BY last_at DESC, thread_id LIMIT 50`);
}

export async function saveTopic(chatId, threadId, fields) {
  const now = nowSec();
  await db.run(sql`INSERT INTO aegis_topics (chat_id, thread_id, name, color, closed, created_at, last_at)
    VALUES (${chatId}, ${threadId}, ${fields.name || `#${threadId}`}, ${fields.color || 0}, ${fields.closed ? 1 : 0}, ${now}, ${now})
    ON CONFLICT(chat_id, thread_id) DO UPDATE SET
      name = CASE WHEN ${fields.name || null} IS NULL THEN aegis_topics.name ELSE ${fields.name || ''} END,
      closed = CASE WHEN ${fields.closed === undefined ? null : (fields.closed ? 1 : 0)} IS NULL THEN aegis_topics.closed ELSE ${fields.closed ? 1 : 0} END,
      last_at = ${now}`);
}

export async function setTopicReadonly(chatId, threadId, on) {
  await db.run(sql`UPDATE aegis_topics SET readonly = ${on ? 1 : 0} WHERE chat_id = ${chatId} AND thread_id = ${threadId}`);
}

export async function forgetTopic(chatId, threadId) {
  await db.run(sql`DELETE FROM aegis_topics WHERE chat_id = ${chatId} AND thread_id = ${threadId}`);
}

/* ---------- anonymous admins' commands ---------- */

export async function addAnon(chatId, message) {
  const r = await db.run(sql`INSERT INTO aegis_anon_cmds (chat_id, message, at) VALUES (${chatId}, ${JSON.stringify(message)}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

export async function takeAnon(id, byId) {
  const row = await db.get(sql`SELECT * FROM aegis_anon_cmds WHERE id = ${id}`);
  if (!row || row.status !== 'pending' || Number(row.at) < nowSec() - 3600) return null;
  const r = await db.run(sql`UPDATE aegis_anon_cmds SET status = 'done', by_id = ${byId} WHERE id = ${id} AND status = 'pending'`);
  return r.rowsAffected ? { ...row, message: parseJson(row.message, {}) } : null;
}

export async function migrate(oldId, newId) {
  for (const t of ['aegis_member_flags', 'aegis_reports', 'aegis_topics', 'aegis_anon_cmds']) {
    await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  }
}

export async function sweep(now) {
  const r = await db.run(sql`DELETE FROM aegis_anon_cmds WHERE id IN (SELECT id FROM aegis_anon_cmds WHERE at < ${now - 86400} LIMIT 200)`);
  return r.rowsAffected;
}
