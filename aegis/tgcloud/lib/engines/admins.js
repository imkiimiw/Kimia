/*
 * Chat admins and Aegis access.
 *
 * Admin cache (aegis_chat_admins): refreshed from getChatAdministrators (on registration, when older
 * than ADMIN_CACHE_SEC, on «Re-check»), from chat_member updates and from every live getChatMember
 * re-check. via_aegis = can_be_edited: Telegram lets a bot edit or demote only the admins it promoted.
 *
 * Access levels: 0 none · 1 view (read only) · 2 settings (change settings) · 3 full (also admins and
 * access) · 4 creator. Only Telegram admins have access. Without a manual level (aegis_access) it
 * follows their Telegram rights: creator → 4; "add new admins" → full; "change chat info" →
 * settings; any other admin → view; bots → none.
 *
 * Re-checks: every panel action re-reads the person's status with getChatMember. Someone who is no
 * longer an admin loses their cached row and manual level at once (former-admin revocation, logged).
 *
 * Anti-escalation: managing admins needs level full and Telegram's "add new admins" right (or being
 * the creator). Nobody can grant rights they don't have themselves (or the bot doesn't have), touch
 * the creator, or edit/demote an Aegis admin of equal or higher level they didn't promote.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as audit from '../core/audit.js';
import { call, describeError } from '../core/tg.js';
import { nowSec, parseJson } from '../core/util.js';
import { demoteParams, grantable, isAdminStatus, promoteParams, rightsOf } from './rights.js';

export const L = { none: 0, view: 1, settings: 2, full: 3, creator: 4 };
export const LEVEL_NAMES = ['none', 'view', 'settings', 'full', 'creator'];

export function defaultLevel(member) {
  if (!member || !isAdminStatus(member.status)) return L.none;
  if (member.status === 'creator') return L.creator;
  if (member.user && member.user.is_bot) return L.none;
  if (member.can_promote_members) return L.full;
  if (member.can_change_info) return L.settings;
  return L.view;
}

/* A cached row back into the ChatMember shape the rules use. */
export function memberOfRow(row) {
  if (!row) return null;
  return {
    status: row.status,
    user: { id: Number(row.user_id), is_bot: !!Number(row.is_bot), first_name: row.first_name, username: row.username },
    can_be_edited: !!Number(row.via_aegis),
    ...parseJson(row.rights, {}),
  };
}

export async function getRow(chatId, userId) {
  return db.get(sql`SELECT * FROM aegis_chat_admins WHERE chat_id = ${chatId} AND user_id = ${userId}`);
}

export async function listRows(chatId) {
  return db.all(sql`SELECT * FROM aegis_chat_admins WHERE chat_id = ${chatId} ORDER BY CASE status WHEN 'creator' THEN 0 ELSE 1 END, user_id LIMIT 200`);
}

