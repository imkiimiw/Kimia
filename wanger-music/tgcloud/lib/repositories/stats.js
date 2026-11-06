// SQL for `stats_daily` and the direct counts the analytics need (users, tracks, publications).
// Every write is one statement: counters add (value = value + n), derived numbers overwrite.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/** @param {any[]} parts */
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
const CHUNK = 100;
const n0 = (r) => (r ? Number(r.n) || 0 : 0);

/** @typedef {{metric: string, dimension: string, value: number}} StatRow */

/** The platform refuses a statement that writes more than 10 000 rows: deletes go in batches. */
const WRITE_BATCH = 5000;
/**
 * Deletes the rows matching `cond` in key order, WRITE_BATCH at a time (stats_daily has no rowid:
 * the batch ends at the WRITE_BATCH-th key, compared column by column).
 */
async function deleteBatched(cond) {
  let total = 0;
  for (;;) {
    const e = await db.get(sql`SELECT date, metric, dimension FROM stats_daily WHERE ${cond} ORDER BY date, metric, dimension LIMIT 1 OFFSET ${WRITE_BATCH - 1}`);
    if (!e) return total + (await db.run(sql`DELETE FROM stats_daily WHERE ${cond}`)).rowsAffected;
    total += (await db.run(sql`DELETE FROM stats_daily WHERE ${cond} AND (date < ${e.date}
      OR (date = ${e.date} AND metric < ${e.metric}) OR (date = ${e.date} AND metric = ${e.metric} AND dimension <= ${e.dimension}))`)).rowsAffected;
  }
}

export function createStatsRepo() {
  /** @param {string} date @param {StatRow[]} rows @param {boolean} add */
  async function write(date, rows, add) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const values = commaJoin(rows.slice(i, i + CHUNK).map((r) => sql`(${date}, ${r.metric}, ${r.dimension}, ${r.value})`));
      await (add
        ? db.run(sql`INSERT INTO stats_daily (date, metric, dimension, value) VALUES ${values}
            ON CONFLICT (date, metric, dimension) DO UPDATE SET value = stats_daily.value + excluded.value`)
        : db.run(sql`INSERT INTO stats_daily (date, metric, dimension, value) VALUES ${values}
            ON CONFLICT (date, metric, dimension) DO UPDATE SET value = excluded.value`));
    }
  }

  return {
    /** Event counters of one invocation, in one statement (per 100 rows). */
    add: (date, rows) => write(date, rows, true),
    /** Derived numbers (recomputed): overwrite. */
    put: (date, rows) => write(date, rows, false),

    /** Dimensions already stored for a derived metric on a day (so vanished ones can be zeroed). */
    dimensions: (date, metric) => db.all(sql`SELECT dimension FROM stats_daily WHERE date = ${date} AND metric = ${metric}`).then((rows) => rows.map((r) => r.dimension)),

    /** Sums per (metric, dimension) over a date range, plays per track excluded (see topTracks). */
    sums: (from, to) => db.all(sql`
      SELECT metric, dimension, sum(value) AS value FROM stats_daily
      WHERE date >= ${from} AND date <= ${to} AND metric != 'track.play'
      GROUP BY metric, dimension LIMIT 2000`),
    /** One metric per day (the daily table). @param {string[]} metrics */
    series: (from, to, metrics) => db.all(sql`
      SELECT date, metric, sum(value) AS value FROM stats_daily
      WHERE date >= ${from} AND date <= ${to} AND metric IN (${commaJoin(metrics.map((m) => sql`${m}`))})
      GROUP BY date, metric ORDER BY date DESC LIMIT 2000`),
    /** Most played tracks in a date range (plays counted per track per day). */
    topTracks: (from, to, limit) => db.all(sql`
      SELECT t.id, t.public_id, t.title, t.artist, t.status, x.plays FROM (
        SELECT dimension, sum(value) AS plays FROM stats_daily
        WHERE date >= ${from} AND date <= ${to} AND metric = 'track.play'
        GROUP BY dimension ORDER BY plays DESC, dimension LIMIT ${limit}
      ) x JOIN tracks t ON t.id = CAST(x.dimension AS INTEGER) ORDER BY x.plays DESC, t.id`),
    /** All-time most played active tracks (tracks.play_count; index idx_tracks_popular). */
    topAllTime: (limit) => db.all(sql`
      SELECT id, public_id, title, artist, status, play_count AS plays FROM tracks
      WHERE status = 'active' AND play_count > 0 ORDER BY play_count DESC, activated_at DESC LIMIT ${limit}`),

    // ---- direct counts (the aggregator's sources, and what tests compare the dashboard with) ----
    usersCreatedBetween: (from, to) => db.get(sql`SELECT count(*) AS n FROM users WHERE created_at >= ${from} AND created_at < ${to}`).then(n0),
    usersCreatedBefore: (to) => db.get(sql`SELECT count(*) AS n FROM users WHERE created_at < ${to}`).then(n0),
    usersSeenSince: (since) => db.get(sql`SELECT count(*) AS n FROM users WHERE last_seen_at >= ${since}`).then(n0),
    tracksActivatedBetween: (from, to) => db.get(sql`
      SELECT count(*) AS n FROM tracks WHERE status IN ('active', 'hidden', 'removed') AND activated_at >= ${from} AND activated_at < ${to}`).then(n0),
    /** Published posts per channel in a time range. */
    publishedBetween: (from, to) => db.all(sql`
      SELECT channel_id, count(*) AS n FROM publications
      WHERE status = 'published' AND published_at >= ${from} AND published_at < ${to} GROUP BY channel_id LIMIT 500`),
    /** Live publication states per channel (waiting and broken rows; index idx_pub_status_next). */
    openByChannel: () => db.all(sql`
      SELECT channel_id, status, count(*) AS n FROM publications
      WHERE status IN ('pending_approval', 'queued', 'sending', 'failed', 'uncertain') GROUP BY channel_id, status LIMIT 1000`),
    /** All-time published posts per channel (partial index idx_pub_channel_published). */
    publishedByChannel: () => db.all(sql`SELECT channel_id, count(*) AS n FROM publications WHERE status = 'published' GROUP BY channel_id LIMIT 500`),

    /** Retention: whole days before `date`, and per-track plays in [from, to) — ≤ 5000 rows per statement. */
    pruneBefore: (date) => deleteBatched(sql`date < ${date}`),
    prunePlays: (from, to) => deleteBatched(sql`date >= ${from} AND date < ${to} AND metric = 'track.play'`),
  };
}
