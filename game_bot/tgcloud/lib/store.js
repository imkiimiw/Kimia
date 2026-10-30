/*
 * Database access for users, settings, channels, counters, stats and leaderboards (rooms are in
 * rooms.js, broadcasts in broadcast.js). Raw SQL with the sql`` tag; every query is keyed or LIMITed.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { pickLang } from './i18n/index.js';

export const nowSec = () => Math.floor(Date.now() / 1000);

/* ---------- users ---------- */

/*
 * Creates or refreshes a user from a Telegram User. `started`: the user wrote to the bot in private
 * (so it can message them; it also means they haven't blocked it). Gives the users row.
 */
export async function touchUser(u, { started = false } = {}) {
  const t = nowSec();
  const r = await db.run(sql`INSERT INTO users (user_id, first_name, username, lang, started, first_seen, last_seen)
    VALUES (${u.id}, ${u.first_name || null}, ${u.username || null}, ${pickLang(u.language_code)}, ${started ? 1 : 0}, ${t}, ${t})
    ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username, last_seen = excluded.last_seen,
      started = MAX(users.started, excluded.started), blocked = CASE WHEN excluded.started = 1 THEN 0 ELSE users.blocked END
    RETURNING *`);
  return r.rows[0];
}

export async function getUser(userId) {
  return db.get(sql`SELECT * FROM users WHERE user_id = ${userId}`);
}

export async function setLang(userId, lang) {
  await db.run(sql`UPDATE users SET lang = ${lang}, lang_set = 1 WHERE user_id = ${userId}`);
}

export async function setBlocked(userId, blocked) {
  await db.run(sql`UPDATE users SET blocked = ${blocked ? 1 : 0} WHERE user_id = ${userId}`);
}

export async function setJoinOk(userId, at, rev) {
  await db.run(sql`UPDATE users SET join_ok_at = ${at}, join_rev = ${rev} WHERE user_id = ${userId}`);
}

/* ---------- settings ---------- */

