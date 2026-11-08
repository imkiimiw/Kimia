// SQL for backups (Phase 8): reading whole tables page by page (keyset paging on the primary key)
// and writing rows back. Table and column names come ONLY from BACKUP_TABLES — never from input —
// and every value is bound. A unit test keeps the lists equal to tgcloud/schema.js.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/**
 * The core tables, in restore order (parents before children, though there are no foreign keys).
 * Not backed up: track_terms (rebuilt from tracks), processed_updates, error_log, alerts,
 * user_flows, import_sessions (short-lived operational state).
 * @type {Readonly<Record<string, {key: string[], columns: string[]}>>}
 */
export const BACKUP_TABLES = Object.freeze({
  settings: { key: ['key'], columns: ['key', 'value', 'updated_at', 'updated_by'] },
  users: { key: ['id'], columns: ['id', 'telegram_id', 'username', 'first_name', 'language_code', 'ui_language', 'role', 'is_banned', 'is_blocked', 'force_join_ok_until', 'created_at', 'last_seen_at', 'flood_at', 'flood_n'] },
  force_join_channels: { key: ['id'], columns: ['id', 'chat_id', 'username', 'title', 'invite_link', 'enabled', 'sort_order', 'last_check_status', 'last_checked_at', 'created_at', 'updated_at'] },
  artists: { key: ['id'], columns: ['id', 'name', 'normalized_name', 'language', 'created_at'] },
  artist_aliases: { key: ['alias_normalized'], columns: ['alias_normalized', 'artist_id'] },
  sources: { key: ['id'], columns: ['id', 'source_type', 'chat_id', 'username', 'title', 'default_language', 'enabled', 'auto_import', 'last_post_at', 'imported_count', 'created_at', 'updated_at', 'chat_type'] },
  tracks: { key: ['id'], columns: ['id', 'public_id', 'title', 'artist', 'featured_artists', 'album', 'version', 'duration', 'genre', 'language', 'language_confidence', 'language_source', 'audio_file_id', 'audio_file_unique_id', 'mime_type', 'file_size', 'file_name', 'cover_file_id', 'cover_source', 'normalized_title', 'normalized_artist', 'dup_key', 'duplicate_of', 'source_type', 'source_id', 'origin_chat_id', 'origin_message_id', 'status', 'added_by', 'play_count', 'archive_chat_id', 'archive_message_id', 'created_at', 'updated_at', 'activated_at'] },
  destination_channels: { key: ['id'], columns: ['id', 'chat_id', 'username', 'title', 'enabled', 'auto_publish', 'approval_required', 'rules', 'caption_template', 'post_format', 'min_interval_seconds', 'active_hours', 'daily_limit', 'time_zone', 'bot_rights_ok', 'bot_rights', 'removed_at', 'publishing_since', 'last_published_at', 'created_at', 'updated_at', 'signature'] },
  publications: { key: ['id'], columns: ['id', 'track_id', 'channel_id', 'status', 'attempt_count', 'last_error', 'next_attempt_at', 'locked_until', 'telegram_message_id', 'cover_message_id', 'deleted_at', 'decided_by', 'decided_at', 'published_at', 'created_at', 'updated_at'] },
  broadcasts: { key: ['id'], columns: ['id', 'created_by', 'source_chat_id', 'source_message_id', 'status', 'cursor_user_id', 'total', 'sent', 'failed', 'blocked', 'created_at', 'started_at', 'finished_at', 'progress_chat_id', 'progress_message_id', 'lock_until'] },
  stats_daily: { key: ['date', 'metric', 'dimension'], columns: ['date', 'metric', 'dimension', 'value'] },
  audit_log: { key: ['id'], columns: ['id', 'actor_id', 'action', 'target_type', 'target_id', 'details', 'created_at'] },
});

/** @param {any[]} parts @param {any} sep */
const join = (parts, sep) => parts.reduce((acc, p, i) => (i ? sql`${acc}${sep}${p}` : p), sql``);
const COMMA = sql.raw(', ');
/** Bound values per statement: the platform's limit is 4096 (docs/PLATFORM_NOTES.md), with headroom. */
const MAX_PARAMS = 4000;
/** A whitelisted identifier. */
const id = (name) => {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`bad identifier ${name}`);
  return sql.raw(`"${name}"`);
};
/** @param {string} table */
function spec(table) {
  const s = BACKUP_TABLES[table];
  if (!s) throw new Error(`not a backup table: ${table}`);
  return s;
}

