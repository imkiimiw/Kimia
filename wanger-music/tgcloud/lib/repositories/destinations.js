// SQL for `destination_channels`. Removal is soft (removed_at).
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => r.rows[0] || null;
/** Columns an update may touch (identifiers only from this list); objects are stored as JSON. */
const EDITABLE = ['username', 'title', 'enabled', 'auto_publish', 'approval_required', 'rules', 'caption_template', 'post_format',
  'min_interval_seconds', 'active_hours', 'daily_limit', 'time_zone', 'bot_rights_ok', 'bot_rights', 'publishing_since'];
const JSON_COLS = ['rules', 'active_hours', 'bot_rights'];
/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
const encode = (k, v) => (JSON_COLS.includes(k) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

export function createDestinationsRepo() {
  return {
    list: () => db.all(sql`SELECT * FROM destination_channels WHERE removed_at IS NULL ORDER BY id LIMIT 50`),
    get: (id) => db.get(sql`SELECT * FROM destination_channels WHERE id = ${id} AND removed_at IS NULL`),
    getAny: (id) => db.get(sql`SELECT * FROM destination_channels WHERE id = ${id}`),
    getByChatId: (chatId) => db.get(sql`SELECT * FROM destination_channels WHERE chat_id = ${chatId}`),
    count: () => db.get(sql`SELECT count(*) AS n FROM destination_channels WHERE removed_at IS NULL`).then((r) => (r ? r.n : 0)),

    /** New channel: disabled, auto-publish off, approval on. Null if the chat exists (even removed). */
    insert: (d) => db.run(sql`
      INSERT INTO destination_channels (chat_id, username, title, enabled, auto_publish, approval_required, rules, post_format,
        min_interval_seconds, daily_limit, time_zone, bot_rights_ok, bot_rights, created_at, updated_at)
      VALUES (${d.chat_id}, ${d.username}, ${d.title}, 0, 0, 1, ${JSON.stringify(d.rules)}, 'audio', 600, 50, ${d.time_zone},
        ${d.bot_rights_ok}, ${JSON.stringify(d.bot_rights)}, ${d.now}, ${d.now})
      ON CONFLICT (chat_id) DO NOTHING RETURNING *`).then(first),

    /** Brings back a removed channel with safe defaults (disabled, auto-publish off, approval on). */
    revive: (id, d) => db.run(sql`
      UPDATE destination_channels SET removed_at = NULL, enabled = 0, auto_publish = 0, approval_required = 1,
        username = ${d.username}, title = ${d.title}, bot_rights_ok = ${d.bot_rights_ok}, bot_rights = ${JSON.stringify(d.bot_rights)}, updated_at = ${d.now}
      WHERE id = ${id} AND removed_at IS NOT NULL RETURNING *`).then(first),

    update: (id, patch, now) => {
      const sets = Object.keys(patch).filter((k) => EDITABLE.includes(k)).map((k) => sql`${sql.raw(`"${k}"`)} = ${encode(k, patch[k])}`);
      if (!sets.length) return Promise.resolve(null);
      return db.run(sql`UPDATE destination_channels SET ${commaJoin(sets)}, updated_at = ${now} WHERE id = ${id} AND removed_at IS NULL RETURNING *`).then(first);
    },

    /** Keeps publishing_since in step with (enabled AND auto_publish): set when it turns on, cleared when off. */
    syncPublishingSince: (id, now) => db.run(sql`
      UPDATE destination_channels SET publishing_since = CASE
          WHEN enabled = 1 AND auto_publish = 1 THEN coalesce(publishing_since, ${now}) ELSE NULL END
      WHERE id = ${id} RETURNING *`).then(first),
    /** Channels routing may target now (the newest track activation must be after publishing_since). */
    routable: () => db.all(sql`SELECT * FROM destination_channels WHERE enabled = 1 AND auto_publish = 1 AND removed_at IS NULL LIMIT 50`),
    setLastPublished: (id, now) => db.run(sql`UPDATE destination_channels SET last_published_at = ${now} WHERE id = ${id}`),
    softRemove: (id, now) => db.run(sql`
      UPDATE destination_channels SET removed_at = ${now}, enabled = 0, auto_publish = 0, updated_at = ${now}
      WHERE id = ${id} AND removed_at IS NULL`).then((r) => r.rowsAffected),
  };
}
