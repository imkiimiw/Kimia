/*
 * Punishments (aegis_punishments): warn, mute, restrict, quarantine, kick, ban, blacklist, demote.
 *
 * apply() does it in Telegram, records who did it (executor), why (reason) and how (source:
 * command, panel, list, step, blacklist, betrayal), mirrors it into its list (muted, restricted,
 * banned, blacklist, quarantine), logs it (audit log + log channel) and, for a warning, applies the
 * step ladder (engines/steps.js) on the member's active warnings.
 *
 * Audit Mode (setting audit): punishments Aegis decides on its own (steps, blacklist on join,
 * anti-betrayal, locks) are only recorded (status 'audit') and reported, never done. A punishment a person
 * asks for (a command, the panel) is done — it is a human decision.
 *
 * Every punishment is reversible except a kick (the member can simply rejoin): undo() lifts a
 * mute/restriction/quarantine, unbans, removes a warning, or re-appoints a demoted admin.
 * A timed punishment ends by itself in Telegram (until_date); its record then reads as expired.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as audit from '../core/audit.js';
import { call, describeError } from '../core/tg.js';
import { iso, nowSec, parseJson, short } from '../core/util.js';
import { dur, t } from '../i18n/index.js';
import * as admins from './admins.js';
import * as lists from './lists.js';
import * as logs from './logs.js';
import { demoteParams, promoteParams } from './rights.js';
import * as settings from './settings.js';
import { lastStep, stepAt } from './steps.js';
import * as users from './users.js';

export const KINDS = ['warn', 'mute', 'restrict', 'quarantine', 'kick', 'ban', 'blacklist', 'demote'];
export const TIMED = new Set(['mute', 'restrict', 'quarantine', 'ban']);
const AUTO = new Set(['step', 'blacklist', 'betrayal', 'lock']);
const PERMS = ['can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos', 'can_send_video_notes',
  'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages', 'can_add_web_page_previews', 'can_change_info', 'can_invite_users',
  'can_pin_messages', 'can_manage_topics'];
const perms = (on) => Object.fromEntries(PERMS.map((p) => [p, on.includes(p)]));
const NONE = perms([]);
const TEXT_ONLY = perms(['can_send_messages']);
const ALL = perms(PERMS);
export const LIFTS = { unmute: ['mute', 'quarantine'], unrestrict: ['restrict'], unban: ['ban', 'blacklist'] };

async function doInTelegram(ctx, chat, userId, kind, until) {
  const base = { chat_id: chat.chat_id, user_id: userId };
  const time = until ? { until_date: until } : {};
  if (kind === 'mute' || kind === 'quarantine') return call(ctx, 'restrictChatMember', { ...base, permissions: NONE, use_independent_chat_permissions: true, ...time }, `punish-${kind}`);
  if (kind === 'restrict') return call(ctx, 'restrictChatMember', { ...base, permissions: TEXT_ONLY, use_independent_chat_permissions: true, ...time }, 'punish-restrict');
  if (kind === 'ban' || kind === 'blacklist') return call(ctx, 'banChatMember', { ...base, ...time }, `punish-${kind}`);
  if (kind === 'kick') {
    await call(ctx, 'banChatMember', base, 'punish-kick');
    return call(ctx, 'unbanChatMember', { ...base, only_if_banned: true }, 'punish-kick-unban');
  }
  if (kind === 'demote') {
    await call(ctx, 'promoteChatMember', { ...base, ...demoteParams(chat.type) }, 'punish-demote');
    return admins.revoke(chat.chat_id, userId, 'demoted');
  }
  return null;
}

async function undoInTelegram(ctx, chat, row) {
  const base = { chat_id: chat.chat_id, user_id: Number(row.user_id) };
  if (['mute', 'quarantine', 'restrict'].includes(row.kind)) return call(ctx, 'restrictChatMember', { ...base, permissions: ALL }, 'undo-restrict');
  if (row.kind === 'ban' || row.kind === 'blacklist') return call(ctx, 'unbanChatMember', { ...base, only_if_banned: true }, 'undo-ban');
  if (row.kind === 'demote') {
    const rights = (parseJson(row.meta, {}) || {}).rights || [];
    await call(ctx, 'promoteChatMember', { ...base, ...promoteParams(chat.type, rights) }, 'undo-demote');
    return admins.cacheMember(chat.chat_id, await call(ctx, 'getChatMember', base, 'undo-demote-reread'));
  }
  return null;
}

export async function get(id) {
  return db.get(sql`SELECT * FROM aegis_punishments WHERE id = ${id}`);
}

export const isExpired = (row) => Number(row.until) > 0 && Number(row.until) <= nowSec();
export const isActive = (row) => row.status === 'active' && !isExpired(row);
export const undoable = (row) => isActive(row) && row.kind !== 'kick';

/* Active (counting) warnings of a member: unexpired per warn_ttl. */
export async function warnCount(ctx, chatId, userId) {
  const s = await settings.all(ctx, chatId);
  const ttl = Number(s.warn_ttl);
  const from = ttl > 0 ? nowSec() - ttl : 0;
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_punishments WHERE chat_id = ${chatId} AND user_id = ${userId}
    AND kind = 'warn' AND status = 'active' AND created_at >= ${from}`)).n);
}

/* One line for logs and notices, in `lang`. */
export function describe(lang, row, targetName, actorName) {
  const sec = Number(row.until) ? Number(row.until) - Number(row.created_at) : 0;
  return t(lang, 'pun.line', {
    icon: t(lang, `pun.icon_${row.kind}`),
    kind: t(lang, `pun.k_${row.kind}`),
    target: iso(targetName),
    actor: actorName ? iso(actorName) : t(lang, 'log.system'),
    time: TIMED.has(row.kind) ? (sec ? dur(lang, sec) : t(lang, 'pun.forever')) : '—',
    reason: row.reason ? iso(row.reason, 120) : '—',
  });
}

async function logIt(ctx, chat, row, targetName, actorName, key) {
  const head = t(chat.lang, key);
  await logs.post(ctx, chat, 'punish', `${head}\n${describe(chat.lang, row, targetName, actorName)}`);
}

/*
 * Punishes. p: { userId, name, kind, sec, reason, actorId, source, meta }.
 * Gives { ok: true, id, row, auditOnly, count?, max?, step?, stepResult? } or { ok: false, error }.
 */
export async function apply(ctx, chat, p) {
  const chatId = chat.chat_id;
  const s = await settings.all(ctx, chatId);
  const auditOnly = AUTO.has(p.source) && settings.flag(s, 'audit');
  const now = nowSec();
  const sec = TIMED.has(p.kind) ? Number(p.sec) || 0 : 0;
  const until = sec ? now + sec : 0;
  if (!auditOnly) {
    try {
      await doInTelegram(ctx, chat, p.userId, p.kind, until);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }
  const status = auditOnly ? 'audit' : (p.kind === 'kick' ? 'done' : 'active');
  const reason = p.reason ? short(p.reason, 200) : null;
  const r = await db.run(sql`INSERT INTO aegis_punishments (chat_id, user_id, kind, reason, actor_id, source, status, until, created_at, meta)
    VALUES (${chatId}, ${p.userId}, ${p.kind}, ${reason}, ${p.actorId || 0}, ${p.source}, ${status}, ${until}, ${now}, ${p.meta ? JSON.stringify(p.meta) : null}) RETURNING id`);
  const id = Number(r.rows[0].id);
  const row = await get(id);
  const mirror = lists.MIRRORS[p.kind];
  if (mirror && !auditOnly && p.source !== 'blacklist') await lists.upsert(chatId, mirror, { ekey: String(p.userId), value: p.name, userId: p.userId, note: reason, expiresAt: until }, p.actorId || 0);
  await audit.log(p.actorId || 0, auditOnly ? 'punish.audit' : `punish.${p.kind}`, { chatId, target: p.userId, details: { id, sec, reason, source: p.source } });
  const actorName = p.actorId ? await users.displayName(p.actorId) : null;
  await logIt(ctx, chat, row, p.name, actorName, auditOnly ? 'logs.audit' : 'logs.punished');
  const out = { ok: true, id, row, auditOnly };
  if (p.kind === 'warn') {
    const ladder = settings.steps(s);
    out.count = await warnCount(ctx, chatId, p.userId);
    out.max = lastStep(ladder).n;
    const step = stepAt(ladder, out.count);
    if (step) {
      out.step = step;
      out.stepResult = await apply(ctx, chat, { userId: p.userId, name: p.name, kind: step.a, sec: step.d, reason: t(chat.lang, 'pun.step_reason', { n: out.count }),
        actorId: 0, source: 'step', meta: { by: p.actorId || 0, warn: id } });
      if (step === lastStep(ladder) && settings.flag(s, 'warn_reset') && out.stepResult.ok && !out.stepResult.auditOnly) {
        await clearWarnings(ctx, chat, p.userId, 0, 'reset');
      }
    }
  }
  return out;
}

/* Undoes punishment `id`. Gives 'ok', 'gone', 'not_active', 'not_undoable' or { error }. */
export async function undo(ctx, chat, id, actorId) {
  const row = await get(id);
  if (!row || Number(row.chat_id) !== Number(chat.chat_id)) return 'gone';
  if (row.kind === 'kick') return 'not_undoable';
  if (!isActive(row)) return 'not_active';
  try {
    await undoInTelegram(ctx, chat, row);
  } catch (err) {
    return { error: describeError(err) };
  }
  await db.run(sql`UPDATE aegis_punishments SET status = 'undone', undone_by = ${actorId}, undone_at = ${nowSec()} WHERE id = ${id}`);
  const mirror = lists.MIRRORS[row.kind];
  if (mirror) await lists.remove(chat.chat_id, mirror, String(row.user_id), actorId, { undo: id });
  await audit.log(actorId, 'punish.undo', { chatId: chat.chat_id, target: Number(row.user_id), details: { id, kind: row.kind } });
  const targetName = await users.displayName(Number(row.user_id));
  await logIt(ctx, chat, row, targetName, actorId ? await users.displayName(actorId) : null, 'logs.undone');
  return 'ok';
}

/*
 * /unmute, /unrestrict, /unban and removing someone from a mirror list: undoes their active
 * punishment of those kinds, or lifts it in Telegram anyway (it may have been done outside Aegis).
 * Gives 'ok' or { error }.
 */
export async function lift(ctx, chat, userId, kinds, actorId) {
  const rows = await db.all(sql`SELECT * FROM aegis_punishments WHERE chat_id = ${chat.chat_id} AND user_id = ${userId} AND status = 'active'
    ORDER BY id DESC LIMIT 20`);
  const mine = rows.filter((r) => kinds.includes(r.kind) && isActive(r));
  for (const r of mine) {
    const res = await undo(ctx, chat, Number(r.id), actorId);
    if (res && res.error) return res;
  }
  if (!mine.length) {
    try {
      await undoInTelegram(ctx, chat, { user_id: userId, kind: kinds[0] });
    } catch (err) {
      return { error: describeError(err) };
    }
    for (const k of kinds) if (lists.MIRRORS[k]) await lists.remove(chat.chat_id, lists.MIRRORS[k], String(userId), actorId, { lift: true });
    await audit.log(actorId, 'punish.lift', { chatId: chat.chat_id, target: userId, details: { kinds } });
  }
  return 'ok';
}

/*
 * A ban done in Telegram itself by an admin (chat_member → kicked): recorded like Aegis's own, so
 * the banned list and the punishment history are complete and it can be undone from the panel.
 */
export async function recordOutside(ctx, chat, { userId, name, until, actorId }) {
  const open = await db.get(sql`SELECT id FROM aegis_punishments WHERE chat_id = ${chat.chat_id} AND user_id = ${userId} AND kind IN ('ban', 'blacklist')
    AND status = 'active' AND (until = 0 OR until > ${nowSec()}) LIMIT 1`);
  if (open) return Number(open.id);
  const r = await db.run(sql`INSERT INTO aegis_punishments (chat_id, user_id, kind, reason, actor_id, source, status, until, created_at)
    VALUES (${chat.chat_id}, ${userId}, 'ban', NULL, ${actorId}, 'telegram', 'active', ${until || 0}, ${nowSec()}) RETURNING id`);
  const id = Number(r.rows[0].id);
  await lists.upsert(chat.chat_id, 'ban', { ekey: String(userId), value: name, userId, expiresAt: until || 0 }, actorId);
  await audit.log(actorId, 'punish.outside', { chatId: chat.chat_id, target: userId, details: { id, until: until || 0 } });
  await logIt(ctx, chat, await get(id), name, await users.displayName(actorId), 'logs.outside');
  return id;
}

/* Lifted in Telegram itself (an admin unbanned someone): Aegis's records follow. */
export async function closeOutside(chat, userId, kinds, actorId) {
  let n = 0;
  for (const k of kinds) {
    const r = await db.run(sql`UPDATE aegis_punishments SET status = 'undone', undone_by = ${actorId}, undone_at = ${nowSec()}
      WHERE chat_id = ${chat.chat_id} AND user_id = ${userId} AND status = 'active' AND kind = ${k}`);
    n += r.rowsAffected;
    if (lists.MIRRORS[k]) await lists.remove(chat.chat_id, lists.MIRRORS[k], String(userId), actorId, { outside: true });
  }
  if (n) await audit.log(actorId, 'punish.lifted_outside', { chatId: chat.chat_id, target: userId, details: { kinds } });
  return n;
}

/* Clears a member's warnings (why: clear | reset). Gives how many. */
export async function clearWarnings(ctx, chat, userId, actorId, why = 'clear') {
  const r = await db.run(sql`UPDATE aegis_punishments SET status = 'undone', undone_by = ${actorId}, undone_at = ${nowSec()}
    WHERE chat_id = ${chat.chat_id} AND user_id = ${userId} AND kind = 'warn' AND status = 'active'`);
  if (r.rowsAffected) await audit.log(actorId, 'punish.unwarn', { chatId: chat.chat_id, target: userId, details: { n: r.rowsAffected, why } });
  return r.rowsAffected;
}

/* The latest active warning, undone (/unwarn). Gives 'ok' or 'none'. */
export async function removeLastWarning(ctx, chat, userId, actorId) {
  const w = await db.get(sql`SELECT id FROM aegis_punishments WHERE chat_id = ${chat.chat_id} AND user_id = ${userId} AND kind = 'warn' AND status = 'active'
    ORDER BY id DESC LIMIT 1`);
  if (!w) return 'none';
  return undo(ctx, chat, Number(w.id), actorId);
}

export async function setNotice(id, messageId) {
  await db.run(sql`UPDATE aegis_punishments SET notice_msg = ${messageId} WHERE id = ${id}`);
}

export async function recent(chatId, limit, offset) {
  return db.all(sql`SELECT * FROM aegis_punishments WHERE chat_id = ${chatId} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`);
}

export async function countAll(chatId) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_punishments WHERE chat_id = ${chatId}`)).n);
}

