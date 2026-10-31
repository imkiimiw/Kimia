/*
 * Anti-betrayal: an admin who removes members (bans, kicks) or demotes other admins in a burst —
 * betray_n such actions within betray_sec — is stopped and reported.
 *
 * Actions are counted from chat_member updates (whatever the admin did in Telegram itself) and
 * from Aegis's own moderation commands and panel (counted for the person, not for the bot).
 * The response (settings betray_action):
 *   demote: the admin is demoted — Telegram allows that only for admins Aegis promoted
 *           (can_be_edited); the creator and admins appointed elsewhere can only be reported.
 *           A non-admin moderator (the «mod» list) loses that role.
 *   alert:  only reported.
 * Audit Mode: nothing is done, the incident is only recorded and reported.
 * Reported to the group (not a channel: that would reach every subscriber), the creator's private
 * chat and the log channel, with buttons to unban the removed members and — after a demotion that
 * turns out to be a false alarm — to restore the admin with the rights they had (bt:<id>:v / :r).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as audit from '../core/audit.js';
import { btn, me, send, tryCall } from '../core/tg.js';
import { iso, nowSec, parseJson } from '../core/util.js';
import { dur, t } from '../i18n/index.js';
import * as lists from './lists.js';
import * as logs from './logs.js';
import * as punish from './punish.js';
import { grantable, rightsOf } from './rights.js';
import * as settings from './settings.js';
import * as users from './users.js';

export const VICTIMS_MAX = 50;

export async function get(id) {
  return db.get(sql`SELECT * FROM aegis_incidents WHERE id = ${id}`);
}

export async function recent(chatId, limit = 10) {
  return db.all(sql`SELECT * FROM aegis_incidents WHERE chat_id = ${chatId} ORDER BY at DESC, id DESC LIMIT ${limit}`);
}

/*
 * A destructive action by `actorId` (kind: 'ban' for a ban or kick, 'demote' for demoting an
 * admin). Counted and checked. The bot's own actions are never counted here: commands count for
 * the person who gave them.
 */
export async function after(ctx, chat, actorId, targetId, kind) {
  if (!actorId) return null;
  if (actorId === (await me(ctx)).id) return null;
  await adminActions.record(chat.chat_id, actorId, targetId, kind);
  const s = await settings.all(ctx, chat.chat_id);
  if (!settings.flag(s, 'betray_on')) return null;
  const from = nowSec() - Number(s.betray_sec);
  const acts = await adminActions.since(chat.chat_id, actorId, from);
  if (acts.length < Number(s.betray_n)) return null;
  const open = await db.get(sql`SELECT id FROM aegis_incidents WHERE chat_id = ${chat.chat_id} AND actor_id = ${actorId} AND at >= ${from} LIMIT 1`);
  if (open) return null;
  return respond(ctx, chat, actorId, acts, s);
}

async function respond(ctx, chat, actorId, acts, s) {
  const ids = (k) => [...new Set(acts.filter((a) => a.kind === k).map((a) => Number(a.target_id)))];
  const victims = ids('ban').slice(0, VICTIMS_MAX);
  const demoted = ids('demote').slice(0, VICTIMS_MAX);
  const auditOnly = settings.flag(s, 'audit');
  const name = await users.displayName(actorId);
  let action = 'alert';
  let why = s.betray_action === 'alert' ? 'setting' : null;
  let punishId = 0;
  if (auditOnly) {
    action = 'audit';
    why = null;
  } else if (s.betray_action === 'demote') {
    const member = await tryCall(ctx, 'getChatMember', { chat_id: chat.chat_id, user_id: actorId }, 'betray-actor');
    if (await lists.has(chat.chat_id, 'mod', String(actorId))) {
      await lists.remove(chat.chat_id, 'mod', String(actorId), 0, { betrayal: true });
      action = 'unmod';
    }
    if (!member) why = 'unknown';
    else if (member.status === 'creator') why = 'creator';
    else if (member.status === 'administrator' && !member.can_be_edited) why = 'not_via_aegis';
    else if (member.status === 'administrator') {
      const rights = Object.keys(rightsOf(member)).filter((r) => grantable(chat.type).includes(r));
      const res = await punish.apply(ctx, chat, { userId: actorId, name, kind: 'demote', reason: t(chat.lang, 'betray.reason', { n: acts.length }),
        actorId: 0, source: 'betrayal', meta: { rights } });
      if (res.ok) {
        action = 'demoted';
        punishId = res.id;
      } else why = 'failed';
    }
  }
  const at = nowSec();
  const details = { bans: victims, demotes: demoted, punish: punishId, why };
  const r = await db.run(sql`INSERT INTO aegis_incidents (chat_id, actor_id, count, action, victims, at)
    VALUES (${chat.chat_id}, ${actorId}, ${acts.length}, ${action}, ${JSON.stringify(details)}, ${at}) RETURNING id`);
  const id = Number(r.rows[0].id);
  await audit.log(0, 'betrayal', { chatId: chat.chat_id, target: actorId, details: { id, n: acts.length, action, why } });
  const incident = await get(id);
  await report(ctx, chat, incident, name, Number(s.betray_sec));
  return incident;
}

