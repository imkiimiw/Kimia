// SQL for `tracks` and `import_sessions`. Status changes are conditional UPDATEs.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => r.rows[0] || null;
/** Upper bound for prefix ranges: key >= k AND key < k + HIGH. */
const HIGH = String.fromCharCode(0xffff);
/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
/** @param {string[]} list */
const inList = (list) => commaJoin(list.map((v) => sql`${v}`));

/** Columns a metadata update may touch (identifiers come only from this list). */
const EDITABLE = ['title', 'artist', 'featured_artists', 'album', 'version', 'genre', 'language', 'language_confidence', 'language_source',
  'cover_file_id', 'normalized_title', 'normalized_artist', 'dup_key', 'duplicate_of', 'audio_file_id'];

const REVIEW = sql`(title IS NULL OR artist IS NULL OR language = 'unknown' OR language_confidence = 'low' OR duplicate_of IS NOT NULL)`;

/** WHERE clause of a list filter: a status, 'review', or a language (non-removed tracks). */
function filterWhere(filter) {
  if (['draft', 'active', 'hidden', 'removed'].includes(filter)) return sql`status = ${filter}`;
  if (filter === 'review') return sql`status = 'draft' AND ${REVIEW}`;
  if (['fa', 'en', 'other', 'unknown'].includes(filter)) return sql`language = ${filter} AND status != 'removed'`;
  return sql`status != 'removed'`;
}

