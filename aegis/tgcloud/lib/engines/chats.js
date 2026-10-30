/*
 * Groups and channels the bot is in (aegis_chats), kept from my_chat_member updates: membership,
 * type, title, member count, the bot's own rights and the per-chat settings.
 * - member_count is cached and refreshed lazily with getChatMemberCount (stats view, joining).
 * - bot_rights / missing: the bot's rights and the required ones it lacks (engines/rights.js).
 * - registered: Aegis set the chat up (sent the warning, read the admins) — engines in ui/group.js.
 * - A group upgraded to a supergroup gets a new id (migrate_to_chat_id): the row, its admin cache,
 *   access levels and promotion history move with it.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { MEMBER_COUNT_TTL_SEC } from '../config.js';
import * as audit from '../core/audit.js';
import { call, describeError, isApiError } from '../core/tg.js';
import { nowSec, parseJson } from '../core/util.js';
import * as admins from './admins.js';
import { missingRequired, rightsOf } from './rights.js';

const ACTIVE = new Set(['member', 'administrator', 'creator', 'restricted']);
export const isGroupType = (type) => type === 'group' || type === 'supergroup';
export const isTracked = (type) => isGroupType(type) || type === 'channel';

export async function get(chatId) {
  return db.get(sql`SELECT * FROM aegis_chats WHERE chat_id = ${chatId}`);
}

async function refreshCount(ctx, chatId) {
  try {
    const n = await call(ctx, 'getChatMemberCount', { chat_id: chatId }, 'member-count');
    await db.run(sql`UPDATE aegis_chats SET member_count = ${Number(n) || 0}, count_at = ${nowSec()} WHERE chat_id = ${chatId}`);
    return true;
  } catch (err) {
    if (isApiError(err) && (err.code === 403 || /chat not found/i.test(err.description))) await setInactive(chatId, 'left');
    else await db.run(sql`UPDATE aegis_chats SET count_at = ${nowSec()} WHERE chat_id = ${chatId}`);
    console.warn(`getChatMemberCount ${chatId}: ${describeError(err)}`);
    return false;
  }
}

/*
 * The bot's own membership changed in a group/supergroup/channel (my_chat_member).
 * `lang`: the language of the user who made the change, used for a newly added chat.
 */
export async function onBotMembership(ctx, upd, lang) {
  const chat = upd.chat;
  const status = upd.new_chat_member && upd.new_chat_member.status;
  const active = ACTIVE.has(status) && !(status === 'restricted' && upd.new_chat_member.is_member === false) ? 1 : 0;
  const actor = upd.from ? upd.from.id : 0;
  const now = nowSec();
  const before = await get(chat.id);
  const wasActive = !!(before && Number(before.active));
  await db.run(sql`INSERT INTO aegis_chats (chat_id, type, title, username, bot_status, active, lang, added_by, joined_at, updated_at)
    VALUES (${chat.id}, ${chat.type}, ${chat.title || null}, ${chat.username || null}, ${status}, ${active}, ${lang}, ${active ? actor : 0},
      ${active ? now : 0}, ${now})
    ON CONFLICT(chat_id) DO UPDATE SET type = excluded.type, title = excluded.title, username = excluded.username,
      bot_status = excluded.bot_status, active = excluded.active, updated_at = excluded.updated_at,
      added_by = CASE WHEN excluded.active = 1 AND aegis_chats.active = 0 THEN excluded.added_by ELSE aegis_chats.added_by END,
      joined_at = CASE WHEN excluded.active = 1 AND aegis_chats.active = 0 THEN excluded.joined_at ELSE aegis_chats.joined_at END`);
  if (active && !wasActive) {
    await audit.log(actor, 'chat.added', { chatId: chat.id, target: chat.type, details: { status } });
    await refreshCount(ctx, chat.id);
  } else if (!active && wasActive) {
    await audit.log(actor, 'chat.removed', { chatId: chat.id, target: chat.type, details: { status } });
  }
  return { wasActive, active: !!active };
}

/* A group became a supergroup: its row (and everything keyed by the chat) moves to the new id. */
export async function migrate(oldId, newId) {
  const old = await get(oldId);
  if (!old) return;
  if (await get(newId)) {
    await db.run(sql`UPDATE aegis_chats SET lang = ${old.lang}, reminder = ${old.reminder}, registered = MAX(registered, ${old.registered}),
      added_by = CASE WHEN added_by = 0 THEN ${old.added_by} ELSE added_by END WHERE chat_id = ${newId}`);
    await db.run(sql`DELETE FROM aegis_chats WHERE chat_id = ${oldId}`);
  } else {
    await db.run(sql`UPDATE aegis_chats SET chat_id = ${newId}, type = 'supergroup', updated_at = ${nowSec()} WHERE chat_id = ${oldId}`);
  }
  await admins.migrate(oldId, newId);
  await audit.log(0, 'chat.migrated', { chatId: newId, target: String(oldId) });
}

