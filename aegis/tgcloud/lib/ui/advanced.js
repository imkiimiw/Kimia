/*
 * Advanced group settings at work (Phase 6), in the group itself:
 *
 * service(): every service message — forum topics are remembered; members added by someone count
 *   for «forced add»; a bot added → alert (bot_alert); a renamed group → the locked title is put back
 *   (title_lock); the linked channel's posts are kept, unpinned or deleted (linked); join, leave,
 *   pin, title/photo and video-chat notices are deleted as chosen.
 * onMessage() (after locks and security; admins, Aegis, the anonymous admin and VIP/trusted members
 *   are exempt): late edits (edit_window), read-only topics, forced join of the group's channels,
 *   forced add, Aegis slow mode, min/max characters, max lines, max mentions, CAPS, junk, other
 *   bots' messages — each deletes the message with one rolling notice; then «@admin» calls the
 *   admins, name changes are announced, and message ids are kept for scheduled cleanup and
 *   self-destructing media.
 * command(): /rules /report /admins /mywarns (or their words), and anonymous admins' moderation
 *   commands, confirmed by a real admin pressing a button.
 * service(): bots added by members are removed (bot_kick) or reported (bot_alert).
 * onJoin()/onLeave(): welcome, goodbye, event channel.
 * sweep() (at most once a minute, any update): self-destructing messages, the night lock and
 *   scheduled cleanup — there is no scheduler, so they happen on the first update after their time.
 * Audit Mode: rules that delete or punish by themselves only record and log.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { ADMIN_CALL_GAP_SEC, FJ_CACHE_SEC, REPORT_ADMINS_MAX, REPORT_GAP_SEC } from '../config.js';
import * as audit from '../core/audit.js';
import { me } from '../core/bot.js';
import { inWindow, localMinutes, nextTime, tzOf } from '../core/clock.js';
import { parseModCommand } from '../core/modparse.js';
import { answer, btn, send, tryCall, urlBtn } from '../core/tg.js';
import { esc, fullName, iso, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import * as events from '../engines/events.js';
import * as gd from '../engines/groupdata.js';
import * as guards from '../engines/guards.js';
import * as lists from '../engines/lists.js';
import * as logs from '../engines/logs.js';
import * as msglog from '../engines/msglog.js';
import * as punish from '../engines/punish.js';
import * as schedules from '../engines/schedules.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { pickLang, t, wordCommand } from '../i18n/index.js';
import { deleteMessage, isAdmin, postNotice } from './enforce.js';
import * as security from './security.js';
import { goodbye, welcome } from './welcome.js';

export const HEADS = new Set(['fj', 'rp', 'an']);
export { welcome };
const SERVICE_KEYS = {
  new_chat_members: 'del_join', left_chat_member: 'del_leave', pinned_message: 'del_pin', new_chat_title: 'del_chatinfo', new_chat_photo: 'del_chatinfo',
  delete_chat_photo: 'del_chatinfo', video_chat_started: 'del_videochat', video_chat_ended: 'del_videochat', video_chat_scheduled: 'del_videochat',
  video_chat_participants_invited: 'del_videochat',
};
/* Group messages of Aegis that self-destructing notices never remove. */
const KEEP_VIEWS = new Set(['captcha', 'raid-alert', 'sec-emergency', 'sec-readonly', 'adv-night', 'welcome', 'group-added', 'group-rights', 'betrayal']);
const flag = (s, k) => settings.flag(s, k);
const auditOn = (s) => settings.flag(s, 'audit');
const msgLink = (chatId, msgId) => `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${msgId}`;
const inChat = (m) => !!m && (['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member === true));

async function exempt(chatId, userId) {
  return (await isAdmin(chatId, userId)) || (await lists.has(chatId, 'vip', String(userId))) || (await lists.has(chatId, 'tru', String(userId)));
}

async function creatorAndAdmins(chatId) {
  const rows = await admins.listRows(chatId);
  return rows.filter((r) => !Number(r.is_bot)).map((r) => Number(r.user_id));
}

/* To the admins: the log channel (security), or the creator's private chat. */
async function tellAdmins(ctx, chat, text, rows = null) {
  const s = await settings.all(ctx, chat.chat_id);
  if (s.log_chat !== '0' && flag(s, 'log_on')) {
    await logs.post(ctx, chat, 'security', text, rows);
    return;
  }
  const creator = (await admins.listRows(chat.chat_id)).find((r) => r.status === 'creator');
  const u = creator ? await users.get(Number(creator.user_id)) : null;
  if (u && Number(u.started) && !Number(u.blocked)) {
    await send(ctx, Number(u.user_id), `${t(u.lang, 'logs.header', { title: iso(chat.title || '', 40) })}\n${text}`, rows, 'adv-admins-pm');
  }
}

/* ---------- service messages ---------- */

export async function service(ctx, chat, message, { deleted = false } = {}) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel') return false;
  const c = chat.chat_id;
  const s = await settings.all(ctx, c);
  const bot = await me(ctx);
  if (message.chat && message.chat.is_forum && !Number(chat.is_forum)) await db.run(sql`UPDATE aegis_chats SET is_forum = 1 WHERE chat_id = ${c}`);
  const thread = message.message_thread_id;
  if (message.forum_topic_created) await gd.saveTopic(c, thread, { name: message.forum_topic_created.name, color: message.forum_topic_created.icon_color });
  else if (message.forum_topic_edited && message.forum_topic_edited.name) await gd.saveTopic(c, thread, { name: message.forum_topic_edited.name });
  else if (message.forum_topic_closed) await gd.saveTopic(c, thread, { closed: true });
  else if (message.forum_topic_reopened) await gd.saveTopic(c, thread, { closed: false });
  else if (message.is_topic_message && thread) await gd.saveTopic(c, thread, {});
  if (Array.isArray(message.new_chat_members) && message.from) {
    const added = message.new_chat_members.filter((u) => !u.is_bot && u.id !== message.from.id);
    if (added.length) await gd.addAdds(c, message.from.id, added.length);
    const bots = message.new_chat_members.filter((u) => u.is_bot && u.id !== bot.id);
    const vars = { user: iso(fullName(message.from)), bots: bots.map((b) => iso(b.username ? `@${b.username}` : fullName(b))).join(', ') };
    if (bots.length && flag(s, 'bot_kick') && !(await isAdmin(c, message.from.id))) {
      /* a bot added by a member is removed (banned, so the member can't add it back); admins may add bots */
      if (!auditOn(s)) for (const b of bots) await tryCall(ctx, 'banChatMember', { chat_id: c, user_id: b.id }, 'bot-kick');
      await tellAdmins(ctx, chat, t(chat.lang, auditOn(s) ? 'adv.bot_kick_audit' : 'adv.bot_kicked', vars));
    } else if (bots.length && flag(s, 'bot_alert')) await tellAdmins(ctx, chat, t(chat.lang, 'adv.bot_added', vars));
  }
  if (message.new_chat_title && flag(s, 'title_lock') && s.title_locked && message.from && message.from.id !== bot.id && message.new_chat_title !== s.title_locked) {
    if (!auditOn(s)) await tryCall(ctx, 'setChatTitle', { chat_id: c, title: s.title_locked }, 'title-restore');
    await tellAdmins(ctx, chat, t(chat.lang, auditOn(s) ? 'adv.title_changed_audit' : 'adv.title_restored', { user: iso(fullName(message.from)), title: iso(message.new_chat_title, 60),
      locked: iso(s.title_locked, 60) }));
  }
  if (message.is_automatic_forward && s.linked !== 'keep') {
    if (s.linked === 'unpin') await tryCall(ctx, 'unpinChatMessage', { chat_id: c, message_id: message.message_id }, 'linked-unpin');
    else if (!deleted) return deleteMessage(ctx, c, message.message_id, 'linked-delete');
  }
  if (deleted) return true;
  const key = Object.keys(SERVICE_KEYS).find((k) => message[k] !== undefined && message[k] !== null);
  if (key && flag(s, SERVICE_KEYS[key])) return deleteMessage(ctx, c, message.message_id, `service-${SERVICE_KEYS[key]}`);
  if (key && (flag(s, 'clean_on'))) await msglog.add(c, message.message_id, message.from ? message.from.id : 0, 'service');
  return false;
}

/* ---------- member messages ---------- */

async function stop(ctx, chat, message, user, key, vars = {}, rows = null) {
  const s = await settings.all(ctx, chat.chat_id);
  if (auditOn(s)) {
    await logs.post(ctx, chat, 'locks', t(chat.lang, 'adv.log_audit', { user: iso(fullName(user)), rule: t(chat.lang, `adv.rule_${key}`) }));
    return false;
  }
  const deleted = await deleteMessage(ctx, chat.chat_id, message.message_id, `adv-${key}`);
  if (!ctx.quiet) await postNotice(ctx, chat, t(chat.lang, `adv.stop_${key}`, { user: iso(fullName(user)), ...vars }), rows);
  await logs.post(ctx, chat, 'locks', t(chat.lang, 'adv.log_deleted', { user: iso(fullName(user)), rule: t(chat.lang, `adv.rule_${key}`) }));
  return deleted;
}

/* Forced join: is the member in every channel of the list? (A channel where Aegis can't check is skipped.) */
async function fjMissing(ctx, chatId, userId, list) {
  const missing = [];
  for (const ch of list) {
    const m = await tryCall(ctx, 'getChatMember', { chat_id: ch.id, user_id: userId }, 'fj-check');
    if (m && !inChat(m)) missing.push(ch);
  }
  return missing;
}

const fjRows = (lang, chatId, list) => [...list.filter((ch) => ch.url).map((ch) => [urlBtn(t(lang, 'adv.btn_fj_join', { title: short(ch.title || ch.username || '', 30) }), ch.url)]),
  [btn(t(lang, 'adv.btn_fj_check'), `fj:${chatId}`)]];

const LETTERS = /\p{L}/gu;

export async function onMessage(ctx, chat, message, { edited = false } = {}) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel') return false;
  const c = chat.chat_id;
  const user = message.from;
  if (!user || message.sender_chat) return false;
  const bot = await me(ctx);
  if (user.id === bot.id) return false;
  const s = await settings.all(ctx, c);
  const text = typeof message.text === 'string' ? message.text : (message.caption || '');
  const isMedia = !!(message.photo || message.video || message.animation || message.document || message.sticker || message.voice || message.video_note || message.audio);
  if (await exempt(c, user.id)) return false;
  if (user.is_bot) return flag(s, 'del_bots') ? stop(ctx, chat, message, user, 'bots') : false;
  if (edited) {
    const window = Number(s.edit_window);
    if (window && Number(message.edit_date) - Number(message.date) > window) return stop(ctx, chat, message, user, 'edit', { time: window / 60 });
    return false;
  }
  if (message.is_topic_message && message.message_thread_id) {
    const tp = await gd.topic(c, message.message_thread_id);
    if (tp && Number(tp.readonly)) return stop(ctx, chat, message, user, 'topic', { topic: iso(tp.name, 40) });
  }
  const fj = parseJson(s.fj_chats, []) || [];
  if (fj.length) {
    const fl = await gd.flags(c, user.id);
    if (Number(fl.fj_ok_at) < nowSec() - FJ_CACHE_SEC) {
      const missing = await fjMissing(ctx, c, user.id, fj);
      if (missing.length) return stop(ctx, chat, message, user, 'fj', { n: missing.length }, fjRows(chat.lang, c, missing));
      await gd.setFjOk(c, user.id);
    }
  }
  const need = Number(s.fa_n);
  if (need) {
    const fl = await gd.flags(c, user.id);
    if (Number(fl.adds) < need) return stop(ctx, chat, message, user, 'fa', { n: need - Number(fl.adds), total: need });
  }
  const slow = Number(s.slow);
  if (slow) {
    /* a stopped message doesn't restart the wait (as in Telegram's own slow mode) */
    const prev = Number((await gd.flags(c, user.id)).last_at);
    if (prev && nowSec() - prev < slow) return stop(ctx, chat, message, user, 'slow', { time: slow });
    await gd.touchLast(c, user.id);
  }
  const chars = [...text].length;
  if (Number(s.min_len) && typeof message.text === 'string' && chars < Number(s.min_len)) return stop(ctx, chat, message, user, 'min', { n: Number(s.min_len) });
  if (Number(s.max_len) && chars > Number(s.max_len)) return stop(ctx, chat, message, user, 'max', { n: Number(s.max_len) });
  if (Number(s.max_lines) && text.split('\n').length > Number(s.max_lines)) return stop(ctx, chat, message, user, 'lines', { n: Number(s.max_lines) });
  const ents = message.entities || message.caption_entities || [];
  const mentions = ents.filter((e) => e.type === 'mention' || e.type === 'text_mention').length;
  if (Number(s.max_mentions) && mentions > Number(s.max_mentions)) return stop(ctx, chat, message, user, 'mentions', { n: Number(s.max_mentions) });
  if (flag(s, 'caps')) {
    const latin = text.match(/[A-Za-z]/g) || [];
    const upper = text.match(/[A-Z]/g) || [];
    if (latin.length >= 10 && upper.length / latin.length >= 0.7) return stop(ctx, chat, message, user, 'caps');
  }
  if (flag(s, 'junk') && typeof message.text === 'string' && message.text.trim() && !(message.text.match(LETTERS) || []).length
    && !/[\p{N}\p{Extended_Pictographic}]/u.test(message.text)) return stop(ctx, chat, message, user, 'junk');
  if (flag(s, 'admin_call') && /(^|\s)@(admins?|ادمین|ادمین\u200Cها|админ|админы)(\s|$)/iu.test(text)) await callAdmins(ctx, chat, message, user);
  if (flag(s, 'name_watch')) await watchName(ctx, chat, user);
  const ttl = Number(s.media_ttl);
  if (flag(s, 'clean_on') || (ttl && isMedia)) await msglog.add(c, message.message_id, user.id, isMedia ? 'media' : 'text', ttl && isMedia ? nowSec() + ttl : 0);
  return false;
}

