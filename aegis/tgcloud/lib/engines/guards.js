/*
 * Group security (Phase 5): the modules' settings (aegis_guards) and their working memory —
 * flood counters, captchas, emergency/read-only/raid lockdowns, risk alerts, recently seen media
 * and ad fingerprints.
 *
 * Modules and their settings (defaults in MODULES, allowed values in CHOICES):
 *   antilink    a d del (punishment, duration, delete), sc (all | new members), btn (button links)
 *   antiads     a d del, win (a member is "new" this long after joining), xg (same ad in other groups)
 *   flood       a d del, n messages in t seconds, dup (the same message this many times; 0 = off)
 *   raid        n joins in t seconds → act (captcha | quarantine | lock | alert) for dur seconds
 *   captcha     mode (button | math), to (seconds to answer), fail (kick | ban | mute), jr (join requests)
 *   quarantine  dur (seconds after joining), lvl (text = text only | mute = nothing)
 *   suspicious  inv homo dec file dupm (which checks), a d del
 *   risk        lv (low | medium | high thresholds), a d del, w (the weights learned from feedback)
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { LOCK_DURATIONS, RISK_KEEP_SEC, SEC_KEEP_SEC, SWEEP_LIMIT } from '../config.js';
import * as audit from '../core/audit.js';
import { nowSec, parseJson } from '../core/util.js';
import { ACTIONS } from './locks.js';

export const MODULES = {
  antilink: { on: 0, a: 'none', d: 0, del: 1, sc: 'all', btn: 1 },
  antiads: { on: 0, a: 'mute', d: 86400, del: 1, win: 600, xg: 1 },
  flood: { on: 0, a: 'mute', d: 600, del: 1, n: 5, t: 5, dup: 3 },
  raid: { on: 0, n: 10, t: 60, act: 'captcha', dur: 1800 },
  captcha: { on: 0, mode: 'button', to: 180, fail: 'kick', jr: 1 },
  quarantine: { on: 0, dur: 3600, lvl: 'text' },
  suspicious: { on: 0, inv: 1, homo: 1, dec: 1, file: 1, dupm: 1, a: 'none', d: 0, del: 1 },
  risk: { on: 0, lv: 'medium', a: 'mute', d: 86400, del: 1, w: {} },
};
export const CODES = Object.keys(MODULES);
const BIT = [0, 1];
const CHOICES = {
  on: BIT, a: ACTIONS, d: LOCK_DURATIONS, del: BIT, sc: ['all', 'new'], btn: BIT, win: [300, 600, 3600, 86400], xg: BIT,
  dup: [0, 2, 3, 5], act: ['captcha', 'quarantine', 'lock', 'alert'], mode: ['button', 'math'], to: [60, 180, 600], fail: ['kick', 'ban', 'mute'],
  jr: BIT, lvl: ['text', 'mute'], inv: BIT, homo: BIT, dec: BIT, file: BIT, dupm: BIT, lv: ['low', 'medium', 'high'],
};
const PER_MODULE = {
  flood: { n: [3, 5, 8, 12], t: [3, 5, 10, 30] },
  raid: { n: [5, 10, 20, 50], t: [30, 60, 300], dur: [600, 1800, 3600, 21600] },
  quarantine: { dur: [600, 3600, 21600, 86400] },
};

export const choices = (code, field) => (PER_MODULE[code] && PER_MODULE[code][field]) || CHOICES[field] || null;

export function normalize(code, raw) {
  const def = MODULES[code];
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    if (k === 'w') {
      const w = {};
      for (const [s, m] of Object.entries(src.w && typeof src.w === 'object' ? src.w : {})) if (Number(m) >= 0.3 && Number(m) <= 2) w[s] = Number(m);
      out.w = w;
      continue;
    }
    const allowed = choices(code, k);
    out[k] = allowed && allowed.includes(src[k]) ? src[k] : v;
  }
  return out;
}

/* ---------- settings ---------- */

