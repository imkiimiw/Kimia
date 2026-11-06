// Users, with their staff role and ban in one read. Every query is keyed by user id.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/** The user row joined with roles and bans, or null. */
export async function load(id) {
  return db.get(sql`SELECT u.*, r.role AS role, r.perms AS role_perms, b.until AS ban_until
    FROM users u LEFT JOIN roles r ON r.user_id = u.id LEFT JOIN bans b ON b.user_id = u.id
    WHERE u.id = ${id}`);
}

/** Inserts a new user; true if this call created the row (concurrent first updates: one wins). */
export async function insert(from, now, day) {
  const r = await db.run(sql`INSERT INTO users (id, username, first_name, tg_lang, created_at, last_seen_at, seen_day)
    VALUES (${from.id}, ${from.username || null}, ${from.first_name || null}, ${from.language_code || null}, ${now}, ${now}, ${day})
    ON CONFLICT DO NOTHING`);
  return r.rowsAffected === 1;
}

/** First activity of the day: true only for the call that moved seen_day (for "active users"). */
export async function markSeenToday(from, now, day) {
  const r = await db.run(sql`UPDATE users SET seen_day = ${day}, last_seen_at = ${now},
      username = ${from.username || null}, first_name = ${from.first_name || null}, tg_lang = ${from.language_code || null}
    WHERE id = ${from.id} AND seen_day IS NOT ${day}`);
  return r.rowsAffected === 1;
}

export async function updateProfile(from, now) {
  await db.run(sql`UPDATE users SET username = ${from.username || null}, first_name = ${from.first_name || null},
      tg_lang = ${from.language_code || null}, last_seen_at = ${now}
    WHERE id = ${from.id}`);
}

export async function setLang(id, lang) {
  await db.run(sql`UPDATE users SET lang = ${lang} WHERE id = ${id}`);
}

export async function setJoinPass(id, until) {
  await db.run(sql`UPDATE users SET join_ok_until = ${until} WHERE id = ${id}`);
}

/** Sets the blocked flag; true if it changed (keeps the "users_blocked" counter exact). */
export async function setBlocked(id, blocked) {
  const v = blocked ? 1 : 0;
  const r = await db.run(sql`UPDATE users SET blocked = ${v} WHERE id = ${id} AND blocked != ${v}`);
  return r.rowsAffected === 1;
}

/**
 * Double-tap guard: false if the same button (same message + data) was pressed less than
 * `windowMs` ago by this user. One conditional statement, so parallel taps can't both pass.
 */
export async function claimTap(id, key, nowMs, windowMs) {
  const r = await db.run(sql`UPDATE users SET last_cb = ${key}, last_cb_at_ms = ${nowMs}
    WHERE id = ${id} AND NOT (last_cb IS ${key} AND last_cb_at_ms > ${nowMs - windowMs})`);
  return r.rowsAffected === 1;
}

/** The language of a user (for owner alerts), or null. */
export async function langOf(id) {
  const r = await db.get(sql`SELECT lang, tg_lang FROM users WHERE id = ${id}`);
  return r ? r.lang || r.tg_lang : null;
}

/** Records that the user accepted the disclaimer. */
export async function setDisclaimer(id, now) {
  await db.run(sql`UPDATE users SET disclaimer_at = ${now} WHERE id = ${id}`);
}

/** The user's preferred quality ('auto' when never set). */
export async function getQuality(id) {
  const r = await db.get(sql`SELECT quality FROM user_settings WHERE user_id = ${id}`);
  return (r && r.quality) || 'auto';
}

export async function setQuality(id, quality, now) {
  await db.run(sql`INSERT INTO user_settings (user_id, quality, updated_at) VALUES (${id}, ${quality}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET quality = excluded.quality, updated_at = excluded.updated_at`);
}

/**
 * Takes one download from the user's daily quota if the quota and the cooldown allow it — one
 * conditional statement, so parallel requests can't both pass. false = quota or cooldown hit.
 */
export async function claimDownload(id, day, now, quota, cooldownS) {
  const r = await db.run(sql`UPDATE users SET
      dl_count = CASE WHEN dl_day IS ${day} THEN dl_count + 1 ELSE 1 END,
      dl_day = ${day}, last_dl_at = ${now}
    WHERE id = ${id} AND (dl_day IS NOT ${day} OR dl_count < ${quota}) AND last_dl_at <= ${now - cooldownS}`);
  return r.rowsAffected === 1;
}

/** Gives a download back after a failure (the cooldown stays, so failing links can't be hammered). */
export async function refundDownload(id, day) {
  await db.run(sql`UPDATE users SET dl_count = max(dl_count - 1, 0) WHERE id = ${id} AND dl_day IS ${day}`);
}

/** Ban and staff role of any Telegram user, whether or not they have a users row (group members). */
export async function standing(id) {
  return db.get(sql`SELECT (SELECT until FROM bans WHERE user_id = ${id}) AS ban_until,
    (SELECT role FROM roles WHERE user_id = ${id}) AS role, (SELECT perms FROM roles WHERE user_id = ${id}) AS role_perms`);
}