/* Stores the bot's own rights in a chat. Gives { prev, missing } (lists of required right ids). */
export async function setBotRights(chatId, chatType, member) {
  const before = await get(chatId);
  const prev = parseJson(before && before.missing, null);
  const missing = missingRequired(chatType, member);
  await db.run(sql`UPDATE aegis_chats SET bot_rights = ${JSON.stringify(rightsOf(member))}, missing = ${JSON.stringify(missing)},
    rights_at = ${nowSec()} WHERE chat_id = ${chatId}`);
  return { prev, missing };
}

/* True the first time a chat is registered (and again after the bot was removed and re-added). */
export async function markRegistered(chatId) {
  const r = await db.run(sql`UPDATE aegis_chats SET registered = 1, registered_at = ${nowSec()} WHERE chat_id = ${chatId} AND registered = 0`);
  return r.rowsAffected > 0;
}

export async function unregister(chatId) {
  await db.run(sql`UPDATE aegis_chats SET registered = 0 WHERE chat_id = ${chatId}`);
}

export async function setLang(chatId, lang) {
  await db.run(sql`UPDATE aegis_chats SET lang = ${lang}, updated_at = ${nowSec()} WHERE chat_id = ${chatId}`);
}

export async function setReminder(chatId, on) {
  await db.run(sql`UPDATE aegis_chats SET reminder = ${on ? 1 : 0}, updated_at = ${nowSec()} WHERE chat_id = ${chatId}`);
}

/* True for one caller when the chat's last reminder is at least `gap` seconds old. */
export async function claimReminder(chatId, now, gap) {
  const r = await db.run(sql`UPDATE aegis_chats SET reminded_at = ${now} WHERE chat_id = ${chatId} AND reminder = 1 AND reminded_at <= ${now - gap}`);
  return r.rowsAffected > 0;
}

export async function countRegistered() {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_chats WHERE active = 1 AND registered = 1`)).n);
}

export async function setInactive(chatId, status = 'left') {
  await db.run(sql`UPDATE aegis_chats SET active = 0, bot_status = ${status}, updated_at = ${nowSec()} WHERE chat_id = ${chatId} AND active = 1`);
}

/* Refreshes up to `limit` stale member counts within `budgetMs`. Gives how many are still stale. */
export async function refreshStaleCounts(ctx, limit, budgetMs) {
  const start = Date.now();
  const stale = await db.all(sql`SELECT chat_id FROM aegis_chats WHERE active = 1 AND count_at < ${nowSec() - MEMBER_COUNT_TTL_SEC}
    ORDER BY count_at LIMIT ${limit}`);
  for (const r of stale) {
    if (Date.now() - start > budgetMs) break;
    await refreshCount(ctx, Number(r.chat_id));
  }
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_chats WHERE active = 1 AND count_at < ${nowSec() - MEMBER_COUNT_TTL_SEC}`)).n);
}

export async function counts() {
  const r = await db.get(sql`SELECT
      COALESCE(SUM(CASE WHEN type IN ('group', 'supergroup') THEN 1 ELSE 0 END), 0) AS groups,
      COALESCE(SUM(CASE WHEN type = 'channel' THEN 1 ELSE 0 END), 0) AS channels,
      COALESCE(SUM(member_count), 0) AS members
    FROM aegis_chats WHERE active = 1`);
  return { groups: Number(r.groups), channels: Number(r.channels), members: Number(r.members) };
}

const audienceTypes = (audience) => (audience === 'channels' ? sql`type = 'channel'` : sql`type IN ('group', 'supergroup')`);

/* Broadcast recipients among the chats, after `cursor` (by chat_id). */
export async function audienceAfter(audience, cursor, limit) {
  const rows = await db.all(sql`SELECT chat_id FROM aegis_chats WHERE active = 1 AND ${audienceTypes(audience)} AND chat_id > ${cursor}
    ORDER BY chat_id LIMIT ${limit}`);
  return rows.map((r) => Number(r.chat_id));
}

export async function countAudience(audience) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_chats WHERE active = 1 AND ${audienceTypes(audience)}`)).n);
}
