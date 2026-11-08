// Users, their settings, bans, block state, forced-join pass, double-tap guard. All index-backed.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const USER_COLS = sql`u.id, u.first_name, u.username, u.lang_code, u.created_at, u.last_seen_at, u.last_seen_day,
  u.blocked, u.banned, u.join_ok_until, u.ban_notice_day,
  s.lang AS s_lang, s.digits AS s_digits, s.output AS s_output, s.ocr_engine AS s_ocr, s.ocr_consent_at AS s_ocr_consent, s.ocr_lang AS s_ocr_lang`;

/** A user with settings, or null. */
export function get(id) {
  return db.get(sql`SELECT ${USER_COLS} FROM users u LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.id = ${id}`);
}

/**
 * Records activity: inserts a new user, or refreshes profile/day at most once per day (writes are
 * slow; "active today" only needs the first activity). → { row, isNew, firstToday }
 */
export async function touch(from, now, day) {
  const existing = await get(from.id);
  const first = from.first_name ? String(from.first_name).slice(0, 64) : null;
  const uname = from.username ? String(from.username).slice(0, 32) : null;
  const lang = from.language_code ? String(from.language_code).slice(0, 8) : null;
  if (!existing) {
    const r = await db.run(sql`INSERT INTO users (id, first_name, username, lang_code, created_at, last_seen_at, last_seen_day)
      VALUES (${from.id}, ${first}, ${uname}, ${lang}, ${now}, ${now}, ${day}) ON CONFLICT (id) DO NOTHING`);
    return { row: await get(from.id), isNew: r.rowsAffected === 1, firstToday: r.rowsAffected === 1 };
  }
  if (existing.last_seen_day !== day || existing.first_name !== first || existing.username !== uname) {
    const r = await db.run(sql`UPDATE users SET first_name = ${first}, username = ${uname}, lang_code = ${lang},
      last_seen_at = ${now}, last_seen_day = ${day}, blocked = 0 WHERE id = ${from.id} AND (last_seen_day IS NOT ${day} OR first_name IS NOT ${first} OR username IS NOT ${uname})`);
    const firstToday = existing.last_seen_day !== day && r.rowsAffected === 1;
    return { row: { ...existing, first_name: first, username: uname, last_seen_day: day, blocked: 0 }, isNew: false, firstToday };
  }
  return { row: existing, isNew: false, firstToday: false };
}

export function setSetting(id, column, value, now) {
  const cols = { lang: sql`lang`, digits: sql`digits`, output: sql`output`, ocr: sql`ocr_engine`, ocrConsent: sql`ocr_consent_at`, ocrLang: sql`ocr_lang` };
  if (!cols[column]) throw new Error(`unknown setting ${column}`);
  return db.run(sql`INSERT INTO user_settings (user_id, ${cols[column]}, updated_at) VALUES (${id}, ${value}, ${now})
    ON CONFLICT (user_id) DO UPDATE SET ${cols[column]} = excluded.${cols[column]}, updated_at = excluded.updated_at`);
}

export const setJoinPass = (id, until) => db.run(sql`UPDATE users SET join_ok_until = ${until} WHERE id = ${id}`);
export const setBlocked = (id, blocked) => db.run(sql`UPDATE users SET blocked = ${blocked ? 1 : 0} WHERE id = ${id}`);

/** Ban / unban by id; a user who never wrote gets a row so the ban holds when they arrive. */
export async function setBanned(id, banned, now) {
  if (banned) {
    return db.run(sql`INSERT INTO users (id, created_at, last_seen_at, banned, banned_at) VALUES (${id}, ${now}, ${now}, 1, ${now})
      ON CONFLICT (id) DO UPDATE SET banned = 1, banned_at = ${now}`);
  }
  return db.run(sql`UPDATE users SET banned = 0, banned_at = NULL WHERE id = ${id}`);
}

/** Claims the once-a-day ban notice. → true if this call should send it. */
export async function claimBanNotice(id, day) {
  const r = await db.run(sql`UPDATE users SET ban_notice_day = ${day} WHERE id = ${id} AND ban_notice_day IS NOT ${day}`);
  return r.rowsAffected === 1;
}

/**
 * Double-tap guard: the same button on the same message within `windowMs` is ignored. One
 * conditional UPDATE, so two parallel taps can't both pass. → true if this tap is new.
 */
export async function claimTap(id, key, nowMs, windowMs) {
  const r = await db.run(sql`UPDATE users SET tap_key = ${key}, tap_at = ${nowMs}
    WHERE id = ${id} AND NOT (tap_key IS ${key} AND tap_at > ${nowMs - windowMs})`);
  return r.rowsAffected === 1;
}

export async function listBanned(limit = 20) {
  return db.all(sql`SELECT id, first_name, username, banned_at FROM users WHERE banned = 1 ORDER BY banned_at DESC LIMIT ${limit}`);
}

/** Next users for a broadcast after `cursor` (by id, the primary key). */
export function nextRecipients(cursor, limit) {
  return db.all(sql`SELECT id FROM users WHERE id > ${cursor} AND blocked = 0 AND banned = 0 ORDER BY id LIMIT ${limit}`);
}

/**
 * /deletemydata: removes everything stored about a user. A banned user keeps a bare row (id +
 * ban) so deleting data can't lift a ban. One statement per table; no transactions here.
 */
export async function deleteUserData(id) {
  await db.run(sql`DELETE FROM jobs WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM files WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM batches WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM pending_actions WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM rate_counters WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM result_cache WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM user_settings WHERE user_id = ${id}`);
  await db.run(sql`DELETE FROM users WHERE id = ${id} AND banned = 0`);
  await db.run(sql`UPDATE users SET first_name = NULL, username = NULL, lang_code = NULL, tap_key = NULL WHERE id = ${id}`);
}
