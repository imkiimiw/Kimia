// Database access for the anonymous-chat section: messages (inbox / archive / filtered folders),
// blocks, a user's own blocked words, star ratings, reports to the bot's owner, and the anti-spam
// state of senders. Like lib/store.js: every query is index-backed and LIMITed, totals are counters
// on the users row (inbox_size, anon_unread, rating_sum/count) so nothing is COUNTed per update.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  INBOX_CAP, MAX_BLOCKS, MAX_WORDS, RESTRICT_LONG_SEC, RESTRICT_SEC, STRIKE_WINDOW_SEC, STRIKES_TO_RESTRICT,
} from './config.js';
import {
  bump, num, toUser, USER_COLS,
} from './store.js';
import { nowSec, randomId } from './util.js';

export const FOLDER = { inbox: 0, archive: 1, filtered: 2 };

// ---------- the link ----------

export async function getUserByAnonCode(code) {
  return toUser(await db.get(sql`SELECT ${USER_COLS} FROM users WHERE anon_code = ${code}`));
}

/** Sets the user's link code; false if the code is taken. */
export async function setAnonCode(id, code) {
  if (await db.get(sql`SELECT user_id FROM users WHERE anon_code = ${code}`)) return false;
  return (await db.run(sql`UPDATE users SET anon_code = ${code} WHERE user_id = ${id}`)).rowsAffected > 0;
}

// ---------- messages ----------

function toMsg(r) {
  if (!r) return null;
  return {
    id: r.id,
    fromId: num(r.from_id),
    toId: num(r.to_id),
    anon: num(r.anon) === 1,
    fromMsg: r.from_msg == null ? null : num(r.from_msg),
    toMsg: r.to_msg == null ? null : num(r.to_msg),
    kind: r.kind || 'text',
    body: r.body == null ? '' : String(r.body),
    fileId: r.file_id || null,
    cat: r.cat || 'g',
    q: r.q || null,
    folder: num(r.folder),
    unread: num(r.unread) === 1,
    createdAt: num(r.created_at),
  };
}

const M_COLS = sql`id, from_id, to_id, anon, from_msg, to_msg, kind, body, file_id, cat, q, folder, unread, created_at`;

/**
 * Stores a message for the recipient's inbox (or filtered folder) and updates their counters.
 * A full inbox (INBOX_CAP) drops its oldest messages.
 */
export async function createAnonMsg(m) {
  const now = nowSec();
  await db.run(sql`
    INSERT INTO anon_msgs (id, from_id, to_id, anon, from_msg, to_msg, kind, body, norm, file_id, cat, q, hash, folder, unread, created_at)
    VALUES (${m.id}, ${m.fromId}, ${m.toId}, ${m.anon ? 1 : 0}, ${m.fromMsg ?? null}, ${m.toMsg ?? null}, ${m.kind},
      ${m.body || null}, ${m.norm || null}, ${m.fileId || null}, ${m.cat || 'g'}, ${m.q || null}, ${m.hash || 0},
      ${m.folder || 0}, 1, ${now})`);
  const unread = (m.folder || 0) === FOLDER.inbox ? 1 : 0;
  const r = await db.run(sql`
    UPDATE users SET inbox_size = inbox_size + 1, anon_unread = anon_unread + ${unread},
      anon_count = anon_count + ${m.anon ? 1 : 0}
    WHERE user_id = ${m.toId} RETURNING inbox_size`);
  await bump('n_anon', 1);
  const size = num(r.rows && r.rows[0] && r.rows[0].inbox_size);
  if (size > INBOX_CAP) await pruneOldest(m.toId, size - INBOX_CAP);
}

async function pruneOldest(userId, n) {
  const rows = await db.all(sql`
    SELECT id FROM anon_msgs WHERE to_id = ${userId} ORDER BY created_at LIMIT ${Math.min(n, 20)}`);
  for (const r of rows) await deleteMsg(r.id, userId);
}

export async function setDelivered(id, toMsg) {
  await db.run(sql`UPDATE anon_msgs SET to_msg = ${toMsg} WHERE id = ${id}`);
}

export async function getAnonMsg(id) {
  return toMsg(await db.get(sql`SELECT ${M_COLS} FROM anon_msgs WHERE id = ${id}`));
}

