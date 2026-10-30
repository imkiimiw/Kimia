/*
 * Moderation in the group itself: commands, notices with an undo button, the group-side buttons
 * (pu:<id> undo a punishment, bt:<id>:v|r answer an anti-betrayal incident), and what Aegis does
 * when members are banned, unbanned or join (chat_member).
 *
 * Who may use a command (re-checked live with getChatMember every time):
 *   the creator — everything;
 *   an admin with at least view access — warn, unwarn, warns; with Telegram's "ban users"
 *     (can_restrict_members) also mute, restrict, kick, ban and lifting them;
 *   a member of the «mod» list (not an admin) — warn, unwarn, warns, mute, unmute.
 * Anyone else is ignored without an answer: ordinary members are never blocked or answered.
 * Never a target: the creator and admins (Telegram doesn't let a bot restrict them), Aegis itself,
 * the person giving the command, VIP-list members (remove them from the list first), and — for a
 * «mod» — another «mod».
 * Notices (settings notify) go to the group with an undo button; with notices off they go to the
 * person's private chat.
 */
import { me } from '../core/bot.js';
import { parseArgs, parseModCommand } from '../core/modparse.js';
import { answer, btn, describeError, send, tryCall } from '../core/tg.js';
import { fullName, iso, parseJson, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as betrayal from '../engines/betrayal.js';
import * as chats from '../engines/chats.js';
import * as lists from '../engines/lists.js';
import * as punish from '../engines/punish.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, pickLang, t } from '../i18n/index.js';
import * as enforce from './enforce.js';
import * as security from './security.js';
import { ensureChat, register } from './group.js';

const MOD_ALLOWED = new Set(['warn', 'unwarn', 'warns', 'mute', 'unmute']);
const NEEDS_RESTRICT = new Set(['mute', 'unmute', 'restrict', 'unrestrict', 'kick', 'ban', 'unban']);
const SUPERGROUP_ONLY = new Set(['mute', 'unmute', 'restrict', 'unrestrict']);
const PUNISHING = new Set(['warn', 'mute', 'restrict', 'kick', 'ban']);
const isAdminStatus = (s) => s === 'creator' || s === 'administrator';
const inChat = (m) => !!m && (['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member === true));

/* The person's moderation role in `chat`, live: { role: creator | admin | mod, level, restrict, member } or null. */
export async function roleOf(ctx, chat, userId) {
  const acc = await admins.liveAccess(ctx, chat.chat_id, userId);
  const m = acc.member;
  if (!m) return null;
  if (m.status === 'creator') return { role: 'creator', level: acc.level, restrict: true, member: m };
  if (m.status === 'administrator') {
    if (acc.level < admins.L.view) return null;
    return { role: 'admin', level: acc.level, restrict: m.can_restrict_members === true, member: m };
  }
  if (await lists.has(chat.chat_id, 'mod', String(userId))) return { role: 'mod', level: 0, restrict: false, member: m };
  return null;
}

export function mayUse(role, cmd) {
  if (!role) return false;
  if (role.role === 'creator') return true;
  if (role.role === 'mod') return MOD_ALLOWED.has(cmd);
  return !NEEDS_RESTRICT.has(cmd) || role.restrict;
}

/* May `role` undo punishment `row`? (Restoring a demoted admin needs the right to manage admins.) */
export function mayUndo(role, row) {
  if (!role) return false;
  if (role.role === 'creator') return true;
  if (row.kind === 'demote') return role.role === 'admin' && admins.canManageAdmins({ level: role.level, member: role.member });
  if (role.role === 'mod') return row.kind === 'warn' || row.kind === 'mute';
  return row.kind === 'warn' || role.restrict;
}

const replyTo = (message) => ({ reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });

/* The message really replied to (in a forum topic every message "replies" to the topic's first message). */
function realReply(message) {
  const r = message.reply_to_message;
  if (!r || r.forum_topic_created) return null;
  if (message.is_topic_message && r.message_id === message.message_thread_id) return null;
  return r;
}

/* ---------- notices ---------- */

function noticeLines(lang, res, targetName, actorName) {
  const row = res.row;
  const sec = Number(row.until) ? Number(row.until) - Number(row.created_at) : 0;
  const lines = [t(lang, res.auditOnly ? 'pun.notice_audit' : 'pun.notice', {
    icon: t(lang, `pun.icon_${row.kind}`), kind: t(lang, `pun.k_${row.kind}`), target: iso(targetName),
  })];
  lines.push(t(lang, 'pun.notice_by', { actor: actorName ? iso(actorName) : t(lang, 'log.system') }));
  if (punish.TIMED.has(row.kind)) lines.push(t(lang, 'pun.notice_time', { time: sec ? dur(lang, sec) : t(lang, 'pun.forever') }));
  if (row.reason) lines.push(t(lang, 'pun.notice_reason', { reason: iso(row.reason, 200) }));
  if (row.kind === 'warn' && res.count) lines.push(t(lang, 'pun.notice_count', { n: res.count, max: res.max }));
  const step = res.stepResult;
  if (step) {
    const vars = { icon: t(lang, `pun.icon_${res.step.a}`), kind: t(lang, `pun.k_${res.step.a}`), time: res.step.d ? dur(lang, res.step.d) : t(lang, 'pun.forever') };
    if (!step.ok) lines.push(t(lang, 'pun.notice_step_failed', { ...vars, error: iso(step.error, 80) }));
    else lines.push(t(lang, step.auditOnly ? 'pun.notice_step_audit' : (res.step.a === 'kick' ? 'pun.notice_step_kick' : 'pun.notice_step'), vars));
  }
  return lines;
}

function noticeButtons(lang, res) {
  const row = [];
  if (!res.auditOnly && res.row.kind !== 'kick') row.push(btn(t(lang, 'pun.btn_undo'), `pu:${res.id}`));
  const step = res.stepResult;
  if (step && step.ok && !step.auditOnly && res.step.a !== 'kick') row.push(btn(t(lang, 'pun.btn_undo_step', { kind: t(lang, `pun.k_${res.step.a}`) }), `pu:${step.id}`));
  return row.length ? [row] : null;
}

/* Posts a punishment notice: to the group, or (notices off) to the person who gave the command. */
export async function notice(ctx, chat, res, targetName, actorId, message = null) {
  if (ctx.quiet) return null;
  const s = await settings.all(ctx, chat.chat_id);
  const actorName = actorId ? await users.displayName(actorId) : null;
  if (settings.flag(s, 'notify') && chat.type !== 'channel') {
    const extra = message ? replyTo(message) : {};
    return send(ctx, chat.chat_id, noticeLines(chat.lang, res, targetName, actorName).join('\n'), noticeButtons(chat.lang, res), `notice-${res.row.kind}`, extra);
  }
  if (!actorId) return null;
  const u = await users.get(actorId);
  if (!u || !Number(u.started) || Number(u.blocked)) return null;
  const head = t(u.lang, 'pun.private_head', { title: iso(chat.title || String(chat.chat_id), 40) });
  return send(ctx, actorId, [head, ...noticeLines(u.lang, res, targetName, actorName)].join('\n'), noticeButtons(u.lang, res), `notice-${res.row.kind}-pm`);
}

/* ---------- commands ---------- */

/* A moderation command in a group message. Gives true when the message was one (handled). */
export async function handle(ctx, message) {
  const parsed = parseModCommand(message.text);
  if (!parsed) return false;
  const tgChat = message.chat;
  if (parsed.mention && parsed.mention !== String((await me(ctx)).username).toLowerCase()) return true;
  let args = parsed.args;
  let target = null;
  const tm = (message.entities || []).find((e) => e.type === 'text_mention' && e.user);
  if (tm) {
    const cut = `${message.text.slice(0, tm.offset)} ${message.text.slice(tm.offset + tm.length)}`;
    const again = parseModCommand(cut);
    if (again) args = again.args;
    target = { id: tm.user.id, user: tm.user };
  }
  const a = parseArgs(parsed.cmd, args);
  if (!target && a.target) target = a.target;
  const reply = realReply(message);
  if (!target && reply) {
    if (reply.sender_chat) target = { chat: reply.sender_chat };
    else if (reply.from) target = { id: reply.from.id, user: reply.from };
  }
  if (!target && !parsed.slash) return false; /* a plain word without a target: ordinary chat */
  if (message.sender_chat) {
    if (message.sender_chat.id === tgChat.id) {
      const known = await chats.get(tgChat.id);
      await send(ctx, tgChat.id, t(known ? known.lang : 'en', 'group.anon_admin'), null, 'mod-anon', replyTo(message));
    }
    return true;
  }
  const from = message.from;
  if (!from || from.is_bot) return true;
  let chat = await ensureChat(ctx, tgChat);
  if (!chat) return true;
  const role = await roleOf(ctx, chat, from.id);
  if (!role) return true; /* ordinary members: no answer */
  await users.remember(from);
  if (!Number(chat.registered)) chat = await register(ctx, chat, null);
  const lang = chat.lang;
  const say = (key, vars = {}, rows = null) => send(ctx, tgChat.id, t(lang, key, vars), rows, `mod-${parsed.cmd}`, replyTo(message));
  const cmd = parsed.cmd;
  if (!mayUse(role, cmd)) {
    await say(role.role === 'mod' ? 'mod.mod_cant' : 'mod.need_restrict');
    return true;
  }
  if (SUPERGROUP_ONLY.has(cmd) && chat.type !== 'supergroup') {
    await say('mod.basic_group');
    return true;
  }
  if (NEEDS_RESTRICT.has(cmd) && parseJson(chat.bot_rights, {}).can_restrict_members !== true) {
    await say('mod.bot_cant');
    return true;
  }
  if (!target) {
    await say('mod.usage', { cmd });
    return true;
  }
  if (target.chat) {
    await say('mod.t_channel');
    return true;
  }
  if (target.username) {
    const known = await users.byUsername(target.username);
    if (!known) {
      await say('mod.t_unknown', { name: iso(`@${target.username}`) });
      return true;
    }
    target = { id: Number(known.user_id) };
  }
  if (a.badDuration) {
    await say('mod.bad_duration');
    return true;
  }
  const uid = target.id;
  const bot = await me(ctx);
  if (uid === bot.id) {
    await say('mod.t_bot_self');
    return true;
  }
  const member = await tryCall(ctx, 'getChatMember', { chat_id: chat.chat_id, user_id: uid }, 'mod-target');
  if (!member) {
    await say('mod.t_unknown', { name: iso(String(uid)) });
    return true;
  }
  await users.remember(member.user);
  const name = fullName(member.user) || (target.user ? fullName(target.user) : String(uid));
  const vars = { target: iso(name) };
  if (cmd === 'warns') return showWarns(ctx, chat, message, uid, name);
  if (uid === from.id) {
    await say('mod.t_self');
    return true;
  }
  if (isAdminStatus(member.status)) {
    await say('mod.t_admin', vars);
    return true;
  }
  if (PUNISHING.has(cmd)) {
    if (await lists.has(chat.chat_id, 'vip', String(uid))) {
      await say('mod.t_vip', vars);
      return true;
    }
    if (role.role === 'mod' && await lists.has(chat.chat_id, 'mod', String(uid))) {
      await say('mod.t_mod', vars);
      return true;
    }
  }
  if (cmd === 'unwarn') {
    const r = await punish.removeLastWarning(ctx, chat, uid, from.id);
    if (r === 'none') await say('mod.no_warns', vars);
    else if (r && r.error) await say('mod.tg_error', { error: iso(r.error, 120) });
    else await say('mod.unwarned', { ...vars, n: await punish.warnCount(ctx, chat.chat_id, uid) });
    return true;
  }
  if (punish.LIFTS[cmd]) {
    const r = await punish.lift(ctx, chat, uid, punish.LIFTS[cmd], from.id);
    if (r && r.error) await say('mod.tg_error', { error: iso(r.error, 120) });
    else await say(`mod.done_${cmd}`, { ...vars, actor: iso(fullName(from)) });
    return true;
  }
  const res = await punish.apply(ctx, chat, { userId: uid, name, kind: cmd, sec: a.sec || 0, reason: a.reason, actorId: from.id, source: 'command' });
  if (!res.ok) {
    await say('mod.tg_error', { error: iso(res.error, 120) });
    return true;
  }
  const sent = await notice(ctx, chat, res, name, from.id, message);
  if (sent && sent.message_id) await punish.setNotice(res.id, sent.message_id);
  if (cmd === 'ban' || cmd === 'kick') await betrayal.after(ctx, chat, from.id, uid, 'ban');
  return true;
}

async function showWarns(ctx, chat, message, uid, name) {
  const lang = chat.lang;
  const s = await settings.all(ctx, chat.chat_id);
  const n = await punish.warnCount(ctx, chat.chat_id, uid);
  const ladder = settings.steps(s);
  const lines = [t(lang, 'mod.warns', { target: iso(name), n, max: ladder[ladder.length - 1].n })];
  const rows = (await punish.warningsOf(chat.chat_id, uid, 5)).filter((r) => r.status === 'active');
  for (const r of rows) lines.push(t(lang, 'mod.warns_item', { reason: r.reason ? iso(r.reason, 80) : '—' }));
  await send(ctx, chat.chat_id, lines.join('\n'), null, 'mod-warns', replyTo(message));
  return true;
}

/* ---------- buttons in the group (and in private chats and the log channel) ---------- */

async function dropButton(ctx, msg, data) {
  if (!msg || !msg.reply_markup || !Array.isArray(msg.reply_markup.inline_keyboard)) return;
  const rows = msg.reply_markup.inline_keyboard.map((r) => r.filter((b) => b.callback_data !== data)).filter((r) => r.length);
  await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: rows } }, 'drop-button');
}

