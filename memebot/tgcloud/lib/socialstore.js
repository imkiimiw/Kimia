/*
 * Phase 4 queries: likes, per-week and per-day counters (leaderboards, meme of the day), profile
 * stats. Same rules as lib/store.js: sql`…` only, index-backed, LIMITed.
 * The ranking score is uses + LIKE_WEIGHT × likes, both on memes (all time) and in the counters.
 * Only approved (public) memes feed the counters; memes.uses / likes / score are kept for all.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { APPROVED, KEEP_DAYS, KEEP_WEEKS, LIKE_WEIGHT } from './config.js';
import { tehranDay, tehranWeek } from './util.js';

/* Adds uses / likes to a meme's week and day counters and to its uploader's week (at time t). */
export async function bumpStats(memeId, uploaderId, t, uses, likes) {
  const week = tehranWeek(t);
  const score = uses + LIKE_WEIGHT * likes;
  await db.run(sql`
    INSERT INTO meme_week (week, meme_id, uses, likes, score) VALUES (${week}, ${memeId}, ${uses}, ${likes}, ${score})
    ON CONFLICT(week, meme_id) DO UPDATE SET uses = meme_week.uses + excluded.uses, likes = meme_week.likes + excluded.likes, score = meme_week.score + excluded.score`);
  await db.run(sql`
    INSERT INTO user_week (week, user_id, uses, likes, score) VALUES (${week}, ${uploaderId}, ${uses}, ${likes}, ${score})
    ON CONFLICT(week, user_id) DO UPDATE SET uses = user_week.uses + excluded.uses, likes = user_week.likes + excluded.likes, score = user_week.score + excluded.score`);
  await db.run(sql`
    INSERT INTO meme_day (day, meme_id, score) VALUES (${tehranDay(t)}, ${memeId}, ${score})
    ON CONFLICT(day, meme_id) DO UPDATE SET score = meme_day.score + excluded.score`);
}

/* ---------- likes ---------- */

export const hasLiked = async (uid, memeId) => !!(await db.get(sql`SELECT meme_id FROM likes WHERE user_id = ${uid} AND meme_id = ${memeId}`));

/* Likes or unlikes. Returns { liked, likes } (likes = the meme's new total), or null if the meme
   is gone. An unlike is taken off the week and day the like was given in. */
export async function toggleLike(uid, memeId, t) {
  const m = await db.get(sql`SELECT id, uploader_id, status FROM memes WHERE id = ${memeId}`);
  if (!m) return null;
  const prev = await db.get(sql`SELECT created_at FROM likes WHERE user_id = ${uid} AND meme_id = ${memeId}`);
  let liked;
  if (prev) {
    const r = await db.run(sql`DELETE FROM likes WHERE user_id = ${uid} AND meme_id = ${memeId}`);
    if (r.rowsAffected) {
      await db.run(sql`UPDATE memes SET likes = likes - 1, score = score - ${LIKE_WEIGHT} WHERE id = ${memeId} AND likes > 0`);
      if (m.status === APPROVED) await bumpStats(memeId, m.uploader_id, prev.created_at, 0, -1);
    }
    liked = false;
  } else {
    const r = await db.run(sql`INSERT INTO likes (user_id, meme_id, created_at) VALUES (${uid}, ${memeId}, ${t}) ON CONFLICT(user_id, meme_id) DO NOTHING`);
    if (r.rowsAffected) {
      await db.run(sql`UPDATE memes SET likes = likes + 1, score = score + ${LIKE_WEIGHT} WHERE id = ${memeId}`);
      if (m.status === APPROVED) await bumpStats(memeId, m.uploader_id, t, 0, 1);
    }
    liked = true;
  }
  const after = await db.get(sql`SELECT likes FROM memes WHERE id = ${memeId}`);
  return { liked, likes: after ? after.likes : 0 };
}

/* ---------- leaderboards ---------- */

