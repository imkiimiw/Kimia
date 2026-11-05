// SQL for `users`. Telegram ids are the key everywhere (telegram_id UNIQUE).
import { db } from 'sdk';
import { sql } from 'sdk/db';

export function createUsersRepo() {
  return {
    /** @param {number} tid */
    get: (tid) => db.get(sql`SELECT * FROM users WHERE telegram_id = ${tid}`),

    /** @param {string} username without @ */
    findByUsername: (username) => db.get(sql`SELECT * FROM users WHERE lower(username) = lower(${username}) LIMIT 1`),

    /** Insert or refresh profile fields and last_seen_at; clears is_blocked (they just wrote to us). */
    upsertSeen: (u) => db.run(sql`
      INSERT INTO users (telegram_id, username, first_name, language_code, role, is_banned, is_blocked, force_join_ok_until, created_at, last_seen_at)
      VALUES (${u.telegram_id}, ${u.username}, ${u.first_name}, ${u.language_code}, 'user', 0, 0, 0, ${u.now}, ${u.now})
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = excluded.username, first_name = excluded.first_name,
        language_code = excluded.language_code, is_blocked = 0, last_seen_at = excluded.last_seen_at
      RETURNING *`).then((r) => r.rows[0] || null),

    /**
     * Someone who used inline mode before starting the bot: the bot can't message them yet, so the
     * row starts with is_blocked = 1; their first /start (or my_chat_member "member") clears it.
     */
    insertInline: (u) => db.run(sql`
      INSERT INTO users (telegram_id, username, first_name, language_code, role, is_banned, is_blocked, force_join_ok_until, created_at, last_seen_at)
      VALUES (${u.telegram_id}, ${u.username}, ${u.first_name}, ${u.language_code}, 'user', 0, 1, 0, ${u.now}, ${u.now})
      ON CONFLICT (telegram_id) DO NOTHING`),

    /** A row for someone known only by id (e.g. added as admin before they started the bot). */
    insertBare: (tid, now) => db.run(sql`
      INSERT INTO users (telegram_id, role, is_banned, is_blocked, force_join_ok_until, created_at, last_seen_at)
      VALUES (${tid}, 'user', 0, 0, 0, ${now}, 0) ON CONFLICT (telegram_id) DO NOTHING`),

    setBlocked: (tid, flag) => db.run(sql`UPDATE users SET is_blocked = ${flag ? 1 : 0} WHERE telegram_id = ${tid} AND is_blocked != ${flag ? 1 : 0}`),
    setBanned: (tid, flag) => db.run(sql`UPDATE users SET is_banned = ${flag ? 1 : 0} WHERE telegram_id = ${tid} RETURNING *`).then((r) => r.rows[0] || null),
    setRole: (tid, role) => db.run(sql`UPDATE users SET role = ${role} WHERE telegram_id = ${tid} RETURNING *`).then((r) => r.rows[0] || null),
    setLanguage: (tid, lang) => db.run(sql`UPDATE users SET ui_language = ${lang} WHERE telegram_id = ${tid}`),
    setForceJoinPass: (tid, until) => db.run(sql`UPDATE users SET force_join_ok_until = ${until} WHERE telegram_id = ${tid}`),

    /** Invalidates every active force-join pass in one statement. */
    clearAllPasses: (now) => db.run(sql`UPDATE users SET force_join_ok_until = 0 WHERE force_join_ok_until > ${now}`).then((r) => r.rowsAffected),

    listAdmins: (limit, offset) => db.all(sql`SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT ${limit} OFFSET ${offset}`),
    listAdminIds: (limit) => db.all(sql`SELECT telegram_id FROM users WHERE role = 'admin' ORDER BY id LIMIT ${limit}`),

    stats: (now) => db.get(sql`
      SELECT count(*) AS total,
        coalesce(sum(last_seen_at >= ${now - 86400}), 0) AS d1,
        coalesce(sum(last_seen_at >= ${now - 7 * 86400}), 0) AS d7,
        coalesce(sum(is_blocked), 0) AS blocked,
        coalesce(sum(is_banned), 0) AS banned,
        coalesce(sum(role = 'admin'), 0) AS admins
      FROM users`),

    countRecipients: () => db.get(sql`SELECT count(*) AS n FROM users WHERE is_blocked = 0 AND is_banned = 0`).then((r) => (r ? r.n : 0)),

    /** Broadcast recipients after a cursor, in id order. */
    recipientsAfter: (cursor, limit) => db.all(sql`
      SELECT id, telegram_id FROM users WHERE id > ${cursor} AND is_blocked = 0 AND is_banned = 0 ORDER BY id LIMIT ${limit}`),
  };
}
