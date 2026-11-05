/*
 * Federations: groups that share one ban list (aegis_feds, aegis_fed_chats, aegis_fed_admins,
 * aegis_fed_bans).
 *
 * A federation is created from a group's panel by that group's creator (or a Full admin), who
 * becomes its owner. Other groups join with the federation's join code — entered by their own
 * creator or a Full admin, so nobody can put a group into a federation without its admins. A
 * group is in at most one federation. The owner names federation admins (up to FED_MAX_ADMINS);
 * the owner and they may /fban and /unfban in any member group. A fed ban bans the person in every
 * member group at once, and again whenever they join or write in one (also groups that join later).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { FED_BAN_PAGE, FED_MAX_ADMINS, FED_MAX_CHATS, FED_NAME_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import { nowSec } from '../core/util.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let s = '';
  for (let i = 0; i < 12; i += 1) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export const get = (id) => db.get(sql`SELECT * FROM aegis_feds WHERE id = ${id}`);
export const byCode = (code) => db.get(sql`SELECT * FROM aegis_feds WHERE code = ${String(code).trim().toUpperCase()}`);

export async function ofChat(chatId) {
  const r = await db.get(sql`SELECT fed_id FROM aegis_fed_chats WHERE chat_id = ${chatId}`);
  return r ? get(Number(r.fed_id)) : null;
}

export async function chats(fedId) {
  return db.all(sql`SELECT f.chat_id, c.title, c.lang, c.active FROM aegis_fed_chats f LEFT JOIN aegis_chats c ON c.chat_id = f.chat_id
    WHERE f.fed_id = ${fedId} ORDER BY f.joined_at LIMIT ${FED_MAX_CHATS}`);
}

export async function chatCount(fedId) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_fed_chats WHERE fed_id = ${fedId}`)).n);
}

export async function admins(fedId) {
  return db.all(sql`SELECT user_id FROM aegis_fed_admins WHERE fed_id = ${fedId} ORDER BY added_at LIMIT ${FED_MAX_ADMINS}`);
}

/* The owner or a federation admin. */
export async function isAdmin(fed, userId) {
  if (!fed) return false;
  if (Number(fed.owner_id) === userId) return true;
  return !!(await db.get(sql`SELECT user_id FROM aegis_fed_admins WHERE fed_id = ${fed.id} AND user_id = ${userId}`));
}

export async function create(name, ownerId, chatId) {
  const clean = [...String(name).trim()].slice(0, FED_NAME_MAX).join('');
  let code = newCode();
  while (await byCode(code)) code = newCode();
  const r = await db.run(sql`INSERT INTO aegis_feds (name, owner_id, code, created_at) VALUES (${clean}, ${ownerId}, ${code}, ${nowSec()}) RETURNING id`);
  const id = Number(r.rows[0].id);
  await audit.log(ownerId, 'fed.create', { chatId, target: String(id), details: { name: clean } });
  await join(id, chatId, ownerId);
  return get(id);
}

/* Puts a chat into a federation. Gives 'ok', 'full' or 'other' (already in another one). */
export async function join(fedId, chatId, byId) {
  const cur = await db.get(sql`SELECT fed_id FROM aegis_fed_chats WHERE chat_id = ${chatId}`);
  if (cur) return Number(cur.fed_id) === fedId ? 'ok' : 'other';
  if (await chatCount(fedId) >= FED_MAX_CHATS) return 'full';
  await db.run(sql`INSERT INTO aegis_fed_chats (fed_id, chat_id, joined_by, joined_at) VALUES (${fedId}, ${chatId}, ${byId}, ${nowSec()})`);
  await audit.log(byId, 'fed.join', { chatId, target: String(fedId) });
  return 'ok';
}

export async function leave(chatId, byId) {
  const fed = await ofChat(chatId);
  if (!fed) return false;
  await db.run(sql`DELETE FROM aegis_fed_chats WHERE chat_id = ${chatId}`);
  await audit.log(byId, 'fed.leave', { chatId, target: String(fed.id) });
  return true;
}

