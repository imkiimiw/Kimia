/*
 * Every database query of the bot. All SQL goes through the sql`…` tag (values become
 * parameters), every query is index-backed and LIMITed, and every user-data query filters by the
 * user's id. Raw queries return snake_case column names and plain numbers.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { APPROVED, PENDING, PRIVATE } from './config.js';
import { bumpStats } from './socialstore.js';

/* ---------- users ---------- */

/* Lowercased username for lookups by @username (indexed; no SQL lower(), the platform whitelists functions). */
const uname = (from) => (from.username ? String(from.username).toLowerCase() : null);

/* Creates or refreshes the user and counts the message for anti-spam. Returns the row. */
export async function touchUser(from, t, window) {
  const r = await db.run(sql`
    INSERT INTO users (id, first_name, username, uname, created_at, seen_at, spam_win, spam_n)
    VALUES (${from.id}, ${from.first_name || null}, ${from.username || null}, ${uname(from)}, ${t}, ${t}, ${t}, 1)
    ON CONFLICT(id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      uname = excluded.uname,
      seen_at = excluded.seen_at,
      blocked = 0,
      spam_n = CASE WHEN users.spam_win > ${t - window} THEN users.spam_n + 1 ELSE 1 END,
      spam_win = CASE WHEN users.spam_win > ${t - window} THEN users.spam_win ELSE ${t} END
    RETURNING *`);
  return r.rows[0];
}

/* Creates the user if needed without counting anything (button presses). Returns the row. */
export async function ensureUser(from, t) {
  const r = await db.run(sql`
    INSERT INTO users (id, first_name, username, uname, created_at, seen_at)
    VALUES (${from.id}, ${from.first_name || null}, ${from.username || null}, ${uname(from)}, ${t}, ${t})
    ON CONFLICT(id) DO UPDATE SET seen_at = excluded.seen_at
    RETURNING *`);
  return r.rows[0];
}

export const getUser = (id) => db.get(sql`SELECT * FROM users WHERE id = ${id}`);

export async function setLang(id, lang) {
  await db.run(sql`UPDATE users SET lang = ${lang} WHERE id = ${id}`);
}

export async function mute(id, until) {
  await db.run(sql`UPDATE users SET mute_until = ${until} WHERE id = ${id}`);
}

export async function setState(id, state, data, t) {
  await db.run(sql`UPDATE users SET state = ${state}, state_data = ${data ? JSON.stringify(data) : null}, state_at = ${t} WHERE id = ${id}`);
}

export async function clearState(id) {
  await db.run(sql`UPDATE users SET state = NULL, state_data = NULL WHERE id = ${id}`);
}

/* True for the first message of an album seen from this user (the others are ignored). */
export async function claimAlbum(id, groupId) {
  const r = await db.run(sql`UPDATE users SET album_id = ${groupId} WHERE id = ${id} AND (album_id IS NULL OR album_id != ${groupId})`);
  return r.rowsAffected > 0;
}

/* Counts one upload for today (Tehran day) unless the user is at max. Returns today's count,
   or null when the limit is reached. Atomic, so two uploads at once can't both pass. */
export async function consumeUpload(id, day, max) {
  const r = await db.run(sql`
    UPDATE users SET
      up_count = CASE WHEN up_day = ${day} THEN up_count + 1 ELSE 1 END,
      up_day = ${day}
    WHERE id = ${id} AND (up_day != ${day} OR up_count < ${max})
    RETURNING up_count`);
  return r.rows.length ? r.rows[0].up_count : null;
}

export async function refundUpload(id, day) {
  await db.run(sql`UPDATE users SET up_count = up_count - 1 WHERE id = ${id} AND up_day = ${day} AND up_count > 0`);
}

/* ---------- memes ---------- */

const MEME_COLS = sql`id, kind, file_id, file_unique_id, keywords, uploader_id, uses, likes, score, created_at, status, reports, backup_chat_id, backup_msg_id, ocr, ai_flag, ai_reason`;

export const memeByUniqueId = (uid) => db.get(sql`SELECT ${MEME_COLS} FROM memes WHERE file_unique_id = ${uid}`);

/* A private meme's file_unique_id column holds this key, so it never collides with a public copy. */
export const privateKey = (userId, fileUniqueId) => `p${userId}:${fileUniqueId}`;
export const publicKeyOf = (key) => String(key).replace(/^p\d+:/, '');