/** A page of a folder, newest first; `cat` null = every category. Returns { items, more }. */
export async function listFolder(userId, folder, cat, page, size) {
  const off = Math.max(0, page) * size;
  const rows = cat
    ? await db.all(sql`
      SELECT ${M_COLS} FROM anon_msgs WHERE to_id = ${userId} AND folder = ${folder} AND cat = ${cat}
      ORDER BY created_at DESC LIMIT ${size + 1} OFFSET ${off}`)
    : await db.all(sql`
      SELECT ${M_COLS} FROM anon_msgs WHERE to_id = ${userId} AND folder = ${folder}
      ORDER BY created_at DESC LIMIT ${size + 1} OFFSET ${off}`);
  return { items: rows.slice(0, size).map(toMsg), more: rows.length > size };
}

/** Messages in a folder whose normalized text contains `norm` (at most `limit`, newest first). */
export async function searchFolder(userId, folder, norm, limit) {
  const pattern = `%${norm.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.all(sql`
    SELECT ${M_COLS} FROM anon_msgs WHERE to_id = ${userId} AND folder = ${folder} AND norm LIKE ${pattern} ESCAPE '\\'
    ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map(toMsg);
}

/** Marks a message read; true if it was unread (the unread counter goes down). */
export async function markRead(id, userId) {
  const r = await db.run(sql`UPDATE anon_msgs SET unread = 0 WHERE id = ${id} AND to_id = ${userId} AND unread = 1 RETURNING folder`);
  if (!r.rows || !r.rows.length) return false;
  if (num(r.rows[0].folder) === FOLDER.inbox) await db.run(sql`UPDATE users SET anon_unread = max(0, anon_unread - 1) WHERE user_id = ${userId}`);
  return true;
}

/** Moves a message between inbox / archive / filtered; a moved message counts as read. */
export async function setFolder(id, userId, folder) {
  await markRead(id, userId);
  return (await db.run(sql`UPDATE anon_msgs SET folder = ${folder} WHERE id = ${id} AND to_id = ${userId}`)).rowsAffected > 0;
}

export async function setCat(id, userId, cat) {
  return (await db.run(sql`UPDATE anon_msgs SET cat = ${cat} WHERE id = ${id} AND to_id = ${userId}`)).rowsAffected > 0;
}

export async function deleteMsg(id, userId) {
  const r = await db.run(sql`DELETE FROM anon_msgs WHERE id = ${id} AND to_id = ${userId} RETURNING unread, folder`);
  if (!r.rows || !r.rows.length) return false;
  const unread = num(r.rows[0].unread) === 1 && num(r.rows[0].folder) === FOLDER.inbox ? 1 : 0;
  await db.run(sql`
    UPDATE users SET inbox_size = max(0, inbox_size - 1), anon_unread = max(0, anon_unread - ${unread}) WHERE user_id = ${userId}`);
  return true;
}

/** Deletes up to `limit` of the user's messages; returns how many. Call again until 0. */
export async function deleteSomeMessages(userId, limit = 200) {
  const rows = await db.all(sql`SELECT id, unread, folder FROM anon_msgs WHERE to_id = ${userId} LIMIT ${limit}`);
  for (const r of rows) await db.run(sql`DELETE FROM anon_msgs WHERE id = ${r.id}`);
  if (rows.length) {
    const unread = rows.filter((r) => num(r.unread) === 1 && num(r.folder) === FOLDER.inbox).length;
    await db.run(sql`
      UPDATE users SET inbox_size = max(0, inbox_size - ${rows.length}), anon_unread = max(0, anon_unread - ${unread})
      WHERE user_id = ${userId}`);
  }
  return rows.length;
}

// ---------- anti-spam (the sender's side) ----------

/** How many messages `fromId` sent since `since` (to `toId` if given), counting at most `cap`. */
export async function countSent(fromId, since, cap, toId = null) {
  const r = toId == null
    ? await db.get(sql`
      SELECT count(*) AS n FROM (SELECT 1 FROM anon_msgs WHERE from_id = ${fromId} AND created_at >= ${since} LIMIT ${cap})`)
    : await db.get(sql`
      SELECT count(*) AS n FROM (SELECT 1 FROM anon_msgs WHERE from_id = ${fromId} AND created_at >= ${since} AND to_id = ${toId} LIMIT ${cap})`);
  return num(r && r.n);
}

