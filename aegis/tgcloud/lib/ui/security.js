/*
 * Group security at work (Phase 5): the checks on every message and every join, captchas,
 * emergency lock / read-only / raid mode, risk alerts with the admins' feedback, federation bans,
 * and the group commands /lockdown /readonly /fban /unfban.
 *
 * Message (after the locks, before commands; admins, Aegis, the anonymous admin, the linked
 * channel's posts, VIP- and trusted-list members are exempt): federation ban → a newcomer still
 * owing a captcha → flood (n messages in t s, or the same message repeated) → advanced anti-link
 * (links de-disguised: full-width letters, look-alike dots, "dot"; links on buttons) → anti-ads /
 * tabchi (a new member's link, an ad posted in other Aegis groups too, ad phrases with a contact,
 * a new member's channel forward) → suspicious content (invisible characters, look-alike letters,
 * scam text and deceptive links, dangerous files, the same media again and again) → the risk score
 * of all signals found. Then, once: delete (if a hit says so), the strongest punishment (source
 * «security»), one rolling notice, a log line; a risk alert with ✅/❌ for the admins.
 *
 * Join (chat_member): federation ban → raid detection (n joins in t s → raid mode for a while:
 * captcha, quarantine, emergency lock or only an alert) → the newcomer's risk (name with links,
 * invisible or look-alike letters, impersonating an admin or Telegram, blocked name patterns,
 * joined during a raid) → captcha (muted until the right button) or quarantine (text only or
 * muted for a while — Telegram lifts it by itself).
 * Join requests (chat_join_request): the captcha in the requester's private chat; the right answer
 * approves the request, a wrong one or none declines it.
 *
 * There is no scheduler: expired captchas and finished lockdowns are handled on the next update of
 * that chat, and for all chats at most every minute on the side of any update (lib/jobs.js).
 * Audit Mode: nothing is deleted, punished, locked or kicked automatically — it is recorded and
 * reported. Commands are human decisions and are carried out.
 */
