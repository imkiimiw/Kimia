/*
 * What Aegis says in groups and channels, and in the private chat of whoever changed its status:
 *
 * - Added (my_chat_member → member/administrator): the chat is registered, the admin list is read,
 *   and at once a warning goes to the group (in the chat's language) and to the adding admin's
 *   private chat (in theirs): Telegram lets a bot edit or demote only admins it promoted itself, so
 *   admins must be appointed through Aegis's panel; the required rights with ✅/❌; admins already
 *   appointed outside Aegis. Buttons: open the private panel, grant the missing rights. In a
 *   channel nothing is posted (it would go to every subscriber): only the private message.
 * - The bot's rights changed: a short notice (what's missing now, or all fine).
 * - «پیکربندی» / config in a group (admins only): a button to that group's private panel.
 * - Reminder about admins not appointed through Aegis: right after such an admin appears (at most
 *   every REMINDER_EVENT_GAP_SEC), and on group activity at most every REMINDER_INTERVAL_SEC while
 *   any remain (switchable in the panel). The panel always shows them.
 * While the bot is shut down (ctx.quiet) everything is recorded but nothing is sent.
 */
import { ADMIN_CACHE_SEC, REMINDER_EVENT_GAP_SEC, REMINDER_INTERVAL_SEC } from '../config.js';
import * as audit from '../core/audit.js';
import { btn, me, send, tryCall, urlBtn } from '../core/tg.js';
import { fullName, iso, nowSec, parseJson } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import { deepLinkRights, REQUIRED } from '../engines/rights.js';
import * as users from '../engines/users.js';
import { t } from '../i18n/index.js';
import * as channel from './channel.js';

export const panelLink = (bot, chatId) => `https://t.me/${bot}?start=c_${chatId}`;
export const grantLink = (bot, chat) => (chat.type === 'channel'
  ? `https://t.me/${bot}?startchannel&admin=${deepLinkRights('channel')}`
  : `https://t.me/${bot}?startgroup=aegis&admin=${deepLinkRights(chat.type)}`);

const rowName = (r) => r.first_name || (r.username ? `@${r.username}` : String(r.user_id));

/* "✅ Delete messages" … for the required rights; `missing` is a list of required ids. */
export function rightsLines(lang, missing) {
  const miss = new Set(missing || []);
  return REQUIRED.map((it) => t(lang, 'group.right_line', { mark: miss.has(it.id) ? '❌' : '✅', name: t(lang, `rights.req_${it.id}`) }));
}

/* The list of admins Aegis can't manage, as lines (at most 10, then "…and N more"). */
export function notViaAegisLines(lang, rows) {
  const lines = rows.slice(0, 10).map((r) => t(lang, Number(r.is_bot) ? 'group.non_aegis_bot' : 'group.non_aegis_item', { name: iso(rowName(r)) }));
  if (rows.length > 10) lines.push(t(lang, 'group.more', { n: rows.length - 10 }));
  return lines;
}

async function nonAegisRows(ctx, chat) {
  if (Number(chat.admins_at) < nowSec() - ADMIN_CACHE_SEC) await admins.refresh(ctx, chat.chat_id);
  return admins.notViaAegis(await admins.listRows(chat.chat_id), (await me(ctx)).id);
}

function warningText(lang, chat, missing, nonAegis) {
  const lines = [t(lang, 'group.added_title', { title: iso(chat.title || '', 48) }), '', t(lang, 'group.rule'), '', t(lang, 'group.perms_title')];
  lines.push(...rightsLines(lang, missing));
  lines.push(t(lang, missing.length ? 'group.perms_missing' : 'group.perms_ok', { n: missing.length }));
  if (chat.type === 'group') lines.push('', t(lang, 'group.basic_group'));
  if (nonAegis.length) lines.push('', t(lang, 'group.non_aegis_title', { n: nonAegis.length }), ...notViaAegisLines(lang, nonAegis), t(lang, 'group.non_aegis_hint'));
  return lines.join('\n');
}

