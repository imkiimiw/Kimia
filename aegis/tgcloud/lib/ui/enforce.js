/*
 * The locks at work, on every message (and every edit) in a registered group.
 *
 * Order: service messages (the bots lock removes bots added by non-admins, then the service lock
 * deletes the join/leave/pin notice) → exempt senders: Aegis, admins (cached admin list, kept
 * current by chat_member), the anonymous admin, the linked channel's own posts, VIP-list members →
 * the active locks that match (lib/engines/locks.js) → each lock's own exceptions: trusted list,
 * moderators, members exempted by hand, «new members only».
 * Then, once per message: delete it if any matching lock says so; the strongest punishment of the
 * matching locks (engines/punish.js, source «lock»: warning steps apply); one notice in the group
 * (the previous lock notice is deleted, at most one every LOCK_NOTICE_GAP_SEC); a log entry.
 * A message sent as a channel can only be deleted: Telegram hides the person behind it.
 * Audit Mode: nothing is deleted or punished and nothing is posted in the group — the hit is
 * recorded, logged, and the punishment recorded as «audit only».
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { LOCK_NOTICE_GAP_SEC } from '../config.js';
import { btn, me, send, tryCall } from '../core/tg.js';
import { MOD_COMMANDS, SLASH_NAMES } from '../core/commands.js';
import { scan } from '../core/msgscan.js';
import { esc, fullName, iso, nowSec, parseJson } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as lists from '../engines/lists.js';
import * as locks from '../engines/locks.js';
import * as logs from '../engines/logs.js';
import * as members from '../engines/members.js';
import * as punish from '../engines/punish.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, t } from '../i18n/index.js';

const OWN = new Set([...SLASH_NAMES, ...MOD_COMMANDS]);
const lockName = (lang, code) => t(lang, `locks.n_${code}`);

export async function isAdmin(chatId, userId) {
  const r = await admins.getRow(chatId, userId);
  return !!r && (r.status === 'creator' || r.status === 'administrator');
}

/* The matches that still apply to this member after each lock's own exceptions. */
async function applicable(ctx, chat, matched, user) {
  if (!user) return matched;
  const c = chat.chat_id;
  const memo = {};
  const inList = async (code) => {
    if (memo[code] === undefined) memo[code] = await lists.has(c, code, String(user.id));
    return memo[code];
  };
  let isNew = null;
  const out = [];
  for (const m of matched) {
    const cfg = m.cfg;
    if (cfg.ex.includes(user.id)) continue;
    if (cfg.exT && await inList('tru')) continue;
    if (cfg.exM && await inList('mod')) continue;
    if (cfg.sc === 'new') {
      if (isNew === null) {
        const at = await members.joinedAt(c, user.id);
        isNew = at > 0 && at >= nowSec() - Number((await settings.all(ctx, c)).new_window);
      }
      if (!isNew) continue;
    }
    out.push(m);
  }
  return out;
}

export async function deleteMessage(ctx, chatId, messageId, view) {
  return !!(await tryCall(ctx, 'deleteMessage', { chat_id: chatId, message_id: messageId }, view));
}

/* The group notice: custom text (escaped; {user} and {lock} filled in) or the default one. */
function noticeText(lang, primary, name, res) {
  const lock = lockName(lang, primary.code);
  const lines = [];
  if (primary.cfg.n === 'custom' && primary.cfg.txt) lines.push(esc(primary.cfg.txt).replace(/\{user\}/g, iso(name)).replace(/\{lock\}/g, esc(lock)));
  else lines.push(t(lang, 'locks.notice', { user: iso(name), lock }));
  if (res && res.ok && !res.auditOnly) {
    const kind = res.row.kind;
    const sec = Number(res.row.until) ? Number(res.row.until) - Number(res.row.created_at) : 0;
    lines.push(t(lang, 'locks.notice_punish', { icon: t(lang, `pun.icon_${kind}`), kind: t(lang, `pun.k_${kind}`),
      time: punish.TIMED.has(kind) ? (sec ? dur(lang, sec) : t(lang, 'pun.forever')) : '—' }));
    if (kind === 'warn' && res.count) lines.push(t(lang, 'pun.notice_count', { n: res.count, max: res.max }));
    if (res.step && res.stepResult && res.stepResult.ok && !res.stepResult.auditOnly) {
      const a = res.step.a;
      lines.push(t(lang, a === 'kick' ? 'pun.notice_step_kick' : 'pun.notice_step', { icon: t(lang, `pun.icon_${a}`), kind: t(lang, `pun.k_${a}`),
        time: res.step.d ? dur(lang, res.step.d) : t(lang, 'pun.forever') }));
    }
  }
  return lines.join('\n');
}