import { CAPTCHA_MAX_ATTEMPTS, FED_MAX_CHATS, XGROUP_WINDOW_SEC } from '../config.js';
import * as audit from '../core/audit.js';
import { me } from '../core/bot.js';
import { parseDuration } from '../core/duration.js';
import { parseArgs } from '../core/modparse.js';
import {
  adHits, adjust, buttonUrls, dangerousFile, deobfuscate, fingerprint, invisible, makeCaptcha, mixedScriptWords, nameSignals, RISK_LEVELS, scamHits, score,
} from '../core/signals.js';
import { deceptive, domainsOf, hostsOf, linksOf, scan } from '../core/msgscan.js';
import { answer, btn, call, describeError, send, tryCall } from '../core/tg.js';
import { esc, fullName, iso, normalizeWord, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import * as feds from '../engines/feds.js';
import * as guards from '../engines/guards.js';
import * as lists from '../engines/lists.js';
import * as locks from '../engines/locks.js';
import * as logs from '../engines/logs.js';
import * as members from '../engines/members.js';
import * as punish from '../engines/punish.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, pickLang, t, wordCommand } from '../i18n/index.js';
import { deleteMessage, isAdmin, postNotice } from './enforce.js';

export const HEADS = new Set(['cp', 'rk', 'ld']);
const OFF_WORDS = new Set(['off', 'end', 'stop', 'خاموش', 'پایان', 'لغو', 'выкл', 'стоп', '关闭', '结束', 'fin', 'arrêt']);
const replyTo = (message) => ({ reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
const mention = (user) => `<a href="tg://user?id=${user.id}">${esc(short(fullName(user), 64))}</a>`;
const auditOn = async (ctx, chatId) => settings.flag(await settings.all(ctx, chatId), 'audit');

async function creatorOf(chatId) {
  const row = (await admins.listRows(chatId)).find((r) => r.status === 'creator');
  return row ? Number(row.user_id) : 0;
}

/* Tells the admins: the log channel (category security); without one, the creator's private chat. */
async function alertAdmins(ctx, chat, text, rows = null) {
  if (ctx.quiet) return;
  const s = await settings.all(ctx, chat.chat_id);
  if (s.log_chat !== '0' && settings.flag(s, 'log_on') && settings.flag(s, 'log_security')) {
    await logs.post(ctx, chat, 'security', text, rows);
    return;
  }
  const cid = await creatorOf(chat.chat_id);
  const u = cid ? await users.get(cid) : null;
  if (u && Number(u.started) && !Number(u.blocked)) {
    await send(ctx, cid, `${t(u.lang, 'logs.header', { title: iso(chat.title || String(chat.chat_id), 40) })}\n${text}`, rows, 'security-alert-pm');
  }
}

/* An admin with Telegram's "ban users" right (or the creator), checked live. */
async function canRestrict(ctx, chatId, userId) {
  const acc = await admins.liveAccess(ctx, chatId, userId);
  const m = acc.member;
  if (!m || acc.level < admins.L.view) return null;
  return m.status === 'creator' || (m.status === 'administrator' && m.can_restrict_members === true) ? acc : null;
}

/* ---------- lockdowns: emergency lock, read-only, raid mode ---------- */

const PERMS_OFF = { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false,
  can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false,
  can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false };
const LOCKING = (ld) => !!ld.saved;

/*
 * Locks the chat for members (setChatPermissions: nothing allowed; admins are not affected) and
 * remembers the permissions it had, to put them back at the end. kind: emergency | readonly | raid.
 * Gives { ok, id } or { ok: false, error }.
 */
export async function lockChat(ctx, chat, kind, { reason = null, byId = 0, until = 0, perms = true } = {}) {
  const c = chat.chat_id;
  const active = await guards.lockdowns(c);
  const same = active.find((l) => l.kind === kind);
  if (same) return { ok: true, id: Number(same.id), already: true };
  let saved = null;
  if (perms) {
    const holder = active.find(LOCKING);
    if (holder) saved = parseJson(holder.saved, null);
    else {
      try {
        const info = await call(ctx, 'getChat', { chat_id: c }, 'lock-read-perms');
        saved = info.permissions || { can_send_messages: true };
        await call(ctx, 'setChatPermissions', { chat_id: c, permissions: PERMS_OFF, use_independent_chat_permissions: true }, `lock-${kind}`);
      } catch (err) {
        return { ok: false, error: describeError(err) };
      }
    }
  }
  const id = await guards.startLockdown(c, kind, saved, reason, byId, until);
  await audit.log(byId, `security.${kind}`, { chatId: c, details: { id, until, reason } });
  return { ok: true, id };
}

/* Ends a lockdown; the earlier permissions come back when no other lock still holds the chat. */
export async function unlockChat(ctx, chat, ld, byId) {
  if (!(await guards.endLockdown(Number(ld.id), byId))) return false;
  const rest = (await guards.lockdowns(chat.chat_id)).filter(LOCKING);
  if (LOCKING(ld) && !rest.length) {
    await tryCall(ctx, 'setChatPermissions', { chat_id: chat.chat_id, permissions: parseJson(ld.saved, { can_send_messages: true }),
      use_independent_chat_permissions: true }, 'lock-restore');
  }
  await audit.log(byId, `security.${ld.kind}_end`, { chatId: chat.chat_id, details: { id: Number(ld.id) } });
  if (!ctx.quiet && chat.type !== 'channel') {
    await send(ctx, chat.chat_id, t(chat.lang, byId ? `sec.${ld.kind}_ended` : `sec.${ld.kind}_restored`, { who: byId ? iso(await users.displayName(byId)) : '' }),
      null, 'lock-ended');
  }
  await logs.post(ctx, chat, 'security', t(chat.lang, `sec.log_${ld.kind}_end`));
  return true;
}

function lockText(lang, kind, until, reason, who) {
  const lines = [t(lang, `sec.${kind}_started`, { who: who ? iso(who) : t(lang, 'log.system') })];
  lines.push(until ? t(lang, 'sec.lock_until', { time: dur(lang, until - nowSec()) }) : t(lang, 'sec.lock_manual'));
  if (reason) lines.push(t(lang, 'pun.notice_reason', { reason: iso(reason, 200) }));
  return lines.join('\n');
}

/* ---------- lazy expiry ---------- */

/* Captchas that ran out and lockdowns whose time is up: in one chat, or (chatId null) anywhere. */
export async function sweep(ctx, chatId = null) {
  const now = nowSec();
  for (const row of await guards.expiredCaptchas(now, chatId)) {
    const chat = await chats.get(Number(row.chat_id));
    if (chat) await failCaptcha(ctx, chat, row, 'expired', 0);
    else await guards.finishCaptcha(Number(row.id), 'expired');
  }
  for (const ld of await guards.dueLockdowns(now, chatId)) {
    const chat = await chats.get(Number(ld.chat_id));
    if (chat) await unlockChat(ctx, chat, ld, 0);
    else await guards.endLockdown(Number(ld.id), 0);
  }
}

/* ---------- captcha ---------- */

function captchaRows(lang, id, cap, withAdmin) {
  const rows = [];
  for (let i = 0; i < cap.options.length; i += 3) rows.push(cap.options.slice(i, i + 3).map((o, j) => btn(o, `cp:${id}:${i + j}`)));
  if (withAdmin) rows.push([btn(t(lang, 'sec.cp_approve'), `cp:${id}:ok`), btn(t(lang, 'sec.cp_remove'), `cp:${id}:no`)]);
  return rows;
}

const questionText = (lang, cap) => t(lang, cap.kind === 'math' ? 'sec.cp_math' : 'sec.cp_button', { target: cap.target });

async function startCaptcha(ctx, chat, user, g) {
  const cfg = g.captcha;
  const lang = chat.lang;
  try {
    await call(ctx, 'restrictChatMember', { chat_id: chat.chat_id, user_id: user.id, permissions: punish.NONE, use_independent_chat_permissions: true }, 'captcha-mute');
  } catch (err) {
    console.warn(`captcha mute: ${describeError(err)}`);
    return false;
  }
  const cap = makeCaptcha(cfg.mode);
  const id = await guards.newCaptcha(chat.chat_id, user.id, 'group', cap, cap.target, nowSec() + cfg.to);
  const text = [t(lang, 'sec.cp_welcome', { user: mention(user) }), questionText(lang, cap), t(lang, 'sec.cp_time', { time: dur(lang, cfg.to) })].join('\n');
  const m = await send(ctx, chat.chat_id, text, captchaRows(lang, id, cap, true), 'captcha');
  if (m) await guards.setCaptchaMessage(id, chat.chat_id, m.message_id);
  return true;
}

async function quarantine(ctx, chat, userId, g, joinedAt = nowSec()) {
  const q = g.quarantine;
  const until = joinedAt + q.dur;
  if (until <= nowSec() + 30) return tryCall(ctx, 'restrictChatMember', { chat_id: chat.chat_id, user_id: userId, permissions: punish.ALL }, 'quarantine-skip');
  return tryCall(ctx, 'restrictChatMember', { chat_id: chat.chat_id, user_id: userId, permissions: q.lvl === 'mute' ? punish.NONE : punish.TEXT_ONLY,
    use_independent_chat_permissions: true, until_date: until }, 'quarantine');
}

async function passCaptcha(ctx, chat, row, byId) {
  if (!(await guards.finishCaptcha(Number(row.id), byId ? 'approved' : 'passed'))) return false;
  const uid = Number(row.user_id);
  if (row.kind === 'request') {
    await tryCall(ctx, 'approveChatJoinRequest', { chat_id: chat.chat_id, user_id: uid }, 'captcha-approve');
  } else {
    const g = await guards.all(ctx, chat.chat_id);
    if (g.quarantine.on) await quarantine(ctx, chat, uid, g, (await members.joinedAt(chat.chat_id, uid)) || nowSec());
    else await tryCall(ctx, 'restrictChatMember', { chat_id: chat.chat_id, user_id: uid, permissions: punish.ALL }, 'captcha-free');
  }
  if (Number(row.msg_id)) {
    if (row.kind === 'request') {
      const u = await users.get(uid);
      await tryCall(ctx, 'editMessageText', { chat_id: Number(row.msg_chat), message_id: Number(row.msg_id), parse_mode: 'HTML',
        text: t(u ? u.lang : 'en', 'sec.cp_request_ok', { title: iso(chat.title || '', 48) }) }, 'captcha-done');
    } else await deleteMessage(ctx, Number(row.msg_chat), Number(row.msg_id), 'captcha-done');
  }
  await audit.log(byId, 'security.captcha_pass', { chatId: chat.chat_id, target: uid, details: { kind: row.kind, by: byId } });
  return true;
}

async function failCaptcha(ctx, chat, row, status, byId) {
  if (!(await guards.finishCaptcha(Number(row.id), status))) return false;
  const uid = Number(row.user_id);
  const g = await guards.all(ctx, chat.chat_id);
  const audited = !byId && await auditOn(ctx, chat.chat_id);
  if (row.kind === 'request') {
    await tryCall(ctx, 'declineChatJoinRequest', { chat_id: chat.chat_id, user_id: uid }, 'captcha-decline');
    if (Number(row.msg_id)) {
      const u = await users.get(uid);
      await tryCall(ctx, 'editMessageText', { chat_id: Number(row.msg_chat), message_id: Number(row.msg_id), parse_mode: 'HTML',
        text: t(u ? u.lang : 'en', 'sec.cp_request_failed', { title: iso(chat.title || '', 48) }) }, 'captcha-done');
    }
  } else {
    const action = byId ? 'kick' : g.captcha.fail;
    if (!audited && action !== 'mute') {
      await tryCall(ctx, 'banChatMember', { chat_id: chat.chat_id, user_id: uid }, `captcha-${action}`);
      if (action === 'kick') await tryCall(ctx, 'unbanChatMember', { chat_id: chat.chat_id, user_id: uid, only_if_banned: true }, 'captcha-kick-unban');
    }
    if (Number(row.msg_id)) await deleteMessage(ctx, Number(row.msg_chat), Number(row.msg_id), 'captcha-done');
  }
  const name = await users.displayName(uid);
  await audit.log(byId, 'security.captcha_fail', { chatId: chat.chat_id, target: uid, details: { status, kind: row.kind } });
  await logs.post(ctx, chat, 'security', t(chat.lang, audited ? 'sec.log_captcha_audit' : `sec.log_captcha_${status}`, { user: iso(name) }));
  return true;
}

/* cp:<id>:<option | ok | no>, in the group or (join requests) in private. */
async function captchaPress(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const row = await guards.captcha(toInt(parts[1]));
  if (!row || row.status !== 'pending') return answer(ctx, t(lang, 'sec.cp_gone'), true);
  const chat = await chats.get(Number(row.chat_id));
  if (!chat) return answer(ctx, t(lang, 'sec.cp_gone'), true);
  const choice = parts[2];
  if (choice === 'ok' || choice === 'no') {
    if (!(await canRestrict(ctx, chat.chat_id, from.id))) return answer(ctx, t(lang, 'sec.admins_only'), true);
    if (choice === 'ok') await passCaptcha(ctx, chat, row, from.id);
    else await failCaptcha(ctx, chat, row, 'removed', from.id);
    return answer(ctx, t(lang, choice === 'ok' ? 'sec.cp_approved' : 'sec.cp_removed'));
  }
  if (from.id !== Number(row.user_id)) return answer(ctx, t(lang, 'sec.cp_not_yours'), true);
  if (toInt(choice) === Number(row.answer)) {
    await passCaptcha(ctx, chat, row, 0);
    return answer(ctx, t(lang, 'sec.cp_right'));
  }
  const n = await guards.captchaAttempt(Number(row.id));
  if (n !== null && n >= CAPTCHA_MAX_ATTEMPTS) {
    await failCaptcha(ctx, chat, row, 'failed', 0);
    return answer(ctx, t(lang, 'sec.cp_failed'), true);
  }
  return answer(ctx, t(lang, 'sec.cp_wrong'), true);
}

/* chat_join_request: the captcha goes to the requester's private chat (Telegram allows 5 minutes). */
export async function onJoinRequest(ctx, req) {
  const chat = await chats.get(req.chat.id);
  if (!chat || !Number(chat.registered) || !Number(chat.active)) return;
  const user = req.from;
  await users.remember(user);
  const fed = await feds.ofChat(chat.chat_id);
  if (fed && await feds.banOf(fed.id, user.id)) {
    await tryCall(ctx, 'declineChatJoinRequest', { chat_id: chat.chat_id, user_id: user.id }, 'fed-decline');
    await logs.post(ctx, chat, 'security', t(chat.lang, 'sec.log_fed_declined', { user: iso(fullName(user)), fed: iso(fed.name) }));
    return;
  }
  const g = await guards.all(ctx, chat.chat_id);
  if (!g.captcha.on || !g.captcha.jr) return;
  const u = await users.get(user.id);
  const lang = u && Number(u.lang_set) ? u.lang : pickLang(user.language_code);
  const cap = makeCaptcha(g.captcha.mode);
  const to = Math.min(g.captcha.to, 300);
  const id = await guards.newCaptcha(chat.chat_id, user.id, 'request', cap, cap.target, nowSec() + to);
  const text = [t(lang, 'sec.cp_request', { title: iso(chat.title || '', 48) }), questionText(lang, cap), t(lang, 'sec.cp_time', { time: dur(lang, to) })].join('\n');
  const m = await send(ctx, req.user_chat_id, text, captchaRows(lang, id, cap, false), 'captcha-request');
  if (m) await guards.setCaptchaMessage(id, req.user_chat_id, m.message_id);
}

/* ---------- risk ---------- */

async function riskAlert(ctx, chat, user, sc, acted, res, auditMode) {
  const lang = chat.lang;
  const reasons = sc.reasons.map(([s, p]) => t(lang, 'sec.risk_reason', { reason: t(lang, `sec.sig_${s}`), points: p }));
  const action = auditMode ? 'audit' : (acted ? 'acted' : 'alert');
  const id = await guards.addRisk(chat.chat_id, user.id, sc.score, sc.reasons, action, res && res.ok ? res.id : 0);
  const head = t(lang, `sec.risk_${action}`, { user: iso(fullName(user)), score: sc.score });
  const rows = [[btn(t(lang, 'sec.btn_right'), `rk:${id}:y`), btn(t(lang, 'sec.btn_wrong'), `rk:${id}:n`)]];
  await alertAdmins(ctx, chat, [head, ...reasons].join('\n'), rows);
  return id;
}

/* rk:<id>:y|n — the admins' feedback teaches the chat's weights; «wrong» also undoes what was done. */
async function riskPress(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const ev = await guards.riskEvent(toInt(parts[1]));
  const chat = ev ? await chats.get(Number(ev.chat_id)) : null;
  if (!ev || !chat) return answer(ctx, t(lang, 'sec.cp_gone'), true);
  const acc = await admins.liveAccess(ctx, chat.chat_id, from.id);
  if (acc.level < admins.L.settings) return answer(ctx, t(lang, 'sec.settings_only'), true);
  const right = parts[2] === 'y';
  if (!(await guards.riskFeedback(Number(ev.id), right ? 'right' : 'wrong', from.id))) return answer(ctx, t(lang, 'betray.already'), true);
  const sigs = (parseJson(ev.reasons, []) || []).map((r) => r[0]);
  const g = await guards.all(ctx, chat.chat_id);
  await guards.update(ctx, chat.chat_id, 'risk', { w: adjust(g.risk.w, sigs, right) }, from.id, { quiet: true });
  if (!right && Number(ev.punish_id)) await punish.undo(ctx, chat, Number(ev.punish_id), from.id);
  await audit.log(from.id, 'security.risk_feedback', { chatId: chat.chat_id, target: Number(ev.user_id), details: { id: Number(ev.id), right } });
  await dropButtons(ctx, cq.message);
  return answer(ctx, t(lang, right ? 'sec.feedback_right' : 'sec.feedback_wrong'), true);
}

async function dropButtons(ctx, msg) {
  if (!msg || !msg.reply_markup) return;
  await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, 'drop-buttons');
}

async function langOf(from) {
  const u = await users.get(from.id);
  return u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
}

/* ---------- federation bans ---------- */

async function fedBanHere(ctx, chat, fed, user, ban, messageId = null) {
  if (messageId) await deleteMessage(ctx, chat.chat_id, messageId, 'fed-delete');
  await tryCall(ctx, 'banChatMember', { chat_id: chat.chat_id, user_id: user.id }, 'fed-ban');
  await logs.post(ctx, chat, 'security', t(chat.lang, 'sec.log_fed_ban_here', { user: iso(fullName(user)), fed: iso(fed.name),
    reason: ban.reason ? iso(ban.reason, 120) : '—' }));
}

/* ---------- the message path ---------- */

export async function onMessage(ctx, chat, message, { edited = false } = {}) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel') return false;
  const c = chat.chat_id;
  await sweep(ctx, c);
  const user = message.from;
  if (!user || message.sender_chat || user.is_bot) return false;
  if (await isAdmin(c, user.id)) return false;
  const fed = await feds.ofChat(c);
  if (fed) {
    const ban = await feds.banOf(fed.id, user.id);
    if (ban) {
      await fedBanHere(ctx, chat, fed, user, ban, message.message_id);
      return true;
    }
  }
  const pending = await guards.pendingCaptcha(c, user.id);
  if (pending && pending.kind === 'group') {
    await deleteMessage(ctx, c, message.message_id, 'captcha-pending');
    return true;
  }
  const g = await guards.all(ctx, c);
  if (!guards.anyOn(g) || edited && !g.antilink.on && !g.suspicious.on) return false;
  if (await lists.has(c, 'vip', String(user.id)) || await lists.has(c, 'tru', String(user.id))) return false;
  const f = scan(message);
  const deob = scan({ text: deobfuscate(f.text) });
  const hits = [];
  const signals = [];
  const now = nowSec();
  const joinedAt = await members.joinedAt(c, user.id);
  const newFor = (sec) => joinedAt > 0 && joinedAt >= now - sec;
  const s = await settings.all(ctx, c);
  let counter = null;
  const media = (message.photo && message.photo[message.photo.length - 1]) || message.video || message.animation || message.document || message.sticker
    || message.voice || message.video_note || message.audio;
  /* The fingerprint for «the same message again»: the text, or the media itself (never one shared value for all photos). */
  const print = f.text ? fingerprint(f.text) : ((media && media.file_unique_id) || `m${message.message_id}`);
  if (!edited && (g.flood.on || g.antiads.on || g.risk.on)) counter = await guards.countMessage(c, user.id, print, g.flood.t);
  if (g.flood.on && counter && (counter.n > g.flood.n || (g.flood.dup && counter.dup >= g.flood.dup))) {
    signals.push('flood');
    hits.push({ m: 'flood', cfg: g.flood, punish: await guards.claimFloodPunish(c, user.id, g.flood.t) });
  }
  const raw = [...f.urls, ...linksOf(deob, 'high'), ...(g.antilink.btn ? buttonUrls(message) : [])];
  const ownLink = (u) => !!chat.username && new RegExp(`(?:t\\.me|telegram\\.me)/${chat.username}\\b`, 'i').test(u);
  const foreign = [];
  for (const h of hostsOf(raw.filter((u) => !ownLink(u)))) if (!(await anyAllowed(c, h))) foreign.push(h);
  const contact = foreign.length > 0 || f.types.has('mention') || f.types.has('phone_number') || buttonUrls(message).length > 0
    || (!!f.forward && f.forward.type === 'channel');
  if (g.antilink.on && foreign.length) {
    if (g.antilink.sc === 'all' || newFor(Number(s.new_window))) hits.push({ m: 'antilink', cfg: g.antilink });
  }
  if (contact) {
    const isNew = newFor(g.antiads.win);
    const ad = [];
    if (isNew) ad.push(f.forward && f.forward.type === 'channel' ? 'fwd_channel_new' : 'new_link');
    if (counter && counter.msgs <= 1) ad.push('first_link');
    if (adHits(f.text) >= 2) ad.push('ad_words');
    if ((g.antiads.on && g.antiads.xg) || g.risk.on) {
      if (f.text && await guards.seenAd(user.id, fingerprint(f.text), c, XGROUP_WINDOW_SEC) >= 1) ad.push('xgroup');
    }
    signals.push(...ad);
    if (g.antiads.on && ad.some((x) => x !== 'first_link')) hits.push({ m: 'antiads', cfg: g.antiads });
  }
  const sus = [];
  if (g.suspicious.inv && invisible(f.text).suspicious) sus.push('invisible');
  if (g.suspicious.homo && mixedScriptWords(f.text) > 0) sus.push('homoglyph');
  if (g.suspicious.dec && (scamHits(f.text) > 0 || f.hidden.some(deceptive) || /\u202E/.test(f.text))) sus.push('deceptive');
  if (g.suspicious.file && dangerousFile(message.document)) sus.push('danger_file');
  if (g.suspicious.dupm && media && media.file_unique_id && !edited && (g.suspicious.on || g.risk.on)) {
    const seen = await guards.seenMedia(media.file_unique_id, c, user.id);
    if (seen.here >= 2 || seen.elsewhere >= 1) sus.push('dup_media');
  }
  signals.push(...sus);
  if (g.suspicious.on && sus.length) hits.push({ m: 'suspicious', cfg: g.suspicious, sus });
  let sc = null;
  if (g.risk.on && signals.length) {
    sc = score(signals, g.risk.w);
    const [alertAt, actAt] = RISK_LEVELS[g.risk.lv];
    if (sc.score >= actAt) hits.push({ m: 'risk', cfg: g.risk, risk: true });
    else if (sc.score < alertAt) sc = null;
  }
  if (!hits.length && !sc) return false;
  return act(ctx, chat, message, user, hits, sc);
}

async function anyAllowed(chatId, host) {
  for (const d of domainsOf(host)) if (await lists.has(chatId, 'aln', d)) return true;
  return false;
}

async function act(ctx, chat, message, user, hits, sc) {
  const lang = chat.lang;
  const c = chat.chat_id;
  const audited = await auditOn(ctx, c);
  const del = hits.some((h) => h.cfg.del);
  const punishing = hits.filter((h) => h.cfg.a && h.cfg.a !== 'none' && h.punish !== false);
  const primary = [...(punishing.length ? punishing : hits)].sort((a, b) => locks.SEVERITY[b.cfg.a || 'none'] - locks.SEVERITY[a.cfg.a || 'none'])[0];
  const names = [...new Set(hits.map((h) => t(lang, `sec.m_${h.m}`)))].join(t(lang, 'common.sep'));
  let deleted = false;
  if (del && !audited) deleted = await deleteMessage(ctx, c, message.message_id, 'security-delete');
  let res = null;
  if (primary && punishing.length) {
    await users.remember(user);
    res = await punish.apply(ctx, chat, { userId: user.id, name: fullName(user), kind: primary.cfg.a, sec: locks.TIMED_ACTIONS.has(primary.cfg.a) ? primary.cfg.d : 0,
      reason: t(lang, 'sec.reason', { what: names }), actorId: 0, source: 'security', meta: { modules: hits.map((h) => h.m) } });
  }
  if (sc) await riskAlert(ctx, chat, user, sc, hits.some((h) => h.risk), res, audited);
  if (hits.length && !audited && !ctx.quiet) {
    const lines = [t(lang, 'sec.notice', { user: iso(fullName(user)), what: names })];
    if (res && res.ok && !res.auditOnly) {
      const sec = Number(res.row.until) ? Number(res.row.until) - Number(res.row.created_at) : 0;
      lines.push(t(lang, 'locks.notice_punish', { icon: t(lang, `pun.icon_${res.row.kind}`), kind: t(lang, `pun.k_${res.row.kind}`),
        time: punish.TIMED.has(res.row.kind) ? (sec ? dur(lang, sec) : t(lang, 'pun.forever')) : '—' }));
    }
    const rows = res && res.ok && res.row.kind !== 'kick' ? [[btn(t(lang, 'pun.btn_undo'), `pu:${res.id}`)]] : null;
    await postNotice(ctx, chat, lines.join('\n'), rows);
  }
  if (hits.length) {
    await logs.post(ctx, chat, 'security', t(lang, audited ? 'sec.log_audit' : (deleted ? 'sec.log_deleted' : 'sec.log_caught'), { user: iso(fullName(user)), what: names }));
  }
  return deleted;
}

/* ---------- the join path ---------- */

export async function onJoin(ctx, chat, user) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel' || !user || user.is_bot) return;
  const c = chat.chat_id;
  await sweep(ctx, c);
  const fed = await feds.ofChat(c);
  if (fed) {
    const ban = await feds.banOf(fed.id, user.id);
    if (ban) {
      await fedBanHere(ctx, chat, fed, user, ban);
      return;
    }
  }
  const g = await guards.all(ctx, c);
  if (!guards.anyOn(g)) return;
  if (await lists.has(c, 'vip', String(user.id)) || await lists.has(c, 'tru', String(user.id))) return;
  const audited = await auditOn(ctx, c);
  let raid = await guards.lockdown(c, 'raid');
  if (g.raid.on && !raid && await guards.recentJoins(c, g.raid.t) >= g.raid.n) raid = await startRaid(ctx, chat, g, audited);
  const raidAct = raid ? g.raid.act : null;
  if (g.risk.on) {
    const adminNames = (await admins.listRows(c)).map((r) => r.first_name).filter(Boolean);
    const sigs = nameSignals(user, adminNames);
    const name = normalizeWord([user.first_name, user.last_name].filter(Boolean).join(' '));
    if ((await lists.all(c, 'nam', 200)).some((e) => e.ekey && name.includes(String(e.ekey)))) sigs.push('name_pattern');
    if (raid) sigs.push('raid');
    const sc = score(sigs, g.risk.w);
    const [alertAt, actAt] = RISK_LEVELS[g.risk.lv];
    if (sc.score >= alertAt) {
      let res = null;
      if (sc.score >= actAt && g.risk.a !== 'none') {
        await users.remember(user);
        res = await punish.apply(ctx, chat, { userId: user.id, name: fullName(user), kind: g.risk.a, sec: locks.TIMED_ACTIONS.has(g.risk.a) ? g.risk.d : 0,
          reason: t(chat.lang, 'sec.reason', { what: t(chat.lang, 'sec.m_risk') }), actorId: 0, source: 'security', meta: { join: true } });
      }
      await riskAlert(ctx, chat, user, sc, sc.score >= actAt, res, audited);
      if (res && res.ok && !res.auditOnly && ['ban', 'kick'].includes(res.row.kind)) return;
    }
  }
  if (audited || chat.type !== 'supergroup') return;
  if ((g.captcha.on || raidAct === 'captcha') && !(await guards.recentPass(c, user.id, nowSec() - 900))) {
    if (await startCaptcha(ctx, chat, user, g)) return;
  }
  if (g.quarantine.on || raidAct === 'quarantine') await quarantine(ctx, chat, user.id, g);
}

