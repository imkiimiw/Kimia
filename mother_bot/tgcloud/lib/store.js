// Shared queries: the kv table, users, flow state, roles and bans. Domain modules (catalog, reports,
// club, ...) keep their own queries. Every query is index-backed and LIMITed.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { OWNER_ID, STATE_TTL_SEC } from './config.js';
import { nowSec, parseJson } from './util.js';

/** sql list for IN (...). */
export function list(values) {
  let acc = null;
  for (const v of values) acc = acc ? sql`${acc}, ${v}` : sql`${v}`;
  return acc;
}

// ---------- kv ----------

export async function getKv(keys) {
  const rows = await db.all(sql`SELECT key, value FROM kv WHERE key IN (${list(keys)})`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function kvGet(key) {
  const r = await db.get(sql`SELECT value FROM kv WHERE key = ${key}`);
  return r ? r.value : null;
}

export async function setKv(key, value) {
  await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${value == null ? null : String(value)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

/** Adds to a numeric kv counter; returns the new value. */
export async function bump(key, delta = 1) {
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${String(delta)})
    ON CONFLICT(key) DO UPDATE SET value = CAST(COALESCE(kv.value, '0') AS INTEGER) + ${delta}
    RETURNING value`);
  return Number((r.rows && r.rows[0] && r.rows[0].value) || 0);
}

/** True for exactly one caller per `everySec` (a compare-and-set on a kv time). */
export async function claimTurn(key, everySec) {
  const now = nowSec();
  const r = await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, ${String(now)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(COALESCE(kv.value, '0') AS INTEGER) <= ${now - everySec}`);
  return r.rowsAffected > 0;
}

// ---------- users ----------

export async function getUser(id) {
  return db.get(sql`SELECT * FROM users WHERE user_id = ${Number(id)}`);
}

export async function getUserByUsername(name) {
  const lc = String(name || '').replace(/^@/, '').toLowerCase();
  if (!lc) return null;
  return db.get(sql`SELECT * FROM users WHERE username_lc = ${lc} LIMIT 1`);
}

/** Records the person behind an update. `started` = they wrote in the private chat. */
export async function touchUser(from, { started = false } = {}) {
  if (!from || !from.id || from.is_bot) return null;
  const now = nowSec();
  const username = from.username || null;
  const r = await db.run(sql`
    INSERT INTO users (user_id, username, username_lc, first_name, first_seen, last_seen, started)
    VALUES (${from.id}, ${username}, ${username ? username.toLowerCase() : null}, ${String(from.first_name || '').slice(0, 64)}, ${now}, ${now}, ${started ? 1 : 0})
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username, username_lc = excluded.username_lc, first_name = excluded.first_name,
      last_seen = excluded.last_seen,
      first_seen = CASE WHEN users.first_seen = 0 THEN excluded.first_seen ELSE users.first_seen END,
      started = MAX(users.started, excluded.started),
      blocked = CASE WHEN excluded.started = 1 THEN 0 ELSE users.blocked END
    RETURNING *, (first_seen = last_seen) AS is_new`);
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

/** A row for someone we only know by id (reported by a child bot, banned before contact). */
export async function ensureUser(id) {
  await db.run(sql`INSERT INTO users (user_id) VALUES (${Number(id)}) ON CONFLICT(user_id) DO NOTHING`);
}

export async function markBlocked(id) {
  await db.run(sql`UPDATE users SET blocked = 1 WHERE user_id = ${Number(id)}`);
}

const USER_COLUMNS = new Set(['note', 'news_kinds', 'role', 'warns', 'club', 'club_since', 'points', 'muted_until', 'ref_by']);

export async function setUserField(id, column, value) {
  if (!USER_COLUMNS.has(column)) throw new Error(`setUserField: ${column}`);
  await db.run(sql`UPDATE users SET ${sql.raw(column)} = ${value} WHERE user_id = ${Number(id)}`);
}

// ---------- flow state ----------

export async function setState(id, state, data = null) {
  await db.run(sql`UPDATE users SET state = ${state}, state_data = ${data == null ? null : JSON.stringify(data)}, state_at = ${nowSec()} WHERE user_id = ${Number(id)}`);
}

export const clearState = (id) => setState(id, null, null);

/** The user's current step, or null when there is none or it went stale. */
export function stateOf(user) {
  if (!user || !user.state) return null;
  if (nowSec() - Number(user.state_at || 0) > STATE_TTL_SEC) return null;
  return { name: user.state, data: parseJson(user.state_data, {}) };
}

// ---------- roles ----------

export const isOwner = (id) => Number(id) === OWNER_ID;

/** Owner or a team member (support + moderation). */
export function isTeam(user) {
  return !!user && (isOwner(user.user_id) || Number(user.role) > 0);
}

export async function teamIds() {
  const rows = await db.all(sql`SELECT user_id FROM users WHERE role > 0 ORDER BY user_id LIMIT 50`);
  return [OWNER_ID, ...rows.map((r) => Number(r.user_id)).filter((id) => id !== OWNER_ID)];
}

// ---------- bans ----------

/** The ban that keeps this user out of `scope` ('mother' or a bot key), or null. */
export async function activeBan(userId, scope = 'mother') {
  const now = nowSec();
  return db.get(sql`
    SELECT * FROM bans WHERE user_id = ${Number(userId)} AND scope IN ('*', ${scope})
      AND (until = 0 OR until > ${now})
    ORDER BY until = 0 DESC, until DESC LIMIT 1`);
}

export async function userBans(userId) {
  const now = nowSec();
  return db.all(sql`SELECT * FROM bans WHERE user_id = ${Number(userId)} AND (until = 0 OR until > ${now}) ORDER BY scope LIMIT 70`);
}

export async function putBan(userId, scope, until, reason, byId) {
  await db.run(sql`
    INSERT INTO bans (user_id, scope, until, reason, by_id, at) VALUES (${Number(userId)}, ${scope}, ${until}, ${reason || null}, ${byId}, ${nowSec()})
    ON CONFLICT(user_id, scope) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_id = excluded.by_id, at = excluded.at`);
}

/** Removes every ban of a user; returns the scopes that were lifted. */
export async function liftBans(userId) {
  const rows = await db.all(sql`SELECT scope FROM bans WHERE user_id = ${Number(userId)} LIMIT 70`);
  await db.run(sql`DELETE FROM bans WHERE user_id = ${Number(userId)}`);
  return rows.map((r) => r.scope);
}