export const memeById = (id) => db.get(sql`SELECT ${MEME_COLS} FROM memes WHERE id = ${id}`);

/* Inserts a meme and its search words. Returns the new id, or null if the file is already there. */
export async function insertMeme({ fileId, fileUniqueId, kind, keywords, uploaderId, words, t, status = APPROVED, ocr = null, aiFlag = 0, aiReason = null }) {
  const r = await db.run(sql`
    INSERT INTO memes (file_id, file_unique_id, kind, keywords, uploader_id, status, uses, created_at, updated_at, ocr, ai_flag, ai_reason)
    VALUES (${fileId}, ${fileUniqueId}, ${kind}, ${keywords}, ${uploaderId}, ${status}, 0, ${t}, ${t}, ${ocr}, ${aiFlag ? 1 : 0}, ${aiReason})
    ON CONFLICT(file_unique_id) DO NOTHING
    RETURNING id`);
  if (!r.rows.length) return null;
  const id = r.rows[0].id;
  let values = null;
  for (const w of words) values = values ? sql`${values}, (${w}, ${id})` : sql`(${w}, ${id})`;
  if (values) await db.run(sql`INSERT OR IGNORE INTO meme_words (word, meme_id) VALUES ${values}`);
  return id;
}

/* Deletes one of the user's own memes (and its search words). False if it isn't theirs. */
export async function deleteOwnMeme(id, uploaderId) {
  const r = await db.run(sql`DELETE FROM memes WHERE id = ${id} AND uploader_id = ${uploaderId}`);
  if (!r.rowsAffected) return false;
  await db.run(sql`DELETE FROM meme_words WHERE meme_id = ${id}`);
  await db.run(sql`DELETE FROM reports WHERE meme_id = ${id}`);
  await db.run(sql`DELETE FROM favorites WHERE meme_id = ${id}`);
  await db.run(sql`DELETE FROM likes WHERE meme_id = ${id}`);
  return true;
}

async function replaceWords(id, words) {
  await db.run(sql`DELETE FROM meme_words WHERE meme_id = ${id}`);
  let values = null;
  for (const w of words) values = values ? sql`${values}, (${w}, ${id})` : sql`(${w}, ${id})`;
  if (values) await db.run(sql`INSERT OR IGNORE INTO meme_words (word, meme_id) VALUES ${values}`);
}

/* The AI's result arrived after the meme was saved (the user was faster): attach the OCR text, its
   words and the flag. Returns the meme row before the change, or null. */
export async function attachAi(fileUniqueId, ocr, words, aiFlag, aiReason) {
  const m = await db.get(sql`SELECT ${MEME_COLS} FROM memes WHERE file_unique_id = ${fileUniqueId}`);
  if (!m) return null;
  await db.run(sql`UPDATE memes SET ocr = ${ocr || null}, ai_flag = ${aiFlag ? 1 : 0}, ai_reason = ${aiReason || null} WHERE id = ${m.id}`);
  let values = null;
  for (const w of words) values = values ? sql`${values}, (${w}, ${m.id})` : sql`(${w}, ${m.id})`;
  if (values) await db.run(sql`INSERT OR IGNORE INTO meme_words (word, meme_id) VALUES ${values}`);
  return m;
}

/* Moves a meme to another status (used when a late AI flag sends a public meme to the queue). */
export async function setStatus(id, from, to, t) {
  const r = await db.run(sql`UPDATE memes SET status = ${to}, updated_at = ${t} WHERE id = ${id} AND status = ${from}`);
  return r.rowsAffected > 0;
}

/* Replaces the pending upload's state only if it is still the same one (compare-and-set), so a
   slow AI answer never overwrites a newer upload or brings back a finished one. */
export async function updatePendingData(id, oldData, newData) {
  const r = await db.run(sql`UPDATE users SET state_data = ${JSON.stringify(newData)} WHERE id = ${id} AND state = 'kw' AND state_data = ${oldData}`);
  return r.rowsAffected > 0;
}

/* New keywords for one of the user's own memes (and its search words). `status` = the status
   it should have afterwards. False if the meme isn't theirs. */
export async function updateKeywords(id, uploaderId, keywords, words, status, t) {
  const r = await db.run(sql`UPDATE memes SET keywords = ${keywords}, status = ${status}, updated_at = ${t} WHERE id = ${id} AND uploader_id = ${uploaderId}`);
  if (!r.rowsAffected) return false;
  await replaceWords(id, words);
  return true;
}