export async function getSettings() {
  const rows = await db.all(sql`SELECT key, value FROM settings LIMIT 100`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key, value) {
  await db.run(sql`INSERT INTO settings (key, value) VALUES (${key}, ${value === null ? null : String(value)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

/* ---------- forced-join channels ---------- */

export async function listChannels() {
  return db.all(sql`SELECT * FROM channels ORDER BY id LIMIT 20`);
}

export async function countChannels() {
  const r = await db.get(sql`SELECT count(*) AS n FROM channels`);
  return Number(r.n);
}

export async function addChannel({ username, chatId, title, link }) {
  const r = await db.run(sql`INSERT INTO channels (uname, username, chat_id, title, link, created_at)
    VALUES (${username ? username.toLowerCase() : null}, ${username || null}, ${chatId || null}, ${title || null}, ${link || null}, ${nowSec()})
    ON CONFLICT(uname) DO NOTHING RETURNING id`);
  return r.rows.length ? Number(r.rows[0].id) : null;
}

export async function channelByChatId(chatId) {
  return db.get(sql`SELECT * FROM channels WHERE chat_id = ${chatId} LIMIT 1`);
}

export async function getChannel(id) {
  return db.get(sql`SELECT * FROM channels WHERE id = ${id}`);
}

export async function removeChannel(id) {
  await db.run(sql`DELETE FROM channels WHERE id = ${id}`);
}

export async function updateChannel(id, { chatId, title }) {
  await db.run(sql`UPDATE channels SET chat_id = COALESCE(${chatId || null}, chat_id), title = COALESCE(${title || null}, title) WHERE id = ${id}`);
}

/* True once per WARN interval per channel: whoever claims it sends the owner the warning. */
export async function claimChannelWarning(id, now, interval) {
  const r = await db.run(sql`UPDATE channels SET warned_at = ${now} WHERE id = ${id} AND warned_at < ${now - interval}`);
  return r.rowsAffected > 0;
}

/* ---------- counters and stats ---------- */

export async function bumpCounter(key, n = 1) {
  await db.run(sql`INSERT INTO counters (key, n) VALUES (${key}, ${n}) ON CONFLICT(key) DO UPDATE SET n = counters.n + excluded.n`);
}

export async function getCounters() {
  return db.all(sql`SELECT key, n FROM counters LIMIT 50`);
}

/*
 * Adds a result to a user's stats (and the chat's, when the game was played from a chat).
 * add: { played, wins, losses, draws, score }; best: true = score is a best (keep the max).
 */
export async function recordResult(userId, game, add, chat = null, best = false) {
  const t = nowSec();
  const a = { played: 0, wins: 0, losses: 0, draws: 0, score: 0, ...add };
  const score = best
    ? sql`score = MAX(stats.score, excluded.score)`
    : sql`score = stats.score + excluded.score`;
  await db.run(sql`INSERT INTO stats (user_id, game, played, wins, losses, draws, score, updated_at)
    VALUES (${userId}, ${game}, ${a.played}, ${a.wins}, ${a.losses}, ${a.draws}, ${a.score}, ${t})
    ON CONFLICT(user_id, game) DO UPDATE SET played = stats.played + excluded.played, wins = stats.wins + excluded.wins,
      losses = stats.losses + excluded.losses, draws = stats.draws + excluded.draws, ${score}, updated_at = excluded.updated_at`);
  if (!chat) return;
  const cscore = best
    ? sql`score = MAX(chat_stats.score, excluded.score)`
    : sql`score = chat_stats.score + excluded.score`;
  await db.run(sql`INSERT INTO chat_stats (chat, user_id, game, played, wins, score)
    VALUES (${chat}, ${userId}, ${game}, ${a.played}, ${a.wins}, ${a.score})
    ON CONFLICT(chat, user_id, game) DO UPDATE SET played = chat_stats.played + excluded.played,
      wins = chat_stats.wins + excluded.wins, ${cscore}`);
}

export async function userStats(userId) {
  return db.all(sql`SELECT game, played, wins, losses, draws, score FROM stats WHERE user_id = ${userId} LIMIT 10`);
}

/* The top 20 for a game, globally or in one chat, with the viewer's own rank. */
export async function leaderboard(game, userId, chat = null) {
  if (chat) {
    const top = await db.all(sql`SELECT c.user_id, c.score, c.wins, c.played, u.first_name FROM chat_stats c
      LEFT JOIN users u ON u.user_id = c.user_id
      WHERE c.chat = ${chat} AND c.game = ${game} AND c.score > 0 ORDER BY c.score DESC, c.user_id LIMIT 20`);
    const me = await db.get(sql`SELECT score FROM chat_stats WHERE chat = ${chat} AND user_id = ${userId} AND game = ${game}`);
    const rank = me && me.score > 0
      ? Number((await db.get(sql`SELECT count(*) AS n FROM chat_stats WHERE chat = ${chat} AND game = ${game} AND score > ${me.score}`)).n) + 1
      : 0;
    return { top, me: me ? Number(me.score) : 0, rank };
  }
  const top = await db.all(sql`SELECT s.user_id, s.score, s.wins, s.played, u.first_name FROM stats s
    LEFT JOIN users u ON u.user_id = s.user_id
    WHERE s.game = ${game} AND s.score > 0 ORDER BY s.score DESC, s.user_id LIMIT 20`);
  const me = await db.get(sql`SELECT score FROM stats WHERE user_id = ${userId} AND game = ${game}`);
  const rank = me && me.score > 0
    ? Number((await db.get(sql`SELECT count(*) AS n FROM stats WHERE game = ${game} AND score > ${me.score}`)).n) + 1
    : 0;
  return { top, me: me ? Number(me.score) : 0, rank };
}

/* ---------- owner stats ---------- */

export async function ownerStats() {
  const t = nowSec();
  const one = async (q) => Number((await db.get(q)).n);
  return {
    users: await one(sql`SELECT count(*) AS n FROM users`),
    d7: await one(sql`SELECT count(*) AS n FROM users WHERE last_seen > ${t - 7 * 86400}`),
    d30: await one(sql`SELECT count(*) AS n FROM users WHERE last_seen > ${t - 30 * 86400}`),
    blocked: await one(sql`SELECT count(*) AS n FROM users WHERE blocked = 1`),
    rooms: await one(sql`SELECT count(*) AS n FROM rooms WHERE status IN ('waiting', 'playing') AND updated_at > ${t - 900}`),
    counters: await getCounters(),
  };
}

/* Users who can receive a broadcast, after `cursor` (by id): started the bot and didn't block it. */
export async function broadcastRecipients(cursor, limit) {
  return db.all(sql`SELECT user_id FROM users WHERE user_id > ${cursor} AND started = 1 AND blocked = 0 ORDER BY user_id LIMIT ${limit}`);
}

export async function countRecipients() {
  return Number((await db.get(sql`SELECT count(*) AS n FROM users WHERE started = 1 AND blocked = 0`)).n);
}
