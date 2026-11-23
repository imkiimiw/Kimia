// SQL for listener features (owner's ideas, 2026-11-23): ❤️ favourites, 🔔 followed artists and
// their notice jobs, 📝 song requests, 🔎 missed searches, and the track lists listeners browse
// (random, by artist, album, genre, mood). user_id is the Telegram id. Every list is LIMITed and
// index-backed; reads join active tracks, so removed tracks simply disappear.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => r.rows[0] || null;
const n = (r) => (r ? Number(r.n) : 0);
/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
/** Columns a listener screen needs. */
const COLS = sql`t.id, t.public_id, t.title, t.artist, t.album, t.duration, t.genre, t.mood, t.audio_file_id, t.normalized_artist, t.play_count, t.activated_at`;

export function createListenersRepo() {
  return {
    // ---- ❤️ favourites
    isFavorite: (userId, trackId) => db.get(sql`SELECT 1 AS ok FROM favorites WHERE user_id = ${userId} AND track_id = ${trackId}`).then(Boolean),
    removeFavorite: (userId, trackId) => db.run(sql`DELETE FROM favorites WHERE user_id = ${userId} AND track_id = ${trackId}`).then((r) => r.rowsAffected > 0),
    /** Adds unless the user already has `max`. @returns {Promise<boolean>} */
    addFavorite: (userId, trackId, now, max) => db.run(sql`
      INSERT INTO favorites (user_id, track_id, created_at)
      SELECT ${userId}, ${trackId}, ${now} WHERE (SELECT count(*) FROM favorites WHERE user_id = ${userId}) < ${max}
      ON CONFLICT (user_id, track_id) DO NOTHING`).then((r) => r.rowsAffected > 0),
    countFavorites: (userId) => db.get(sql`SELECT count(*) AS n FROM favorites WHERE user_id = ${userId}`).then(n),
    favorites: (userId, limit, offset) => db.all(sql`
      SELECT ${COLS} FROM favorites f JOIN tracks t ON t.id = f.track_id
      WHERE f.user_id = ${userId} AND t.status = 'active'
      ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${offset}`),

    // ---- 🔔 followed artists
    isFollowing: (userId, artistKey) => db.get(sql`SELECT 1 AS ok FROM artist_follows WHERE artist_key = ${artistKey} AND user_id = ${userId}`).then(Boolean),
    unfollow: (userId, artistKey) => db.run(sql`DELETE FROM artist_follows WHERE artist_key = ${artistKey} AND user_id = ${userId}`).then((r) => r.rowsAffected > 0),
    follow: (userId, artistKey, artistName, now, max) => db.run(sql`
      INSERT INTO artist_follows (artist_key, user_id, artist_name, created_at)
      SELECT ${artistKey}, ${userId}, ${artistName}, ${now} WHERE (SELECT count(*) FROM artist_follows WHERE user_id = ${userId}) < ${max}
      ON CONFLICT (artist_key, user_id) DO NOTHING`).then((r) => r.rowsAffected > 0),
    follows: (userId, limit, offset) => db.all(sql`
      SELECT artist_key, artist_name, created_at FROM artist_follows WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`),
    countFollows: (userId) => db.get(sql`SELECT count(*) AS n FROM artist_follows WHERE user_id = ${userId}`).then(n),
    /** Followers of an artist after a user id, who can be messaged (not blocked / banned). */
    followersAfter: (artistKey, cursor, limit) => db.all(sql`
      SELECT f.user_id FROM artist_follows f JOIN users u ON u.telegram_id = f.user_id
      WHERE f.artist_key = ${artistKey} AND f.user_id > ${cursor} AND u.is_blocked = 0 AND u.is_banned = 0
      ORDER BY f.user_id LIMIT ${limit}`).then((rows) => rows.map((r) => Number(r.user_id))),

    // ---- notice jobs (a newly active track → its artist's followers)
    /** One job per track, and only if the artist has followers. @returns {Promise<any|null>} */
    createNoticeJob: (trackId, artistKey, now) => db.run(sql`
      INSERT INTO notice_jobs (track_id, artist_key, created_at)
      SELECT ${trackId}, ${artistKey}, ${now} WHERE EXISTS (SELECT 1 FROM artist_follows WHERE artist_key = ${artistKey})
      ON CONFLICT (track_id) DO NOTHING RETURNING *`).then(first),
    openNoticeJob: () => db.get(sql`SELECT * FROM notice_jobs WHERE done_at IS NULL ORDER BY id LIMIT 1`),
    /** Claims the next followers by moving the cursor first (at most once: a lost batch is not re-sent). */
    claimNoticeBatch: (id, fromCursor, toCursor) => db.run(sql`
      UPDATE notice_jobs SET cursor_user_id = ${toCursor} WHERE id = ${id} AND cursor_user_id = ${fromCursor} AND done_at IS NULL`).then((r) => r.rowsAffected > 0),
    finishNoticeBatch: (id, sent, done, now) => db.run(sql`
      UPDATE notice_jobs SET sent = sent + ${sent}, done_at = CASE WHEN ${done ? 1 : 0} = 1 THEN ${now} ELSE done_at END WHERE id = ${id}`),

    // ---- 📝 song requests
    hasOpenRequest: (userId, key) => db.get(sql`SELECT 1 AS ok FROM song_requests WHERE user_id = ${userId} AND status = 'open' AND key = ${key}`).then(Boolean),
    countOpenRequestsOf: (userId) => db.get(sql`SELECT count(*) AS n FROM song_requests WHERE user_id = ${userId} AND status = 'open'`).then(n),
    addRequest: (userId, text, key, now) => db.run(sql`
      INSERT INTO song_requests (user_id, text, key, status, created_at) VALUES (${userId}, ${text}, ${key}, 'open', ${now}) RETURNING *`).then(first),
    requestsOf: (userId, limit) => db.all(sql`
      SELECT id, text, created_at FROM song_requests WHERE user_id = ${userId} AND status = 'open' ORDER BY id DESC LIMIT ${limit}`),
    cancelRequest: (userId, id, now) => db.run(sql`
      UPDATE song_requests SET status = 'dropped', done_at = ${now} WHERE id = ${id} AND user_id = ${userId} AND status = 'open'`).then((r) => r.rowsAffected > 0),
    /** The newest open requests (matching a new track runs over these). */
    openRequests: (limit) => db.all(sql`SELECT id, user_id, key FROM song_requests WHERE status = 'open' ORDER BY id DESC LIMIT ${limit}`),
    markMatched: (ids, trackId) => (ids.length
      ? db.run(sql`UPDATE song_requests SET status = 'matched', track_id = ${trackId} WHERE status = 'open' AND id IN (${commaJoin(ids.map((i) => sql`${i}`))})`).then((r) => r.rowsAffected)
      : Promise.resolve(0)),
    matchedRequests: (limit) => db.all(sql`SELECT * FROM song_requests WHERE status = 'matched' ORDER BY id LIMIT ${limit}`),
    /** Claims a matched request before its message goes out (at most once). */
    claimMatched: (id, now) => db.run(sql`UPDATE song_requests SET status = 'done', done_at = ${now} WHERE id = ${id} AND status = 'matched'`).then((r) => r.rowsAffected > 0),
    /** The owner's list: open requests grouped by their text, most asked first. */
    requestSummary: (limit) => db.all(sql`
      SELECT key, min(text) AS text, count(*) AS n, max(created_at) AS last_at FROM song_requests
      WHERE status = 'open' GROUP BY key ORDER BY n DESC, last_at DESC LIMIT ${limit}`),
    countOpenRequests: () => db.get(sql`SELECT count(*) AS n FROM song_requests WHERE status = 'open'`).then(n),
    dropRequests: (key, now) => db.run(sql`
      UPDATE song_requests SET status = 'dropped', done_at = ${now} WHERE status = 'open' AND key = ${key}`).then((r) => r.rowsAffected),

    // ---- 🔎 missed searches (no user ids)
    recordMissed: (key, text, now) => db.run(sql`
      INSERT INTO missed_searches (key, text, n, first_at, last_at) VALUES (${key}, ${text}, 1, ${now}, ${now})
      ON CONFLICT (key) DO UPDATE SET n = n + 1, last_at = excluded.last_at`),
    topMissed: (since, limit) => db.all(sql`
      SELECT key, text, n, last_at FROM missed_searches WHERE last_at >= ${since} ORDER BY n DESC, last_at DESC LIMIT ${limit}`),
    deleteMissed: (key) => db.run(sql`DELETE FROM missed_searches WHERE key = ${key}`).then((r) => r.rowsAffected),
    /** Retention (≤ 5000 rows per statement, the platform's write limit). */
    pruneMissed: (before) => db.run(sql`
      DELETE FROM missed_searches WHERE key IN (SELECT key FROM missed_searches WHERE last_at < ${before} LIMIT 5000)`).then((r) => r.rowsAffected),

    // ---- track lists
    popular: (limit) => db.all(sql`SELECT ${COLS} FROM tracks t WHERE t.status = 'active' ORDER BY t.play_count DESC, t.activated_at DESC LIMIT ${limit}`),
    byArtist: (artistKey, limit, offset) => db.all(sql`
      SELECT ${COLS} FROM tracks t WHERE t.normalized_artist = ${artistKey} AND t.status = 'active'
      ORDER BY t.activated_at DESC, t.id DESC LIMIT ${limit} OFFSET ${offset}`),
    album: (artistKey, album, limit) => db.all(sql`
      SELECT ${COLS} FROM tracks t WHERE t.normalized_artist = ${artistKey} AND t.status = 'active' AND t.album = ${album}
      ORDER BY t.id LIMIT ${limit}`),
    byGenre: (genre, limit, offset) => db.all(sql`
      SELECT ${COLS} FROM tracks t WHERE t.status = 'active' AND t.genre = ${genre}
      ORDER BY t.activated_at DESC LIMIT ${limit} OFFSET ${offset}`),
    byMood: (mood, limit, offset) => db.all(sql`
      SELECT ${COLS} FROM tracks t WHERE t.status = 'active' AND t.mood = ${mood}
      ORDER BY t.activated_at DESC LIMIT ${limit} OFFSET ${offset}`),
    activeById: (id) => db.get(sql`SELECT ${COLS} FROM tracks t WHERE t.id = ${id} AND t.status = 'active'`),
    /** Candidates for a game round: popular active MP3s (≤ 20 MB, the download limit) with a title. */
    gameCandidates: (limit) => db.all(sql`
      SELECT ${COLS}, t.mime_type, t.file_size FROM tracks t WHERE t.status = 'active'
      ORDER BY t.play_count DESC, t.activated_at DESC LIMIT ${limit}`),

    // ---- 🎮 game
    round: (chatId) => db.get(sql`SELECT * FROM game_rounds WHERE chat_id = ${chatId}`),
    /** Opens a round unless one is open and recent. @returns {Promise<boolean>} */
    openRound: (chatId, trackId, messageId, now, staleBefore) => db.run(sql`
      INSERT INTO game_rounds (chat_id, track_id, message_id, status, started_at) VALUES (${chatId}, ${trackId}, ${messageId}, 'open', ${now})
      ON CONFLICT (chat_id) DO UPDATE SET track_id = excluded.track_id, message_id = excluded.message_id, status = 'open',
        winner_id = NULL, started_at = excluded.started_at, ended_at = NULL
      WHERE game_rounds.status != 'open' OR game_rounds.started_at < ${staleBefore}`).then((r) => r.rowsAffected > 0),
    /** The first right answer (or a reveal) closes the round. @returns {Promise<any|null>} */
    closeRound: (chatId, messageId, status, winnerId, now) => db.run(sql`
      UPDATE game_rounds SET status = ${status}, winner_id = ${winnerId}, ended_at = ${now}
      WHERE chat_id = ${chatId} AND message_id = ${messageId} AND status = 'open' RETURNING *`).then(first),
    addPoint: (chatId, userId, name, now) => db.run(sql`
      INSERT INTO game_scores (chat_id, user_id, name, points, updated_at) VALUES (${chatId}, ${userId}, ${name}, 1, ${now})
      ON CONFLICT (chat_id, user_id) DO UPDATE SET points = points + 1, name = excluded.name, updated_at = excluded.updated_at
      RETURNING points`).then((r) => (r.rows[0] ? Number(r.rows[0].points) : 1)),
    topScores: (chatId, limit) => db.all(sql`SELECT user_id, name, points FROM game_scores WHERE chat_id = ${chatId} ORDER BY points DESC LIMIT ${limit}`),

    // ---- ⭐ donations
    addDonation: (userId, amount, chargeId, now) => db.run(sql`
      INSERT INTO donations (user_id, amount, charge_id, created_at) VALUES (${userId}, ${amount}, ${chargeId}, ${now})
      ON CONFLICT (charge_id) DO NOTHING RETURNING id`).then((r) => r.rows.length > 0),
    donationsSince: (since) => db.get(sql`SELECT count(*) AS n, coalesce(sum(amount), 0) AS stars FROM donations WHERE created_at >= ${since}`),
  };
}