export async function all(ctx, chatId) {
  ctx.guards = ctx.guards || {};
  if (ctx.guards[chatId]) return ctx.guards[chatId];
  const rows = await db.all(sql`SELECT code, config FROM aegis_guards WHERE chat_id = ${chatId} LIMIT 20`);
  const out = {};
  for (const c of CODES) out[c] = normalize(c, null);
  for (const r of rows) if (MODULES[r.code]) out[r.code] = normalize(r.code, parseJson(r.config, {}));
  ctx.guards[chatId] = out;
  return out;
}

export const anyOn = (g) => CODES.some((c) => g[c].on);

/* Changes some settings of a module (validated, logged). Gives the new config. */
export async function update(ctx, chatId, code, patch, actorId, { quiet = false } = {}) {
  if (!MODULES[code]) return null;
  const g = await all(ctx, chatId);
  const before = g[code];
  const next = normalize(code, { ...before, ...patch });
  const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
  if (!changed.length) return next;
  await db.run(sql`INSERT INTO aegis_guards (chat_id, code, enabled, config, updated_by, updated_at)
    VALUES (${chatId}, ${code}, ${next.on}, ${JSON.stringify(next)}, ${actorId}, ${nowSec()})
    ON CONFLICT(chat_id, code) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  g[code] = next;
  if (!quiet) {
    const details = {};
    for (const k of changed) details[k] = k === 'w' ? '…' : next[k];
    await audit.log(actorId, 'guard.set', { chatId, target: code, details });
  }
  return next;
}

/* ---------- flood counters ---------- */

/* Counts one message: { n (in the flood window), dup (same fingerprint in a row), msgs (all), punishedAt }. */
export async function countMessage(chatId, userId, hash, windowSec) {
  const now = nowSec();
  const r = await db.run(sql`INSERT INTO aegis_flood (chat_id, user_id, win_at, n, last_hash, dup_n, msgs, at)
    VALUES (${chatId}, ${userId}, ${now}, 1, ${hash}, 1, 1, ${now})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      n = CASE WHEN aegis_flood.win_at >= ${now - windowSec} THEN aegis_flood.n + 1 ELSE 1 END,
      win_at = CASE WHEN aegis_flood.win_at >= ${now - windowSec} THEN aegis_flood.win_at ELSE ${now} END,
      dup_n = CASE WHEN aegis_flood.last_hash = excluded.last_hash AND aegis_flood.at >= ${now - 60} THEN aegis_flood.dup_n + 1 ELSE 1 END,
      last_hash = excluded.last_hash, msgs = aegis_flood.msgs + 1, at = excluded.at
    RETURNING n, dup_n, msgs, punished_at`);
  const x = r.rows[0];
  return { n: Number(x.n), dup: Number(x.dup_n), msgs: Number(x.msgs), punishedAt: Number(x.punished_at) };
}

/* Claims the right to punish a flood once per window. */
export async function claimFloodPunish(chatId, userId, windowSec) {
  const now = nowSec();
  const r = await db.run(sql`UPDATE aegis_flood SET punished_at = ${now} WHERE chat_id = ${chatId} AND user_id = ${userId} AND punished_at < ${now - windowSec}`);
  return r.rowsAffected > 0;
}

/* ---------- media and ad fingerprints ---------- */

export async function seenMedia(fileUid, chatId, userId) {
  const since = nowSec() - SEC_KEEP_SEC;
  const here = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_media_seen WHERE file_uid = ${fileUid} AND at >= ${since} AND chat_id = ${chatId}`)).n);
  const elsewhere = Number((await db.get(sql`SELECT count(DISTINCT chat_id) AS n FROM aegis_media_seen WHERE file_uid = ${fileUid} AND at >= ${since}
    AND user_id = ${userId} AND chat_id != ${chatId}`)).n);
  await db.run(sql`INSERT INTO aegis_media_seen (file_uid, chat_id, user_id, at) VALUES (${fileUid}, ${chatId}, ${userId}, ${nowSec()})`);
  return { here, elsewhere };
}

