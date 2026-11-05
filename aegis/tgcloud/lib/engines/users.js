/*
 * User tracking (aegis_users): started / active / blocked.
 * - touch(): every private message or button press refreshes the row; `started` marks that the
 *   user opened the bot's chat (and so has not blocked it any more).
 * - markBlocked(): my_chat_member "kicked" or a 403 when writing to them.
 * Language: picked from Telegram's language_code until the user chooses one in the picker.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec } from '../core/util.js';
import { pickLang } from '../i18n/index.js';

export async function touch(from, { started = false } = {}) {
  const t = nowSec();
  const s = started ? 1 : 0;
  const r = await db.run(sql`INSERT INTO aegis_users (user_id, first_name, last_name, username, tg_lang, lang, started, started_at, first_seen, last_seen)
    VALUES (${from.id}, ${from.first_name || null}, ${from.last_name || null}, ${from.username || null}, ${from.language_code || null},
      ${pickLang(from.language_code)}, ${s}, ${started ? t : 0}, ${t}, ${t})
    ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
      tg_lang = COALESCE(excluded.tg_lang, aegis_users.tg_lang), last_seen = excluded.last_seen,
      lang = CASE WHEN aegis_users.lang_set = 1 OR excluded.tg_lang IS NULL THEN aegis_users.lang ELSE excluded.lang END,
      started = MAX(aegis_users.started, excluded.started),
      started_at = CASE WHEN aegis_users.started_at = 0 THEN excluded.started_at ELSE aegis_users.started_at END,
      blocked = CASE WHEN excluded.started = 1 THEN 0 ELSE aegis_users.blocked END
    RETURNING *`);
  return r.rows[0];
}

/* A user seen in a group (a punished member, a moderator): only their name is kept, so lists, logs
 * and the panel can show it. They are not marked as having started the bot. */
export async function remember(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return;
  await touch(user);
}

export async function get(userId) {
  return db.get(sql`SELECT * FROM aegis_users WHERE user_id = ${userId}`);
}

/* A user Aegis has met, by @username (the Bot API can't look users up by username). */
export async function byUsername(username) {
  return db.get(sql`SELECT * FROM aegis_users WHERE lower(username) = ${String(username).toLowerCase()} ORDER BY last_seen DESC LIMIT 1`);
}

/* A name to show for a user id: what Aegis knows of them, else the id. */
export async function displayName(userId) {
  const u = await get(userId);
  if (u) return u.first_name || (u.username ? `@${u.username}` : String(userId));
  const a = await db.get(sql`SELECT first_name, username FROM aegis_chat_admins WHERE user_id = ${userId} LIMIT 1`);
  if (a) return a.first_name || (a.username ? `@${a.username}` : String(userId));
  return String(userId);
}

export async function setLang(userId, lang) {
  await db.run(sql`UPDATE aegis_users SET lang = ${lang}, lang_set = 1 WHERE user_id = ${userId}`);
}

export async function markBlocked(userId) {
  await db.run(sql`UPDATE aegis_users SET blocked = 1, blocked_at = ${nowSec()} WHERE user_id = ${userId} AND blocked = 0`);
}

/* my_chat_member "member" in private: the user unblocked (or started) the bot. */
export async function markUnblocked(from) {
  await touch(from, { started: true });
}

export async function setJoinOk(userId, at, rev) {
  await db.run(sql`UPDATE aegis_users SET join_ok_at = ${at}, join_rev = ${rev} WHERE user_id = ${userId}`);
}

/* Users who can receive a broadcast after `cursor` (by id): started and not blocked; `except` left out. */
export async function reachableAfter(cursor, limit, except = 0) {
  const rows = await db.all(sql`SELECT user_id FROM aegis_users WHERE started = 1 AND blocked = 0 AND user_id > ${cursor} AND user_id != ${except}
    ORDER BY user_id LIMIT ${limit}`);
  return rows.map((r) => Number(r.user_id));
}

export async function countReachable(except = 0) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_users WHERE started = 1 AND blocked = 0 AND user_id != ${except}`)).n);
}

/* The owner panel's numbers. */
export async function counts(now, todayStart) {
  const one = async (q) => Number((await db.get(q)).n);
  return {
    started: await one(sql`SELECT count(*) AS n FROM aegis_users WHERE started = 1`),
    reachable: await countReachable(),
    blocked: await one(sql`SELECT count(*) AS n FROM aegis_users WHERE blocked = 1`),
    newToday: await one(sql`SELECT count(*) AS n FROM aegis_users WHERE started = 1 AND started_at >= ${todayStart}`),
    newWeek: await one(sql`SELECT count(*) AS n FROM aegis_users WHERE started = 1 AND started_at >= ${now - 7 * 86400}`),
    active24h: await one(sql`SELECT count(*) AS n FROM aegis_users WHERE started = 1 AND last_seen >= ${now - 86400}`),
    active7d: await one(sql`SELECT count(*) AS n FROM aegis_users WHERE started = 1 AND last_seen >= ${now - 7 * 86400}`),
  };
}
