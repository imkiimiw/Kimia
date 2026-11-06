// SQL for `sources` (source channels and groups; source_type stays 'telegram_channel' = a Telegram
// chat, chat_type says which kind).
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => r.rows[0] || null;
/** Columns a source update may touch (identifiers come only from this list). */
const EDITABLE = ['enabled', 'auto_import', 'default_language', 'title', 'username'];
/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);

export function createSourcesRepo() {
  return {
    list: () => db.all(sql`SELECT * FROM sources ORDER BY id LIMIT 100`),
    count: () => db.get(sql`SELECT count(*) AS n FROM sources`).then((r) => (r ? r.n : 0)),
    get: (id) => db.get(sql`SELECT * FROM sources WHERE id = ${id}`),
    getByChatId: (chatId) => db.get(sql`SELECT * FROM sources WHERE chat_id = ${chatId}`),
    /** Returns the new row, or null if the chat is a source already or the list is full. */
    insert: (s) => db.run(sql`
      INSERT INTO sources (source_type, chat_id, username, title, default_language, enabled, auto_import, imported_count, created_at, updated_at, chat_type)
      SELECT 'telegram_channel', ${s.chat_id}, ${s.username}, ${s.title}, NULL, 1, 'draft', 0, ${s.now}, ${s.now}, ${s.chat_type || 'channel'}
      WHERE (SELECT count(*) FROM sources) < ${s.max}
      ON CONFLICT (chat_id) DO NOTHING RETURNING *`).then(first),
    update: (id, patch, now) => {
      const sets = Object.keys(patch).filter((k) => EDITABLE.includes(k)).map((k) => sql`${sql.raw(`"${k}"`)} = ${patch[k]}`);
      if (!sets.length) return Promise.resolve(null);
      return db.run(sql`UPDATE sources SET ${commaJoin(sets)}, updated_at = ${now} WHERE id = ${id} RETURNING *`).then(first);
    },
    remove: (id) => db.run(sql`DELETE FROM sources WHERE id = ${id}`).then((r) => r.rowsAffected),
    /** A group became a supergroup: Telegram gives it a new id. */
    moveChat: (id, chatId, chatType, now) => db.run(sql`UPDATE sources SET chat_id = ${chatId}, chat_type = ${chatType}, updated_at = ${now} WHERE id = ${id} RETURNING *`).then(first),
    /** One more post seen (and, when a track was created, one more import). */
    recordPost: (id, now, imported) => db.run(sql`
      UPDATE sources SET last_post_at = ${now}, imported_count = imported_count + ${imported ? 1 : 0} WHERE id = ${id}`),
  };
}
