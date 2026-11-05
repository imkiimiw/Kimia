// SQL for `force_join_channels`.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/** @param {any[]} parts @returns {any} sql fragments joined by commas */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);

export function createForceJoinRepo() {
  return {
    list: () => db.all(sql`SELECT * FROM force_join_channels ORDER BY sort_order, id LIMIT 50`),
    listEnabled: () => db.all(sql`SELECT * FROM force_join_channels WHERE enabled = 1 ORDER BY sort_order, id LIMIT 50`),
    get: (id) => db.get(sql`SELECT * FROM force_join_channels WHERE id = ${id}`),
    getByChatId: (chatId) => db.get(sql`SELECT * FROM force_join_channels WHERE chat_id = ${chatId}`),
    count: () => db.get(sql`SELECT count(*) AS n FROM force_join_channels`).then((r) => (r ? r.n : 0)),

    /**
     * Appends a channel at the end, only while fewer than `c.max` exist (one statement).
     * Returns the row, or null if the chat_id exists already or the list is full.
     */
    insert: (c) => db.run(sql`
      INSERT INTO force_join_channels (chat_id, username, title, invite_link, enabled, sort_order, last_check_status, last_checked_at, created_at, updated_at)
      SELECT ${c.chat_id}, ${c.username}, ${c.title}, ${c.invite_link}, 1,
        (SELECT coalesce(max(sort_order), 0) + 1 FROM force_join_channels), 'ok', ${c.now}, ${c.now}, ${c.now}
      WHERE (SELECT count(*) FROM force_join_channels) < ${c.max}
      ON CONFLICT (chat_id) DO NOTHING RETURNING *`).then((r) => r.rows[0] || null),

    /** Inserts the seed list only if the table is empty (one statement). */
    seedIfEmpty: (rows, now) => {
      if (!rows.length) return Promise.resolve(0);
      const values = commaJoin(rows.map((r, i) => sql`(${r.chat_id}, ${r.username}, ${r.title}, ${i + 1})`));
      return db.run(sql`
        INSERT INTO force_join_channels (chat_id, username, title, invite_link, enabled, sort_order, last_check_status, last_checked_at, created_at, updated_at)
        SELECT column1, column2, column3, NULL, 1, column4, 'ok', 0, ${now}, ${now} FROM (VALUES ${values})
        WHERE NOT EXISTS (SELECT 1 FROM force_join_channels)
        ON CONFLICT (chat_id) DO NOTHING`).then((r) => r.rowsAffected);
    },

    remove: (id) => db.run(sql`DELETE FROM force_join_channels WHERE id = ${id}`).then((r) => r.rowsAffected),
    setEnabled: (id, flag, now) => db.run(sql`UPDATE force_join_channels SET enabled = ${flag ? 1 : 0}, updated_at = ${now} WHERE id = ${id}`).then((r) => r.rowsAffected),
    setInviteLink: (id, link, now) => db.run(sql`UPDATE force_join_channels SET invite_link = ${link}, updated_at = ${now} WHERE id = ${id}`).then((r) => r.rowsAffected),
    setHealth: (id, status, now) => db.run(sql`UPDATE force_join_channels SET last_check_status = ${status}, last_checked_at = ${now} WHERE id = ${id}`),
    updateMeta: (id, m, now) => db.run(sql`UPDATE force_join_channels SET title = ${m.title}, username = ${m.username}, updated_at = ${now} WHERE id = ${id}`),

    /** Rewrites sort_order for the given ids in one statement (0, 1, 2… in list order). */
    reorder: (ids, now) => {
      if (!ids.length) return Promise.resolve(0);
      const cases = ids.reduce((acc, id, i) => sql`${acc} WHEN ${id} THEN ${i}`, sql``);
      return db.run(sql`UPDATE force_join_channels SET sort_order = CASE id ${cases} ELSE sort_order END, updated_at = ${now} WHERE id IN (${commaJoin(ids.map((id) => sql`${id}`))})`).then((r) => r.rowsAffected);
    },
  };
}