async function warningRows(ctx, lang, chat, missing, inPrivate) {
  const bot = (await me(ctx)).username;
  const open = inPrivate ? btn(t(lang, 'group.btn_panel'), `g:${chat.chat_id}`) : urlBtn(t(lang, 'group.btn_panel'), panelLink(bot, chat.chat_id));
  const rows = [[open]];
  if (missing.length) rows.push([urlBtn(t(lang, 'group.btn_grant'), grantLink(bot, chat))]);
  return rows;
}

/* The warning, to the group (not a channel) and to the person who added the bot. */
async function sendWarning(ctx, chat, actor, missing) {
  const nonAegis = await nonAegisRows(ctx, chat);
  if (chat.type !== 'channel') {
    await send(ctx, chat.chat_id, warningText(chat.lang, chat, missing, nonAegis), await warningRows(ctx, chat.lang, chat, missing, false), 'group-added');
    await chats.claimReminder(chat.chat_id, nowSec(), 0);
  }
  if (!actor || actor.is_bot) return;
  const u = await users.get(actor.id);
  if (!u || !Number(u.started) || Number(u.blocked)) return;
  await send(ctx, actor.id, warningText(u.lang, chat, missing, nonAegis), await warningRows(ctx, u.lang, chat, missing, true), 'group-added-pm');
}

/*
 * Registers a chat: reads its admins, logs it, and (unless quiet) sends the warning. Used when the
 * bot is added, and for chats the bot was in before they were registered.
 */
export async function register(ctx, chat, actor) {
  await chats.markRegistered(chat.chat_id);
  await admins.refresh(ctx, chat.chat_id);
  await audit.log(actor ? actor.id : 0, 'chat.registered', { chatId: chat.chat_id, target: chat.type });
  const fresh = await chats.get(chat.chat_id);
  if (!ctx.quiet) await sendWarning(ctx, fresh, actor, parseJson(fresh.missing, []));
  return fresh;
}

/* my_chat_member in a group/supergroup/channel. */
export async function onBotMembership(ctx, upd, lang) {
  const before = await chats.get(upd.chat.id);
  const r = await chats.onBotMembership(ctx, upd, lang);
  const chatId = upd.chat.id;
  if (!r.active) {
    if (r.wasActive) await channel.botAlert(ctx, before, [], true);
    await chats.unregister(chatId);
    return;
  }
  const { prev, missing } = await chats.setBotRights(chatId, upd.chat.type, upd.new_chat_member);
  const chat = await chats.get(chatId);
  const actor = upd.from && !upd.from.is_bot ? upd.from : null;
  if (!r.wasActive || !Number(chat.registered)) {
    await register(ctx, chat, actor);
    return;
  }
  if (JSON.stringify(prev) === JSON.stringify(missing)) return;
  await audit.log(actor ? actor.id : 0, 'chat.rights', { chatId, details: { missing } });
  if (ctx.quiet) return;
  if (chat.type === 'channel') {
    /* the owner hears about it, unless they made the change themselves (they get the notice below) */
    const creator = (await admins.listRows(chatId)).find((r) => r.status === 'creator');
    if (!actor || !creator || Number(creator.user_id) !== actor.id) await channel.botAlert(ctx, chat, missing);
  }
  const notice = (l) => [t(l, missing.length ? 'group.rights_changed_missing' : 'group.rights_changed_ok', { n: missing.length }), ...rightsLines(l, missing)].join('\n');
  const bot = (await me(ctx)).username;
  if (chat.type !== 'channel') {
    const rows = missing.length ? [[urlBtn(t(chat.lang, 'group.btn_grant'), grantLink(bot, chat))]] : null;
    await send(ctx, chatId, notice(chat.lang), rows, 'group-rights');
  }
  if (actor) {
    const u = await users.get(actor.id);
    if (u && Number(u.started) && !Number(u.blocked)) await send(ctx, actor.id, notice(u.lang), [[btn(t(u.lang, 'group.btn_panel'), `g:${chatId}`)]], 'group-rights-pm');
  }
}