export async function overrideOf(chatId, userId) {
  const r = await db.get(sql`SELECT level FROM aegis_access WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  return r ? Number(r.level) : null;
}

export async function overrides(chatId) {
  const rows = await db.all(sql`SELECT user_id, level, set_by FROM aegis_access WHERE chat_id = ${chatId} LIMIT 200`);
  const out = new Map();
  for (const r of rows) out.set(Number(r.user_id), { level: Number(r.level), setBy: Number(r.set_by) });
  return out;
}

export function effectiveLevel(member, override) {
  const base = defaultLevel(member);
  if (base === L.none || base === L.creator) return base;
  return override === null || override === undefined ? base : override;
}

/* The user stopped being an admin: drop the cached row and any manual level; logged if they had one. */
export async function revoke(chatId, userId, reason) {
  const hadRow = await getRow(chatId, userId);
  const hadLevel = await overrideOf(chatId, userId);
  await db.run(sql`DELETE FROM aegis_chat_admins WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  await db.run(sql`DELETE FROM aegis_access WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  if (hadRow) await audit.log(0, 'access.revoked', { chatId, target: userId, details: { reason, level: hadLevel } });
  return !!hadRow;
}

/* Stores one ChatMember: an admin is upserted, anyone else is revoked. */
export async function cacheMember(chatId, member) {
  const u = member && member.user;
  if (!u) return;
  if (!isAdminStatus(member.status)) {
    await revoke(chatId, u.id, member.status || 'left');
    return;
  }
  await db.run(sql`INSERT INTO aegis_chat_admins (chat_id, user_id, status, via_aegis, is_bot, rights, first_name, username, updated_at)
    VALUES (${chatId}, ${u.id}, ${member.status}, ${member.can_be_edited ? 1 : 0}, ${u.is_bot ? 1 : 0}, ${JSON.stringify(rightsOf(member))},
      ${u.first_name || null}, ${u.username || null}, ${nowSec()})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET status = excluded.status, via_aegis = excluded.via_aegis, is_bot = excluded.is_bot,
      rights = excluded.rights, first_name = excluded.first_name, username = excluded.username, updated_at = excluded.updated_at`);
}

/* Re-reads the whole admin list. Former admins are revoked. Gives the ChatMember list, or null. */
export async function refresh(ctx, chatId) {
  let list;
  try {
    list = await call(ctx, 'getChatAdministrators', { chat_id: chatId }, 'admins');
  } catch (err) {
    console.warn(`getChatAdministrators ${chatId}: ${describeError(err)}`);
    return null;
  }
  const ids = new Set();
  for (const m of list) {
    ids.add(m.user.id);
    await cacheMember(chatId, m);
  }
  for (const r of await listRows(chatId)) if (!ids.has(Number(r.user_id))) await revoke(chatId, Number(r.user_id), 'not_admin');
  await db.run(sql`UPDATE aegis_chats SET admins_at = ${nowSec()} WHERE chat_id = ${chatId}`);
  return list;
}

/*
 * The person's live status in the chat (getChatMember), cached, with their access level.
 * { member, level } — level 0 also when Telegram can't be asked (then member is null).
 */
export async function liveAccess(ctx, chatId, userId) {
  let member;
  try {
    member = await call(ctx, 'getChatMember', { chat_id: chatId, user_id: userId }, 'access-check');
  } catch (err) {
    console.warn(`getChatMember ${chatId}/${userId}: ${describeError(err)}`);
    return { member: null, level: L.none };
  }
  await cacheMember(chatId, member);
  if (!isAdminStatus(member.status)) return { member, level: L.none };
  return { member, level: effectiveLevel(member, await overrideOf(chatId, userId)) };
}

/* Chats (registered, bot present) where the user is a cached admin with at least view access. */
export async function chatsOf(userId) {
  const rows = await db.all(sql`SELECT c.chat_id, c.type, c.title, c.username, a.status, a.rights, a.is_bot, a.via_aegis, a.user_id, a.first_name,
      x.level AS override
    FROM aegis_chat_admins a JOIN aegis_chats c ON c.chat_id = a.chat_id
    LEFT JOIN aegis_access x ON x.chat_id = a.chat_id AND x.user_id = a.user_id
    WHERE a.user_id = ${userId} AND c.active = 1 AND c.registered = 1 ORDER BY c.title LIMIT 200`);
  const out = [];
  for (const r of rows) {
    const level = effectiveLevel(memberOfRow(r), r.override === null ? null : Number(r.override));
    if (level >= L.view) out.push({ chatId: Number(r.chat_id), type: r.type, title: r.title, level });
  }
  return out;
}

/* Admins Telegram won't let Aegis edit (promoted by someone else), apart from the creator and Aegis. */
export const notViaAegis = (rows, botId) => rows.filter((r) => r.status === 'administrator' && !Number(r.via_aegis) && Number(r.user_id) !== botId);

/* Who promoted `userId` through Aegis most recently (0 if nobody did). */
export async function promoterOf(chatId, userId) {
  const r = await db.get(sql`SELECT actor_id FROM aegis_promotions WHERE chat_id = ${chatId} AND user_id = ${userId} AND kind = 'promote'
    ORDER BY at DESC, id DESC LIMIT 1`);
  return r ? Number(r.actor_id) : 0;
}

/* ---------- rules (pure) ---------- */

/* Telegram itself requires the person to be the creator or hold "add new admins". */
export const canManageAdmins = (actor) => actor.level === L.creator || (actor.level >= L.full && !!actor.member && actor.member.can_promote_members === true);

/* Rights `actor` may hand out in a chat: grantable ∩ what the bot has ∩ what the actor has. */
export function grantableBy(chatType, actor, botRights) {
  const mine = actor.level === L.creator ? null : rightsOf(actor.member);
  return grantable(chatType).filter((r) => botRights[r] === true && (mine === null || mine[r] === true));
}

/*
 * May `actor` ({ id, level, member }) edit or demote `target` ({ member, level, promoter })?
 * Gives null when allowed, else a reason code.
 */
export function manageBlock(actor, target) {
  if (!canManageAdmins(actor)) return 'no_rights';
  if (!target.member || target.member.status === 'creator') return 'creator';
  if (target.member.status !== 'administrator') return 'not_admin';
  if (!target.member.can_be_edited) return 'not_via_aegis';
  if (actor.level === L.creator) return null;
  if (target.promoter === actor.id) return null;
  if (target.level >= actor.level) return 'higher';
  return null;
}

/* May someone at `actorLevel` move a person from `current` to `next` (null = back to the default)? */
export function canSetLevel(actorLevel, current, next, targetIsCreator) {
  if (targetIsCreator) return false;
  if (actorLevel === L.creator) return next === null || next <= L.full;
  if (actorLevel === L.full) return current < L.full && (next === null || next < L.full);
  return false;
}

/* ---------- changes ---------- */

export async function setLevel(chatId, userId, level, actorId) {
  const before = await overrideOf(chatId, userId);
  if (level === null) await db.run(sql`DELETE FROM aegis_access WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  else {
    await db.run(sql`INSERT INTO aegis_access (chat_id, user_id, level, set_by, set_at) VALUES (${chatId}, ${userId}, ${level}, ${actorId}, ${nowSec()})
      ON CONFLICT(chat_id, user_id) DO UPDATE SET level = excluded.level, set_by = excluded.set_by, set_at = excluded.set_at`);
  }
  await audit.log(actorId, 'access.set', { chatId, target: userId, details: { from: before, to: level } });
}

async function record(chatId, userId, actorId, kind, rights) {
  await db.run(sql`INSERT INTO aegis_promotions (chat_id, user_id, actor_id, kind, rights, at)
    VALUES (${chatId}, ${userId}, ${actorId}, ${kind}, ${rights ? JSON.stringify(rights) : null}, ${nowSec()})`);
}

/*
 * Promotes `targetId` (or edits an Aegis admin's rights) to exactly `chosen`. Throws the Bot API
 * error when Telegram refuses. kind: 'promote' | 'edit'.
 */
export async function applyRights(ctx, chat, actorId, targetId, chosen, kind) {
  await call(ctx, 'promoteChatMember', { chat_id: chat.chat_id, user_id: targetId, ...promoteParams(chat.type, chosen) }, `admin-${kind}`);
  await record(chat.chat_id, targetId, actorId, kind, chosen);
  await audit.log(actorId, `admin.${kind}`, { chatId: chat.chat_id, target: targetId, details: { rights: chosen } });
  try {
    await cacheMember(chat.chat_id, await call(ctx, 'getChatMember', { chat_id: chat.chat_id, user_id: targetId }, 'admin-reread'));
  } catch (err) {
    console.warn(`re-read after ${kind}: ${describeError(err)}`);
  }
}

/* Demotes an Aegis admin to a plain member; their access goes with it. Throws when Telegram refuses. */
export async function demote(ctx, chat, actorId, targetId) {
  await call(ctx, 'promoteChatMember', { chat_id: chat.chat_id, user_id: targetId, ...demoteParams(chat.type) }, 'admin-demote');
  await record(chat.chat_id, targetId, actorId, 'demote', null);
  await audit.log(actorId, 'admin.demote', { chatId: chat.chat_id, target: targetId });
  await revoke(chat.chat_id, targetId, 'demoted');
}

/* A group became a supergroup: admin cache, levels and promotion history move with it. */
export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_chat_admins WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_chat_admins SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`DELETE FROM aegis_access WHERE chat_id = ${newId} AND user_id IN (SELECT user_id FROM aegis_access WHERE chat_id = ${oldId})`);
  await db.run(sql`UPDATE aegis_access SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_promotions SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
