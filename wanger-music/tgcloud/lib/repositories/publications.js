// SQL for `publications`. Every status change is conditional (WHERE status = expected).
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => r.rows[0] || null;
/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
const inList = (list) => commaJoin(list.map((v) => sql`${v}`));
const CHUNK = 100;

/** Joined columns for lists (track + channel names). */
const LIST = sql`p.*, t.title AS track_title, t.artist AS track_artist, t.public_id AS track_public_id, d.title AS channel_title, d.username AS channel_username`;

export function createPublicationsRepo() {
  return {
    get: (id) => db.get(sql`SELECT * FROM publications WHERE id = ${id}`),
    getFull: (id) => db.get(sql`SELECT ${LIST} FROM publications p JOIN tracks t ON t.id = p.track_id JOIN destination_channels d ON d.id = p.channel_id WHERE p.id = ${id}`),

    /** Idempotent routing: one row per (track, channel). @param {{track_id: number, channel_id: number, status: string}[]} rows */
    async insertMany(rows, now) {
      let created = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const values = commaJoin(rows.slice(i, i + CHUNK).map((r) => sql`(${r.track_id}, ${r.channel_id}, ${r.status}, 0, ${now}, ${now}, ${now})`));
        const res = await db.run(sql`INSERT INTO publications (track_id, channel_id, status, attempt_count, next_attempt_at, created_at, updated_at)
          VALUES ${values} ON CONFLICT (track_id, channel_id) DO NOTHING RETURNING id`);
        created += res.rows.length;
      }
      return created;
    },

    /** Claims the oldest due queued publication of a channel (one statement; the lease guards the send). */
    claimNext: (channelId, now, leaseUntil) => db.run(sql`
      UPDATE publications SET status = 'sending', locked_until = ${leaseUntil}, attempt_count = attempt_count + 1, updated_at = ${now}
      WHERE id IN (SELECT id FROM publications WHERE channel_id = ${channelId} AND status = 'queued' AND next_attempt_at <= ${now} ORDER BY id LIMIT 1)
        AND status = 'queued' RETURNING *`).then(first),

    /** Leases that ran out: the send may have reached Telegram → uncertain (never re-sent automatically). */
    expireLeases: (now) => db.run(sql`
      UPDATE publications SET status = 'uncertain', locked_until = NULL, last_error = 'lease expired', updated_at = ${now}
      WHERE status = 'sending' AND locked_until < ${now} RETURNING id`).then((r) => r.rows.length),

    markPublished: (id, messageId, coverMessageId, now) => db.run(sql`
      UPDATE publications SET status = 'published', telegram_message_id = ${messageId}, cover_message_id = ${coverMessageId},
        published_at = ${now}, locked_until = NULL, last_error = NULL, updated_at = ${now}
      WHERE id = ${id} AND status = 'sending' RETURNING *`).then(first),
    /** Back to the queue after a 429 (the attempt doesn't count) or a transient error (backoff). */
    requeue: (id, nextAt, error, countAttempt, now) => db.run(sql`
      UPDATE publications SET status = 'queued', next_attempt_at = ${nextAt}, last_error = ${error}, locked_until = NULL,
        attempt_count = attempt_count - ${countAttempt ? 0 : 1}, updated_at = ${now}
      WHERE id = ${id} AND status = 'sending'`).then((r) => r.rowsAffected),
    fail: (id, error, now) => db.run(sql`
      UPDATE publications SET status = 'failed', last_error = ${error}, locked_until = NULL, updated_at = ${now}
      WHERE id = ${id} AND status = 'sending'`).then((r) => r.rowsAffected),

    /** Approval decisions: only one reviewer wins. */
    decide: (id, to, actorId, now) => db.run(sql`
      UPDATE publications SET status = ${to}, decided_by = ${actorId}, decided_at = ${now}, next_attempt_at = ${now}, updated_at = ${now}
      WHERE id = ${id} AND status = 'pending_approval' RETURNING *`).then(first),
    /** Owner actions on uncertain / failed rows. @param {string[]} from */
    transition: (id, from, to, actorId, now, extra = {}) => db.run(sql`
      UPDATE publications SET status = ${to}, decided_by = ${actorId}, decided_at = ${now}, next_attempt_at = ${now}, updated_at = ${now},
        attempt_count = CASE WHEN ${to} = 'queued' THEN 0 ELSE attempt_count END,
        published_at = CASE WHEN ${to} = 'published' THEN coalesce(published_at, ${now}) ELSE published_at END,
        last_error = ${extra.error ?? null}
      WHERE id = ${id} AND status IN (${inList(from)}) RETURNING *`).then(first),

    /** A track left the catalog: its waiting publications are cancelled. */
    cancelForTrack: (trackId, now) => db.run(sql`
      UPDATE publications SET status = 'cancelled', updated_at = ${now} WHERE track_id = ${trackId} AND status IN ('pending_approval', 'queued')`).then((r) => r.rowsAffected),
    async cancelForChannel(channelId, now) {
      let total = 0; // ≤ 5000 rows per statement (platform write cap: 10 000)
      for (;;) {
        const n = (await db.run(sql`UPDATE publications SET status = 'cancelled', updated_at = ${now} WHERE id IN (
          SELECT id FROM publications WHERE channel_id = ${channelId} AND status IN ('pending_approval', 'queued') LIMIT 5000)`)).rowsAffected;
        total += n;
        if (n < 5000) return total;
      }
    },
    deleteForTrack: (trackId) => db.run(sql`DELETE FROM publications WHERE track_id = ${trackId}`).then((r) => r.rowsAffected),
    sweepOrphans: (cap) => db.run(sql`
      DELETE FROM publications WHERE id IN (
        SELECT p.id FROM publications p LEFT JOIN tracks t ON t.id = p.track_id WHERE t.id IS NULL LIMIT ${cap})`).then((r) => r.rowsAffected),
    markDeleted: (id, now) => db.run(sql`UPDATE publications SET deleted_at = ${now}, updated_at = ${now} WHERE id = ${id} AND deleted_at IS NULL`),

    /** Publications that failed or became uncertain since `since` (monitoring; index on status). */
    brokenSince: (since) => db.get(sql`SELECT count(*) AS n FROM publications WHERE status IN ('failed', 'uncertain') AND updated_at >= ${since}`).then((r) => (r ? Number(r.n) : 0)),
    publishedSince: (channelId, since) => db.get(sql`SELECT count(*) AS n FROM publications WHERE channel_id = ${channelId} AND status = 'published' AND published_at >= ${since}`).then((r) => (r ? r.n : 0)),
    counts: () => db.get(sql`
      SELECT coalesce(sum(status = 'pending_approval'), 0) AS pending, coalesce(sum(status = 'queued'), 0) AS queued,
        coalesce(sum(status = 'sending'), 0) AS sending, coalesce(sum(status = 'failed'), 0) AS failed,
        coalesce(sum(status = 'uncertain'), 0) AS uncertain, coalesce(sum(status = 'published'), 0) AS published
      FROM publications`),

    /** Oldest pending approval after `afterId` (review queue). */
    nextPending: (afterId) => db.get(sql`SELECT ${LIST} FROM publications p JOIN tracks t ON t.id = p.track_id JOIN destination_channels d ON d.id = p.channel_id
      WHERE p.status = 'pending_approval' AND p.id > ${afterId} ORDER BY p.id LIMIT 1`),
    countPending: () => db.get(sql`SELECT count(*) AS n FROM publications WHERE status = 'pending_approval'`).then((r) => (r ? r.n : 0)),
    byStatus: (status, limit) => db.all(sql`SELECT ${LIST} FROM publications p JOIN tracks t ON t.id = p.track_id JOIN destination_channels d ON d.id = p.channel_id
      WHERE p.status = ${status} ORDER BY p.id DESC LIMIT ${limit}`),
    forTrack: (trackId) => db.all(sql`SELECT ${LIST} FROM publications p JOIN tracks t ON t.id = p.track_id JOIN destination_channels d ON d.id = p.channel_id
      WHERE p.track_id = ${trackId} ORDER BY p.id LIMIT 30`),
    forChannel: (channelId, limit, offset) => db.all(sql`SELECT ${LIST} FROM publications p JOIN tracks t ON t.id = p.track_id JOIN destination_channels d ON d.id = p.channel_id
      WHERE p.channel_id = ${channelId} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${offset}`),

    /** Active tracks with no publication for this channel yet (backfill candidates). */
    unroutedActive: (channelId, limit) => db.all(sql`
      SELECT t.* FROM tracks t WHERE t.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.track_id = t.id AND p.channel_id = ${channelId})
      ORDER BY t.activated_at DESC, t.id DESC LIMIT ${limit}`),
  };
}