/* The incident's text in `lang`. */
export function text(lang, chat, incident, name, windowSec) {
  const d = parseJson(incident.victims, {}) || {};
  const lines = [t(lang, 'betray.title', { title: iso(chat.title || String(chat.chat_id), 40) }),
    t(lang, 'betray.body', { name: iso(name), n: Number(incident.count), time: dur(lang, windowSec) })];
  if ((d.bans || []).length) lines.push(t(lang, 'betray.victims', { n: d.bans.length }));
  if ((d.demotes || []).length) lines.push(t(lang, 'betray.demotes', { n: d.demotes.length }));
  lines.push(t(lang, `betray.action_${incident.action}`));
  if (d.why) lines.push(t(lang, `betray.why_${d.why}`));
  return lines.join('\n');
}

export function buttons(lang, incident) {
  const d = parseJson(incident.victims, {}) || {};
  const row = [];
  if ((d.bans || []).length && !d.freed) row.push(btn(t(lang, 'betray.btn_unban', { n: d.bans.length }), `bt:${incident.id}:v`));
  if (d.punish && !d.restored) row.push(btn(t(lang, 'betray.btn_restore'), `bt:${incident.id}:r`));
  return row.length ? [row] : null;
}

async function report(ctx, chat, incident, name, windowSec) {
  if (ctx.quiet) return;
  if (chat.type !== 'channel') {
    await send(ctx, chat.chat_id, text(chat.lang, chat, incident, name, windowSec), buttons(chat.lang, incident), 'betrayal');
  }
  const creator = await db.get(sql`SELECT user_id FROM aegis_chat_admins WHERE chat_id = ${chat.chat_id} AND status = 'creator' LIMIT 1`);
  const cid = creator ? Number(creator.user_id) : 0;
  if (cid && cid !== Number(incident.actor_id)) {
    const u = await users.get(cid);
    if (u && Number(u.started) && !Number(u.blocked)) await send(ctx, cid, text(u.lang, chat, incident, name, windowSec), buttons(u.lang, incident), 'betrayal-pm');
  }
  await logs.post(ctx, chat, 'admin', text(chat.lang, chat, incident, name, windowSec), buttons(chat.lang, incident));
}

async function mark(incident, patch, actorId) {
  const d = { ...(parseJson(incident.victims, {}) || {}), ...patch };
  await db.run(sql`UPDATE aegis_incidents SET victims = ${JSON.stringify(d)}, undone_by = ${actorId}, undone_at = ${nowSec()} WHERE id = ${incident.id}`);
}

/* Unbans everyone the betrayer removed. Gives { n, failed } or 'done' (already). */
export async function freeVictims(ctx, chat, incident, actorId) {
  const d = parseJson(incident.victims, {}) || {};
  if (d.freed) return 'done';
  let n = 0;
  let failed = 0;
  for (const uid of (d.bans || []).slice(0, VICTIMS_MAX)) {
    const r = await punish.lift(ctx, chat, uid, ['ban', 'blacklist'], actorId);
    if (r === 'ok') n += 1;
    else failed += 1;
  }
  await mark(incident, { freed: true }, actorId);
  await audit.log(actorId, 'betrayal.unban', { chatId: chat.chat_id, target: Number(incident.actor_id), details: { id: Number(incident.id), n, failed } });
  return { n, failed };
}

/* Re-appoints the demoted admin with their former rights. Gives 'ok', 'done', 'gone' or { error }. */
export async function restore(ctx, chat, incident, actorId) {
  const d = parseJson(incident.victims, {}) || {};
  if (d.restored) return 'done';
  if (!d.punish) return 'gone';
  const r = await punish.undo(ctx, chat, Number(d.punish), actorId);
  if (r === 'ok' || r === 'not_active') await mark(incident, { restored: true }, actorId);
  return r === 'not_active' ? 'done' : r;
}

/* ========== adminActions (was engines/admin_actions.js) ========== */
/*
 * Destructive admin actions seen in a chat (aegis_admin_actions): bans and removals of members,
 * demotions of other admins — whether done in Telegram (chat_member updates) or through Aegis's
 * moderation commands. Anti-betrayal (engines/betrayal.js) counts them per admin in a window.
 */
export const adminActions = (() => {
async function record(chatId, actorId, targetId, kind) {
  await db.run(sql`INSERT INTO aegis_admin_actions (chat_id, actor_id, target_id, kind, at) VALUES (${chatId}, ${actorId}, ${targetId}, ${kind}, ${nowSec()})`);
}

async function since(chatId, actorId, from) {
  return db.all(sql`SELECT * FROM aegis_admin_actions WHERE chat_id = ${chatId} AND actor_id = ${actorId} AND at >= ${from} ORDER BY at LIMIT 500`);
}

async function sweep(now, keepSec) {
  const r = await db.run(sql`DELETE FROM aegis_admin_actions WHERE id IN (SELECT id FROM aegis_admin_actions WHERE at < ${now - keepSec} ORDER BY at LIMIT 500)`);
  return r.rowsAffected;
}

  return { record, since, sweep };
})();