export async function rename(fed, name, byId, chatId) {
  const clean = [...String(name).trim()].slice(0, FED_NAME_MAX).join('');
  await db.run(sql`UPDATE aegis_feds SET name = ${clean} WHERE id = ${fed.id}`);
  await audit.log(byId, 'fed.rename', { chatId, target: String(fed.id), details: { from: fed.name, to: clean } });
}

export async function newJoinCode(fed, byId, chatId) {
  let code = newCode();
  while (await byCode(code)) code = newCode();
  await db.run(sql`UPDATE aegis_feds SET code = ${code} WHERE id = ${fed.id}`);
  await audit.log(byId, 'fed.code', { chatId, target: String(fed.id) });
  return code;
}

/* Deletes a federation: its member list, admins and bans go with it (bans already done stay in Telegram). */
export async function remove(fed, byId, chatId) {
  for (const t of [sql`DELETE FROM aegis_fed_chats WHERE fed_id = ${fed.id}`, sql`DELETE FROM aegis_fed_admins WHERE fed_id = ${fed.id}`,
    sql`DELETE FROM aegis_fed_bans WHERE fed_id = ${fed.id}`, sql`DELETE FROM aegis_feds WHERE id = ${fed.id}`]) await db.run(t);
  await audit.log(byId, 'fed.delete', { chatId, target: String(fed.id), details: { name: fed.name } });
}

/* Gives 'ok', 'full' or 'exists'. */
export async function addAdmin(fed, userId, byId, chatId) {
  if (await isAdmin(fed, userId)) return 'exists';
  if ((await admins(fed.id)).length >= FED_MAX_ADMINS) return 'full';
  await db.run(sql`INSERT INTO aegis_fed_admins (fed_id, user_id, added_by, added_at) VALUES (${fed.id}, ${userId}, ${byId}, ${nowSec()})`);
  await audit.log(byId, 'fed.admin_add', { chatId, target: userId, details: { fed: Number(fed.id) } });
  return 'ok';
}

export async function removeAdmin(fed, userId, byId, chatId) {
  const r = await db.run(sql`DELETE FROM aegis_fed_admins WHERE fed_id = ${fed.id} AND user_id = ${userId}`);
  if (r.rowsAffected) await audit.log(byId, 'fed.admin_remove', { chatId, target: userId, details: { fed: Number(fed.id) } });
  return r.rowsAffected > 0;
}

/* ---------- bans ---------- */

export const banOf = (fedId, userId) => db.get(sql`SELECT * FROM aegis_fed_bans WHERE fed_id = ${fedId} AND user_id = ${userId}`);

export async function ban(fed, userId, name, reason, byId, chatId) {
  await db.run(sql`INSERT INTO aegis_fed_bans (fed_id, user_id, name, reason, by_id, at) VALUES (${fed.id}, ${userId}, ${name || null}, ${reason || null}, ${byId}, ${nowSec()})
    ON CONFLICT(fed_id, user_id) DO UPDATE SET name = excluded.name, reason = excluded.reason, by_id = excluded.by_id, at = excluded.at`);
  await audit.log(byId, 'fed.ban', { chatId, target: userId, details: { fed: Number(fed.id), reason: reason || null } });
}

export async function unban(fed, userId, byId, chatId) {
  const r = await db.run(sql`DELETE FROM aegis_fed_bans WHERE fed_id = ${fed.id} AND user_id = ${userId}`);
  if (r.rowsAffected) await audit.log(byId, 'fed.unban', { chatId, target: userId, details: { fed: Number(fed.id) } });
  return r.rowsAffected > 0;
}

export async function bans(fedId, p) {
  const total = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_fed_bans WHERE fed_id = ${fedId}`)).n);
  const rows = await db.all(sql`SELECT * FROM aegis_fed_bans WHERE fed_id = ${fedId} ORDER BY at DESC LIMIT ${FED_BAN_PAGE} OFFSET ${p * FED_BAN_PAGE}`);
  return { rows, total };
}

export async function allBans(fedId, limit) {
  return db.all(sql`SELECT * FROM aegis_fed_bans WHERE fed_id = ${fedId} ORDER BY at LIMIT ${limit}`);
}

/* A group became a supergroup: its federation membership moves with it. */
export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_fed_chats WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_fed_chats SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