async function callAdmins(ctx, chat, message, user) {
  const c = chat.chat_id;
  const now = nowSec();
  const r = await db.run(sql`UPDATE aegis_chats SET admin_call_at = ${now} WHERE chat_id = ${c} AND admin_call_at < ${now - ADMIN_CALL_GAP_SEC}`);
  if (!r.rowsAffected) return;
  const link = chat.type === 'supergroup' ? msgLink(c, message.message_id) : null;
  let n = 0;
  for (const id of (await creatorAndAdmins(c)).slice(0, REPORT_ADMINS_MAX)) {
    const u = await users.get(id);
    if (!u || !Number(u.started) || Number(u.blocked)) continue;
    const rows = link ? [[urlBtn(t(u.lang, 'adv.btn_open_message'), link)]] : null;
    if (await send(ctx, id, t(u.lang, 'adv.admin_called_pm', { user: iso(fullName(user)), title: iso(chat.title || '', 48), text: iso(message.text || '', 200) }), rows, 'admin-call-pm')) n += 1;
  }
  await send(ctx, c, t(chat.lang, n ? 'adv.admin_called' : 'adv.admin_called_none', { user: iso(fullName(user)) }), null, 'admin-call',
    { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
}

async function watchName(ctx, chat, user) {
  const before = await users.get(user.id);
  await users.remember(user);
  if (!before) return;
  const oldName = [before.first_name, before.last_name].filter(Boolean).join(' ');
  const newName = fullName(user);
  const oldU = before.username || '';
  const newU = user.username || '';
  if (oldName === newName && oldU.toLowerCase() === newU.toLowerCase()) return;
  const text = t(chat.lang, 'adv.name_changed', { old: iso(`${oldName}${oldU ? ` @${oldU}` : ''}`, 60), now: iso(`${newName}${newU ? ` @${newU}` : ''}`, 60), id: String(user.id) });
  if (!(await events.post(ctx, chat, 'names', text))) await logs.post(ctx, chat, 'security', text);
}

/* ---------- commands ---------- */

const MEMBER_CMDS = ['rules', 'report', 'admins', 'mywarns'];

export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 500) return null;
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) return MEMBER_CMDS.includes(m[1].toLowerCase()) ? { cmd: m[1].toLowerCase(), args: tokens.slice(1), mention: m[2] ? m[2].toLowerCase() : null } : null;
  for (let n = Math.min(3, tokens.length); n >= 1; n -= 1) {
    const cmd = wordCommand('advcmd', tokens.slice(0, n).join(' '));
    if (cmd) return { cmd, args: tokens.slice(n), mention: null };
  }
  return null;
}