async function startRaid(ctx, chat, g, audited) {
  const until = nowSec() + g.raid.dur;
  const r = await lockChat(ctx, chat, 'raid', { until, perms: g.raid.act === 'lock' && !audited, reason: t(chat.lang, 'sec.raid_reason', { n: g.raid.n, time: dur(chat.lang, g.raid.t) }) });
  if (!r.ok) return null;
  const ld = await guards.lockdown(chat.chat_id, 'raid');
  const lang = chat.lang;
  const text = [t(lang, 'sec.raid_alert', { n: g.raid.n, time: dur(lang, g.raid.t) }), t(lang, `sec.raid_act_${audited ? 'audit' : g.raid.act}`),
    t(lang, 'sec.lock_until', { time: dur(lang, g.raid.dur) })].join('\n');
  const rows = [[btn(t(lang, 'sec.btn_end_raid'), `ld:${ld.id}:end`)]];
  if (!ctx.quiet) await send(ctx, chat.chat_id, text, rows, 'raid-alert');
  const cid = await creatorOf(chat.chat_id);
  const u = cid ? await users.get(cid) : null;
  if (u && Number(u.started) && !Number(u.blocked) && !ctx.quiet) {
    await send(ctx, cid, [t(u.lang, 'logs.header', { title: iso(chat.title || '', 40) }), t(u.lang, 'sec.raid_alert', { n: g.raid.n, time: dur(u.lang, g.raid.t) }),
      t(u.lang, `sec.raid_act_${audited ? 'audit' : g.raid.act}`)].join('\n'), [[btn(t(u.lang, 'sec.btn_end_raid'), `ld:${ld.id}:end`)]], 'raid-alert-pm');
  }
  await logs.post(ctx, chat, 'security', t(lang, 'sec.raid_alert', { n: g.raid.n, time: dur(lang, g.raid.t) }));
  return ld;
}

