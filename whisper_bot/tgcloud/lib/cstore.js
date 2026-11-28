// Database access for confessions and their comments (lib/confess.js). Like lib/store.js: every query
// is index-backed and LIMITed, and a status change is a compare-and-set, so two reviewers pressing at
// once can't both post a confession.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { bump, getKv, num } from './store.js';
import { nowSec } from './util.js';

const C_COLS = sql`id, author_id, body, allow_comments, allow_dm, flags, status, lang, channel_id, channel_msg, comments,
  decided_at, created_at`;

function toConfession(r) {
  if (!r) return null;
  return {
    id: num(r.id),
    authorId: Number(r.author_id),
    body: r.body || '',
    allowComments: num(r.allow_comments) === 1,
    allowDm: num(r.allow_dm) === 1,
    flags: String(r.flags || '').split(',').filter(Boolean),
    status: r.status,
    lang: r.lang || 'fa',
    channelId: r.channel_id == null ? null : Number(r.channel_id),
    channelMsg: r.channel_msg == null ? null : num(r.channel_msg),
    comments: num(r.comments),
    decidedAt: num(r.decided_at),
    createdAt: num(r.created_at),
  };
}

export async function createConfession({ authorId, body, allowComments, allowDm, flags, lang }) {
  const r = await db.run(sql`
    INSERT INTO confessions (author_id, body, allow_comments, allow_dm, flags, status, lang, created_at)
    VALUES (${authorId}, ${body}, ${allowComments ? 1 : 0}, ${allowDm ? 1 : 0}, ${flags.join(',') || null}, 'pending',
      ${lang}, ${nowSec()})
    RETURNING id`);
  await bump('n_confessions', 1);
  return num(r.rows && r.rows[0] && r.rows[0].id);
}

export async function getConfession(id) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  return toConfession(await db.get(sql`SELECT ${C_COLS} FROM confessions WHERE id = ${Number(id)}`));
}

export async function listPending(limit = 10) {
  const rows = await db.all(sql`SELECT ${C_COLS} FROM confessions WHERE status = 'pending' ORDER BY id LIMIT ${limit}`);
  return rows.map(toConfession);
}

export async function countPendingConfessions() {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM confessions WHERE status = 'pending' LIMIT 100)`);
  return num(r && r.n);
}

/** How many the author sent since `since` (for the daily limit), counting at most `max`. */
export async function countByAuthorSince(authorId, since, max) {
  const r = await db.get(sql`
    SELECT count(*) AS n FROM (
      SELECT created_at FROM confessions WHERE author_id = ${authorId} ORDER BY id DESC LIMIT ${max})
    WHERE created_at >= ${since}`);
  return num(r && r.n);
}

/** pending → approved / rejected, once: false if someone else decided first. */
export async function decide(id, status) {
  const r = await db.run(sql`
    UPDATE confessions SET status = ${status}, decided_at = ${nowSec()} WHERE id = ${id} AND status = 'pending'`);
  return r.rowsAffected > 0;
}

/** Back to pending (the post to the channel failed after the approval was claimed). */
export async function undecide(id) {
  await db.run(sql`UPDATE confessions SET status = 'pending', decided_at = 0 WHERE id = ${id} AND status = 'approved'`);
}

export async function setPosted(id, channelId, channelMsg) {
  await db.run(sql`UPDATE confessions SET channel_id = ${channelId}, channel_msg = ${channelMsg} WHERE id = ${id}`);
  await bump('n_cf_posted', 1);
}

/** Confessions posted to the channel so far (a kv counter). */
export async function countPublished() {
  return num((await getKv(['n_cf_posted'])).n_cf_posted);
}

// ---------- comments ----------

function toComment(r) {
  if (!r) return null;
  return {
    id: num(r.id), confessionId: num(r.confession_id), authorId: Number(r.author_id), body: r.body || '', hidden: num(r.hidden) === 1, createdAt: num(r.created_at),
  };
}

/** Adds a comment and returns the confession's new comment count. */
export async function addComment(confessionId, authorId, body) {
  await db.run(sql`
    INSERT INTO cf_comments (confession_id, author_id, body, created_at) VALUES (${confessionId}, ${authorId}, ${body}, ${nowSec()})`);
  const r = await db.run(sql`UPDATE confessions SET comments = comments + 1 WHERE id = ${confessionId} RETURNING comments`);
  return num(r.rows && r.rows[0] && r.rows[0].comments);
}

/** Visible comments, oldest first, `limit` from `offset`. */
export async function listComments(confessionId, offset, limit) {
  const rows = await db.all(sql`
    SELECT id, confession_id, author_id, body, hidden, created_at FROM cf_comments
    WHERE confession_id = ${confessionId} AND hidden = 0 ORDER BY id LIMIT ${limit} OFFSET ${offset}`);
  return rows.map(toComment);
}

export async function getComment(id) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  return toComment(await db.get(sql`
    SELECT id, confession_id, author_id, body, hidden, created_at FROM cf_comments WHERE id = ${Number(id)}`));
}

/** Hides a comment (a reviewer's decision); returns the confession's new count, or null if it was hidden already. */
export async function hideComment(id) {
  const c = await getComment(id);
  if (!c || c.hidden) return null;
  const r = await db.run(sql`UPDATE cf_comments SET hidden = 1 WHERE id = ${c.id} AND hidden = 0`);
  if (!r.rowsAffected) return null;
  const u = await db.run(sql`
    UPDATE confessions SET comments = max(0, comments - 1) WHERE id = ${c.confessionId} RETURNING comments`);
  return { confessionId: c.confessionId, count: num(u.rows && u.rows[0] && u.rows[0].comments) };
}

/** When this person last commented anywhere (the gap between comments). */
export async function lastCommentAt(authorId) {
  const r = await db.get(sql`
    SELECT created_at FROM cf_comments WHERE author_id = ${authorId} ORDER BY created_at DESC LIMIT 1`);
  return num(r && r.created_at);
}

/** The first report of a comment only reaches the reviewers (kv cfrep:<id>). */
export async function firstReport(commentId) {
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${`cfrep:${commentId}`}, ${String(nowSec())}) ON CONFLICT(key) DO NOTHING`);
  return r.rowsAffected > 0;
}