/* A chat the bot is in but has no row for (it was there before Aegis tracked chats). */
export async function ensureChat(ctx, tgChat) {
  const known = await chats.get(tgChat.id);
  if (known) return known;
  const bot = await me(ctx);
  const member = await tryCall(ctx, 'getChatMember', { chat_id: tgChat.id, user_id: bot.id }, 'bot-member');
  if (!member) return null;
  await chats.onBotMembership(ctx, { chat: tgChat, from: null, new_chat_member: member }, 'en');
  await chats.setBotRights(tgChat.id, tgChat.type, member);
  return chats.get(tgChat.id);
}

/* «پیکربندی» / config in a group: a button to this group's private panel (admins only). */
export async function configInGroup(ctx, message) {
  const tgChat = message.chat;
  let chat = await ensureChat(ctx, tgChat);
  if (!chat) return;
  const reply = { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } };
  if (message.sender_chat && message.sender_chat.id === tgChat.id) {
    await send(ctx, tgChat.id, t(chat.lang, 'group.anon_admin'), null, 'config-anon', reply);
    return;
  }
  const from = message.from;
  const acc = await admins.liveAccess(ctx, tgChat.id, from.id);
  if (!acc.member || !['creator', 'administrator'].includes(acc.member.status)) return; /* ordinary members: no answer */
  if (!Number(chat.registered)) chat = await register(ctx, chat, null);
  if (acc.level < admins.L.view) {
    await send(ctx, tgChat.id, t(chat.lang, 'group.config_no_access', { name: iso(fullName(from)) }), null, 'config-no-access', reply);
    return;
  }
  const bot = (await me(ctx)).username;
  await send(ctx, tgChat.id, t(chat.lang, 'group.config_reply', { name: iso(fullName(from)) }), [[urlBtn(t(chat.lang, 'group.btn_panel'), panelLink(bot, tgChat.id))]],
    'config-link', reply);
}

/* The reminder about admins Aegis can't manage. event: right after one appeared (shorter gap). */
export async function reminder(ctx, chat, { event = false } = {}) {
  if (ctx.quiet || chat.type === 'channel' || !Number(chat.reminder) || !Number(chat.registered)) return false;
  const gap = event ? REMINDER_EVENT_GAP_SEC : REMINDER_INTERVAL_SEC;
  if (Number(chat.reminded_at) > nowSec() - gap) return false;
  const rows = await nonAegisRows(ctx, chat);
  if (!rows.length) return false;
  if (!(await chats.claimReminder(chat.chat_id, nowSec(), gap))) return false;
  const lang = chat.lang;
  const text = [t(lang, 'group.non_aegis_title', { n: rows.length }), ...notViaAegisLines(lang, rows), '', t(lang, 'group.reminder_body')].join('\n');
  const bot = (await me(ctx)).username;
  await send(ctx, chat.chat_id, text, [[urlBtn(t(lang, 'group.btn_panel'), panelLink(bot, chat.chat_id))]], 'group-reminder');
  return true;
}

/* chat_member: someone's admin status changed. Keeps the cache, logs changes made outside Aegis. */
export async function onMemberChange(ctx, upd) {
  const before = upd.old_chat_member || {};
  const after = upd.new_chat_member || {};
  const wasAdmin = before.status === 'creator' || before.status === 'administrator';
  const isAdmin = after.status === 'creator' || after.status === 'administrator';
  if (!wasAdmin && !isAdmin) return;
  const chat = await chats.get(upd.chat.id);
  if (!chat || !Number(chat.active)) return;
  const bot = await me(ctx);
  if (after.user && after.user.id === bot.id) return; /* the bot itself: my_chat_member */
  await admins.cacheMember(chat.chat_id, after);
  const actorId = upd.from ? upd.from.id : 0;
  if (actorId !== bot.id) {
    await audit.log(actorId, 'admin.outside', { chatId: chat.chat_id, target: after.user.id, details: { from: before.status, to: after.status } });
  }
  if (isAdmin && after.status === 'administrator' && !after.can_be_edited) await reminder(ctx, chat, { event: true });
}

/* Any message in a registered group: the occasional reminder rides on it. */
export async function onActivity(ctx, chat) {
  if (!Number(chat.registered) || !Number(chat.reminder)) return;
  if (Number(chat.reminded_at) > nowSec() - REMINDER_INTERVAL_SEC) return;
  await reminder(ctx, chat);
}
