/*
 * Database queries for Phase 2: settings, admins, moderation (queue, reports), bans, forced-join
 * channels and broadcasts. Same rules as lib/store.js: sql`…` only, index-backed, LIMITed.
 * State changes that two admins could race on are compare-and-set (WHERE status = …), so the
 * second click gets "already handled" instead of doing the work twice.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { APPROVED, HIDDEN, PENDING, REJECTED, SETTINGS } from './config.js';

/* ---------- settings (kv rows set:*, numeric value in n) ---------- */

/* All settings in one query, plus the number of forced-join channels (as `channels`). `join` is
   the switch; forced join applies only when it is on AND channels exist (`joinActive`). */
export async function getSettings() {
  const rows = await db.all(sql`
    SELECT key, n FROM kv WHERE key IN (${SETTINGS.moderation.key}, ${SETTINGS.trust.key}, ${SETTINGS.hide.key}, ${SETTINGS.join.key}, ${'join:ver'})
    UNION ALL SELECT 'channels' AS key, count(*) AS n FROM channels`);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.n]));
  const out = { joinVer: byKey['join:ver'] || 0, channels: byKey.channels || 0 };
  for (const [name, s] of Object.entries(SETTINGS)) out[name] = byKey[s.key] === undefined ? s.def : byKey[s.key];
  out.joinActive = !!(out.join && out.channels);
  return out;
}

export async function setSetting(name, value) {
  await db.run(sql`INSERT INTO kv (key, value, n) VALUES (${SETTINGS[name].key}, '', ${value}) ON CONFLICT(key) DO UPDATE SET n = excluded.n`);
}

/* Forced-join version: bumped whenever the channel list or the switch changes, so every cached
   membership check becomes stale. */
export async function bumpJoinVersion() {
  await db.run(sql`INSERT INTO kv (key, value, n) VALUES ('join:ver', '', 1) ON CONFLICT(key) DO UPDATE SET n = kv.n + 1`);
}

/* ---------- admins ---------- */

export const isAdminRow = async (uid) => !!(await db.get(sql`SELECT user_id FROM admins WHERE user_id = ${uid}`));

export const listAdmins = () => db.all(sql`
  SELECT a.user_id AS user_id, u.first_name AS first_name, u.username AS username
  FROM admins a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.added_at LIMIT 50`);

export async function addAdmin(uid, by, t) {
  const r = await db.run(sql`INSERT INTO admins (user_id, added_by, added_at) VALUES (${uid}, ${by}, ${t}) ON CONFLICT(user_id) DO NOTHING`);
  return r.rowsAffected > 0;
}

export async function removeAdmin(uid) {
  const r = await db.run(sql`DELETE FROM admins WHERE user_id = ${uid}`);
  return r.rowsAffected > 0;
}

/* ---------- moderation queue ---------- */

export const countStatus = async (status) => (await db.get(sql`SELECT count(*) AS n FROM memes WHERE status = ${status}`)).n;

const CARD_COLS = sql`m.id AS id, m.kind AS kind, m.file_id AS file_id, m.keywords AS keywords, m.uploader_id AS uploader_id,
  m.status AS status, m.uses AS uses, m.reports AS reports, m.created_at AS created_at,
  u.first_name AS first_name, u.username AS username, u.approved_n AS approved_n, u.banned AS banned`;

/* The oldest pending meme after `afterId` (0 = from the start), with its uploader. */
export const nextPending = (afterId) => db.get(sql`
  SELECT ${CARD_COLS} FROM memes m LEFT JOIN users u ON u.id = m.uploader_id
  WHERE m.status = ${PENDING} AND m.id > ${afterId} ORDER BY m.id LIMIT 1`);

/* Moves a meme from one status to another; null if it was no longer in `from` (someone else acted). */
export async function review(id, from, to, by, t) {
  const r = await db.run(sql`
    UPDATE memes SET status = ${to}, reviewed_by = ${by}, reviewed_at = ${t}, updated_at = ${t}
    WHERE id = ${id} AND status IN (${from[0]}, ${from[1] || from[0]})
    RETURNING uploader_id, keywords`);
  return r.rows[0] || null;
}

/* One more admin-approved meme for the uploader; returns their new total. */
export async function incApproved(uid) {
  const r = await db.run(sql`UPDATE users SET approved_n = approved_n + 1 WHERE id = ${uid} RETURNING approved_n`);
  return r.rows.length ? r.rows[0].approved_n : 0;
}