export const topMemes = (week, limit) => db.all(sql`
  SELECT w.meme_id AS id, w.uses AS uses, w.likes AS likes, w.score AS score, m.kind AS kind, m.keywords AS keywords
  FROM meme_week w JOIN memes m ON m.id = w.meme_id
  WHERE w.week = ${week} AND w.score > 0 AND m.status = ${APPROVED}
  ORDER BY w.score DESC, w.meme_id DESC LIMIT ${limit}`);

export const topUploaders = (week, limit) => db.all(sql`
  SELECT w.user_id AS id, w.uses AS uses, w.likes AS likes, w.score AS score, u.first_name AS first_name, u.lb_hidden AS hidden
  FROM user_week w LEFT JOIN users u ON u.id = w.user_id
  WHERE w.week = ${week} AND w.score > 0 AND coalesce(u.banned, 0) = 0
  ORDER BY w.score DESC, w.user_id LIMIT ${limit}`);

/* ---------- profiles ---------- */

/* A user's public memes: how many, total uses, total likes. */
export const profileStats = (uid) => db.get(sql`
  SELECT count(*) AS memes, coalesce(sum(uses), 0) AS uses, coalesce(sum(likes), 0) AS likes
  FROM memes WHERE uploader_id = ${uid} AND status = ${APPROVED}`);

/* This week's points and rank (null rank = no points yet). */
export async function weekRank(uid, week) {
  const me = await db.get(sql`SELECT score FROM user_week WHERE week = ${week} AND user_id = ${uid}`);
  if (!me || me.score <= 0) return { score: 0, rank: null };
  const above = await db.get(sql`SELECT count(*) AS n FROM user_week WHERE week = ${week} AND score > ${me.score}`);
  return { score: me.score, rank: above.n + 1 };
}

export async function setLbHidden(uid, hidden) {
  await db.run(sql`UPDATE users SET lb_hidden = ${hidden ? 1 : 0} WHERE id = ${uid}`);
}

/* ---------- meme of the day ---------- */

const MOTD_COLS = sql`m.id AS id, m.kind AS kind, m.file_id AS file_id, m.keywords AS keywords, m.uses AS uses, m.likes AS likes`;

/* The best public meme of `day` (by that day's score), not posted since day `since`. */
export const pickOfDay = (day, since) => db.get(sql`
  SELECT ${MOTD_COLS} FROM meme_day d JOIN memes m ON m.id = d.meme_id
  WHERE d.day = ${day} AND d.score > 0 AND m.status = ${APPROVED} AND m.id NOT IN (SELECT meme_id FROM motd WHERE day > ${since})
  ORDER BY d.score DESC, m.id DESC LIMIT 1`);

export const pickOfWeek = (week, since) => db.get(sql`
  SELECT ${MOTD_COLS} FROM meme_week w JOIN memes m ON m.id = w.meme_id
  WHERE w.week = ${week} AND w.score > 0 AND m.status = ${APPROVED} AND m.id NOT IN (SELECT meme_id FROM motd WHERE day > ${since})
  ORDER BY w.score DESC, m.id DESC LIMIT 1`);

export const pickOfAllTime = (since) => db.get(sql`
  SELECT ${MOTD_COLS} FROM memes m
  WHERE m.status = ${APPROVED} AND m.id NOT IN (SELECT meme_id FROM motd WHERE day > ${since})
  ORDER BY m.score DESC, m.id DESC LIMIT 1`);

export async function recordMotd(day, memeId, chatId, msgId, t) {
  await db.run(sql`INSERT INTO motd (day, meme_id, chat_id, msg_id, posted_at) VALUES (${day}, ${memeId}, ${chatId}, ${msgId}, ${t}) ON CONFLICT(day) DO NOTHING`);
}

/* Drops counters older than KEEP_DAYS / KEEP_WEEKS (index range deletes). */
export async function pruneStats(t) {
  await db.run(sql`DELETE FROM meme_day WHERE day < ${tehranDay(t) - KEEP_DAYS}`);
  await db.run(sql`DELETE FROM meme_week WHERE week < ${tehranWeek(t) - KEEP_WEEKS}`);
  await db.run(sql`DELETE FROM user_week WHERE week < ${tehranWeek(t) - KEEP_WEEKS}`);
}
