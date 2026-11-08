// Settings, limits, running counters, owner-alert throttling, recent errors, processed updates,
// staff, secrets and housekeeping. One statement per state change (no transactions here).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { DEFAULT_LIMITS, ERRORS_KEEP } from '../config.js';

// ---- settings (key/value; JSON values) ----
export async function getSetting(key, fallback = null) {
  const r = await db.get(sql`SELECT value FROM settings WHERE key = ${key}`);
  if (!r || r.value == null) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}

/** Several settings in one query → { key: value }. */
export async function getSettings(keys) {
  if (!keys.length) return {};
  let list = sql`${keys[0]}`;
  for (let i = 1; i < keys.length; i++) list = sql`${list}, ${keys[i]}`;
  const rows = await db.all(sql`SELECT key, value FROM settings WHERE key IN (${list})`);
  const out = {};
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch { /* ignore broken values */ } }
  return out;
}

export function setSetting(key, value, now, by = null) {
  return db.run(sql`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${JSON.stringify(value)}, ${now}, ${by})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
}

/** Limits: spec §9 defaults, overridden key by key by the `limits` setting (numbers only). */
export function mergeLimits(override) {
  const out = { ...DEFAULT_LIMITS };
  if (override && typeof override === 'object') {
    for (const [k, v] of Object.entries(override)) if (k in out && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

// ---- counters (per Tehran day; day 'all' = since the start) ----
export function count(day, key, by = 1) {
  return db.run(sql`INSERT INTO counters (day, key, n) VALUES (${day}, ${key}, ${by})
    ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n`);
}

/** Several counters with one statement: list of [day, key]. */
export async function countMany(pairs) {
  if (!pairs.length) return;
  const values = pairs.map(([d, k]) => sql`(${d}, ${k}, 1)`);
  let joined = values[0];
  for (let i = 1; i < values.length; i++) joined = sql`${joined}, ${values[i]}`;
  await db.run(sql`INSERT INTO counters (day, key, n) VALUES ${joined} ON CONFLICT (day, key) DO UPDATE SET n = n + 1`);
}

/** → { key: n } for one day. */
export async function counters(day) {
  const rows = await db.all(sql`SELECT key, n FROM counters WHERE day = ${day}`);
  return Object.fromEntries(rows.map((r) => [r.key, r.n]));
}

// ---- owner alerts: the same key at most once per `everyS` ----
export async function claimAlert(key, now, everyS) {
  const k = `alert:${key}`;
  const r = await db.run(sql`INSERT INTO settings (key, value, updated_at) VALUES (${k}, ${String(now)}, ${now})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE settings.updated_at <= ${now - everyS}`);
  return r.rowsAffected === 1;
}

// ---- errors (sanitized, last ERRORS_KEEP) ----
export function addError(now, source, code, detail = null, jobCode = null) {
  return db.run(sql`INSERT INTO errors (at, source, code, detail, job_code)
    VALUES (${now}, ${String(source).slice(0, 40)}, ${String(code).slice(0, 40)}, ${detail ? String(detail).slice(0, 300) : null}, ${jobCode})`);
}
export const recentErrors = (limit = 10) => db.all(sql`SELECT at, source, code, detail, job_code FROM errors ORDER BY id DESC LIMIT ${limit}`);

// ---- processed updates: claim before handling (a redelivery must never act twice) ----
export async function claimUpdate(updateId, now) {
  const r = await db.run(sql`INSERT INTO processed_updates (update_id, at) VALUES (${updateId}, ${now}) ON CONFLICT (update_id) DO NOTHING`);
  return r.rowsAffected === 1;
}

// ---- staff (admins next to the owner) ----
export async function isStaff(id) {
  return !!(await db.get(sql`SELECT 1 AS x FROM staff WHERE user_id = ${id}`));
}
export const listStaff = () => db.all(sql`SELECT user_id, role, added_at FROM staff ORDER BY added_at LIMIT 50`);
export const addStaff = (id, by, now) => db.run(sql`INSERT INTO staff (user_id, role, added_by, added_at) VALUES (${id}, 'admin', ${by}, ${now}) ON CONFLICT (user_id) DO NOTHING`);
export const removeStaff = (id) => db.run(sql`DELETE FROM staff WHERE user_id = ${id}`);

// ---- secrets (values never leave lib/secrets.js except to the service they belong to) ----
export const setSecret = (name, value, by, now) => db.run(sql`INSERT INTO secrets (name, value, updated_at, updated_by) VALUES (${name}, ${value}, ${now}, ${by})
  ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
export const deleteSecret = (name) => db.run(sql`DELETE FROM secrets WHERE name = ${name}`);
export const secretNames = () => db.all(sql`SELECT name, updated_at FROM secrets ORDER BY name LIMIT 20`);
export async function hasSecret(name) {
  return !!(await db.get(sql`SELECT 1 AS x FROM secrets WHERE name = ${name}`));
}
export async function getSecret(name) {
  const r = await db.get(sql`SELECT value FROM secrets WHERE name = ${name}`);
  return r ? r.value : null;
}

// ---- housekeeping: small bounded deletes (no cron; run opportunistically) ----
export async function housekeeping(now, { jobDays, updateKeepS }) {
  const out = {};
  const run = async (key, q) => { out[key] = (await db.run(q)).rowsAffected; };
  await run('jobs', sql`DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE created_at < ${now - jobDays * 86400} ORDER BY created_at LIMIT 500)`);
  await run('files', sql`DELETE FROM files WHERE ref IN (SELECT ref FROM files WHERE created_at < ${now - 86400} ORDER BY created_at LIMIT 500)`);
  await run('batches', sql`DELETE FROM batches WHERE id IN (SELECT id FROM batches WHERE updated_at < ${now - 86400} ORDER BY updated_at LIMIT 500)`);
  await run('pending', sql`DELETE FROM pending_actions WHERE expires_at < ${now}`);
  await run('rate', sql`DELETE FROM rate_counters WHERE expires_at < ${now}`);
  await run('cache', sql`DELETE FROM result_cache WHERE key IN (SELECT key FROM result_cache WHERE expires_at < ${now} ORDER BY expires_at LIMIT 500)`);
  await run('updates', sql`DELETE FROM processed_updates WHERE update_id IN (SELECT update_id FROM processed_updates WHERE at < ${now - updateKeepS} ORDER BY at LIMIT 1000)`);
  const max = await db.get(sql`SELECT max(id) AS m FROM errors`);
  if (max && max.m > ERRORS_KEEP) await run('errors', sql`DELETE FROM errors WHERE id <= ${max.m - ERRORS_KEEP}`);
  return out;
}