/* ---------- reports ---------- */

/* Counts one report for today unless the user is at max (atomic). False when the limit is reached. */
export async function consumeReport(uid, day, max) {
  const r = await db.run(sql`
    UPDATE users SET rep_n = CASE WHEN rep_day = ${day} THEN rep_n + 1 ELSE 1 END, rep_day = ${day}
    WHERE id = ${uid} AND (rep_day != ${day} OR rep_n < ${max})`);
  return r.rowsAffected > 0;
}

/* Files a report. Returns the meme's new open-report count, or null if this user already reported it. */
export async function addReport(memeId, uid, reason, t) {
  const r = await db.run(sql`
    INSERT INTO reports (meme_id, reporter_id, reason, created_at) VALUES (${memeId}, ${uid}, ${reason}, ${t})
    ON CONFLICT(meme_id, reporter_id) DO NOTHING`);
  if (!r.rowsAffected) return null;
  const m = await db.run(sql`UPDATE memes SET reports = reports + 1 WHERE id = ${memeId} RETURNING reports`);
  return m.rows.length ? m.rows[0].reports : 0;
}

/* Hides a public meme (reports reached the threshold). True if it was public. */
export async function hideReported(memeId, t) {
  const r = await db.run(sql`UPDATE memes SET status = ${HIDDEN}, updated_at = ${t} WHERE id = ${memeId} AND status = ${APPROVED}`);
  return r.rowsAffected > 0;
}

export const countReported = async () => (await db.get(sql`SELECT count(*) AS n FROM memes WHERE reports > 0`)).n;

/* The most-reported meme with open reports, skipping ids already shown in this round. */
export const nextReported = (afterId) => db.get(sql`
  SELECT ${CARD_COLS} FROM memes m LEFT JOIN users u ON u.id = m.uploader_id
  WHERE m.reports > 0 AND m.id > ${afterId} ORDER BY m.id LIMIT 1`);

export const reportReasons = (memeId) => db.all(sql`
  SELECT reason, count(*) AS n FROM reports WHERE meme_id = ${memeId} GROUP BY reason LIMIT 10`);

/* Closes a meme's reports: keep (back to public) or remove (rejected). Returns the meme or null. */
export async function resolveReports(memeId, keep, by, t) {
  const r = await db.run(sql`
    UPDATE memes SET reports = 0, status = ${keep ? APPROVED : REJECTED}, reviewed_by = ${by}, reviewed_at = ${t}, updated_at = ${t}
    WHERE id = ${memeId} AND reports > 0 AND status IN (${APPROVED}, ${HIDDEN})
    RETURNING uploader_id, keywords`);
  await db.run(sql`DELETE FROM reports WHERE meme_id = ${memeId}`);
  return r.rows[0] || null;
}

/* ---------- users, bans ---------- */

export const countUsers = async () => (await db.get(sql`SELECT count(*) AS n FROM users`)).n;
export const countBanned = async () => (await db.get(sql`SELECT count(*) AS n FROM users WHERE banned = 1`)).n;

