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
  return (await getPrefs(id)).quality;
}

/** Download preferences: { quality, gif, delivery } with defaults when never set. */
export async function getPrefs(id) {
  const r = await db.get(sql`SELECT quality, gif, delivery FROM user_settings WHERE user_id = ${id}`);
  return { quality: (r && r.quality) || 'auto', gif: (r && r.gif) || 'ask', delivery: (r && r.delivery) || 'media' };
}

const PREF_COLUMNS = { gif: 'gif', delivery: 'delivery' };
/** Sets one of the whitelisted preference columns (gif | delivery). */
export async function setPref(id, field, value, now) {
  const col = PREF_COLUMNS[field];
  if (!col || !Object.prototype.hasOwnProperty.call(PREF_COLUMNS, field)) throw new Error('unknown preference ' + field);
  await db.run(sql`INSERT INTO user_settings (user_id, ${sql.raw(col)}, updated_at) VALUES (${id}, ${value}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET ${sql.raw(col)} = excluded.${sql.raw(col)}, updated_at = excluded.updated_at`);
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

/** Records who invited a new user — once, and only if the inviter is a known user. */
export async function setReferrer(id, inviterId) {
  const r = await db.run(sql`UPDATE users SET referred_by = ${inviterId}
    WHERE id = ${id} AND referred_by IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ${inviterId})`);
  return r.rowsAffected === 1;
}

/**
 * Credits the inviter of `id` once (the conditional update wins only once): ref_count + 1 and
 * ref_bonus + bonus up to cap. → { inviter, bonus } or null.
 */
export async function creditReferral(id, bonus, cap) {
  const r = await db.run(sql`UPDATE users SET ref_credited = 1 WHERE id = ${id} AND ref_credited = 0 AND referred_by IS NOT NULL`);
  if (r.rowsAffected !== 1) return null;
  const row = await db.get(sql`SELECT referred_by FROM users WHERE id = ${id}`);
  if (!row || !row.referred_by) return null;
  await db.run(sql`UPDATE users SET ref_count = ref_count + 1, ref_bonus = MIN(${cap}, ref_bonus + ${bonus}) WHERE id = ${row.referred_by}`);
  const inv = await db.get(sql`SELECT ref_bonus FROM users WHERE id = ${row.referred_by}`);
  return inv ? { inviter: row.referred_by, bonus: inv.ref_bonus } : null;
}

/** Extends VIP by `seconds` from now or from its current end, whichever is later. → the new end. */
export async function extendVip(id, seconds, now) {
  await db.run(sql`UPDATE users SET vip_until = MAX(vip_until, ${now}) + ${seconds} WHERE id = ${id}`);
  const r = await db.get(sql`SELECT vip_until FROM users WHERE id = ${id}`);
  return r ? r.vip_until : 0;
}

/** Takes `seconds` off VIP (a refund), never below `now`. */
export async function reduceVip(id, seconds, now) {
  await db.run(sql`UPDATE users SET vip_until = MAX(${now}, vip_until - ${seconds}) WHERE id = ${id} AND vip_until > ${now}`);
}

