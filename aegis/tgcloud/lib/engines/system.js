/*
 * Bot-wide state and the Super Admin panel's data (ui/admin.js).
 *
 * The global switch (owner only: /shutdown, /activate) and the numbers behind /status: aegis_kv
 * (shutdown '1'/'0', shutdown_at, shutdown_by, activated_at), so it survives deploys. While shut down,
 * Aegis answers nobody but the owner, posts nothing in groups, and background work (broadcast chunks)
 * stops; membership changes are still recorded quietly (lib/router.js).
 *
 * Phase 10, in sections:
 * - staff: the bot's team (aegis_staff) and its access levels viewer < support < manager; the owner
 *   is above all of them and is never stored. levelOf() is read fresh on every button press.
 * - globals: system settings in aegis_kv — g_new_chats, g_fun, g_media, g_err_notify, g_jobs ('0' =
 *   off, anything else = on), g_log_chat (the global log channel for the audit seals), g_suspended
 *   (JSON {chat id: [at, by]}: chats the team suspended — Aegis ignores them, lib/router.js).
 * - seals: the audit log's SHA-256 hash chain (aegis_audit_seals); a row changed or deleted after it
 *   was sealed breaks its seal. Database triggers (data migration 3) refuse UPDATE/DELETE on both
 *   tables; the seals' hashes are also posted to the global log channel, outside the database.
 * - health and queues: what the health and queue screens show.
 * - chats: the global chat list, details, refresh, leave.
 * - globalBackup: the bot-wide configuration file and its validated restore.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  GLOBAL_BACKUP_MAX, LATE_SEC, MAX_JOIN_CHANNELS, OWNER_ID, PHASE, RESTORE_STEP, SEAL_MAX_ROWS, SEALS_PER_RUN, STAFF_MAX, SUSPEND_MAX,
  UPDATE_RETRY_SEC, VERIFY_SEALS, VERSION,
} from '../config.js';
import * as audit from '../core/audit.js';
import { sha256 } from '../core/files.js';
import * as kv from '../core/kv.js';
import { call, describeError, isApiError, me, tryCall } from '../core/tg.js';
import { nowSec, parseJson, toInt, utf8Bytes } from '../core/util.js';
import * as backup from './backup.js';
import * as bc from './broadcast.js';
import * as chats from './chats.js';
import * as join from './join.js';
import * as users from './users.js';

export const isShutdown = (s) => s.shutdown === '1';

export async function shutdown(ctx, actorId) {
  const s = await kv.all(ctx);
  if (isShutdown(s)) return false;
  await kv.set(ctx, 'shutdown', '1');
  await kv.set(ctx, 'shutdown_at', nowSec());
  await kv.set(ctx, 'shutdown_by', actorId);
  await audit.log(actorId, 'system.shutdown');
  return true;
}

export async function activate(ctx, actorId) {
  const s = await kv.all(ctx);
  if (!isShutdown(s)) return false;
  await kv.set(ctx, 'shutdown', '0');
  await kv.set(ctx, 'activated_at', nowSec());
  await audit.log(actorId, 'system.activate', { details: { downSec: nowSec() - Number(s.shutdown_at || nowSec()) } });
  return true;
}

const count = async (q) => Number((await db.get(q)).n);

/*
 * getWebhookInfo, or { managed: true } where the platform keeps it to itself (Telegram Serverless answers
 * 403 «Method getWebhookInfo is restricted»: it manages the webhook — `npx tgcloud webhook` shows it), or null.
 */
async function webhookInfo(ctx) {
  try {
    const hook = await call(ctx, 'getWebhookInfo', {}, 'webhook-info');
    return {
      set: !!hook.url, pending: Number(hook.pending_update_count || 0), lastError: hook.last_error_message || null,
      lastErrorAt: Number(hook.last_error_date || 0), types: (hook.allowed_updates || []).length,
    };
  } catch (err) {
    if (isApiError(err) && err.code === 403 && /restricted/i.test(err.description)) return { managed: true };
    return null;
  }
}

