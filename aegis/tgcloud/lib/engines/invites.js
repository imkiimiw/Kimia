/*
 * Invite links created through Aegis (aegis_invite_links). The Bot API can't list a chat's links, so
 * only these are shown; joins and join requests are counted from the invite_link Telegram reports
 * with each join (chat_member) and request (chat_join_request).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { INVITE_LINKS_MAX } from '../config.js';
import { nowSec } from '../core/util.js';

export async function add(chatId, link, byId) {
  const r = await db.run(sql`INSERT INTO aegis_invite_links (chat_id, link, name, created_by, created_at, expire_at, member_limit, requests)
    VALUES (${chatId}, ${link.invite_link}, ${link.name || null}, ${byId}, ${nowSec()}, ${link.expire_date || 0}, ${link.member_limit || 0},
    ${link.creates_join_request ? 1 : 0})
    ON CONFLICT(link) DO UPDATE SET name = excluded.name, expire_at = excluded.expire_at, member_limit = excluded.member_limit, requests = excluded.requests
    RETURNING id`);
  return Number(r.rows[0].id);
}

export const get = (id) => db.get(sql`SELECT * FROM aegis_invite_links WHERE id = ${id}`);

export async function list(chatId, { live = true } = {}) {
  if (live) {
    return db.all(sql`SELECT * FROM aegis_invite_links WHERE chat_id = ${chatId} AND revoked = 0 ORDER BY created_at DESC LIMIT ${INVITE_LINKS_MAX}`);
  }
  return db.all(sql`SELECT * FROM aegis_invite_links WHERE chat_id = ${chatId} ORDER BY created_at DESC LIMIT ${INVITE_LINKS_MAX}`);
}

export async function countLive(chatId) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_invite_links WHERE chat_id = ${chatId} AND revoked = 0`)).n);
}

export const isExpired = (row, now = nowSec()) => Number(row.expire_at) > 0 && Number(row.expire_at) <= now;

export async function update(id, link) {
  await db.run(sql`UPDATE aegis_invite_links SET name = ${link.name || null}, expire_at = ${link.expire_date || 0}, member_limit = ${link.member_limit || 0},
    requests = ${link.creates_join_request ? 1 : 0} WHERE id = ${id}`);
}

export async function markRevoked(id) {
  await db.run(sql`UPDATE aegis_invite_links SET revoked = 1 WHERE id = ${id}`);
}

/* A join or a request through one of Aegis's links (Telegram may show other links only in part). */
export async function count(chatId, inviteLink, field) {
  if (!inviteLink || !inviteLink.invite_link) return;
  if (field === 'joins') await db.run(sql`UPDATE aegis_invite_links SET joins = joins + 1 WHERE chat_id = ${chatId} AND link = ${inviteLink.invite_link}`);
  else await db.run(sql`UPDATE aegis_invite_links SET asked = asked + 1 WHERE chat_id = ${chatId} AND link = ${inviteLink.invite_link}`);
}

/* How a link reads in lists: its name, else the visible part of the link. */
export const label = (link) => (link && (link.name || link.invite_link)) || '';

export async function migrate(oldId, newId) {
  await db.run(sql`UPDATE aegis_invite_links SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