/** Did `fromId` already send this text (hash) to `toId` since `since`? */
export async function isDuplicate(fromId, toId, hash, since) {
  return !!(await db.get(sql`
    SELECT 1 AS x FROM anon_msgs WHERE from_id = ${fromId} AND created_at >= ${since} AND to_id = ${toId} AND hash = ${hash} LIMIT 1`));
}

export async function touchSent(userId) {
  await db.run(sql`UPDATE users SET last_anon_at = ${nowSec()} WHERE user_id = ${userId}`);
}

/** A recipient blocked or reported this sender. Enough strikes within a week restrict them. */
export async function addStrike(senderId) {
  const now = nowSec();
  const r = await db.run(sql`
    UPDATE users SET
      strikes = CASE WHEN strike_at < ${now - STRIKE_WINDOW_SEC} THEN 1 ELSE strikes + 1 END,
      strike_at = ${now}
    WHERE user_id = ${senderId} RETURNING strikes, restricted_until`);
  const row = r.rows && r.rows[0];
  if (!row) return;
  const strikes = num(row.strikes);
  if (strikes >= STRIKES_TO_RESTRICT) {
    await restrict(senderId, strikes >= STRIKES_TO_RESTRICT * 2 ? RESTRICT_LONG_SEC : RESTRICT_SEC);
  }
}

export async function restrict(userId, sec) {
  const until = nowSec() + sec;
  await db.run(sql`UPDATE users SET restricted_until = max(restricted_until, ${until}) WHERE user_id = ${userId}`);
}

// ---------- blocks ----------

export async function isAnonBlocked(ownerId, senderId) {
  return !!(await db.get(sql`SELECT ref FROM anon_blocks WHERE owner_id = ${ownerId} AND blocked_id = ${senderId}`));
}

/** 'ok' | 'dup' | 'full' */
export async function addAnonBlock(ownerId, blockedId) {
  if (await isAnonBlocked(ownerId, blockedId)) return 'dup';
  const r = await db.run(sql`
    INSERT INTO anon_blocks (owner_id, blocked_id, ref, created_at)
    SELECT ${ownerId}, ${blockedId}, ${randomId(10)}, ${nowSec()}
    WHERE (SELECT count(*) FROM (SELECT 1 FROM anon_blocks WHERE owner_id = ${ownerId} LIMIT ${MAX_BLOCKS})) < ${MAX_BLOCKS}
    ON CONFLICT(owner_id, blocked_id) DO NOTHING`);
  return r.rowsAffected > 0 ? 'ok' : 'full';
}

export async function removeAnonBlock(ownerId, blockedId) {
  return (await db.run(sql`DELETE FROM anon_blocks WHERE owner_id = ${ownerId} AND blocked_id = ${blockedId}`)).rowsAffected > 0;
}

export async function removeAnonBlockByRef(ownerId, ref) {
  return (await db.run(sql`DELETE FROM anon_blocks WHERE owner_id = ${ownerId} AND ref = ${ref}`)).rowsAffected > 0;
}

/** The owner's anonymous blocks — refs and dates only, never who. */
export async function listAnonBlocks(ownerId) {
  const rows = await db.all(sql`
    SELECT ref, created_at FROM anon_blocks WHERE owner_id = ${ownerId} ORDER BY created_at DESC LIMIT ${MAX_BLOCKS}`);
  return rows.map((r) => ({ ref: r.ref, createdAt: num(r.created_at) }));
}

// ---------- blocked words ----------

export async function listWords(userId) {
  const rows = await db.all(sql`SELECT word FROM anon_words WHERE user_id = ${userId} ORDER BY created_at LIMIT ${MAX_WORDS}`);
  return rows.map((r) => r.word);
}

/** 'ok' | 'dup' | 'full' */
export async function addWord(userId, word) {
  const r = await db.run(sql`
    INSERT INTO anon_words (user_id, word, created_at)
    SELECT ${userId}, ${word}, ${nowSec()}
    WHERE (SELECT count(*) FROM (SELECT 1 FROM anon_words WHERE user_id = ${userId} LIMIT ${MAX_WORDS})) < ${MAX_WORDS}
    ON CONFLICT(user_id, word) DO NOTHING`);
  if (r.rowsAffected > 0) return 'ok';
  return (await db.get(sql`SELECT 1 AS x FROM anon_words WHERE user_id = ${userId} AND word = ${word}`)) ? 'dup' : 'full';
}

export async function removeWord(userId, word) {
  return (await db.run(sql`DELETE FROM anon_words WHERE user_id = ${userId} AND word = ${word}`)).rowsAffected > 0;
}