/* Answers a member: privately when reply_private is on and they started the bot, else in the group. */
async function answerMember(ctx, chat, message, user, key, vars, rows = null) {
  const s = await settings.all(ctx, chat.chat_id);
  if (flag(s, 'reply_private')) {
    const u = await users.get(user.id);
    if (u && Number(u.started) && !Number(u.blocked) && await send(ctx, user.id, t(u.lang, key, vars), rows, `member-${key}-pm`)) return;
  }
  await send(ctx, chat.chat_id, t(chat.lang, key, vars), rows, `member-${key}`, { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
}

export async function command(ctx, message) {
  const chat = await chats.get(message.chat.id);
  if (!chat || !Number(chat.registered)) return false;
  const s = await settings.all(ctx, chat.chat_id);
  if (message.sender_chat && message.sender_chat.id === chat.chat_id && flag(s, 'anon_cmds') && (parseModCommand(message.text) || security.parseCommand(message.text))) {
    const id = await gd.addAnon(chat.chat_id, { text: message.text, entities: message.entities || [], reply_to_message: message.reply_to_message || null,
      message_id: message.message_id, chat: message.chat });
    await send(ctx, chat.chat_id, t(chat.lang, 'adv.anon_confirm'), [[btn(t(chat.lang, 'adv.btn_anon_confirm'), `an:${id}`)]], 'anon-confirm',
      { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
    return true;
  }
  const parsed = parseCommand(message.text);
  const user = message.from;
  if (!parsed || !user || message.sender_chat) return false;
  if (parsed.mention && parsed.mention !== String((await me(ctx)).username).toLowerCase()) return true;
  if (parsed.cmd === 'report') return report(ctx, chat, message, user, parsed, s);
  if (!flag(s, 'member_cmds') && !(await isAdmin(chat.chat_id, user.id))) return true;
  const lang = chat.lang;
  if (parsed.cmd === 'rules') {
    await answerMember(ctx, chat, message, user, s.rules ? 'adv.rules_text' : 'adv.no_rules', { title: iso(chat.title || '', 48), rules: esc(s.rules) });
  } else if (parsed.cmd === 'admins') {
    const rows = (await admins.listRows(chat.chat_id)).filter((r) => !Number(r.is_bot));
    const names = rows.map((r) => t(lang, r.status === 'creator' ? 'adv.admin_line_owner' : 'adv.admin_line', { name: iso(r.first_name || r.username || String(r.user_id)) }));
    await answerMember(ctx, chat, message, user, 'adv.admins_list', { title: iso(chat.title || '', 48), list: names.join('\n') });
  } else {
    const ladder = settings.steps(s);
    await answerMember(ctx, chat, message, user, 'adv.mywarns', { n: await punish.warnCount(ctx, chat.chat_id, user.id), max: ladder[ladder.length - 1].n });
  }
  return true;
}

async function report(ctx, chat, message, user, parsed, s) {
  const lang = chat.lang;
  const c = chat.chat_id;
  const say = (key, vars = {}) => postNotice(ctx, chat, t(lang, key, { user: iso(fullName(user)), ...vars }), null);
  if (!flag(s, 'reports')) return true;
  const target = message.reply_to_message;
  if (!target || target.forum_topic_created || (message.is_topic_message && target.message_id === message.message_thread_id)) {
    await say('adv.report_usage');
    return true;
  }
  const targetUser = target.from;
  if (targetUser && (targetUser.id === user.id || await isAdmin(c, targetUser.id) || targetUser.id === (await me(ctx)).id)) {
    await say('adv.report_not_this');
    return true;
  }
  if (await gd.lastReportAt(c, user.id) > nowSec() - REPORT_GAP_SEC) {
    await say('adv.report_wait');
    return true;
  }
  await users.remember(user);
  if (targetUser) await users.remember(targetUser);
  const reason = [...parsed.args.join(' ')].slice(0, 200).join('') || null;
  const snippet = [...String(target.text || target.caption || '')].slice(0, 300).join('') || null;
  const id = await gd.addReport(c, user.id, targetUser ? targetUser.id : 0, target.message_id, snippet, reason);
  await audit.log(user.id, 'report.new', { chatId: c, target: targetUser ? targetUser.id : 0, details: { id } });
  await deleteMessage(ctx, c, message.message_id, 'report-command');
  await say('adv.report_thanks');
  const body = (l) => [t(l, 'adv.report_title', { title: iso(chat.title || '', 48) }), t(l, 'adv.report_who', { user: iso(fullName(user)),
    target: targetUser ? iso(fullName(targetUser)) : '—' }), t(l, 'adv.report_text', { text: snippet ? iso(snippet, 300) : '—' }),
    t(l, 'adv.report_reason', { reason: reason ? iso(reason, 200) : '—' })].join('\n');
  const rows = (l) => {
    const r = [[btn(t(l, 'adv.btn_rp_delete'), `rp:${id}:d`), btn(t(l, 'adv.btn_rp_mute'), `rp:${id}:m`)], [btn(t(l, 'adv.btn_rp_ban'), `rp:${id}:b`),
      btn(t(l, 'adv.btn_rp_dismiss'), `rp:${id}:x`)]];
    if (chat.type === 'supergroup') r.unshift([urlBtn(t(l, 'adv.btn_open_message'), msgLink(c, target.message_id))]);
    return r;
  };
  if (s.report_dest === 'log' && s.log_chat !== '0' && flag(s, 'log_on')) {
    await send(ctx, Number(s.log_chat), body(lang), rows(lang), 'report-log');
    return true;
  }
  for (const aid of (await creatorAndAdmins(c)).slice(0, REPORT_ADMINS_MAX)) {
    const u = await users.get(aid);
    if (u && Number(u.started) && !Number(u.blocked)) await send(ctx, aid, body(u.lang), rows(u.lang), 'report-pm');
  }
  return true;
}

/* ---------- joins and leaves ---------- */

/* A newcomer: the event channel, and the welcome (later, after the captcha, when one is pending). */
export async function onJoin(ctx, chat, user, { welcomeNow = true } = {}) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel' || !user || user.is_bot) return;
  await events.post(ctx, chat, 'join', t(chat.lang, 'adv.ev_joined', { user: iso(fullName(user)), id: String(user.id) }));
  if (welcomeNow) await welcome(ctx, chat, user);
}

export async function onLeave(ctx, chat, user, { removedBy = 0 } = {}) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel' || !user || user.is_bot) return;
  if (removedBy) {
    await events.post(ctx, chat, 'leave', t(chat.lang, 'adv.ev_removed', { user: iso(fullName(user)), id: String(user.id), by: iso(await users.displayName(removedBy)) }));
    return;
  }
  await events.post(ctx, chat, 'leave', t(chat.lang, 'adv.ev_left', { user: iso(fullName(user)), id: String(user.id) }));
  await goodbye(ctx, chat, user);
}

export async function onAdminChange(ctx, chat, user, before, after, actorId) {
  const was = ['creator', 'administrator'].includes(before.status);
  const is = ['creator', 'administrator'].includes(after.status);
  if (was === is) return;
  await events.post(ctx, chat, 'admin', t(chat.lang, is ? 'adv.ev_promoted' : 'adv.ev_demoted', { user: iso(fullName(user)), by: actorId ? iso(await users.displayName(actorId)) : '—' }));
}

/* ---------- buttons ---------- */

async function langOf(from) {
  const u = await users.get(from.id);
  return u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
}

async function dropButtons(ctx, msg) {
  if (msg && msg.reply_markup) await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, 'drop-buttons');
}

export async function callback(ctx, cq, parts, handlers) {
  const from = cq.from;
  const lang = await langOf(from);
  if (parts[0] === 'fj') {
    const chat = await chats.get(toInt(parts[1]));
    if (!chat) return answer(ctx, t(lang, 'sec.cp_gone'), true);
    const list = parseJson((await settings.all(ctx, chat.chat_id)).fj_chats, []) || [];
    const missing = await fjMissing(ctx, chat.chat_id, from.id, list);
    if (missing.length) return answer(ctx, t(lang, 'adv.fj_still', { n: missing.length }), true);
    await gd.setFjOk(chat.chat_id, from.id);
    return answer(ctx, t(lang, 'adv.fj_ok'), true);
  }
  if (parts[0] === 'rp') {
    const rep = await gd.report(toInt(parts[1]));
    const chat = rep ? await chats.get(Number(rep.chat_id)) : null;
    if (!rep || !chat) return answer(ctx, t(lang, 'sec.cp_gone'), true);
    const role = await handlers.roleOf(ctx, chat, from.id);
    const act = parts[2];
    if (!role || role.role === 'mod' || ((act === 'm' || act === 'b') && !role.restrict)) return answer(ctx, t(lang, 'adv.rp_denied'), true);
    if (rep.status !== 'open') {
      await dropButtons(ctx, cq.message);
      return answer(ctx, t(lang, 'adv.rp_done_already'), true);
    }
    const target = Number(rep.target_id);
    let status = 'dismissed';
    if (act === 'd') {
      await deleteMessage(ctx, chat.chat_id, Number(rep.msg_id), 'report-delete');
      status = 'deleted';
    } else if ((act === 'm' || act === 'b') && target) {
      await deleteMessage(ctx, chat.chat_id, Number(rep.msg_id), 'report-delete');
      const res = await punish.apply(ctx, chat, { userId: target, name: await users.displayName(target), kind: act === 'm' ? 'mute' : 'ban', sec: act === 'm' ? 86400 : 0,
        reason: t(chat.lang, 'adv.report_reason_punish'), actorId: from.id, source: 'command' });
      if (!res.ok) return answer(ctx, t(lang, 'pun.undo_failed', { error: res.error }), true);
      status = act === 'm' ? 'muted' : 'banned';
    }
    await gd.handleReport(Number(rep.id), status, from.id);
    await audit.log(from.id, 'report.handled', { chatId: chat.chat_id, target, details: { id: Number(rep.id), status } });
    await dropButtons(ctx, cq.message);
    return answer(ctx, t(lang, `adv.rp_${status}`), true);
  }
  /* an:<id> — a real admin confirms an anonymous admin's command; it runs as theirs. */
  const row = await gd.takeAnon(toInt(parts[1]), from.id).catch(() => null);
  if (!row) {
    await dropButtons(ctx, cq.message);
    return answer(ctx, t(lang, 'sec.cp_gone'), true);
  }
  const chat = await chats.get(Number(row.chat_id));
  const acc = chat ? await admins.liveAccess(ctx, chat.chat_id, from.id) : { member: null };
  if (!acc.member || !['creator', 'administrator'].includes(acc.member.status)) {
    await db.run(sql`UPDATE aegis_anon_cmds SET status = 'pending', by_id = 0 WHERE id = ${row.id}`);
    return answer(ctx, t(lang, 'adv.anon_not_admin'), true);
  }
  const msg = { ...row.message, from, sender_chat: undefined, date: 0 };
  if (!(await handlers.security(ctx, msg))) await handlers.moderation(ctx, msg);
  if (cq.message) await deleteMessage(ctx, cq.message.chat.id, cq.message.message_id, 'anon-done');
  return answer(ctx, t(lang, 'adv.anon_done'));
}

/* ---------- timed jobs ---------- */

export function nightNext(s, lang, now) {
  return nextTime([Number(s.night_from), Number(s.night_to)], now, tzOf(s.tz, lang));
}

/* The night lock: locked inside the window, open outside; the next boundary is scheduled. */
export async function applyNight(ctx, chat) {
  const s = await settings.all(ctx, chat.chat_id);
  const ld = await guards.lockdown(chat.chat_id, 'night');
  const inside = flag(s, 'night_on') && chat.type === 'supergroup'
    && inWindow(Number(s.night_from), Number(s.night_to), localMinutes(nowSec(), tzOf(s.tz, chat.lang)));
  if (inside && !ld && !auditOn(s)) {
    const r = await security.lockChat(ctx, chat, 'night', { byId: 0 });
    if (r.ok && !r.already && !ctx.quiet) {
      const to = Number(s.night_to);
      await send(ctx, chat.chat_id, t(chat.lang, 'adv.night_on', { time: `${String(Math.floor(to / 60)).padStart(2, '0')}:${String(to % 60).padStart(2, '0')}` }), null, 'adv-night');
    }
  } else if (!inside && ld) await security.unlockChat(ctx, chat, ld, 0);
}

/* (Re)plans a chat's timed jobs after its settings changed; the night lock applies at once. */
export async function plan(ctx, chat) {
  const s = await settings.all(ctx, chat.chat_id);
  const now = nowSec();
  await schedules.set(chat.chat_id, 'night', flag(s, 'night_on') ? nightNext(s, chat.lang, now) : 0);
  await applyNight(ctx, chat);
  const times = parseJson(s.clean_times, []) || [];
  await schedules.set(chat.chat_id, 'cleanup', flag(s, 'clean_on') && times.length ? nextTime(times, now, tzOf(s.tz, chat.lang)) : 0);
}

/* Scheduled cleanup: deletes the messages Aegis saw since the last cleanup (48 h at most). */
export async function cleanup(ctx, chat, sinceSec) {
  const s = await settings.all(ctx, chat.chat_id);
  const kinds = { all: ['text', 'media', 'service', 'aegis'], media: ['media'], service: ['service', 'aegis'] }[s.clean_scope] || ['text', 'media', 'service'];
  const rows = await msglog.since(chat.chat_id, sinceSec, kinds, 1000);
  if (auditOn(s)) {
    await logs.post(ctx, chat, 'locks', t(chat.lang, 'adv.cleanup_audit', { n: rows.length }));
    return 0;
  }
  let n = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100);
    if (await tryCall(ctx, 'deleteMessages', { chat_id: chat.chat_id, message_ids: part.map((r) => Number(r.msg_id)) }, 'cleanup')) n += part.length;
  }
  await msglog.forget(rows.map((r) => Number(r.id)));
  await logs.post(ctx, chat, 'locks', t(chat.lang, 'adv.cleanup_done', { n }));
  return n;
}