/* A user by numeric id or @username (case-insensitive), or null. */
export function findUser(ref) {
  const s = String(ref || '').trim();
  if (/^\d{4,15}$/.test(s)) return db.get(sql`SELECT * FROM users WHERE id = ${Number(s)}`);
  const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s.replace(/^https?:\/\/t\.me\//i, ''));
  return m ? db.get(sql`SELECT * FROM users WHERE uname = ${m[1].toLowerCase()} LIMIT 1`) : Promise.resolve(null);
}

export async function userStats(uid) {
  return db.get(sql`
    SELECT count(*) AS total,
      coalesce(sum(CASE WHEN status = ${APPROVED} THEN 1 ELSE 0 END), 0) AS public,
      coalesce(sum(CASE WHEN status = ${PENDING} THEN 1 ELSE 0 END), 0) AS pending
    FROM memes WHERE uploader_id = ${uid}`);
}

export async function setBanned(uid, banned) {
  const r = await db.run(sql`UPDATE users SET banned = ${banned ? 1 : 0}, ban_told_at = 0, state = NULL, state_data = NULL WHERE id = ${uid} AND banned = ${banned ? 0 : 1}`);
  return r.rowsAffected > 0;
}

/* Rejects every meme of a user in the given statuses; returns how many. */
export async function rejectAllOf(uid, statuses, by, t) {
  const r = await db.run(sql`
    UPDATE memes SET status = ${REJECTED}, reviewed_by = ${by}, reviewed_at = ${t}, updated_at = ${t}
    WHERE uploader_id = ${uid} AND status IN (${statuses[0]}, ${statuses[1] || statuses[0]}, ${statuses[2] || statuses[0]})`);
  return r.rowsAffected;
}

export const bannedPage = (limit, offset) => db.all(sql`
  SELECT id, first_name, username FROM users WHERE banned = 1 ORDER BY id LIMIT ${limit} OFFSET ${offset}`);

/* True at most once per `every` seconds: a banned user is told so, then ignored. */
export async function claimBanNotice(uid, t, every) {
  const r = await db.run(sql`UPDATE users SET ban_told_at = ${t} WHERE id = ${uid} AND ban_told_at <= ${t - every}`);
  return r.rowsAffected > 0;
}

/* ---------- forced join ---------- */

export const listChannels = () => db.all(sql`SELECT chat_id, username, title, link FROM channels ORDER BY added_at LIMIT 20`);

export async function addChannel(ch, t) {
  const r = await db.run(sql`
    INSERT INTO channels (chat_id, username, title, link, added_at) VALUES (${ch.chatId}, ${ch.username || null}, ${ch.title || null}, ${ch.link || null}, ${t})
    ON CONFLICT(chat_id) DO NOTHING`);
  return r.rowsAffected > 0;
}

export async function removeChannel(chatId) {
  const r = await db.run(sql`DELETE FROM channels WHERE chat_id = ${chatId}`);
  return r.rowsAffected > 0;
}

export async function setJoinCache(uid, ok, until, ver) {
  await db.run(sql`UPDATE users SET join_ok = ${ok ? 1 : 0}, join_until = ${until}, join_ver = ${ver} WHERE id = ${uid}`);
}

/* ---------- broadcasts ---------- */

export async function createBroadcast(srcChat, srcMsg, by, t) {
  const r = await db.run(sql`
    INSERT INTO broadcasts (src_chat, src_msg, created_by, created_at, status) VALUES (${srcChat}, ${srcMsg}, ${by}, ${t}, 'draft')
    RETURNING id`);
  return r.rows[0].id;
}

export const getBroadcast = (id) => db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`);

export const runningBroadcast = () => db.get(sql`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1`);

/* draft → running (one running broadcast at a time). */
export async function startBroadcast(id, total) {
  const busy = await runningBroadcast();
  if (busy) return false;
  const r = await db.run(sql`UPDATE broadcasts SET status = 'running', total = ${total} WHERE id = ${id} AND status = 'draft'`);
  return r.rowsAffected > 0;
}

export async function setBroadcastStatus(id, from, to) {
  const r = await db.run(sql`UPDATE broadcasts SET status = ${to} WHERE id = ${id} AND status = ${from}`);
  return r.rowsAffected > 0;
}

/* Users a broadcast goes to: everyone who wrote to the bot, except banned users and those known to
   have blocked it, in id order after `cursor`. */
export const recipientsAfter = (cursor, limit) => db.all(sql`
  SELECT id FROM users WHERE id > ${cursor} AND banned = 0 AND blocked = 0 ORDER BY id LIMIT ${limit}`);

export const countRecipients = async () => (await db.get(sql`SELECT count(*) AS n FROM users WHERE banned = 0 AND blocked = 0`)).n;

/* Claims the next range of recipients by moving the cursor (compare-and-set): two updates can
   never send the same range. */
export async function claimRange(id, from, to) {
  const r = await db.run(sql`UPDATE broadcasts SET cursor = ${to} WHERE id = ${id} AND cursor = ${from} AND status = 'running'`);
  return r.rowsAffected > 0;
}

/* After a 429: give back the unsent part of the claimed range and wait. */
export async function rewindRange(id, claimedTo, backTo, retryAt) {
  await db.run(sql`UPDATE broadcasts SET cursor = ${backTo}, retry_at = ${retryAt} WHERE id = ${id} AND cursor = ${claimedTo}`);
}

export async function addBroadcastCounts(id, sent, failed) {
  await db.run(sql`UPDATE broadcasts SET sent = sent + ${sent}, failed = failed + ${failed} WHERE id = ${id}`);
}

export async function markBlocked(uid) {
  await db.run(sql`UPDATE users SET blocked = 1 WHERE id = ${uid}`);
}