/* Members with active warnings (the warned list): { rows: [{ user_id, n, last }], total }. */
export async function warned(ctx, chatId, limit, offset) {
  const s = await settings.all(ctx, chatId);
  const ttl = Number(s.warn_ttl);
  const from = ttl > 0 ? nowSec() - ttl : 0;
  const rows = await db.all(sql`SELECT user_id, count(*) AS n, MAX(created_at) AS last, MAX(id) AS id FROM aegis_punishments
    WHERE chat_id = ${chatId} AND kind = 'warn' AND status = 'active' AND created_at >= ${from}
    GROUP BY user_id ORDER BY last DESC LIMIT ${limit} OFFSET ${offset}`);
  const total = Number((await db.get(sql`SELECT count(DISTINCT user_id) AS n FROM aegis_punishments
    WHERE chat_id = ${chatId} AND kind = 'warn' AND status = 'active' AND created_at >= ${from}`)).n);
  return { rows, total };
}

export async function warningsOf(chatId, userId, limit = 20) {
  return db.all(sql`SELECT * FROM aegis_punishments WHERE chat_id = ${chatId} AND user_id = ${userId} AND kind = 'warn' ORDER BY id DESC LIMIT ${limit}`);
}

/* A group became a supergroup: its punishments move with it. */
export async function migrate(oldId, newId) {
  await db.run(sql`UPDATE aegis_punishments SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_admin_actions SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_incidents SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