export async function deleteWords(userId) {
  await db.run(sql`DELETE FROM anon_words WHERE user_id = ${userId}`);
}

// ---------- ratings ----------

export async function getRating(targetId, raterId) {
  const r = await db.get(sql`SELECT stars FROM ratings WHERE target_id = ${targetId} AND rater_id = ${raterId}`);
  return r ? num(r.stars) : 0;
}

/** One rating per rater; changing it replaces the old one in the totals. Returns the new totals. */
export async function setRating(targetId, raterId, stars) {
  const old = await getRating(targetId, raterId);
  if (old) {
    await db.run(sql`UPDATE ratings SET stars = ${stars}, at = ${nowSec()} WHERE target_id = ${targetId} AND rater_id = ${raterId}`);
    await db.run(sql`UPDATE users SET rating_sum = rating_sum + ${stars - old} WHERE user_id = ${targetId}`);
  } else {
    const r = await db.run(sql`
      INSERT INTO ratings (target_id, rater_id, stars, at) VALUES (${targetId}, ${raterId}, ${stars}, ${nowSec()})
      ON CONFLICT(target_id, rater_id) DO NOTHING`);
    if (r.rowsAffected > 0) {
      await db.run(sql`UPDATE users SET rating_sum = rating_sum + ${stars}, rating_count = rating_count + 1 WHERE user_id = ${targetId}`);
    }
  }
  const u = await db.get(sql`SELECT rating_sum, rating_count FROM users WHERE user_id = ${targetId}`);
  return { sum: num(u && u.rating_sum), count: num(u && u.rating_count) };
}

/** "Delete my data": the ratings this user received (totals reset) and gave (others' totals fixed). */
export async function deleteRatingsOf(userId, limit = 200) {
  const given = await db.all(sql`SELECT target_id, stars FROM ratings WHERE rater_id = ${userId} LIMIT ${limit}`);
  for (const g of given) {
    await db.run(sql`DELETE FROM ratings WHERE target_id = ${g.target_id} AND rater_id = ${userId}`);
    await db.run(sql`
      UPDATE users SET rating_sum = max(0, rating_sum - ${num(g.stars)}), rating_count = max(0, rating_count - 1)
      WHERE user_id = ${g.target_id}`);
  }
  const got = await db.all(sql`SELECT rater_id FROM ratings WHERE target_id = ${userId} LIMIT ${limit}`);
  for (const g of got) await db.run(sql`DELETE FROM ratings WHERE target_id = ${userId} AND rater_id = ${g.rater_id}`);
  await db.run(sql`UPDATE users SET rating_sum = 0, rating_count = 0 WHERE user_id = ${userId}`);
  return given.length + got.length;
}

// ---------- reports ----------

function toReport(r) {
  if (!r) return null;
  return {
    id: num(r.id),
    msgId: r.msg_id,
    reporterId: num(r.reporter_id),
    senderId: num(r.sender_id),
    kind: r.kind || 'text',
    body: r.body == null ? '' : String(r.body),
    fileId: r.file_id || null,
    status: r.status,
    createdAt: num(r.created_at),
  };
}

const R_COLS = sql`id, msg_id, reporter_id, sender_id, kind, body, file_id, status, created_at`;

/** 'ok' | 'dup' (the message was already reported). */
export async function createReport(m, reporterId) {
  const r = await db.run(sql`
    INSERT INTO reports (msg_id, reporter_id, sender_id, kind, body, file_id, status, created_at)
    VALUES (${m.id}, ${reporterId}, ${m.fromId}, ${m.kind}, ${m.body || null}, ${m.fileId || null}, 'open', ${nowSec()})
    ON CONFLICT(msg_id) DO NOTHING`);
  return r.rowsAffected > 0 ? 'ok' : 'dup';
}

export async function listReports(status, limit = 10) {
  const rows = await db.all(sql`SELECT ${R_COLS} FROM reports WHERE status = ${status} ORDER BY id DESC LIMIT ${limit}`);
  return rows.map(toReport);
}

export async function getReport(id) {
  return toReport(await db.get(sql`SELECT ${R_COLS} FROM reports WHERE id = ${id}`));
}

export async function setReportStatus(id, to) {
  return (await db.run(sql`UPDATE reports SET status = ${to} WHERE id = ${id} AND status = 'open'`)).rowsAffected > 0;
}
