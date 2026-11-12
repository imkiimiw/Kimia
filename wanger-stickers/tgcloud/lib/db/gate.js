// SQL for `channels` (forced-join list) and `membership_cache`. (Adapted from wanger-music.)
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);

export const gate = {
  list: () => db.all(sql`SELECT * FROM channels ORDER BY position, id LIMIT 20`),
  listEnabled: () => db.all(sql`SELECT * FROM channels WHERE enabled = 1 ORDER BY position, id LIMIT 20`),
  get: (id) => db.get(sql`SELECT * FROM channels WHERE id = ${id}`),
  getByChatId: (chatId) => db.get(sql`SELECT * FROM channels WHERE chat_id = ${chatId}`),
  count: () => db.get(sql`SELECT count(*) AS n FROM channels`).then((r) => (r ? r.n : 0)),

  /** Appends a channel while fewer than `max` exist (one statement); null if full or a duplicate. */
  insert: (c, max, now) => db.run(sql`
    INSERT INTO channels (chat_id, username, title, invite_link, position, enabled, added_at, health, checked_at)
    SELECT ${c.chat_id}, ${c.username}, ${c.title}, ${c.invite_link}, (SELECT coalesce(max(position), 0) + 1 FROM channels), 1, ${now}, 'ok', ${now}
    WHERE (SELECT count(*) FROM channels) < ${max}
    ON CONFLICT (chat_id) DO NOTHING RETURNING *`).then(first),

  /** Seeds only an empty table (one statement). */
  seedIfEmpty: (rows, now) => {
    if (!rows.length) return Promise.resolve(0);
    const values = commaJoin(rows.map((r, i) => sql`(${r.chat_id}, ${r.username}, ${r.title}, ${i + 1})`));
    return db.run(sql`
      INSERT INTO channels (chat_id, username, title, invite_link, position, enabled, added_at, health, checked_at)
      SELECT column1, column2, column3, NULL, column4, 1, ${now}, 'ok', 0 FROM (VALUES ${values})
      WHERE NOT EXISTS (SELECT 1 FROM channels)
      ON CONFLICT (chat_id) DO NOTHING`).then((r) => r.rowsAffected);
  },

  remove: (id) => db.run(sql`DELETE FROM channels WHERE id = ${id}`).then((r) => r.rowsAffected),
  setEnabled: (id, flag) => db.run(sql`UPDATE channels SET enabled = ${flag ? 1 : 0} WHERE id = ${id}`).then((r) => r.rowsAffected),
  setInviteLink: (id, link) => db.run(sql`UPDATE channels SET invite_link = ${link} WHERE id = ${id}`).then((r) => r.rowsAffected),
  setHealth: (id, health, now) => db.run(sql`UPDATE channels SET health = ${health}, checked_at = ${now} WHERE id = ${id}`),
  updateMeta: (id, title, username) => db.run(sql`UPDATE channels SET title = ${title}, username = ${username} WHERE id = ${id}`),
  /** Rewrites positions in list order (one statement). */
  reorder: (ids) => {
    if (!ids.length) return Promise.resolve(0);
    const cases = ids.reduce((acc, id, i) => sql`${acc} WHEN ${id} THEN ${i + 1}`, sql``);
    return db.run(sql`UPDATE channels SET position = CASE id ${cases} ELSE position END WHERE id IN (${commaJoin(ids.map((id) => sql`${id}`))})`).then((r) => r.rowsAffected);
  },

  /* membership_cache: a pass is valid while ok_until > now and version matches the list version */
  getPass: (id) => db.get(sql`SELECT ok_until, version FROM membership_cache WHERE tg_id = ${id}`),
  setPass: (id, until, version) => db.run(sql`
    INSERT INTO membership_cache (tg_id, ok_until, version) VALUES (${id}, ${until}, ${version})
    ON CONFLICT (tg_id) DO UPDATE SET ok_until = excluded.ok_until, version = excluded.version`),
  clearPass: (id) => db.run(sql`DELETE FROM membership_cache WHERE tg_id = ${id}`),
};