/** Rows per write statement: the platform refuses a statement that writes more than 10 000 rows. */
const WRITE_BATCH = 5000;

/** Keyset condition "row key <= edge" (a key range the planner can use), without row values. */
function upTo(key, edge) {
  const ors = key.map((_, i) => join([...key.slice(0, i).map((k, j) => sql`${id(k)} = ${edge[j]}`), i === key.length - 1 ? sql`${id(key[i])} <= ${edge[i]}` : sql`${id(key[i])} < ${edge[i]}`], sql.raw(' AND ')));
  return sql`(${join(ors.map((o) => sql`(${o})`), sql.raw(' OR '))})`;
}

/** Keyset condition "row key > last key" for a (possibly composite) key, without row values. */
function after(key, last) {
  const ors = key.map((_, i) => join([...key.slice(0, i).map((k, j) => sql`${id(k)} = ${last[j]}`), sql`${id(key[i])} > ${last[i]}`], sql.raw(' AND ')));
  return sql`(${join(ors.map((o) => sql`(${o})`), sql.raw(' OR '))})`;
}

/**
 * Deletes every row in batches: find the WRITE_BATCH-th key in key order, delete the keys up to it,
 * repeat; the last batch deletes the rest. Works for WITHOUT ROWID tables too.
 */
async function clearAll(table, key) {
  const order = join(key.map(id), COMMA);
  let total = 0;
  for (;;) {
    const edge = await db.get(sql`SELECT ${order} FROM ${id(table)} ORDER BY ${order} LIMIT 1 OFFSET ${WRITE_BATCH - 1}`);
    if (!edge) return total + (await db.run(sql`DELETE FROM ${id(table)}`)).rowsAffected;
    total += (await db.run(sql`DELETE FROM ${id(table)} WHERE ${upTo(key, key.map((k) => edge[k]))}`)).rowsAffected;
  }
}

export function createBackupRepo() {
  return {
    /**
     * One page of a table in key order. @param {string} table @param {any[]|null} last key of the previous page
     * @returns {Promise<any[][]>} rows as arrays in BACKUP_TABLES column order
     */
    async page(table, last, limit) {
      const s = spec(table);
      const cols = join(s.columns.map(id), COMMA);
      const order = join(s.key.map(id), COMMA);
      const rows = await db.all(last
        ? sql`SELECT ${cols} FROM ${id(table)} WHERE ${after(s.key, last)} ORDER BY ${order} LIMIT ${limit}`
        : sql`SELECT ${cols} FROM ${id(table)} ORDER BY ${order} LIMIT ${limit}`);
      return rows.map((r) => s.columns.map((c) => (r[c] === undefined ? null : r[c])));
    },

    /** @param {string} table */
    async count(table) {
      spec(table);
      const r = await db.get(sql`SELECT count(*) AS n FROM ${id(table)}`);
      return r ? Number(r.n) : 0;
    },

    /** Empties a table (restore --replace), ≤ 5000 rows per statement. @param {string} table */
    clear: (table) => clearAll(table, spec(table).key),
    /** The search index is derived from tracks: emptied before a full rebuild after a replace. */
    clearSearchIndex: () => clearAll('track_terms', ['term', 'track_id']),

    /**
     * Upserts rows by primary key in one statement: a row with the same key is overwritten; a row
     * that clashes with another row on a different unique column (e.g. telegram_id) is skipped.
     * @param {string} table @param {string[]} columns a subset of the table's columns that includes the key
     * @param {any[][]} rows
     * @returns {Promise<number>} rows written
     */
    async upsert(table, columns, rows) {
      const s = spec(table);
      const keys = s.key.map(id);
      const set = columns.filter((c) => !s.key.includes(c)).map((c) => sql`${id(c)} = excluded.${id(c)}`);
      const onKey = set.length ? sql`DO UPDATE SET ${join(set, COMMA)}` : sql`DO NOTHING`;
      // the platform refuses more than 4096 bound values in one statement (measured): stay under it
      const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
      let written = 0;
      for (let i = 0; i < rows.length; i += perStatement) {
        const values = join(rows.slice(i, i + perStatement).map((r) => sql`(${join(r.map((v) => sql`${v}`), COMMA)})`), COMMA);
        const res = await db.run(sql`INSERT INTO ${id(table)} (${join(columns.map(id), COMMA)}) VALUES ${values}
          ON CONFLICT (${join(keys, COMMA)}) ${onKey} ON CONFLICT DO NOTHING RETURNING 1 AS ok`);
        written += res.rows.length;
      }
      return written;
    },
  };
}