async function langOf(from) {
  const u = await users.get(from.id);
  return u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
}

/* pu:<id> and bt:<id>:v|r, pressed anywhere. Authorization is live, in the punishment's chat. */
export async function callback(ctx, cq, parts) {
  const from = cq.from;
  const msg = cq.message;
  const lang = await langOf(from);
  const id = toInt(parts[1]);
  if (parts[0] === 'pu') {
    const row = id ? await punish.get(id) : null;
    const chat = row ? await chats.get(Number(row.chat_id)) : null;
    if (!row || !chat || !Number(chat.active)) return answer(ctx, t(lang, 'pun.undo_gone'), true);
    const role = await roleOf(ctx, chat, from.id);
    if (!mayUndo(role, row)) return answer(ctx, t(lang, 'pun.undo_denied'), true);
    const r = await punish.undo(ctx, chat, id, from.id);
    if (r && r.error) return answer(ctx, t(lang, 'pun.undo_failed', { error: r.error }), true);
    if (r === 'not_undoable') return answer(ctx, t(lang, 'pun.undo_kick'), true);
    await dropButton(ctx, msg, cq.data);
    if (r !== 'ok') return answer(ctx, t(lang, r === 'gone' ? 'pun.undo_gone' : 'pun.undo_not_active'), true);
    await answer(ctx, t(lang, 'pun.undo_done'));
    if (msg && msg.chat && msg.chat.id === Number(chat.chat_id)) {
      const target = await users.displayName(Number(row.user_id));
      await send(ctx, chat.chat_id, t(chat.lang, 'pun.undone_notice', { kind: t(chat.lang, `pun.k_${row.kind}`), target: iso(target), actor: iso(fullName(from)) }),
        null, 'undone', { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
    }
    return null;
  }
  const incident = id ? await betrayal.get(id) : null;
  const chat = incident ? await chats.get(Number(incident.chat_id)) : null;
  if (!incident || !chat || !Number(chat.active)) return answer(ctx, t(lang, 'pun.undo_gone'), true);
  const role = await roleOf(ctx, chat, from.id);
  const full = !!role && (role.role === 'creator' || (role.role === 'admin' && role.level >= admins.L.full));
  if (parts[2] === 'v') {
    if (!full || !role.restrict) return answer(ctx, t(lang, 'betray.denied'), true);
    const r = await betrayal.freeVictims(ctx, chat, incident, from.id);
    await dropButton(ctx, msg, cq.data);
    if (r === 'done') return answer(ctx, t(lang, 'betray.already'), true);
    return answer(ctx, t(lang, 'betray.freed', { n: r.n, failed: r.failed }), true);
  }
  if (parts[2] === 'r') {
    if (!full || !mayUndo(role, { kind: 'demote' })) return answer(ctx, t(lang, 'betray.denied'), true);
    const r = await betrayal.restore(ctx, chat, incident, from.id);
    if (r && r.error) return answer(ctx, t(lang, 'pun.undo_failed', { error: r.error }), true);
    await dropButton(ctx, msg, cq.data);
    return answer(ctx, t(lang, r === 'ok' ? 'betray.restored' : 'betray.already'), true);
  }
  return null;
}

/* ---------- chat_member: bans, unbans and joins ---------- */

export async function onMemberChange(ctx, upd) {
  const before = upd.old_chat_member || {};
  const after = upd.new_chat_member || {};
  const target = after.user;
  if (!target || !upd.chat) return;
  const chat = await chats.get(upd.chat.id);
  if (!chat || !Number(chat.active) || !Number(chat.registered)) return;
  const bot = await me(ctx);
  if (target.id === bot.id) return;
  const actorId = upd.from ? upd.from.id : 0;
  const byPerson = !!actorId && actorId !== bot.id && actorId !== target.id;
  await enforce.memberChange(chat.chat_id, target, inChat(before), inChat(after));
  if (byPerson && after.status === 'kicked' && before.status !== 'kicked') {
    await users.remember(target);
    if (upd.from && !upd.from.is_bot) await users.remember(upd.from);
    await punish.recordOutside(ctx, chat, { userId: target.id, name: fullName(target), until: Number(after.until_date) || 0, actorId });
    await betrayal.after(ctx, chat, actorId, target.id, 'ban');
    return;
  }
  if (byPerson && before.status === 'kicked' && after.status !== 'kicked') {
    await punish.closeOutside(chat, target.id, ['ban'], actorId);
    return;
  }
  if (byPerson && isAdminStatus(before.status) && !isAdminStatus(after.status) && after.status !== 'left') {
    await betrayal.after(ctx, chat, actorId, target.id, 'demote');
    return;
  }
  if (!inChat(before) && inChat(after) && actorId !== bot.id && !(await onJoin(ctx, chat, target))) await security.onJoin(ctx, chat, target);
}

/* Someone joined: a blacklisted member is banned again (Audit Mode: only reported). */
/* Gives true when the newcomer was dealt with (banned again), so the security checks can skip them. */
async function onJoin(ctx, chat, user) {
  if (isAdminStatus((await admins.getRow(chat.chat_id, user.id) || {}).status)) return true;
  if (!(await lists.has(chat.chat_id, 'blk', String(user.id)))) return false;
  if (await lists.has(chat.chat_id, 'vip', String(user.id))) return false;
  const name = fullName(user);
  await users.remember(user);
  const res = await punish.apply(ctx, chat, { userId: user.id, name, kind: 'blacklist', sec: 0, reason: t(chat.lang, 'pun.blacklist_reason'), actorId: 0, source: 'blacklist' });
  if (res.ok) await notice(ctx, chat, res, name, 0);
  return res.ok && !res.auditOnly;
}