/* A private meme becomes public (status pending or approved) under its real file_unique_id.
   False if it isn't the user's private meme, or the file is public already (UNIQUE). */
export async function publishPrivate(id, uploaderId, status, t) {
  const m = await db.get(sql`SELECT file_unique_id FROM memes WHERE id = ${id} AND uploader_id = ${uploaderId} AND status = ${PRIVATE}`);
  if (!m) return false;
  const key = publicKeyOf(m.file_unique_id);
  if (await db.get(sql`SELECT id FROM memes WHERE file_unique_id = ${key}`)) return false;
  const r = await db.run(sql`UPDATE memes SET file_unique_id = ${key}, status = ${status}, updated_at = ${t} WHERE id = ${id} AND status = ${PRIVATE}`);
  return r.rowsAffected > 0;
}

export const countOwn = async (uid) => (await db.get(sql`SELECT count(*) AS n FROM memes WHERE uploader_id = ${uid}`)).n;

export const listOwn = (uid, limit, offset) => db.all(sql`
  SELECT ${MEME_COLS} FROM memes WHERE uploader_id = ${uid} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`);

export async function setBackup(id, chatId, msgId) {
  await db.run(sql`UPDATE memes SET backup_chat_id = ${chatId}, backup_msg_id = ${msgId} WHERE id = ${id}`);
}

/* Memes not in the channel yet (partial index idx_memes_no_backup); `onlyPublic` = approved ones only. */
export const pendingBackups = (before, limit, onlyPublic = false) => db.all(sql`
  SELECT id, kind, file_id, keywords, likes FROM memes
  WHERE backup_msg_id IS NULL AND created_at < ${before} ${onlyPublic ? sql`AND status = ${APPROVED}` : sql``}
  ORDER BY id LIMIT ${limit}`);

/* ---------- inline search ---------- */

const INLINE_COLS = sql`id, kind, file_id, keywords, likes`;
const TOP = String.fromCodePoint(0x10ffff);

/* What a user may see in inline mode: public memes, plus their own memes waiting for approval and
   their private collection. */
const visibleTo = (uid) => sql`(status = ${APPROVED} OR (status IN (${PENDING}, ${PRIVATE}) AND uploader_id = ${uid}))`;

/* Memes matching every word: a one-letter word must equal a keyword word, a longer one is a prefix
   of one (an index range scan on uidx_meme_words; #tags are words too). Optional filters: `kind`
   (one type) and `fav` (only the user's favourites). Ranked by score (uses + 3 × likes), newest first on ties. */
export function search({ words, kind = null, fav = false }, limit, offset, uid) {
  let where = visibleTo(uid);
  if (kind) where = sql`${where} AND kind = ${kind}`;
  if (fav) where = sql`${where} AND id IN (SELECT meme_id FROM favorites WHERE user_id = ${uid})`;
  for (const w of words) {
    const match = Array.from(w).length === 1
      ? sql`word = ${w}`
      : sql`word >= ${w} AND word < ${w + TOP}`;
    where = sql`${where} AND id IN (SELECT meme_id FROM meme_words WHERE ${match})`;
  }
  return db.all(sql`SELECT ${INLINE_COLS} FROM memes WHERE ${where} ORDER BY score DESC, id DESC LIMIT ${limit} OFFSET ${offset}`);
}

export const popular = (limit, offset) => db.all(sql`
  SELECT ${INLINE_COLS} FROM memes WHERE status = ${APPROVED} ORDER BY score DESC, id DESC LIMIT ${limit} OFFSET ${offset}`);

/* The memes this user sent most recently through inline mode. */
export const recentUsed = (uid, limit) => db.all(sql`
  SELECT m.id AS id, m.kind AS kind, m.file_id AS file_id, m.keywords AS keywords, m.likes AS likes
  FROM recent_uses r JOIN memes m ON m.id = r.meme_id
  WHERE r.user_id = ${uid} AND ${visibleTo(uid)}
  ORDER BY r.used_at DESC LIMIT ${limit}`);

/* The user's own latest uploads that they may send (public, waiting for approval, or private). */
export const ownLatest = (uid, limit) => db.all(sql`
  SELECT ${INLINE_COLS} FROM memes WHERE uploader_id = ${uid} AND status IN (${APPROVED}, ${PENDING}, ${PRIVATE}) ORDER BY id DESC LIMIT ${limit}`);