/* ld:<id>:end — an admin ends a lockdown or raid mode from its alert. */
async function lockdownPress(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const ld = await guards.lockdownById(toInt(parts[1]));
  const chat = ld ? await chats.get(Number(ld.chat_id)) : null;
  if (!ld || !chat || !Number(ld.active)) {
    await dropButtons(ctx, cq.message);
    return answer(ctx, t(lang, 'sec.ld_over'), true);
  }
  if (!(await canRestrict(ctx, chat.chat_id, from.id))) return answer(ctx, t(lang, 'sec.admins_only'), true);
  await unlockChat(ctx, chat, ld, from.id);
  await dropButtons(ctx, cq.message);
  return answer(ctx, t(lang, 'sec.ld_ended'));
}

/* ---------- commands ---------- */

/* /lockdown /readonly /fban /unfban (or their words in any of our languages): { cmd, args, mention } or null. */
export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 1000) return null;
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) {
    const cmd = m[1].toLowerCase();
    return ['lockdown', 'readonly', 'fban', 'unfban'].includes(cmd) ? { cmd, args: tokens.slice(1), mention: m[2] ? m[2].toLowerCase() : null } : null;
  }
  for (let n = Math.min(3, tokens.length); n >= 1; n -= 1) {
    const cmd = wordCommand('seccmd', tokens.slice(0, n).join(' '));
    if (cmd) return { cmd, args: tokens.slice(n), mention: null };
  }
  return null;
}