export async function postNotice(ctx, chat, text, rows) {
  const now = nowSec();
  const fresh = await db.get(sql`SELECT lock_notice, lock_notice_at FROM aegis_chats WHERE chat_id = ${chat.chat_id}`);
  if (fresh && Number(fresh.lock_notice_at) > now - LOCK_NOTICE_GAP_SEC) return null;
  const claimed = await db.run(sql`UPDATE aegis_chats SET lock_notice_at = ${now} WHERE chat_id = ${chat.chat_id} AND lock_notice_at <= ${now - LOCK_NOTICE_GAP_SEC}`);
  if (!claimed.rowsAffected) return null;
  if (fresh && Number(fresh.lock_notice)) await deleteMessage(ctx, chat.chat_id, Number(fresh.lock_notice), 'lock-notice-old');
  const m = await send(ctx, chat.chat_id, text, rows, 'lock-notice');
  if (m) await db.run(sql`UPDATE aegis_chats SET lock_notice = ${m.message_id} WHERE chat_id = ${chat.chat_id}`);
  return m;
}

/* Carries out the matches for one message. user: the sender (null for a message sent as a channel). */
async function act(ctx, chat, message, user, matched) {
  const lang = chat.lang;
  const c = chat.chat_id;
  const s = await settings.all(ctx, c);
  const auditOn = settings.flag(s, 'audit');
  const defOf = (m) => locks.get(m.code);
  const del = matched.some((m) => m.cfg.del);
  const punishing = user ? matched.filter((m) => defOf(m).punish && m.cfg.a !== 'none') : [];
  const primary = [...(punishing.length ? punishing : matched)].sort((a, b) => locks.SEVERITY[b.cfg.a] - locks.SEVERITY[a.cfg.a])[0];
  const names = matched.map((m) => lockName(lang, m.code)).join(t(lang, 'common.sep'));
  let deleted = false;
  if (del && !auditOn) deleted = await deleteMessage(ctx, c, message.message_id, 'lock-delete');
  let res = null;
  const name = user ? fullName(user) : (message.sender_chat ? message.sender_chat.title || '' : '');
  if (user && punishing.length) {
    await users.remember(user);
    const a = primary.cfg;
    res = await punish.apply(ctx, chat, { userId: user.id, name, kind: a.a, sec: locks.TIMED_ACTIONS.has(a.a) ? a.d : 0,
      reason: t(lang, 'locks.reason', { lock: names }), actorId: 0, source: 'lock', meta: { locks: matched.map((m) => m.code) } });
  }
  const action = auditOn ? 'audit' : (deleted ? 'deleted' : 'kept');
  for (const m of matched) await locks.recordHit(c, m.code, user ? user.id : 0, action, res && res.ok ? res.row.kind : null);
  if (!auditOn && !ctx.quiet && primary.cfg.n !== 'off' && chat.type !== 'channel') {
    const rows = res && res.ok && res.row.kind !== 'kick' ? [[btn(t(lang, 'pun.btn_undo'), `pu:${res.id}`)]] : null;
    await postNotice(ctx, chat, noticeText(lang, primary, name || '—', res), rows);
  }
  if (matched.some((m) => m.cfg.log)) {
    const key = auditOn ? 'logs.lock_audit' : (deleted ? 'logs.lock_deleted' : 'logs.lock_kept');
    await logs.post(ctx, chat, 'locks', t(lang, key, { user: iso(name || '—'), locks: names }));
  }
  return { deleted, res };
}