/* ---------- favourites (Phase 3) ---------- */

/* The user's favourites they can still see, newest starred first (optionally one type). */
export function favList(uid, kind, limit, offset) {
  const k = kind ? sql`AND m.kind = ${kind}` : sql``;
  return db.all(sql`
    SELECT m.id AS id, m.kind AS kind, m.file_id AS file_id, m.keywords AS keywords, m.uses AS uses, m.likes AS likes, m.status AS status
    FROM favorites f JOIN memes m ON m.id = f.meme_id
    WHERE f.user_id = ${uid} AND ${visibleTo(uid)} ${k}
    ORDER BY f.created_at DESC, f.meme_id DESC LIMIT ${limit} OFFSET ${offset}`);
}

export const countFav = async (uid) => (await db.get(sql`SELECT count(*) AS n FROM favorites WHERE user_id = ${uid}`)).n;

export const isFav = async (uid, memeId) => !!(await db.get(sql`SELECT meme_id FROM favorites WHERE user_id = ${uid} AND meme_id = ${memeId}`));

/* Stars a meme: 'added' | 'exists' | 'full' (at most `max` per user). */
export async function addFav(uid, memeId, t, max) {
  if ((await countFav(uid)) >= max) return (await isFav(uid, memeId)) ? 'exists' : 'full';
  const r = await db.run(sql`INSERT INTO favorites (user_id, meme_id, created_at) VALUES (${uid}, ${memeId}, ${t}) ON CONFLICT(user_id, meme_id) DO NOTHING`);
  return r.rowsAffected ? 'added' : 'exists';
}

export async function removeFav(uid, memeId) {
  const r = await db.run(sql`DELETE FROM favorites WHERE user_id = ${uid} AND meme_id = ${memeId}`);
  return r.rowsAffected > 0;
}

/* The most used public #tags: an index range over meme_words ('#' … '$'). */
export const topTags = (limit) => db.all(sql`
  SELECT w.word AS tag, count(*) AS n FROM meme_words w JOIN memes m ON m.id = w.meme_id
  WHERE w.word >= '#' AND w.word < '$' AND m.status = ${APPROVED}
  GROUP BY w.word ORDER BY n DESC, w.word LIMIT ${limit}`);

/* Records that a user sent a meme: refreshes their recent list (keeping the newest `keep`) and
   counts a use unless they sent the same meme within `cooldown` seconds. True if counted. */
export async function recordUse(uid, memeId, t, cooldown, keep) {
  const meme = await db.get(sql`SELECT id FROM memes WHERE id = ${memeId}`);
  if (!meme) return false;
  const prev = await db.get(sql`SELECT used_at FROM recent_uses WHERE user_id = ${uid} AND meme_id = ${memeId}`);
  await db.run(sql`
    INSERT INTO recent_uses (user_id, meme_id, used_at) VALUES (${uid}, ${memeId}, ${t})
    ON CONFLICT(user_id, meme_id) DO UPDATE SET used_at = excluded.used_at`);
  if (!prev) {
    await db.run(sql`
      DELETE FROM recent_uses WHERE user_id = ${uid} AND used_at < (
        SELECT used_at FROM recent_uses WHERE user_id = ${uid} ORDER BY used_at DESC LIMIT 1 OFFSET ${keep - 1})`);
  }
  if (prev && t - prev.used_at < cooldown) return false;
  const r = await db.run(sql`UPDATE memes SET uses = uses + 1, score = score + 1 WHERE id = ${memeId} RETURNING status, uploader_id`);
  if (r.rows[0] && r.rows[0].status === APPROVED) await bumpStats(memeId, r.rows[0].uploader_id, t, 1, 0);
  return true;
}

/* ---------- key/value ---------- */

export const kvGet = (key) => db.get(sql`SELECT value, n FROM kv WHERE key = ${key}`);

export async function kvSet(key, value, n) {
  await db.run(sql`INSERT INTO kv (key, value, n) VALUES (${key}, ${value}, ${n}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, n = excluded.n`);
}

/* True at most once per `every` seconds for a key (atomic), e.g. for owner alerts. */
export async function claimEvery(key, t, every) {
  const r = await db.run(sql`
    INSERT INTO kv (key, value, n) VALUES (${key}, '', ${t})
    ON CONFLICT(key) DO UPDATE SET n = excluded.n WHERE kv.n <= ${t - every}
    RETURNING key`);
  return r.rows.length > 0;
}