export function createTracksRepo() {
  return {
    get: (id) => db.get(sql`SELECT * FROM tracks WHERE id = ${id}`),
    getByPublicId: (pid) => db.get(sql`SELECT * FROM tracks WHERE public_id = ${pid}`),

    /** Hard duplicate: same file, or the same origin post. */
    findHard: ({ file_unique_id, origin_chat_id, origin_message_id }) => (origin_chat_id != null && origin_message_id != null
      ? db.get(sql`SELECT * FROM tracks WHERE audio_file_unique_id = ${file_unique_id}
          OR (origin_chat_id = ${origin_chat_id} AND origin_message_id = ${origin_message_id}) LIMIT 1`)
      : db.get(sql`SELECT * FROM tracks WHERE audio_file_unique_id = ${file_unique_id} LIMIT 1`)),

    /** Candidates for a soft duplicate (not removed). */
    byDupKey: (dupKey, excludeId) => db.all(sql`
      SELECT id, public_id, title, artist, duration, dup_key, status FROM tracks
      WHERE dup_key = ${dupKey} AND status != 'removed' AND id != ${excludeId} ORDER BY id LIMIT 10`),

    /** Other versions of the same song: same artist + title keys, a different version key. */
    relatedVersions: (artistKey, titleKey, dupKey, excludeId) => {
      const prefix = `${artistKey}|${titleKey}|`;
      return db.all(sql`
        SELECT id, public_id, title, artist, version, status FROM tracks
        WHERE dup_key >= ${prefix} AND dup_key < ${prefix + HIGH} AND dup_key != ${dupKey}
          AND status != 'removed' AND id != ${excludeId} ORDER BY id LIMIT 3`);
    },

    /** Language of the artist's other tracks whose language a human (or a source) set. */
    artistLanguage: (normArtist) => db.get(sql`
      SELECT language FROM tracks WHERE normalized_artist = ${normArtist} AND normalized_artist != ''
        AND language_source IN ('manual', 'source') AND language != 'unknown' AND status != 'removed'
      ORDER BY updated_at DESC LIMIT 1`).then((r) => (r ? r.language : null)),

    /** Inserts a track; null on any uniqueness conflict (file, origin post or public id). */
    insert: (t) => db.run(sql`
      INSERT INTO tracks (public_id, title, artist, featured_artists, album, version, duration, genre,
        language, language_confidence, language_source, audio_file_id, audio_file_unique_id, mime_type, file_size,
        file_name, cover_file_id, normalized_title, normalized_artist, dup_key, duplicate_of, source_type, source_id,
        origin_chat_id, origin_message_id, status, added_by, play_count, created_at, updated_at)
      VALUES (${t.public_id}, ${t.title}, ${t.artist}, ${t.featured_artists}, ${t.album}, ${t.version}, ${t.duration}, ${t.genre},
        ${t.language}, ${t.language_confidence}, ${t.language_source}, ${t.audio_file_id}, ${t.audio_file_unique_id}, ${t.mime_type}, ${t.file_size},
        ${t.file_name}, ${t.cover_file_id}, ${t.normalized_title}, ${t.normalized_artist}, ${t.dup_key}, ${t.duplicate_of}, ${t.source_type}, ${t.source_id},
        ${t.origin_chat_id}, ${t.origin_message_id}, ${t.status}, ${t.added_by}, 0, ${t.now}, ${t.now})
      ON CONFLICT DO NOTHING RETURNING *`).then(first),

    /** Updates whitelisted metadata columns. @param {Record<string, any>} patch */
    update: (id, patch, now) => {
      const sets = Object.keys(patch).filter((k) => EDITABLE.includes(k)).map((k) => sql`${sql.raw(`"${k}"`)} = ${patch[k] === undefined ? null : patch[k]}`);
      if (!sets.length) return Promise.resolve(null);
      return db.run(sql`UPDATE tracks SET ${commaJoin(sets)}, updated_at = ${now} WHERE id = ${id} RETURNING *`).then(first);
    },

    /** Conditional status change; the first activation sets activated_at. @param {string[]} from */
    transition: (id, from, to, now) => db.run(sql`
      UPDATE tracks SET status = ${to}, updated_at = ${now},
        activated_at = CASE WHEN ${to} = 'active' THEN coalesce(activated_at, ${now}) ELSE activated_at END
      WHERE id = ${id} AND status IN (${inList(from)}) RETURNING *`).then(first),

    setArchive: (id, chatId, messageId) => db.run(sql`UPDATE tracks SET archive_chat_id = ${chatId}, archive_message_id = ${messageId} WHERE id = ${id} AND archive_message_id IS NULL`).then((r) => r.rowsAffected),
    archiveBacklog: (limit) => db.all(sql`SELECT * FROM tracks WHERE status = 'active' AND archive_message_id IS NULL ORDER BY id LIMIT ${limit}`),

    /** Deletes a removed track for good (owner's purge). */
    purge: (id) => db.run(sql`DELETE FROM tracks WHERE id = ${id} AND status = 'removed'`).then((r) => r.rowsAffected),

    list: (filter, limit, offset) => db.all(sql`
      SELECT id, public_id, title, artist, status, language, duplicate_of FROM tracks WHERE ${filterWhere(filter)}
      ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`),
    count: (filter) => db.get(sql`SELECT count(*) AS n FROM tracks WHERE ${filterWhere(filter)}`).then((r) => (r ? r.n : 0)),

    /** Totals per status and language, plus the review count, in one scan. */
    counts: () => db.get(sql`
      SELECT count(*) AS total,
        coalesce(sum(status = 'draft'), 0) AS draft, coalesce(sum(status = 'active'), 0) AS active,
        coalesce(sum(status = 'hidden'), 0) AS hidden, coalesce(sum(status = 'removed'), 0) AS removed,
        coalesce(sum(status = 'draft' AND ${REVIEW}), 0) AS review,
        coalesce(sum(status != 'removed' AND language = 'fa'), 0) AS fa, coalesce(sum(status != 'removed' AND language = 'en'), 0) AS en,
        coalesce(sum(status != 'removed' AND language = 'other'), 0) AS other, coalesce(sum(status != 'removed' AND language = 'unknown'), 0) AS unknown
      FROM tracks`),

    /**
     * Prefix search on the title or artist key (index range, never a %…% scan).
     * @param {string} k normalized key @param {string[]} statuses
     */
    searchPrefix: (k, statuses, limit) => db.all(sql`
      SELECT * FROM tracks WHERE id IN (
        SELECT id FROM tracks WHERE normalized_title >= ${k} AND normalized_title < ${k + HIGH}
        UNION SELECT id FROM tracks WHERE normalized_artist >= ${k} AND normalized_artist < ${k + HIGH}
      ) AND status IN (${inList(statuses)}) ORDER BY (status = 'active') DESC, play_count DESC, id DESC LIMIT ${limit}`),

    // ---- import sessions (bulk summary)

    /** Counts one more audio in the admin's current run (a new run after `window` seconds of quiet). */
    bumpSession: (adminId, now, window, d) => db.run(sql`
      INSERT INTO import_sessions (admin_id, started_at, last_at, total, created, duplicates, review, message_id)
      VALUES (${adminId}, ${now}, ${now}, 1, ${d.created}, ${d.duplicates}, ${d.review}, NULL)
      ON CONFLICT (admin_id) DO UPDATE SET
        started_at = CASE WHEN import_sessions.last_at < ${now - window} THEN ${now} ELSE import_sessions.started_at END,
        total = CASE WHEN import_sessions.last_at < ${now - window} THEN 1 ELSE import_sessions.total + 1 END,
        created = CASE WHEN import_sessions.last_at < ${now - window} THEN ${d.created} ELSE import_sessions.created + ${d.created} END,
        duplicates = CASE WHEN import_sessions.last_at < ${now - window} THEN ${d.duplicates} ELSE import_sessions.duplicates + ${d.duplicates} END,
        review = CASE WHEN import_sessions.last_at < ${now - window} THEN ${d.review} ELSE import_sessions.review + ${d.review} END,
        message_id = CASE WHEN import_sessions.last_at < ${now - window} THEN NULL ELSE import_sessions.message_id END,
        last_at = ${now}
      RETURNING *`).then(first),
    /** Only one invocation gets to send the summary message of a run. */
    claimSummary: (adminId, startedAt) => db.run(sql`
      UPDATE import_sessions SET message_id = 0 WHERE admin_id = ${adminId} AND started_at = ${startedAt} AND message_id IS NULL RETURNING admin_id`).then((r) => r.rows.length > 0),
    setSummaryMessage: (adminId, startedAt, messageId) => db.run(sql`UPDATE import_sessions SET message_id = ${messageId} WHERE admin_id = ${adminId} AND started_at = ${startedAt}`),
    getSession: (adminId) => db.get(sql`SELECT * FROM import_sessions WHERE admin_id = ${adminId}`),
  };
}
