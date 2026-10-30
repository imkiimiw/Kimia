/*
 * Backups of a chat's configuration (a JSON file the admins keep) and their validated restore; and
 * the job that copies a channel's older posts into its backup chat (aegis_backup_jobs), a batch at a
 * time (copyMessages skips ids that don't exist, so the job walks message ids 1 … the newest).
 *
 * The file: { aegis: 'backup', v: 1, type, chat, title, at, settings: {key: value}, lists:
 * {code: [{ k, v, n }]}, locks: {code: config}, guards: {code: config} }. Only configuration is
 * kept: punishment lists (mute, ban …) are records of what happened and are not restored.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec, parseJson } from '../core/util.js';
import * as guards from './guards.js';
import * as lists from './lists.js';
import * as locks from './locks.js';
import * as settings from './settings.js';

export const VERSION = 1;
const CONFIG_LISTS = lists.LISTS.filter((l) => l.effect === 'none' || l.effect === 'mod').map((l) => l.code);
const SKIP_SETTINGS = new Set(['log_chat', 'ev_chat', 'ch_mirror', 'title_locked', 'ch_title_locked']); /* tied to other chats or the moment */

export async function make(chat) {
  const c = chat.chat_id;
  const out = { aegis: 'backup', v: VERSION, type: chat.type, chat: c, title: chat.title || '', at: nowSec(), settings: {}, lists: {}, locks: {}, guards: {} };
  for (const r of await db.all(sql`SELECT key, value FROM aegis_chat_settings WHERE chat_id = ${c} LIMIT 200`)) {
    if (r.key in settings.DEFAULTS && !SKIP_SETTINGS.has(r.key)) out.settings[r.key] = r.value;
  }
  for (const code of CONFIG_LISTS) {
    const rows = await lists.all(c, code, 500);
    if (rows.length) out.lists[code] = rows.map((r) => ({ k: r.ekey, v: r.value, ...(r.note ? { n: r.note } : {}) }));
  }
  for (const r of await db.all(sql`SELECT code, config FROM aegis_locks WHERE chat_id = ${c} LIMIT 60`)) out.locks[r.code] = parseJson(r.config, {});
  for (const r of await db.all(sql`SELECT code, config FROM aegis_guards WHERE chat_id = ${c} LIMIT 20`)) out.guards[r.code] = parseJson(r.config, {});
  return out;
}

/*
 * Checks a backup for `chat`. Gives { error } or { data, counts: { settings, entries, locks, guards },
 * other: true if it came from another chat }. Values are checked again when applied.
 */
export function check(text, chat) {
  const data = parseJson(text, null);
  if (!data || typeof data !== 'object' || data.aegis !== 'backup') return { error: 'not_backup' };
  if (Number(data.v) !== VERSION) return { error: 'version' };
  if ((data.type === 'channel') !== (chat.type === 'channel')) return { error: 'type' };
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const st = Object.entries(obj(data.settings)).filter(([k, v]) => k in settings.DEFAULTS && !SKIP_SETTINGS.has(k) && typeof v === 'string');
  const ls = Object.entries(obj(data.lists)).filter(([code, rows]) => CONFIG_LISTS.includes(code) && Array.isArray(rows));
  const lk = Object.entries(obj(data.locks)).filter(([code]) => !!locks.get(code));
  const gd = Object.entries(obj(data.guards)).filter(([code]) => !!guards.MODULES[code]);
  const entries = ls.reduce((n, [, rows]) => n + rows.length, 0);
  if (!st.length && !entries && !lk.length && !gd.length) return { error: 'empty' };
  return {
    data: { settings: st, lists: ls, locks: lk, guards: gd },
    counts: { settings: st.length, entries, locks: lk.length, guards: gd.length },
    other: Number(data.chat) !== chat.chat_id,
  };
}

/* Applies a checked backup. Gives how many values were taken (invalid ones are skipped). */
export async function apply(ctx, chat, data, actorId) {
  const c = chat.chat_id;
  let n = 0;
  for (const [k, v] of data.settings) if (await settings.set(ctx, c, k, v, actorId)) n += 1;
  for (const [code, rows] of data.lists) {
    const def = lists.get(code);
    for (const r of rows.slice(0, 500)) {
      const e = r && lists.parseOne(def.kind, String(r.v || r.k || ''));
      if (!e) continue;
      if (r.n) e.note = String(r.n).slice(0, 200);
      if (['added', 'updated'].includes(await lists.upsert(c, code, e, actorId))) n += 1;
    }
  }
  if (chat.type !== 'channel') {
    for (const [code, cfg] of data.locks) if (await locks.update(c, code, locks.normalize(cfg), actorId)) n += 1;
    for (const [code, cfg] of data.guards) {
      await guards.update(ctx, c, code, guards.normalize(code, cfg), actorId, { quiet: true });
      n += 1;
    }
  }
  return n;
}

/* ---------- copying older posts ---------- */

export const job = (chatId) => db.get(sql`SELECT * FROM aegis_backup_jobs WHERE chat_id = ${chatId}`);

export async function startJob(chatId, target, lastId, byId) {
  await db.run(sql`INSERT INTO aegis_backup_jobs (chat_id, target, next_id, last_id, copied, status, error, retry_at, by_id, updated_at)
    VALUES (${chatId}, ${target}, 1, ${lastId}, 0, 'running', NULL, 0, ${byId}, ${nowSec()})
    ON CONFLICT(chat_id) DO UPDATE SET target = excluded.target, next_id = 1, last_id = excluded.last_id, copied = 0, status = 'running', error = NULL,
      retry_at = 0, by_id = excluded.by_id, updated_at = excluded.updated_at`);
}

/* Claims a step of a job (nobody else runs the same batch). */
export async function claimStep(row, now) {
  const r = await db.run(sql`UPDATE aegis_backup_jobs SET retry_at = ${now + 60}, updated_at = ${now} WHERE chat_id = ${row.chat_id} AND status = 'running'
    AND next_id = ${row.next_id} AND retry_at <= ${now}`);
  return r.rowsAffected > 0;
}

export async function progress(chatId, nextId, copiedAdd, done) {
  await db.run(sql`UPDATE aegis_backup_jobs SET next_id = ${nextId}, copied = copied + ${copiedAdd}, retry_at = 0, status = ${done ? 'done' : 'running'},
    updated_at = ${nowSec()} WHERE chat_id = ${chatId}`);
}

export async function setJob(chatId, fields) {
  if (fields.status !== undefined) await db.run(sql`UPDATE aegis_backup_jobs SET status = ${fields.status}, error = ${fields.error || null} WHERE chat_id = ${chatId}`);
  if (fields.retryAt !== undefined) await db.run(sql`UPDATE aegis_backup_jobs SET retry_at = ${fields.retryAt} WHERE chat_id = ${chatId}`);
}

export async function runnable(now, limit = 1) {
  return db.all(sql`SELECT * FROM aegis_backup_jobs WHERE status = 'running' AND retry_at <= ${now} ORDER BY updated_at LIMIT ${limit}`);
}

export async function migrate(oldId, newId) {
  await db.run(sql`DELETE FROM aegis_backup_jobs WHERE chat_id = ${newId}`);
  await db.run(sql`UPDATE aegis_backup_jobs SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}
