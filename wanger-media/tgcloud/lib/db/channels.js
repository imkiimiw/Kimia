// Forced-join channels (≤ 10 rows, so listing them reads at most a handful of rows).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { MAX_CHANNELS } from '../config.js';

export async function listEnabled() {
  return db.all(sql`SELECT * FROM forced_channels WHERE enabled = 1 ORDER BY position, id LIMIT ${MAX_CHANNELS}`);
}

/** Inserts channels by username (skipping existing ones); returns the rows this call inserted. */
export async function seed(usernames, now) {
  const rows = usernames.reduce((acc, u, i) => {
    const row = sql`(${u}, ${i}, ${now})`;
    return i ? sql`${acc}, ${row}` : row;
  }, null);
  const r = await db.run(sql`INSERT INTO forced_channels (username, position, added_at) VALUES ${rows}
    ON CONFLICT DO NOTHING RETURNING id, username`);
  return r.rows;
}

/** Stores what Telegram said about a channel (chat id/title may be null when unknown). */
export async function setInfo(id, { chatId = null, title = null, botStatus, detail = null }, now) {
  await db.run(sql`UPDATE forced_channels SET chat_id = coalesce(${chatId}, chat_id), title = coalesce(${title}, title),
      bot_status = ${botStatus}, status_detail = ${detail}, checked_at = ${now}
    WHERE id = ${id}`);
}

/** Sets bot_status only if it differs; true if it changed. */
export async function setStatus(id, botStatus, detail, now) {
  const r = await db.run(sql`UPDATE forced_channels SET bot_status = ${botStatus}, status_detail = ${detail}, checked_at = ${now}
    WHERE id = ${id} AND bot_status IS NOT ${botStatus}`);
  return r.rowsAffected === 1;
}

/** The forced channel matching a chat (by id, else by username), or null. */
export async function findByChat(chatId, username) {
  const byId = await db.get(sql`SELECT * FROM forced_channels WHERE chat_id = ${chatId}`);
  if (byId || !username) return byId;
  return db.get(sql`SELECT * FROM forced_channels WHERE lower(username) = ${String(username).toLowerCase()}`);
}