export async function command(ctx, message) {
  const parsed = parseCommand(message.text);
  if (!parsed) return false;
  if (parsed.mention && parsed.mention !== String((await me(ctx)).username).toLowerCase()) return true;
  const from = message.from;
  const chat = await chats.get(message.chat.id);
  if (!from || !chat || !Number(chat.registered) || message.sender_chat) return false;
  const lang = chat.lang;
  const say = (key, vars = {}, rows = null) => send(ctx, chat.chat_id, t(lang, key, vars), rows, `sec-${parsed.cmd}`, replyTo(message));
  if (parsed.cmd === 'fban' || parsed.cmd === 'unfban') return fedCommand(ctx, chat, message, parsed, say);
  const acc = await canRestrict(ctx, chat.chat_id, from.id);
  if (!acc) return !!(await admins.getRow(chat.chat_id, from.id)) && !!(await say('sec.need_restrict'));
  if (chat.type !== 'supergroup') return !!(await say('mod.basic_group'));
  const kind = parsed.cmd === 'lockdown' ? 'emergency' : 'readonly';
  if (parsed.args.length && OFF_WORDS.has(parsed.args[0].toLowerCase())) {
    const ld = await guards.lockdown(chat.chat_id, kind);
    if (!ld) return !!(await say(`sec.${kind}_not_on`));
    await unlockChat(ctx, chat, ld, from.id);
    return true;
  }
  let rest = parsed.args;
  let until = 0;
  const d = parseDuration(rest);
  if (d && d.invalid) return !!(await say('mod.bad_duration'));
  if (d) {
    until = d.sec ? nowSec() + d.sec : 0;
    rest = rest.slice(d.used);
  }
  const reason = [...rest.join(' ')].slice(0, 200).join('') || null;
  const r = await lockChat(ctx, chat, kind, { reason, byId: from.id, until });
  if (!r.ok) return !!(await say('mod.tg_error', { error: iso(r.error, 120) }));
  if (r.already) return !!(await say(`sec.${kind}_already`));
  await announceLock(ctx, chat, kind, until, reason, from);
  return true;
}

