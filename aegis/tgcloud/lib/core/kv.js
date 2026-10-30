/*
 * Bot-wide settings and small state in aegis_kv. Keys:
 *   data_version   data migrations applied (lib/core/migrations.js)
 *   join_enabled   '1' / '0' — forced join on or off
 *   join_rev       bumped on every change to the forced-join list (invalidates cached passes)
 *   bot_id, bot_username   from getMe, cached
 *   gc_at          last housekeeping run
 *   err_notify_at  last time the owner was told about a failure
 *   cmd_rev        revision of the command menus set with setMyCommands (cmd_try_at: last attempt;
 *                  owner_cmd_rev: the owner's own menu)
 * all(ctx) reads every key once per update and caches it on ctx.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';

export async function all(ctx) {
  if (ctx && ctx.kv) return ctx.kv;
  const rows = await db.all(sql`SELECT key, value FROM aegis_kv LIMIT 200`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  if (ctx) ctx.kv = out;
  return out;
}

export async function get(key) {
  const r = await db.get(sql`SELECT value FROM aegis_kv WHERE key = ${key}`);
  return r ? r.value : null;
}

export async function set(ctx, key, value) {
  const v = value === null || value === undefined ? null : String(value);
  await db.run(sql`INSERT INTO aegis_kv (key, value) VALUES (${key}, ${v}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  if (ctx && ctx.kv) ctx.kv[key] = v;
}

export async function incr(ctx, key) {
  const r = await db.run(sql`INSERT INTO aegis_kv (key, value) VALUES (${key}, '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(COALESCE(aegis_kv.value, '0') AS INTEGER) + 1 AS TEXT) RETURNING value`);
  const v = r.rows[0].value;
  if (ctx && ctx.kv) ctx.kv[key] = v;
  return Number(v);
}

/*
 * True for exactly one caller per `interval` seconds: the key holds the last claim time and the
 * claim is a conditional write, so concurrent invocations can't both win.
 */
export async function claim(key, now, interval) {
  await db.run(sql`INSERT INTO aegis_kv (key, value) VALUES (${key}, '0') ON CONFLICT(key) DO NOTHING`);
  const r = await db.run(sql`UPDATE aegis_kv SET value = ${String(now)}
    WHERE key = ${key} AND CAST(COALESCE(value, '0') AS INTEGER) <= ${now - interval}`);
  return r.rowsAffected > 0;
}