/* Join/leave/pin… notices: the bots lock, then the service lock. */
async function serviceMessage(ctx, chat, message, f, on, bot) {
  const c = chat.chat_id;
  const lang = chat.lang;
  const auditOn = settings.flag(await settings.all(ctx, c), 'audit');
  const from = message.from;
  if (on.has('bots') && f.newMembers.some((u) => u.is_bot) && from && !(await isAdmin(c, from.id)) && !(await lists.has(c, 'vip', String(from.id)))) {
    const cfg = on.get('bots');
    const adder = (await applicable(ctx, chat, [{ code: 'bots', cfg }], from)).length ? from : null;
    const bots = adder ? await locks.unwantedBots(f, locks.listEnv(c), bot) : [];
    for (const b of bots) {
      if (!auditOn) {
        await tryCall(ctx, 'banChatMember', { chat_id: c, user_id: b.id }, 'lock-bot-kick');
        await tryCall(ctx, 'unbanChatMember', { chat_id: c, user_id: b.id, only_if_banned: true }, 'lock-bot-unban');
      }
      await locks.recordHit(c, 'bots', b.id, auditOn ? 'audit' : 'removed', null);
    }
    if (bots.length) {
      let res = null;
      if (cfg.a !== 'none') {
        await users.remember(from);
        res = await punish.apply(ctx, chat, { userId: from.id, name: fullName(from), kind: cfg.a, sec: locks.TIMED_ACTIONS.has(cfg.a) ? cfg.d : 0,
          reason: t(lang, 'locks.reason', { lock: lockName(lang, 'bots') }), actorId: 0, source: 'lock', meta: { bots: bots.map((b) => b.id) } });
      }
      const botNames = bots.map((b) => iso(b.username ? `@${b.username}` : fullName(b))).join(t(lang, 'common.sep'));
      if (!auditOn && !ctx.quiet && cfg.n !== 'off') {
        const text = [t(lang, 'locks.bots_removed', { bots: botNames, user: iso(fullName(from)) })];
        if (cfg.n === 'custom' && cfg.txt) text.unshift(esc(cfg.txt).replace(/\{user\}/g, iso(fullName(from))).replace(/\{lock\}/g, esc(lockName(lang, 'bots'))));
        const rows = res && res.ok && res.row.kind !== 'kick' ? [[btn(t(lang, 'pun.btn_undo'), `pu:${res.id}`)]] : null;
        await postNotice(ctx, chat, text.join('\n'), rows);
      }
      if (cfg.log) await logs.post(ctx, chat, 'locks', t(lang, auditOn ? 'logs.lock_bots_audit' : 'logs.lock_bots', { bots: botNames, user: iso(fullName(from)) }));
    }
  }
  if (on.has('service') && on.get('service').del) {
    if (!auditOn) await deleteMessage(ctx, c, message.message_id, 'lock-service');
    await locks.recordHit(c, 'service', from ? from.id : 0, auditOn ? 'audit' : 'deleted', null);
    return true;
  }
  return false;
}

/*
 * A message (edited = an edit of one) in a group. Gives true when the message was deleted, so
 * nothing else (commands) acts on it.
 */
export async function check(ctx, chat, message, { edited = false } = {}) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel') return false;
  const c = chat.chat_id;
  const f = scan(message);
  if (f.newMembers.length) for (const u of f.newMembers) if (!u.is_bot) await members.joined(c, u.id);
  if (message.left_chat_member) await members.left(c, message.left_chat_member.id);
  const on = await locks.active(c);
  if (!on.size) return false;
  const bot = await me(ctx);
  if (f.service.length) return serviceMessage(ctx, chat, message, f, on, bot);
  let user = message.from || null;
  if (f.senderChat) {
    if (f.senderChat.id === c || f.automatic) return false; /* the anonymous admin; the linked channel's own posts */
    user = null; /* posted as a channel: Telegram hides the person */
  } else {
    if (!user || user.id === bot.id) return false;
    if (await isAdmin(c, user.id)) return false;
    if (await lists.has(c, 'vip', String(user.id))) return false;
  }
  const matched = await locks.evaluate(f, on, { env: locks.listEnv(c), bot, own: OWN, edited });
  const due = await applicable(ctx, chat, matched, user);
  if (!due.length) return false;
  const r = await act(ctx, chat, message, user, due);
  return r.deleted;
}

/* Telegram reported a join or a departure (chat_member): the join time for «new members only». */
export async function memberChange(chatId, user, wasIn, isIn) {
  if (!user || user.is_bot) return;
  if (!wasIn && isIn) await members.joined(chatId, user.id);
  else if (wasIn && !isIn) await members.left(chatId, user.id);
}

/* What the panel shows about Aegis's own rights for the locks. */
export function rightsProblem(chat) {
  const r = parseJson(chat.bot_rights, {});
  if (r.can_delete_messages !== true) return 'locks.bot_cant_delete';
  if (r.can_restrict_members !== true) return 'locks.bot_cant_restrict';
  return null;
}