/* How many other chats got the same ad-like text from this person recently (then this one is recorded). */
export async function seenAd(userId, hash, chatId, windowSec) {
  const n = Number((await db.get(sql`SELECT count(DISTINCT chat_id) AS n FROM aegis_msg_hashes WHERE user_id = ${userId} AND hash = ${hash}
    AND at >= ${nowSec() - windowSec} AND chat_id != ${chatId}`)).n);
  await db.run(sql`INSERT INTO aegis_msg_hashes (user_id, hash, chat_id, at) VALUES (${userId}, ${hash}, ${chatId}, ${nowSec()})`);
  return n;
}

export async function recentJoins(chatId, sinceSec) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_members WHERE chat_id = ${chatId} AND joined_at >= ${nowSec() - sinceSec}`)).n);
}

/* ---------- captchas ---------- */

export async function newCaptcha(chatId, userId, kind, cap, question, expiresAt) {
  await db.run(sql`UPDATE aegis_captchas SET status = 'expired' WHERE chat_id = ${chatId} AND user_id = ${userId} AND status = 'pending'`);
  const r = await db.run(sql`INSERT INTO aegis_captchas (chat_id, user_id, kind, answer, options, question, created_at, expires_at)
    VALUES (${chatId}, ${userId}, ${kind}, ${cap.answer}, ${JSON.stringify(cap.options)}, ${question}, ${nowSec()}, ${expiresAt}) RETURNING id`);
  return Number(r.rows[0].id);
}

export async function setCaptchaMessage(id, chatId, messageId) {
  await db.run(sql`UPDATE aegis_captchas SET msg_chat = ${chatId}, msg_id = ${messageId} WHERE id = ${id}`);
}

export const captcha = (id) => db.get(sql`SELECT * FROM aegis_captchas WHERE id = ${id}`);

export async function pendingCaptcha(chatId, userId) {
  return db.get(sql`SELECT * FROM aegis_captchas WHERE chat_id = ${chatId} AND user_id = ${userId} AND status = 'pending' ORDER BY id DESC LIMIT 1`);
}

export async function captchaAttempt(id) {
  const r = await db.run(sql`UPDATE aegis_captchas SET attempts = attempts + 1 WHERE id = ${id} AND status = 'pending' RETURNING attempts`);
  return r.rows.length ? Number(r.rows[0].attempts) : null;
}

/* Ends a pending captcha once (a second press or a sweep finds it already ended). */
export async function finishCaptcha(id, status) {
  const r = await db.run(sql`UPDATE aegis_captchas SET status = ${status} WHERE id = ${id} AND status = 'pending'`);
  return r.rowsAffected > 0;
}

/* Passed (or approved) recently: a join request's captcha counts for the join that follows. */
export async function recentPass(chatId, userId, since) {
  return !!(await db.get(sql`SELECT id FROM aegis_captchas WHERE chat_id = ${chatId} AND user_id = ${userId} AND status IN ('passed', 'approved')
    AND created_at >= ${since} LIMIT 1`));
}

export async function expiredCaptchas(now, chatId = null) {
  if (chatId !== null) {
    return db.all(sql`SELECT * FROM aegis_captchas WHERE status = 'pending' AND expires_at <= ${now} AND chat_id = ${chatId} ORDER BY expires_at LIMIT ${SWEEP_LIMIT}`);
  }
  return db.all(sql`SELECT * FROM aegis_captchas WHERE status = 'pending' AND expires_at <= ${now} ORDER BY expires_at LIMIT ${SWEEP_LIMIT}`);
}

/* ---------- lockdowns ---------- */

export async function lockdown(chatId, kind) {
  return db.get(sql`SELECT * FROM aegis_lockdowns WHERE chat_id = ${chatId} AND kind = ${kind} AND active = 1 ORDER BY id DESC LIMIT 1`);
}

export async function lockdowns(chatId) {
  return db.all(sql`SELECT * FROM aegis_lockdowns WHERE chat_id = ${chatId} AND active = 1 ORDER BY id LIMIT 5`);
}

export async function startLockdown(chatId, kind, saved, reason, byId, until) {
  const r = await db.run(sql`INSERT INTO aegis_lockdowns (chat_id, kind, saved, reason, by_id, started_at, until)
    VALUES (${chatId}, ${kind}, ${saved ? JSON.stringify(saved) : null}, ${reason || null}, ${byId}, ${nowSec()}, ${until}) RETURNING id`);
  return Number(r.rows[0].id);
}

export async function endLockdown(id, byId) {
  const r = await db.run(sql`UPDATE aegis_lockdowns SET active = 0, ended_at = ${nowSec()}, ended_by = ${byId} WHERE id = ${id} AND active = 1`);
  return r.rowsAffected > 0;
}

export const lockdownById = (id) => db.get(sql`SELECT * FROM aegis_lockdowns WHERE id = ${id}`);

export async function dueLockdowns(now, chatId = null) {
  if (chatId !== null) {
    return db.all(sql`SELECT * FROM aegis_lockdowns WHERE active = 1 AND until > 0 AND until <= ${now} AND chat_id = ${chatId} LIMIT ${SWEEP_LIMIT}`);
  }
  return db.all(sql`SELECT * FROM aegis_lockdowns WHERE active = 1 AND until > 0 AND until <= ${now} ORDER BY until LIMIT ${SWEEP_LIMIT}`);
}

/* ---------- risk alerts ---------- */

export async function addRisk(chatId, userId, score, reasons, action, punishId) {
  const r = await db.run(sql`INSERT INTO aegis_risk_events (chat_id, user_id, score, reasons, action, punish_id, at)
    VALUES (${chatId}, ${userId}, ${score}, ${JSON.stringify(reasons)}, ${action}, ${punishId || 0}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

export const riskEvent = (id) => db.get(sql`SELECT * FROM aegis_risk_events WHERE id = ${id}`);

export async function riskFeedback(id, feedback, byId) {
  const r = await db.run(sql`UPDATE aegis_risk_events SET feedback = ${feedback}, feedback_by = ${byId} WHERE id = ${id} AND feedback IS NULL`);
  return r.rowsAffected > 0;
}

export async function recentRisk(chatId, limit = 8) {
  return db.all(sql`SELECT * FROM aegis_risk_events WHERE chat_id = ${chatId} ORDER BY at DESC, id DESC LIMIT ${limit}`);
}

/* ---------- housekeeping and migration ---------- */

export async function sweep(now) {
  const del = async (q) => (await db.run(q)).rowsAffected;
  return {
    flood: await del(sql`DELETE FROM aegis_flood WHERE rowid IN (SELECT rowid FROM aegis_flood WHERE at < ${now - SEC_KEEP_SEC} LIMIT 500)`),
    media: await del(sql`DELETE FROM aegis_media_seen WHERE id IN (SELECT id FROM aegis_media_seen WHERE at < ${now - SEC_KEEP_SEC} ORDER BY at LIMIT 500)`),
    hashes: await del(sql`DELETE FROM aegis_msg_hashes WHERE id IN (SELECT id FROM aegis_msg_hashes WHERE at < ${now - SEC_KEEP_SEC} ORDER BY at LIMIT 500)`),
    risk: await del(sql`DELETE FROM aegis_risk_events WHERE id IN (SELECT id FROM aegis_risk_events WHERE at < ${now - RISK_KEEP_SEC} ORDER BY at LIMIT 500)`),
    captchas: await del(sql`DELETE FROM aegis_captchas WHERE id IN (SELECT id FROM aegis_captchas WHERE status != 'pending' AND created_at < ${now - 7 * 86400} LIMIT 500)`),
  };
}

export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_guards WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_guards SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_lockdowns SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_risk_events SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`UPDATE aegis_captchas SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  await db.run(sql`DELETE FROM aegis_flood WHERE chat_id = ${oldId}`);
}
