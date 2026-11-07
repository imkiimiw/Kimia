// Forced-join channels (local gate). A handful of rows (≤ MAX_CHANNELS).
import { db } from 'sdk';
import { sql } from 'sdk/db';

const COLS = sql`id, username, chat_id, title, enabled, bot_status, bot_detail, checked_at`;

export const list = () => db.all(sql`SELECT ${COLS} FROM channels ORDER BY id LIMIT 50`);
export const listEnabled = () => db.all(sql`SELECT ${COLS} FROM channels WHERE enabled = 1 ORDER BY id LIMIT 50`);
export const byId = (id) => db.get(sql`SELECT ${COLS} FROM channels WHERE id = ${id}`);

/** A channel by chat id or username (my_chat_member, duplicate checks). */
export function find(chatId, username) {
  const u = username ? String(username).toLowerCase() : null;
  return db.get(sql`SELECT ${COLS} FROM channels WHERE chat_id = ${chatId ?? null} OR (${u} IS NOT NULL AND lower(username) = ${u}) LIMIT 1`);
}

/** Inserts the seed channels that are missing. → the inserted rows (only the inserting call gets them). */
export async function seed(usernames, now) {
  const out = [];
  for (const u of usernames) {
    const r = await db.run(sql`INSERT INTO channels (username, enabled, bot_status, created_at)
      VALUES (${u}, 1, 'unknown', ${now}) ON CONFLICT DO NOTHING RETURNING id, username`);
    if (r.rows && r.rows[0]) out.push(r.rows[0]);
  }
  return out;
}

export function add({ username, chatId, title, botStatus, botDetail }, now) {
  return db.run(sql`INSERT INTO channels (username, chat_id, title, enabled, bot_status, bot_detail, checked_at, created_at)
    VALUES (${username}, ${chatId}, ${title}, 1, ${botStatus}, ${botDetail}, ${now}, ${now}) RETURNING id`);
}

export const remove = (id) => db.run(sql`DELETE FROM channels WHERE id = ${id}`);
export async function count() {
  const r = await db.get(sql`SELECT count(*) AS n FROM channels`);
  return r ? r.n : 0;
}

export function setInfo(id, { chatId, title, botStatus, botDetail }, now) {
  return db.run(sql`UPDATE channels SET chat_id = coalesce(${chatId ?? null}, chat_id), title = coalesce(${title ?? null}, title),
    bot_status = ${botStatus}, bot_detail = ${botDetail ?? null}, checked_at = ${now} WHERE id = ${id}`);
}

/** Updates the bot's standing; → true if it changed. */
export async function setStatus(id, status, detail, now) {
  const r = await db.run(sql`UPDATE channels SET bot_status = ${status}, bot_detail = ${detail ?? null}, checked_at = ${now}
    WHERE id = ${id} AND bot_status IS NOT ${status}`);
  return r.rowsAffected === 1;
}
