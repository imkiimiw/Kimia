/*
 * The post archive of a channel (aegis_posts + aegis_post_versions: every edit kept as a version) and
 * the posts waiting to be published (aegis_post_queue): held for approval, or set for a later time.
 * Content is stored as { t, e, f } (lib/core/content.js), so a post can be published or put back
 * without the original message.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { POST_VERSIONS_MAX, POSTS_KEEP_SEC, POSTS_PAGE, QUEUE_PAGE } from '../config.js';
import { nowSec, parseJson } from '../core/util.js';

const pack = (c) => JSON.stringify({ t: c.t || '', e: c.e && c.e.length ? c.e : undefined, f: c.f || undefined });
export const unpack = (row) => parseJson(row && row.content, { t: '' }) || { t: '' };

/* ---------- archive ---------- */

export async function save(chatId, msgId, kind, c, { signature = null, album = null, viaAegis = false, at = nowSec() } = {}) {
  const r = await db.run(sql`INSERT INTO aegis_posts (chat_id, msg_id, kind, content, signature, album, via_aegis, posted_at)
    VALUES (${chatId}, ${msgId}, ${kind}, ${pack(c)}, ${signature}, ${album}, ${viaAegis ? 1 : 0}, ${at})
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET content = excluded.content RETURNING id`);
  return Number(r.rows[0].id);
}

export const get = (id) => db.get(sql`SELECT * FROM aegis_posts WHERE id = ${id}`);
export const byMsg = (chatId, msgId) => db.get(sql`SELECT * FROM aegis_posts WHERE chat_id = ${chatId} AND msg_id = ${msgId}`);

/* The current content becomes a version; `c` the new current content. source: edit, restore, revert. */
export async function newVersion(post, c, source) {
  const n = Number(post.versions);
  await db.run(sql`INSERT INTO aegis_post_versions (post_id, n, content, source, at) VALUES (${post.id}, ${n}, ${post.content}, ${source}, ${nowSec()})`);
  await db.run(sql`UPDATE aegis_posts SET content = ${pack(c)}, versions = ${n + 1}, edited_at = ${nowSec()} WHERE id = ${post.id}`);
  await db.run(sql`DELETE FROM aegis_post_versions WHERE post_id = ${post.id} AND n <= ${n - POST_VERSIONS_MAX}`);
}

export async function versions(postId) {
  return db.all(sql`SELECT * FROM aegis_post_versions WHERE post_id = ${postId} ORDER BY n DESC LIMIT ${POST_VERSIONS_MAX}`);
}

export const version = (postId, n) => db.get(sql`SELECT * FROM aegis_post_versions WHERE post_id = ${postId} AND n = ${n}`);

export async function recent(chatId, page = 0) {
  const total = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_posts WHERE chat_id = ${chatId}`)).n);
  const rows = await db.all(sql`SELECT * FROM aegis_posts WHERE chat_id = ${chatId} ORDER BY posted_at DESC, msg_id DESC LIMIT ${POSTS_PAGE}
    OFFSET ${page * POSTS_PAGE}`);
  return { total, rows };
}

export async function all(chatId, limit = 1000) {
  return db.all(sql`SELECT * FROM aegis_posts WHERE chat_id = ${chatId} ORDER BY msg_id LIMIT ${limit}`);
}

export async function lastMsgId(chatId) {
  const r = await db.get(sql`SELECT max(msg_id) AS m FROM aegis_posts WHERE chat_id = ${chatId}`);
  return r && r.m ? Number(r.m) : 0;
}

export async function forget(chatId, msgId) {
  const p = await byMsg(chatId, msgId);
  if (!p) return;
  await db.run(sql`DELETE FROM aegis_post_versions WHERE post_id = ${p.id}`);
  await db.run(sql`DELETE FROM aegis_posts WHERE id = ${p.id}`);
}

/* ---------- waiting posts ---------- */

export async function enqueue(chatId, kind, c, { options = {}, authorId = 0, origin = 'aegis', status = 'pending', publishAt = 0 } = {}) {
  const r = await db.run(sql`INSERT INTO aegis_post_queue (chat_id, kind, content, options, author_id, origin, status, publish_at, at)
    VALUES (${chatId}, ${kind}, ${pack(c)}, ${JSON.stringify(options)}, ${authorId}, ${origin}, ${status}, ${publishAt}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

export const item = (id) => db.get(sql`SELECT * FROM aegis_post_queue WHERE id = ${id}`);

export async function waiting(chatId, page = 0) {
  const total = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_post_queue WHERE chat_id = ${chatId} AND status IN ('pending', 'scheduled')`)).n);
  const rows = await db.all(sql`SELECT * FROM aegis_post_queue WHERE chat_id = ${chatId} AND status IN ('pending', 'scheduled')
    ORDER BY at DESC LIMIT ${QUEUE_PAGE} OFFSET ${page * QUEUE_PAGE}`);
  return { total, rows };
}

export async function countWaiting(chatId, status = null) {
  if (status) return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_post_queue WHERE chat_id = ${chatId} AND status = ${status}`)).n);
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_post_queue WHERE chat_id = ${chatId} AND status IN ('pending', 'scheduled')`)).n);
}

/* Moves an item from one status to another once. Gives true if this call did it. */
export async function claim(id, from, to, byId = 0) {
  const r = await db.run(sql`UPDATE aegis_post_queue SET status = ${to}, decided_by = ${byId}, decided_at = ${nowSec()} WHERE id = ${id} AND status = ${from}`);
  return r.rowsAffected > 0;
}

export async function finish(id, status, resultMsg = 0) {
  await db.run(sql`UPDATE aegis_post_queue SET status = ${status}, result_msg = ${resultMsg} WHERE id = ${id}`);
}

export async function setTime(id, publishAt) {
  await db.run(sql`UPDATE aegis_post_queue SET publish_at = ${publishAt} WHERE id = ${id}`);
}

export async function setOptions(id, options) {
  await db.run(sql`UPDATE aegis_post_queue SET options = ${JSON.stringify(options)} WHERE id = ${id}`);
}

export async function due(now, limit = 10) {
  return db.all(sql`SELECT * FROM aegis_post_queue WHERE status = 'scheduled' AND publish_at <= ${now} ORDER BY publish_at LIMIT ${limit}`);
}

export async function migrate(oldId, newId) {
  for (const t of ['aegis_posts', 'aegis_post_queue']) await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

export async function sweep(now) {
  const old = await db.all(sql`SELECT id FROM aegis_posts WHERE posted_at < ${now - POSTS_KEEP_SEC} ORDER BY posted_at LIMIT 200`);
  for (const p of old) {
    await db.run(sql`DELETE FROM aegis_post_versions WHERE post_id = ${p.id}`);
    await db.run(sql`DELETE FROM aegis_posts WHERE id = ${p.id}`);
  }
  await db.run(sql`DELETE FROM aegis_post_queue WHERE id IN (SELECT id FROM aegis_post_queue WHERE status IN ('published', 'rejected', 'failed')
    AND at < ${now - POSTS_KEEP_SEC} LIMIT 200)`);
  await db.run(sql`DELETE FROM aegis_post_queue WHERE id IN (SELECT id FROM aegis_post_queue WHERE status = 'draft' AND at < ${now - 86400} LIMIT 200)`);
  return old.length;
}
