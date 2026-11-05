// SQL for the search index (track_terms), artists and artist_aliases.
// Every query is an index range or exact lookup on track_terms (term, track_id) — never %…%.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const HIGH = String.fromCharCode(0xffff);
/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
const CHUNK = 200; // rows per multi-row insert (2 variables each, well under SQLite's limit)

/** Columns an inline / private result needs. */
const RESULT_COLS = sql`t.id, t.public_id, t.title, t.artist, t.album, t.duration, t.genre, t.language, t.audio_file_id, t.play_count, t.activated_at`;

export function createSearchRepo() {
  return {
    /**
     * Writes a track's terms: insert the new set, then delete terms no longer in it (no moment
     * where the track has no terms; no transactions on this platform).
     */
    async setTerms(trackId, terms) {
      for (let i = 0; i < terms.length; i += CHUNK) {
        const rows = commaJoin(terms.slice(i, i + CHUNK).map((t) => sql`(${t}, ${trackId})`));
        await db.run(sql`INSERT INTO track_terms (term, track_id) VALUES ${rows} ON CONFLICT DO NOTHING`);
      }
      if (!terms.length) return db.run(sql`DELETE FROM track_terms WHERE track_id = ${trackId}`);
      return db.run(sql`DELETE FROM track_terms WHERE track_id = ${trackId} AND term NOT IN (${commaJoin(terms.map((t) => sql`${t}`))})`);
    },
    clearTerms: (trackId) => db.run(sql`DELETE FROM track_terms WHERE track_id = ${trackId}`),
    countTerms: () => db.get(sql`SELECT count(*) AS n FROM track_terms`).then((r) => (r ? r.n : 0)),

    /**
     * Active tracks matching every token (earlier ones exactly, the last as a prefix unless it is
     * one letter), ranked: exact title/artist match, then prefix match, then plays, then recency.
     */
    search(tokens, full, limit, offset) {
      const last = tokens[tokens.length - 1];
      const lastCond = Array.from(last).length === 1 ? sql`term = ${last}` : sql`term >= ${last} AND term < ${last + HIGH}`;
      let ids = sql`SELECT track_id FROM track_terms WHERE ${lastCond}`;
      for (const tok of tokens.slice(0, -1)) ids = sql`${ids} INTERSECT SELECT track_id FROM track_terms WHERE term = ${tok}`;
      return db.all(sql`
        SELECT ${RESULT_COLS} FROM tracks t WHERE t.status = 'active' AND t.id IN (${ids})
        ORDER BY CASE
            WHEN t.normalized_title = ${full} OR t.normalized_artist = ${full} THEN 0
            WHEN (t.normalized_title >= ${full} AND t.normalized_title < ${full + HIGH})
              OR (t.normalized_artist >= ${full} AND t.normalized_artist < ${full + HIGH}) THEN 1
            ELSE 2 END,
          t.play_count DESC, t.activated_at DESC, t.id DESC
        LIMIT ${limit} OFFSET ${offset}`);
    },

    /** Empty query: most played, then newest. */
    popular: (limit, offset) => db.all(sql`
      SELECT ${RESULT_COLS} FROM tracks t WHERE t.status = 'active'
      ORDER BY t.play_count DESC, t.activated_at DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`),

    /** Active tracks after a cursor (search index rebuild). */
    activeAfter: (cursor, limit) => db.all(sql`SELECT * FROM tracks WHERE status = 'active' AND id > ${cursor} ORDER BY id LIMIT ${limit}`),
    activeByArtist: (artistKey, limit) => db.all(sql`SELECT * FROM tracks WHERE status = 'active' AND normalized_artist = ${artistKey} ORDER BY id LIMIT ${limit}`),

    /** @returns {Promise<number|null>} the track id when an active track was counted */
    addPlay: (publicId) => db.run(sql`UPDATE tracks SET play_count = play_count + 1 WHERE public_id = ${publicId} AND status = 'active' RETURNING id`).then((r) => (r.rows[0] ? r.rows[0].id : null)),

    // ---- artists and aliases

    /** Creates artists that don't exist yet (by normalized name). @param {{key: string, name: string}[]} list */
    ensureArtists: (list, now) => {
      if (!list.length) return Promise.resolve(0);
      return db.run(sql`INSERT INTO artists (name, normalized_name, language, created_at)
        VALUES ${commaJoin(list.map((a) => sql`(${a.name}, ${a.key}, NULL, ${now})`))} ON CONFLICT (normalized_name) DO NOTHING`).then((r) => r.rowsAffected);
    },
    aliasesFor: (keys) => (keys.length
      ? db.all(sql`SELECT a.alias_normalized AS alias FROM artist_aliases a JOIN artists r ON r.id = a.artist_id
          WHERE r.normalized_name IN (${commaJoin(keys.map((k) => sql`${k}`))}) LIMIT 50`).then((rows) => rows.map((r) => r.alias))
      : Promise.resolve([])),
    getArtist: (id) => db.get(sql`SELECT * FROM artists WHERE id = ${id}`),
    getArtistByKey: (k) => db.get(sql`SELECT * FROM artists WHERE normalized_name = ${k}`),
    listArtists: (limit, offset) => db.all(sql`SELECT * FROM artists ORDER BY name LIMIT ${limit} OFFSET ${offset}`),
    countArtists: () => db.get(sql`SELECT count(*) AS n FROM artists`).then((r) => (r ? r.n : 0)),
    artistAliases: (artistId) => db.all(sql`SELECT alias_normalized AS alias FROM artist_aliases WHERE artist_id = ${artistId} ORDER BY alias_normalized LIMIT 50`).then((rows) => rows.map((r) => r.alias)),
    aliasOwner: (alias) => db.get(sql`SELECT r.* FROM artist_aliases a JOIN artists r ON r.id = a.artist_id WHERE a.alias_normalized = ${alias}`),
    /** @returns {Promise<boolean>} false when the alias belongs to an artist already */
    addAlias: (alias, artistId) => db.run(sql`INSERT INTO artist_aliases (alias_normalized, artist_id) VALUES (${alias}, ${artistId}) ON CONFLICT DO NOTHING RETURNING alias_normalized`).then((r) => r.rows.length > 0),
    removeAlias: (alias, artistId) => db.run(sql`DELETE FROM artist_aliases WHERE alias_normalized = ${alias} AND artist_id = ${artistId}`).then((r) => r.rowsAffected),
    setArtistLanguage: (k, language) => db.run(sql`UPDATE artists SET language = ${language} WHERE normalized_name = ${k}`),
    artistTrackCount: (k) => db.get(sql`SELECT count(*) AS n FROM tracks WHERE normalized_artist = ${k} AND status != 'removed'`).then((r) => (r ? r.n : 0)),
  };
}