export async function status(ctx) {
  const s = await kv.all(ctx);
  const now = nowSec();
  const c = await chats.counts();
  const lastErr = await db.get(sql`SELECT at, source, message FROM aegis_errors ORDER BY id DESC LIMIT 1`);
  const errs = await count(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${now - 86400}`);
  const hook = await webhookInfo(ctx);
  const active = await bc.active();
  return {
    shutdown: isShutdown(s),
    since: Number(isShutdown(s) ? s.shutdown_at : s.activated_at) || 0,
    by: Number(s.shutdown_by || OWNER_ID),
    version: VERSION,
    phase: PHASE,
    dataVersion: Number(s.data_version || 0),
    users: await users.countReachable(),
    groups: c.groups,
    channels: c.channels,
    registered: await chats.countRegistered(),
    broadcast: active ? { id: Number(active.id), status: active.status } : null,
    errors24h: errs,
    lastError: lastErr ? { at: Number(lastErr.at), source: lastErr.source, message: lastErr.message } : null,
    webhook: hook,
  };
}

/* ---------- staff ---------- */

export const staff = (() => {
  const LEVELS = ['viewer', 'support', 'manager'];
  const RANK = { viewer: 1, support: 2, manager: 3, owner: 9 };
  const can = (level, need) => !!level && (RANK[level] || 0) >= (RANK[need] || 99);
  const get = (userId) => db.get(sql`SELECT * FROM aegis_staff WHERE user_id = ${userId}`);
  const list = () => db.all(sql`SELECT * FROM aegis_staff ORDER BY added_at, user_id LIMIT ${STAFF_MAX}`);
  const total = () => count(sql`SELECT count(*) AS n FROM aegis_staff`);

  /* 'owner', a staff level, or null — read fresh every time (a removed member loses access at once). */
  async function levelOf(userId) {
    if (userId === OWNER_ID) return 'owner';
    const r = await get(userId);
    return r && LEVELS.includes(r.level) ? r.level : null;
  }

  /* Adds or changes a member. Gives 'added', 'changed', 'same', 'full' or 'invalid'. */
  async function set(actorId, userId, level, name) {
    if (!LEVELS.includes(level) || !Number.isSafeInteger(userId) || userId <= 0 || userId === OWNER_ID) return 'invalid';
    const now = nowSec();
    const before = await get(userId);
    if (before && before.level === level) return 'same';
    if (!before && (await total()) >= STAFF_MAX) return 'full';
    await db.run(sql`INSERT INTO aegis_staff (user_id, level, name, added_by, added_at, updated_at)
      VALUES (${userId}, ${level}, ${name ? String(name).slice(0, 64) : null}, ${actorId}, ${now}, ${now})
      ON CONFLICT(user_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`);
    await audit.log(actorId, before ? 'staff.level' : 'staff.add', { target: userId, details: { level, from: before ? before.level : null } });
    return before ? 'changed' : 'added';
  }

  async function remove(actorId, userId) {
    const before = await get(userId);
    if (!before) return false;
    await db.run(sql`DELETE FROM aegis_staff WHERE user_id = ${userId}`);
    await audit.log(actorId, 'staff.remove', { target: userId, details: { level: before.level } });
    return true;
  }

  return { LEVELS, RANK, can, get, list, total, levelOf, set, remove };
})();

/* ---------- system settings ---------- */

export const globals = (() => {
  const FLAGS = ['g_new_chats', 'g_fun', 'g_media', 'g_err_notify', 'g_jobs'];
  const on = (s, key) => (s || {})[key] !== '0';

  async function setFlag(ctx, actorId, key, value) {
    if (!FLAGS.includes(key)) return false;
    await kv.set(ctx, key, value ? '1' : '0');
    await audit.log(actorId, 'system.setting', { target: key, details: { on: !!value } });
    return true;
  }

  const logChat = (s) => toInt((s || {}).g_log_chat) || 0;

  async function setLogChat(ctx, actorId, channelId) {
    await kv.set(ctx, 'g_log_chat', channelId ? String(channelId) : '');
    await audit.log(actorId, 'system.log_chat', { target: channelId ? String(channelId) : null });
  }

  /* Suspended chats: {chat id: [at, by]}. */
  function suspended(s) {
    const m = parseJson((s || {}).g_suspended, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  }
  const suspendedSet = (s) => new Set(Object.keys(suspended(s)).map(Number));

  /* Gives 'done', 'same' or 'full'. */
  async function suspend(ctx, actorId, chatId, value) {
    const m = suspended(await kv.all(ctx));
    const key = String(chatId);
    if (!!m[key] === !!value) return 'same';
    if (value && Object.keys(m).length >= SUSPEND_MAX) return 'full';
    if (value) m[key] = [nowSec(), actorId];
    else delete m[key];
    await kv.set(ctx, 'g_suspended', JSON.stringify(m));
    await audit.log(actorId, value ? 'chat.suspend' : 'chat.unsuspend', { chatId });
    return 'done';
  }

  return { FLAGS, on, setFlag, logChat, setLogChat, suspended, suspendedSet, suspend };
})();

/* ---------- the audit log's seals ---------- */

export const seals = (() => {
  const ZERO = '0'.repeat(64);
  const str = (v) => (v === null || v === undefined ? null : String(v));
  const line = (r) => JSON.stringify([Number(r.id), Number(r.at), Number(r.actor_id), Number(r.chat_id), String(r.action), str(r.target), str(r.details)]);
  const hashOf = (prev, rows) => sha256(utf8Bytes(`${prev}\n${rows.map(line).join('\n')}`));
  const last = () => db.get(sql`SELECT * FROM aegis_audit_seals ORDER BY id DESC LIMIT 1`);
  const rowsIn = (from, to) => db.all(sql`SELECT * FROM aegis_audit WHERE id >= ${from} AND id <= ${to} ORDER BY id LIMIT ${SEAL_MAX_ROWS + 1}`);

  /* Seals the rows written since the last seal (up to SEALS_PER_RUN seals). Gives the new seals. */
  async function sealNow(ctx, { runs = SEALS_PER_RUN } = {}) {
    const made = [];
    for (let i = 0; i < runs; i += 1) {
      const prev = await last();
      const from = prev ? Number(prev.to_id) + 1 : 1;
      const rows = await db.all(sql`SELECT * FROM aegis_audit WHERE id >= ${from} ORDER BY id LIMIT ${SEAL_MAX_ROWS}`);
      if (!rows.length) break;
      const to = Number(rows[rows.length - 1].id);
      const prevHash = prev ? prev.hash : ZERO;
      const hash = hashOf(prevHash, rows);
      const at = nowSec();
      /* one seal per range, even if two updates seal at the same moment */
      const r = await db.run(sql`INSERT INTO aegis_audit_seals (from_id, to_id, rows, prev, hash, at, posted_msg)
        SELECT ${from}, ${to}, ${rows.length}, ${prevHash}, ${hash}, ${at}, 0
        WHERE NOT EXISTS (SELECT 1 FROM aegis_audit_seals WHERE to_id >= ${from})`);
      if (!r.rowsAffected) break;
      const seal = await last();
      made.push(seal);
      if (rows.length < SEAL_MAX_ROWS) break;
    }
    if (made.length && ctx) await post(ctx, made);
    return made;
  }

  /* Copies new seals' hashes to the global log channel, if one is set (outside the database). */
  async function post(ctx, list) {
    const chatId = globals.logChat(await kv.all(ctx));
    if (!chatId) return;
    for (const sl of list) {
      const text = `🔏 Aegis audit seal #${sl.id}\nrows ${sl.from_id}–${sl.to_id} (${sl.rows})\nprev ${sl.prev.slice(0, 16)}…\n<code>${sl.hash}</code>`;
      const m = await tryCall(ctx, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_notification: true }, 'audit-seal');
      if (m && m.message_id) await db.run(sql`UPDATE aegis_audit_seals SET posted_msg = ${m.message_id} WHERE id = ${sl.id}`);
    }
  }

  async function guardOn() {
    try {
      return (await count(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'aegis_audit%'`)) >= 4;
    } catch (err) {
      return false;
    }
  }

  async function summary() {
    const l = await last();
    const maxRow = await db.get(sql`SELECT max(id) AS id FROM aegis_audit`);
    const top = Number((maxRow && maxRow.id) || 0);
    return {
      seals: await count(sql`SELECT count(*) AS n FROM aegis_audit_seals`),
      last: l ? { id: Number(l.id), to: Number(l.to_id), at: Number(l.at), hash: l.hash, posted: Number(l.posted_msg) > 0 } : null,
      rows: top,
      unsealed: Math.max(0, top - (l ? Number(l.to_id) : 0)),
      guard: await guardOn(),
    };
  }

  /*
   * Re-checks up to VERIFY_SEALS seals from seal id `from`: the chain (each prev = the hash before),
   * the ranges (no gap), the row count and the hash. Gives { checked, rows, bad: [{ id, why }], next }.
   */
  async function verify(from = 1) {
    const list = await db.all(sql`SELECT * FROM aegis_audit_seals WHERE id >= ${from} ORDER BY id LIMIT ${VERIFY_SEALS + 1}`);
    const more = list.length > VERIFY_SEALS;
    const todo = list.slice(0, VERIFY_SEALS);
    const before = todo.length ? await db.get(sql`SELECT * FROM aegis_audit_seals WHERE id < ${todo[0].id} ORDER BY id DESC LIMIT 1`) : null;
    let prevHash = before ? before.hash : ZERO;
    let prevTo = before ? Number(before.to_id) : 0;
    const bad = [];
    let rows = 0;
    for (const sl of todo) {
      if (sl.prev !== prevHash) bad.push({ id: Number(sl.id), why: 'chain' });
      else if (Number(sl.from_id) !== prevTo + 1) bad.push({ id: Number(sl.id), why: 'gap' });
      else {
        const got = await rowsIn(Number(sl.from_id), Number(sl.to_id));
        rows += got.length;
        if (got.length !== Number(sl.rows)) bad.push({ id: Number(sl.id), why: 'count' });
        else if (hashOf(sl.prev, got) !== sl.hash) bad.push({ id: Number(sl.id), why: 'hash' });
      }
      prevHash = sl.hash;
      prevTo = Number(sl.to_id);
    }
    return { checked: todo.length, rows, bad, next: more ? Number(list[VERIFY_SEALS].id) : 0 };
  }

  /* The database triggers that make both tables append-only (data migration 3). */
  async function installGuard() {
    await db.run(sql`CREATE TRIGGER IF NOT EXISTS aegis_audit_no_update BEFORE UPDATE ON aegis_audit
      BEGIN SELECT RAISE(ABORT, 'aegis_audit is append-only'); END`);
    await db.run(sql`CREATE TRIGGER IF NOT EXISTS aegis_audit_no_delete BEFORE DELETE ON aegis_audit
      BEGIN SELECT RAISE(ABORT, 'aegis_audit is append-only'); END`);
    await db.run(sql`CREATE TRIGGER IF NOT EXISTS aegis_audit_seals_no_update BEFORE UPDATE OF from_id, to_id, rows, prev, hash, at ON aegis_audit_seals
      BEGIN SELECT RAISE(ABORT, 'aegis_audit_seals is append-only'); END`);
    await db.run(sql`CREATE TRIGGER IF NOT EXISTS aegis_audit_seals_no_delete BEFORE DELETE ON aegis_audit_seals
      BEGIN SELECT RAISE(ABORT, 'aegis_audit_seals is append-only'); END`);
  }

  return { ZERO, line, hashOf, last, sealNow, summary, verify, installGuard, guardOn };
})();

/* ---------- health and queues ---------- */

export async function queues(now = nowSec()) {
  const late = now - LATE_SEC;
  return {
    broadcasts: { running: await count(sql`SELECT count(*) AS n FROM aegis_broadcasts WHERE status IN ('running', 'paused')`),
      queued: await count(sql`SELECT count(*) AS n FROM aegis_broadcasts WHERE status = 'queued'`) },
    posts: { pending: await count(sql`SELECT count(*) AS n FROM aegis_post_queue WHERE status = 'pending'`),
      scheduled: await count(sql`SELECT count(*) AS n FROM aegis_post_queue WHERE status = 'scheduled'`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_post_queue WHERE status = 'scheduled' AND publish_at < ${late}`) },
    schedules: { total: await count(sql`SELECT count(*) AS n FROM aegis_schedules`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_schedules WHERE next_at < ${late}`) },
    backups: { running: await count(sql`SELECT count(*) AS n FROM aegis_backup_jobs WHERE status = 'running'`),
      failed: await count(sql`SELECT count(*) AS n FROM aegis_backup_jobs WHERE status = 'failed'`) },
    captchas: { pending: await count(sql`SELECT count(*) AS n FROM aegis_captchas WHERE status = 'pending'`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_captchas WHERE status = 'pending' AND expires_at < ${late}`) },
    lockdowns: { active: await count(sql`SELECT count(*) AS n FROM aegis_lockdowns WHERE active = 1`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_lockdowns WHERE active = 1 AND until > 0 AND until < ${late}`) },
    contests: { running: await count(sql`SELECT count(*) AS n FROM aegis_contests WHERE status = 'running'`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_contests WHERE status = 'running' AND ends_at < ${late}`) },
    polls: { open: await count(sql`SELECT count(*) AS n FROM aegis_polls WHERE status = 'open' AND closes_at > 0`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_polls WHERE status = 'open' AND closes_at > 0 AND closes_at < ${late}`) },
    games: { running: await count(sql`SELECT count(*) AS n FROM aegis_fun_games WHERE status = 'running'`),
      late: await count(sql`SELECT count(*) AS n FROM aegis_fun_games WHERE status = 'running' AND ends_at < ${late}`) },
    media: await count(sql`SELECT count(*) AS n FROM aegis_media_jobs`),
    inputs: await count(sql`SELECT count(*) AS n FROM aegis_states`),
  };
}

/* Items past their time across every queue (the health verdict). */
export const lateTotal = (qs) => qs.posts.late + qs.schedules.late + qs.captchas.late + qs.lockdowns.late + qs.contests.late + qs.polls.late + qs.games.late;

export async function health(ctx) {
  const now = nowSec();
  const s = await kv.all(ctx);
  const bot = await tryCall(ctx, 'getMe', {}, 'health-me');
  const hook = await webhookInfo(ctx);
  const chans = await join.list();
  const qs = await queues(now);
  const out = {
    api: !!bot,
    webhook: hook,
    errors1h: await count(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${now - 3600}`),
    errors24h: await count(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${now - 86400}`),
    stuck: await count(sql`SELECT count(*) AS n FROM aegis_updates WHERE status = 0 AND at < ${now - UPDATE_RETRY_SEC}`),
    gcAt: Number(s.gc_at || 0),
    sweepAt: Number(s.sec_sweep_at || 0),
    join: { n: chans.length, bad: chans.filter((c) => Number(c.bot_admin) !== 1).length, on: join.enabled(s) },
    shutdown: isShutdown(s),
    jobs: globals.on(s, 'g_jobs'),
    seals: await seals.summary(),
    queues: qs,
  };
  const problems = [];
  if (!out.api) problems.push('api');
  if (out.webhook && !out.webhook.managed) {
    if (!out.webhook.set) problems.push('webhook');
    else if (out.webhook.pending > 100) problems.push('backlog');
    if (out.webhook.lastErrorAt > now - 3600) problems.push('delivery');
  }
  if (out.errors1h >= 10) problems.push('errors');
  if (out.stuck > 0) problems.push('stuck');
  if (out.join.on && out.join.bad) problems.push('join');
  if (!out.jobs) problems.push('jobs');
  if (lateTotal(qs) > 0) problems.push('late');
  if (!out.seals.guard) problems.push('guard');
  if (out.shutdown) problems.push('shutdown');
  out.problems = problems;
  return out;
}

/* Unsticks timed work: releases broadcast batch locks and backup-copy waits (each is retried on its own later anyway). */
export async function releaseLocks(actorId) {
  const a = await db.run(sql`UPDATE aegis_broadcasts SET lock_until_ms = 0, next_at_ms = 0 WHERE status = 'running'`);
  const b = await db.run(sql`UPDATE aegis_backup_jobs SET retry_at = 0 WHERE status = 'running'`);
  await audit.log(actorId, 'system.release_locks', { details: { broadcasts: a.rowsAffected, backups: b.rowsAffected } });
  return a.rowsAffected + b.rowsAffected;
}

/* The sweeps run right after this update (lib/jobs.js), instead of waiting for their interval. */
export async function sweepSoon(ctx, actorId) {
  await kv.set(ctx, 'sec_sweep_at', '0');
  await kv.set(ctx, 'gc_at', '0');
  await audit.log(actorId, 'system.sweep_now');
}

/* ---------- chats ---------- */

export const allChats = (() => {
  const FILTERS = ['a', 'g', 'c', 'n', 'l', 's'];
  const where = (f) => {
    if (f === 'g') return sql`active = 1 AND type IN ('group', 'supergroup')`;
    if (f === 'c') return sql`active = 1 AND type = 'channel'`;
    if (f === 'n') return sql`active = 1 AND (bot_status <> 'administrator' OR (missing IS NOT NULL AND missing <> '[]'))`;
    if (f === 'l') return sql`active = 0`;
    return sql`active = 1`;
  };

  /* A page of chats: { rows, total }. 's' = the suspended chats (from aegis_kv). */
  async function page(ctx, filter, offset, limit) {
    if (filter === 's') {
      const ids = Object.keys(globals.suspended(await kv.all(ctx))).map(Number).sort((a, b) => a - b);
      const rows = [];
      for (const id of ids.slice(offset, offset + limit)) rows.push((await chats.get(id)) || { chat_id: id, type: '?', title: null, active: 0, member_count: 0 });
      return { rows, total: ids.length };
    }
    const w = where(filter);
    const rows = await db.all(sql`SELECT * FROM aegis_chats WHERE ${w} ORDER BY member_count DESC, chat_id LIMIT ${limit} OFFSET ${offset}`);
    return { rows, total: await count(sql`SELECT count(*) AS n FROM aegis_chats WHERE ${w}`) };
  }

  /* By id (-100…), @username or a piece of the title. */
  async function find(q, limit) {
    const s = String(q || '').trim().slice(0, 64);
    if (!s) return [];
    if (/^-?\d{5,16}$/.test(s)) {
      const r = await chats.get(toInt(s));
      return r ? [r] : [];
    }
    const name = s.replace(/^@/, '').toLowerCase();
    const like = `%${s.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return db.all(sql`SELECT * FROM aegis_chats WHERE lower(username) = ${name} OR title LIKE ${like} ESCAPE '\\'
      ORDER BY active DESC, member_count DESC LIMIT ${limit}`);
  }

  async function info(chatId) {
    const chat = await chats.get(chatId);
    if (!chat) return null;
    return {
      chat,
      settings: await count(sql`SELECT count(*) AS n FROM aegis_chat_settings WHERE chat_id = ${chatId}`),
      punishments: await count(sql`SELECT count(*) AS n FROM aegis_punishments WHERE chat_id = ${chatId} AND status = 'active'`),
      admins: await count(sql`SELECT count(*) AS n FROM aegis_chat_admins WHERE chat_id = ${chatId}`),
      lockdown: await count(sql`SELECT count(*) AS n FROM aegis_lockdowns WHERE chat_id = ${chatId} AND active = 1`),
      events: await count(sql`SELECT count(*) AS n FROM aegis_audit WHERE chat_id = ${chatId}`),
    };
  }

  /* Asks Telegram again: title, username, member count, the bot's own status and rights. Gives 'ok', 'gone' or an error text. */
  async function refresh(ctx, chat) {
    const id = Number(chat.chat_id);
    try {
      const c = await call(ctx, 'getChat', { chat_id: id }, 'sa-chat');
      await db.run(sql`UPDATE aegis_chats SET title = ${c.title || null}, username = ${c.username || null}, updated_at = ${nowSec()} WHERE chat_id = ${id}`);
      const n = await tryCall(ctx, 'getChatMemberCount', { chat_id: id }, 'sa-count');
      if (n !== null) await chats.setCount(id, n);
      const m = await call(ctx, 'getChatMember', { chat_id: id, user_id: (await me(ctx)).id }, 'sa-bot');
      await db.run(sql`UPDATE aegis_chats SET bot_status = ${m.status} WHERE chat_id = ${id}`);
      await chats.setBotRights(id, c.type, m);
      return 'ok';
    } catch (err) {
      if (isApiError(err) && (err.code === 403 || /chat not found|bot was kicked|not a member/i.test(err.description))) {
        await chats.setInactive(id, 'left');
        return 'gone';
      }
      return describeError(err);
    }
  }

  async function leave(ctx, actorId, chat) {
    const id = Number(chat.chat_id);
    const r = await tryCall(ctx, 'leaveChat', { chat_id: id }, 'sa-leave');
    await chats.setInactive(id, 'left');
    await chats.unregister(id);
    await audit.log(actorId, 'chat.leave', { chatId: id, target: chat.type, details: { title: chat.title || '', ok: !!r } });
    return !!r;
  }

  return { FILTERS, page, find, info, refresh, leave };
})();

/* ---------- the global configuration backup ---------- */

export const globalBackup = (() => {
  const V = 1;
  const KEYS = [...globals.FLAGS, 'join_enabled'];

  async function makeGlobals(ctx) {
    const s = await kv.all(ctx);
    const settings = {};
    for (const k of KEYS) if (s[k] !== undefined && s[k] !== null) settings[k] = String(s[k]);
    return {
      aegis: 'global-backup', v: V, part: 'globals', at: nowSec(), version: VERSION, settings,
      join: (await join.list()).map((c) => ({ chat_id: Number(c.chat_id) || 0, username: c.username || null, title: c.title || '', invite_link: c.invite_link || null })),
      staff: (await staff.list()).map((r) => ({ user_id: Number(r.user_id), level: r.level, name: r.name || null })),
    };
  }

  /* Part of the chats' configuration: every active chat, GLOBAL_BACKUP_CHATS at a time by chat id. */
  async function makeChats(offset, limit) {
    const rows = await db.all(sql`SELECT * FROM aegis_chats WHERE active = 1 ORDER BY chat_id LIMIT ${limit} OFFSET ${offset}`);
    const total = await count(sql`SELECT count(*) AS n FROM aegis_chats WHERE active = 1`);
    const list = [];
    for (const c of rows) list.push(await backup.make(c));
    return { aegis: 'global-backup', v: V, part: 'chats', at: nowSec(), version: VERSION, offset, total, chats: list };
  }

  /* { error } or { part, data, counts }. Values are checked again when applied. */
  function check(text) {
    if (String(text || '').length > GLOBAL_BACKUP_MAX) return { error: 'too_big' };
    const d = parseJson(text, null);
    if (!d || typeof d !== 'object' || d.aegis !== 'global-backup') return { error: 'not_backup' };
    if (Number(d.v) !== V) return { error: 'version' };
    if (d.part === 'globals') {
      const settings = Object.entries(d.settings && typeof d.settings === 'object' ? d.settings : {})
        .filter(([k, v]) => KEYS.includes(k) && (v === '0' || v === '1'));
      const joinList = (Array.isArray(d.join) ? d.join : []).filter((c) => c && (typeof c.username === 'string' || Number.isSafeInteger(c.chat_id))).slice(0, MAX_JOIN_CHANNELS);
      const team = (Array.isArray(d.staff) ? d.staff : []).filter((r) => r && Number.isSafeInteger(r.user_id) && staff.LEVELS.includes(r.level)).slice(0, STAFF_MAX);
      if (!settings.length && !joinList.length && !team.length) return { error: 'empty' };
      return { part: 'globals', data: { settings, join: joinList, staff: team }, counts: { settings: settings.length, join: joinList.length, staff: team.length } };
    }
    if (d.part === 'chats') {
      const list = (Array.isArray(d.chats) ? d.chats : []).filter((c) => c && c.aegis === 'backup' && Number.isSafeInteger(c.chat));
      if (!list.length) return { error: 'empty' };
      return { part: 'chats', data: { chats: list }, counts: { chats: list.length } };
    }
    return { error: 'not_backup' };
  }

  /* Settings and the team are taken as they are; forced-join channels missing from the list are added (nothing is removed). */
  async function applyGlobals(ctx, actorId, data) {
    let n = 0;
    for (const [k, v] of data.settings) {
      await kv.set(ctx, k, v);
      n += 1;
    }
    let joined = 0;
    for (const c of data.join) {
      if (await join.count() >= MAX_JOIN_CHANNELS) break;
      if (await join.findDuplicate(Number(c.chat_id) || -1, c.username || null)) continue;
      if (!c.username && !c.invite_link) continue;
      if (await join.add({ chatId: Number(c.chat_id) || null, username: c.username || null, title: String(c.title || c.username || c.chat_id).slice(0, 128), inviteLink: c.invite_link || null, botAdmin: false })) joined += 1;
    }
    if (joined) await join.bumpRev(ctx);
    let team = 0;
    for (const r of data.staff) if (['added', 'changed'].includes(await staff.set(actorId, r.user_id, r.level, r.name))) team += 1;
    await audit.log(actorId, 'system.restore', { details: { part: 'globals', settings: n, join: joined, staff: team } });
    return { settings: n, join: joined, staff: team };
  }

  /* Up to RESTORE_STEP chats from `offset`: only chats Aegis is in now, each through backup.check/apply. */
  async function applyChats(ctx, actorId, data, offset) {
    const part = data.chats.slice(offset, offset + RESTORE_STEP);
    let applied = 0;
    let values = 0;
    let skipped = 0;
    for (const b of part) {
      const chat = await chats.get(b.chat);
      if (!chat || !Number(chat.active)) {
        skipped += 1;
        continue;
      }
      const c = backup.check(JSON.stringify(b), chat);
      if (c.error) {
        skipped += 1;
        continue;
      }
      values += await backup.apply(ctx, chat, c.data, actorId);
      applied += 1;
    }
    const next = offset + RESTORE_STEP < data.chats.length ? offset + RESTORE_STEP : 0;
    await audit.log(actorId, 'system.restore', { details: { part: 'chats', offset, applied, skipped, values } });
    return { applied, skipped, values, next, total: data.chats.length };
  }

  return { makeGlobals, makeChats, check, applyGlobals, applyChats };
})();