/* Tells the group (with an «end now» button), the log channel and — for an emergency — the creator. */
export async function announceLock(ctx, chat, kind, until, reason, by) {
  const ld = await guards.lockdown(chat.chat_id, kind);
  if (!ld || ctx.quiet) return;
  const lang = chat.lang;
  await send(ctx, chat.chat_id, lockText(lang, kind, until, reason, fullName(by)), [[btn(t(lang, 'sec.btn_end'), `ld:${ld.id}:end`)]], `sec-${kind}`);
  await logs.post(ctx, chat, 'security', lockText(lang, kind, until, reason, fullName(by)));
  if (kind !== 'emergency') return;
  const cid = await creatorOf(chat.chat_id);
  const u = cid && cid !== by.id ? await users.get(cid) : null;
  if (u && Number(u.started) && !Number(u.blocked)) {
    await send(ctx, cid, [t(u.lang, 'logs.header', { title: iso(chat.title || '', 40) }), lockText(u.lang, kind, until, reason, fullName(by))].join('\n'),
      [[btn(t(u.lang, 'sec.btn_end'), `ld:${ld.id}:end`)]], 'emergency-pm');
  }
}

async function fedCommand(ctx, chat, message, parsed, say) {
  const from = message.from;
  const fed = await feds.ofChat(chat.chat_id);
  if (!fed) return (await admins.getRow(chat.chat_id, from.id)) ? !!(await say('sec.fed_none')) : true;
  if (!(await feds.isAdmin(fed, from.id))) return (await admins.getRow(chat.chat_id, from.id)) ? !!(await say('sec.fed_not_admin', { fed: iso(fed.name) })) : true;
  const a = parseArgs('warn', parsed.args);
  let target = a.target;
  const reply = message.reply_to_message;
  if (!target && reply && reply.from && !reply.forum_topic_created) target = { id: reply.from.id, user: reply.from };
  if (target && target.username) {
    const known = await users.byUsername(target.username);
    target = known ? { id: Number(known.user_id) } : null;
  }
  if (!target) return !!(await say('sec.fed_usage', { cmd: parsed.cmd }));
  const uid = target.id;
  if (uid === (await me(ctx)).id || uid === from.id || await feds.isAdmin(fed, uid)) return !!(await say('sec.fed_protected'));
  const member = await tryCall(ctx, 'getChatMember', { chat_id: chat.chat_id, user_id: uid }, 'fed-target');
  if (member && ['creator', 'administrator'].includes(member.status)) return !!(await say('mod.t_admin', { target: iso(fullName(member.user)) }));
  if (member) await users.remember(member.user);
  const name = member ? fullName(member.user) : await users.displayName(uid);
  const list = await feds.chats(fed.id);
  let n = 0;
  if (parsed.cmd === 'fban') {
    await feds.ban(fed, uid, name, a.reason, from.id, chat.chat_id);
    for (const fc of list.slice(0, FED_MAX_CHATS)) {
      if (await tryCall(ctx, 'banChatMember', { chat_id: Number(fc.chat_id), user_id: uid }, 'fed-ban-all')) n += 1;
    }
    await say('sec.fbanned', { target: iso(name), fed: iso(fed.name), n, total: list.length, reason: a.reason ? iso(a.reason, 200) : '—' });
  } else {
    if (!(await feds.unban(fed, uid, from.id, chat.chat_id))) return !!(await say('sec.fed_not_banned', { target: iso(name) }));
    for (const fc of list.slice(0, FED_MAX_CHATS)) {
      if (await tryCall(ctx, 'unbanChatMember', { chat_id: Number(fc.chat_id), user_id: uid, only_if_banned: true }, 'fed-unban-all')) n += 1;
    }
    await say('sec.funbanned', { target: iso(name), fed: iso(fed.name), n, total: list.length });
  }
  await logs.post(ctx, chat, 'security', t(chat.lang, parsed.cmd === 'fban' ? 'sec.log_fban' : 'sec.log_funban', { target: iso(name), fed: iso(fed.name),
    who: iso(fullName(from)) }));
  return true;
}

/* ---------- buttons ---------- */

export async function callback(ctx, cq, parts) {
  if (parts[0] === 'cp') return captchaPress(ctx, cq, parts);
  if (parts[0] === 'rk') return riskPress(ctx, cq, parts);
  return lockdownPress(ctx, cq, parts);
}