/* Self-destructing messages and due jobs of every chat (lib/jobs.js, at most once a minute). */
export async function sweep(ctx) {
  const now = nowSec();
  const d = await msglog.due(now, 100);
  for (const [chatId, ids] of d.byChat) await tryCall(ctx, 'deleteMessages', { chat_id: chatId, message_ids: ids }, 'ttl-delete');
  await msglog.forget(d.ids);
  for (const row of await schedules.due(now)) {
    const chat = await chats.get(Number(row.chat_id));
    if (!chat || !Number(chat.active)) {
      await schedules.set(Number(row.chat_id), row.kind, 0);
      continue;
    }
    const s = await settings.all(ctx, chat.chat_id);
    if (row.kind === 'night') {
      if (!(await schedules.claim(row, flag(s, 'night_on') ? nightNext(s, chat.lang, now + 60) : 0))) continue;
      await applyNight(ctx, chat);
    } else {
      const times = parseJson(s.clean_times, []) || [];
      if (!(await schedules.claim(row, flag(s, 'clean_on') && times.length ? nextTime(times, now + 60, tzOf(s.tz, chat.lang)) : 0))) continue;
      await cleanup(ctx, chat, Math.max(Number(row.last_at) || 0, now - 48 * 3600));
    }
  }
}

/* After an update: Aegis's own group messages are kept for cleanup / self-destructing notices. */
export async function afterUpdate(ctx) {
  const now = nowSec();
  for (const e of ctx.trace) {
    if (e.m !== 'sendMessage' || !e.ok || !e.mid || typeof e.chat !== 'number' || e.chat >= 0 || KEEP_VIEWS.has(e.view)) continue;
    /* posts into a log or event chat belong to that record, not to the chat they were sent to */
    if (/^(log-|event-|report-log|ev-connected|log-test)/.test(String(e.view || ''))) continue;
    const s = await settings.all(ctx, e.chat);
    const ttl = Number(s.notice_ttl);
    if (ttl || (flag(s, 'clean_on') && ['all', 'service'].includes(s.clean_scope))) await msglog.add(e.chat, e.mid, 0, 'aegis', ttl ? now + ttl : 0);
  }
}
