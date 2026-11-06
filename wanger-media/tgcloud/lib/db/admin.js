// Queries for the admin panel (Phase 4). Every lookup is keyed or LIMITed; the tables listed in
// full (roles, forced_channels, blocklist pages) are small by construction.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/** A user by numeric id or exact @username (case-insensitive, index-backed). */
export async function findUser(query) {
  const q = String(query || '').trim();
  if (/^\d{1,15}$/.test(q)) return db.get(sql`SELECT id FROM users WHERE id = ${Number(q)}`);
  const name = q.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(name)) return null;
  return db.get(sql`SELECT id FROM users WHERE lower(username) = ${name} LIMIT 1`);
}

export async function setNote(id, note) {
  await db.run(sql`UPDATE users SET note = ${note} WHERE id = ${id}`);
}

export async function setQuotaOverride(id, quota) {
  await db.run(sql`UPDATE users SET quota_override = ${quota} WHERE id = ${id}`);
}

export async function ban(id, until, reason, by, now) {
  await db.run(sql`INSERT INTO bans (user_id, until, reason, by_id, created_at) VALUES (${id}, ${until}, ${reason}, ${by}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_id = excluded.by_id, created_at = excluded.created_at`);
}

export async function unban(id) {
  const r = await db.run(sql`DELETE FROM bans WHERE user_id = ${id}`);
  return r.rowsAffected === 1;
}

/** Staff (the owner is not stored). At most a few dozen rows. */
export async function staffList() {
  return db.all(sql`SELECT roles.user_id, roles.role, roles.perms, users.first_name, users.username
    FROM roles LEFT JOIN users ON users.id = roles.user_id ORDER BY roles.user_id LIMIT 100`);
}

export async function setRole(id, role, perms, by, now) {
  await db.run(sql`INSERT INTO roles (user_id, role, perms, granted_by, granted_at) VALUES (${id}, ${role}, ${perms}, ${by}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, perms = excluded.perms, granted_by = excluded.granted_by, granted_at = excluded.granted_at`);
}

export async function removeRole(id) {
  await db.run(sql`DELETE FROM roles WHERE user_id = ${id}`);
}

export async function setPerms(id, perms) {
  await db.run(sql`UPDATE roles SET perms = ${perms} WHERE user_id = ${id}`);
}

// ---- forced-join channels (≤ 10 rows) ----

export async function channelsAll() {
  return db.all(sql`SELECT * FROM forced_channels ORDER BY position, id LIMIT 20`);
}

export async function channelGet(id) {
  return db.get(sql`SELECT * FROM forced_channels WHERE id = ${id}`);
}

/** Inserts a channel; null if it is already in the list (same chat id or username). */
export async function channelAdd({ chatId, username, title, inviteLink, botStatus, detail }, by, now) {
  const r = await db.run(sql`INSERT INTO forced_channels (chat_id, username, title, invite_link, bot_status, status_detail, checked_at, position, added_by, added_at)
    VALUES (${chatId}, ${username}, ${title}, ${inviteLink}, ${botStatus}, ${detail}, ${now},
      (SELECT coalesce(max(position), -1) + 1 FROM forced_channels), ${by}, ${now})
    ON CONFLICT DO NOTHING RETURNING id`);
  return r.rows.length ? r.rows[0].id : null;
}

export async function channelSetEnabled(id, enabled) {
  await db.run(sql`UPDATE forced_channels SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}`);
}

export async function channelDelete(id) {
  await db.run(sql`DELETE FROM forced_channels WHERE id = ${id}`);
}

// ---- blocklist, cache, failures ----

export async function blocklistPage(limit = 20) {
  return db.all(sql`SELECT id, kind, value, reason, by_id, created_at FROM blocklist ORDER BY id DESC LIMIT ${limit}`);
}

export async function blocklistAdd(kind, value, reason, by, now) {
  const r = await db.run(sql`INSERT INTO blocklist (kind, value, reason, by_id, created_at) VALUES (${kind}, ${value}, ${reason}, ${by}, ${now})
    ON CONFLICT DO NOTHING`);
  return r.rowsAffected === 1;
}

export async function blocklistRemove(id) {
  const r = await db.run(sql`DELETE FROM blocklist WHERE id = ${id} RETURNING kind, value`);
  return r.rows[0] || null;
}

/** How many cached variants a URL key has (then they are deleted by downloads.cacheDrop). */
export async function cacheCount(urlKey) {
  const r = await db.get(sql`SELECT count(*) AS n FROM file_cache WHERE url_key = ${urlKey}`);
  return r ? r.n : 0;
}

/** The latest failed downloads of a platform (index on platform, status, id). */
export async function recentFailures(platform, limit = 10) {
  return db.all(sql`SELECT id, user_id, url, reason, created_at FROM downloads
    WHERE platform = ${platform} AND status = 'failed' ORDER BY id DESC LIMIT ${limit}`);
}
