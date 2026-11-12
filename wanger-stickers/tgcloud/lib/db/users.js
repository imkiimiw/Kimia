// SQL for `users` and `usage_daily`. Every state change is one statement (no transactions here).
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;

/** Audience filter for broadcasts (fixed strings only). */
function audienceWhere(audience, now) {
  if (audience === 'fa') return sql`AND coalesce(lang, 'fa') = 'fa'`;
  if (audience === 'en') return sql`AND lang = 'en'`;
  if (audience === 'active30') return sql`AND last_active_at >= ${now - 30 * 86400}`;
  if (audience === 'pro') return sql`AND plan = 'pro' AND plan_until > ${now}`;
  return sql``;
}

export const users = {
  /** Creates or refreshes the row of a Telegram user; returns the row and whether it is new. */
  async touch(from, now) {
    const r = await db.run(sql`
      INSERT INTO users (tg_id, first_name, username, lang_code, joined_at, last_active_at)
      VALUES (${from.id}, ${String(from.first_name || '').slice(0, 64)}, ${from.username || null}, ${from.language_code || null}, ${now}, ${now})
      ON CONFLICT (tg_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
        lang_code = excluded.lang_code, last_active_at = excluded.last_active_at, blocked_bot = 0
      RETURNING *, (joined_at = ${now}) AS is_new`);
    return first(r);
  },
  get: (id) => db.get(sql`SELECT * FROM users WHERE tg_id = ${id}`),
  getByUsername: (name) => db.get(sql`SELECT * FROM users WHERE lower(username) = ${String(name).toLowerCase()} LIMIT 1`),
  setLang: (id, lang) => db.run(sql`UPDATE users SET lang = ${lang} WHERE tg_id = ${id}`),
  markBlocked: (id, flag) => db.run(sql`UPDATE users SET blocked_bot = ${flag ? 1 : 0} WHERE tg_id = ${id}`),
  setBan: (id, banned, reason, scope) => db.run(sql`
    UPDATE users SET banned = ${banned ? 1 : 0}, ban_reason = ${banned ? reason : null}, ban_scope = ${banned ? scope : null} WHERE tg_id = ${id}`).then((r) => r.rowsAffected),
  setPlan: (id, plan, until) => db.run(sql`UPDATE users SET plan = ${plan}, plan_until = ${until} WHERE tg_id = ${id}`).then((r) => r.rowsAffected),
  addPoints: (id, delta) => db.run(sql`UPDATE users SET points = max(0, points + ${delta}) WHERE tg_id = ${id} RETURNING points`).then((r) => (first(r) ? first(r).points : null)),
  setPublishBanned: (id, flag) => db.run(sql`UPDATE users SET publish_banned = ${flag ? 1 : 0} WHERE tg_id = ${id}`).then((r) => r.rowsAffected),
  /** Next pack number for this user (atomic). */
  nextPackNumber: (id) => db.run(sql`UPDATE users SET pack_counter = pack_counter + 1 WHERE tg_id = ${id} RETURNING pack_counter`).then((r) => (first(r) ? first(r).pack_counter : null)),

  /** /deletemydata: names cleared; id, ban and counters kept (a ban can't be escaped). */
  anonymize: (id) => db.run(sql`UPDATE users SET first_name = NULL, username = NULL, referrer_id = NULL WHERE tg_id = ${id}`),

  /** Broadcast recipients after the cursor (tg_id order). */
  recipientsAfter: (cursor, audience, n, now) => db.all(sql`
    SELECT tg_id FROM users WHERE tg_id > ${cursor} AND blocked_bot = 0 AND banned = 0 ${audienceWhere(audience, now)}
    ORDER BY tg_id LIMIT ${n}`),
  countRecipients: (audience, now) => db.get(sql`
    SELECT count(*) AS n FROM users WHERE blocked_bot = 0 AND banned = 0 ${audienceWhere(audience, now)}`).then((r) => (r ? r.n : 0)),

  async stats(now, dayStartTs) {
    const r = await db.get(sql`SELECT
        count(*) AS total,
        sum(joined_at >= ${dayStartTs}) AS new_today,
        sum(joined_at >= ${now - 7 * 86400}) AS new_7,
        sum(joined_at >= ${now - 30 * 86400}) AS new_30,
        sum(last_active_at >= ${dayStartTs}) AS active_today,
        sum(last_active_at >= ${now - 7 * 86400}) AS active_7,
        sum(last_active_at >= ${now - 30 * 86400}) AS active_30,
        sum(blocked_bot) AS blocked,
        sum(banned) AS banned,
        sum(lang = 'en') AS lang_en,
        sum(lang = 'fa' OR lang IS NULL) AS lang_fa,
        sum(plan = 'pro' AND plan_until > ${now}) AS pro
      FROM users`);
    return Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, Number(v) || 0]));
  },

  /** usage_daily: today's count of a feature. */
  usage: (id, day, feature) => db.get(sql`SELECT count FROM usage_daily WHERE tg_id = ${id} AND day = ${day} AND feature = ${feature}`).then((r) => (r ? r.count : 0)),
  usageAll: (id, day) => db.all(sql`SELECT feature, count FROM usage_daily WHERE tg_id = ${id} AND day = ${day} LIMIT 50`),
  addUsage: (id, day, feature, n = 1) => db.run(sql`
    INSERT INTO usage_daily (tg_id, day, feature, count) VALUES (${id}, ${day}, ${feature}, ${n})
    ON CONFLICT (tg_id, day, feature) DO UPDATE SET count = count + ${n}`),
  resetUsage: (id, day) => db.run(sql`DELETE FROM usage_daily WHERE tg_id = ${id} AND day = ${day}`).then((r) => r.rowsAffected),
  deleteUsage: (id) => db.run(sql`DELETE FROM usage_daily WHERE tg_id = ${id}`),
  pruneUsage: (beforeDay) => db.run(sql`DELETE FROM usage_daily WHERE (tg_id, day, feature) IN (SELECT tg_id, day, feature FROM usage_daily WHERE day < ${beforeDay} LIMIT 5000)`).then((r) => r.rowsAffected),

  /** Backup pages (tg_id order). */
  page: (after, n) => db.all(sql`SELECT * FROM users WHERE tg_id > ${after} ORDER BY tg_id LIMIT ${n}`),
};
