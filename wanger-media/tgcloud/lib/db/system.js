// System tables: settings, throttles/leases, counters, audit log, error log, processed updates.
// No transactions exist on this platform: every state change here is ONE statement.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { ERROR_LOG_KEEP, HOUSEKEEP_BATCH, UPDATE_KEEP_S } from '../config.js';
import { clip } from '../util.js';

/** Records an update_id; false if it was already handled (a redelivery). */
export async function markUpdate(updateId, now) {
  const r = await db.run(sql`INSERT INTO processed_updates (update_id, at) VALUES (${updateId}, ${now}) ON CONFLICT DO NOTHING`);
  return r.rowsAffected === 1;
}

/** { key: { value, updatedAt } } for the given keys (value parsed from JSON). */
export async function loadSettings(keys) {
  const list = keys.reduce((acc, k, i) => (i ? sql`${acc}, ${k}` : sql`${k}`), null);
  const rows = await db.all(sql`SELECT key, value, updated_at FROM settings WHERE key IN (${list})`);
  const out = {};
  for (const r of rows) {
    let value = null;
    try { value = r.value == null ? null : JSON.parse(r.value); } catch { value = r.value; }
    out[r.key] = { value, updatedAt: r.updated_at };
  }
  return out;
}

export async function setSetting(key, value, by, now) {
  const v = JSON.stringify(value);
  await db.run(sql`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${v}, ${now}, ${by})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
}

/**
 * Claims `key` if it wasn't claimed in the last `every` seconds (alerts, housekeeping). Atomic:
 * of several concurrent callers exactly one gets true.
 */
export async function claimThrottle(key, now, every) {
  const cut = now - every;
  const r = await db.run(sql`INSERT INTO settings (key, value, updated_at) VALUES (${key}, '1', ${now})
    ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE settings.updated_at <= ${cut}`);
  return r.rowsAffected === 1;
}

/** Adds to counters in one statement: incs = [[name, day, delta], …] (day '' = all-time). */
export async function count(incs) {
  if (!incs.length) return;
  const rows = incs.reduce((acc, [name, day, n], i) => {
    const row = sql`(${name}, ${day || ''}, ${n})`;
    return i ? sql`${acc}, ${row}` : row;
  }, null);
  await db.run(sql`INSERT INTO counters (name, day, value) VALUES ${rows}
    ON CONFLICT(name, day) DO UPDATE SET value = counters.value + excluded.value`);
}

export async function getCounter(name, day = '') {
  const r = await db.get(sql`SELECT value FROM counters WHERE name = ${name} AND day = ${day}`);
  return r ? r.value : 0;
}

/** Appends to the audit log. `details` must never contain secrets. */
export async function audit(now, actorId, action, target, details) {
  await db.run(sql`INSERT INTO audit_log (at, actor_id, action, target, details)
    VALUES (${now}, ${actorId}, ${action}, ${target == null ? null : String(target)}, ${details == null ? null : JSON.stringify(details)})`);
}

export async function logError(now, source, message, detail) {
  await db.run(sql`INSERT INTO error_log (at, source, message, detail)
    VALUES (${now}, ${clip(source, 80)}, ${clip(message, 300)}, ${detail == null ? null : clip(detail, 1500)})`);
}

/** Deletes old processed_updates and trims error_log; small batches, index-backed. */
export async function housekeep(now) {
  const cut = now - UPDATE_KEEP_S;
  const a = await db.run(sql`DELETE FROM processed_updates WHERE update_id IN
    (SELECT update_id FROM processed_updates WHERE at < ${cut} ORDER BY at LIMIT ${HOUSEKEEP_BATCH})`);
  const b = await db.run(sql`DELETE FROM error_log WHERE id IN
    (SELECT id FROM error_log WHERE id <= (SELECT id FROM error_log ORDER BY id DESC LIMIT 1 OFFSET ${ERROR_LOG_KEEP})
     ORDER BY id LIMIT ${HOUSEKEEP_BATCH})`);
  return { updates: a.rowsAffected, errors: b.rowsAffected };
}

export async function deleteSetting(key) {
  await db.run(sql`DELETE FROM settings WHERE key = ${key}`);
}

/** Counter values for [[name, day], …] → { 'name|day': value } (missing = 0). One PK lookup each, one statement. */
export async function counterValues(pairs) {
  if (!pairs.length) return {};
  const cond = pairs.reduce((acc, [n, d], i) => {
    const one = sql`(name = ${n} AND day = ${d || ''})`;
    return i ? sql`${acc} OR ${one}` : one;
  }, null);
  const rows = await db.all(sql`SELECT name, day, value FROM counters WHERE ${cond}`);
  const out = {};
  for (const r of rows) out[`${r.name}|${r.day}`] = r.value;
  return out;
}

/** One page of the audit log, newest first. */
export async function auditPage(offset, limit) {
  return db.all(sql`SELECT id, at, actor_id, action, target, details FROM audit_log ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`);
}
