/*
 * Phase 5 stats queries. Same rules as lib/store.js: sql`…` only, index-backed, LIMITed.
 *
 * Daily counters (stat_day): upload, search, search_miss, send, like.
 * Searches: inline queries arrive per keystroke ("س", "سل", "سلا" …), so each user's latest query
 * waits in search_pending and is counted once, when the user moves on: they send a result
 * (chosen_inline_result), or their next query is not a continuation of it — typing on, or deleting
 * back — within SEARCH_SETTLE seconds. A counted search goes into stat_day and into search_q (per
 * day and normalised query, with how many found nothing), which feeds "top searches" and "searches
 * with no result". Searches are counted on the day they were typed.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { KEEP_SEARCH_DAYS, KEEP_STAT_DAYS, SEARCH_SETTLE } from './config.js';
import { tehranDay } from './util.js';

export async function bumpDay(name, t, n = 1) {
  await db.run(sql`
    INSERT INTO stat_day (day, name, n) VALUES (${tehranDay(t)}, ${name}, ${n})
    ON CONFLICT(day, name) DO UPDATE SET n = stat_day.n + excluded.n`);
}

async function countSearch(q, hits, t) {
  const miss = hits > 0 ? 0 : 1;
  await bumpDay('search', t);
  if (miss) await bumpDay('search_miss', t);
  await db.run(sql`
    INSERT INTO search_q (day, q, n, miss) VALUES (${tehranDay(t)}, ${q}, 1, ${miss})
    ON CONFLICT(day, q) DO UPDATE SET n = search_q.n + 1, miss = search_q.miss + excluded.miss`);
}

/* Is `next` the same search still being typed (or deleted back) after `prev`? An empty query is
   not: clearing the text ends the search. */
const continues = (prev, next, t) => !!next && t - prev.at <= SEARCH_SETTLE && (next.startsWith(prev.q) || prev.q.startsWith(next));

/* An inline search ran: q = its normalised words, hits = results on the first page. */
export async function trackQuery(uid, q, hits, t) {
  const prev = await db.get(sql`SELECT q, hits, at FROM search_pending WHERE user_id = ${uid}`);
  if (prev && prev.q !== q && !continues(prev, q, t)) await countSearch(prev.q, prev.hits, prev.at);
  await db.run(sql`
    INSERT INTO search_pending (user_id, q, hits, at) VALUES (${uid}, ${q}, ${hits}, ${t})
    ON CONFLICT(user_id) DO UPDATE SET q = excluded.q, hits = excluded.hits, at = excluded.at`);
}

/* The user sent a result found with query q (normalised, may be ''): that search is done. */
export async function settleChosen(uid, q, t) {
  const prev = await db.get(sql`SELECT q, hits, at FROM search_pending WHERE user_id = ${uid}`);
  if (prev) await db.run(sql`DELETE FROM search_pending WHERE user_id = ${uid}`);
  if (q) await countSearch(q, 1, prev && prev.q === q ? prev.at : t);
  if (prev && prev.q !== q && !continues(prev, q, t)) await countSearch(prev.q, prev.hits, prev.at);
}

/* ---------- reading ---------- */

/* Sums of the daily counters since `fromDay` (inclusive): { upload, search, search_miss, send, like }. */
export async function sumsSince(fromDay) {
  const rows = await db.all(sql`SELECT name, sum(n) AS n FROM stat_day WHERE day >= ${fromDay} GROUP BY name LIMIT 20`);
  const out = { upload: 0, search: 0, search_miss: 0, send: 0, like: 0 };
  for (const r of rows) out[r.name] = r.n;
  return out;
}

export async function userCounts(t) {
  const day = 86400;
  return db.get(sql`
    SELECT (SELECT count(*) FROM users) AS total,
      (SELECT count(*) FROM users WHERE created_at >= ${t - day}) AS new1,
      (SELECT count(*) FROM users WHERE created_at >= ${t - 7 * day}) AS new7,
      (SELECT count(*) FROM users WHERE seen_at >= ${t - 7 * day}) AS active7,
      (SELECT count(*) FROM users WHERE blocked = 1) AS blocked,
      (SELECT count(*) FROM users WHERE banned = 1) AS banned`);
}

export async function memeCounts() {
  const rows = await db.all(sql`SELECT status, count(*) AS n FROM memes GROUP BY status LIMIT 10`);
  const out = { approved: 0, pending: 0, private: 0, hidden: 0, rejected: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/* The most searched queries since `fromDay` (miss = only those that found nothing). */
export function topQueries(fromDay, limit, onlyMisses = false) {
  return onlyMisses
    ? db.all(sql`SELECT q, sum(miss) AS n FROM search_q WHERE day >= ${fromDay} AND miss > 0 GROUP BY q ORDER BY n DESC, q LIMIT ${limit}`)
    : db.all(sql`SELECT q, sum(n) AS n, sum(miss) AS miss FROM search_q WHERE day >= ${fromDay} GROUP BY q ORDER BY n DESC, q LIMIT ${limit}`);
}

/* Drops old rows (index range deletes). */
export async function pruneStats(t) {
  const today = tehranDay(t);
  await db.run(sql`DELETE FROM search_q WHERE day < ${today - KEEP_SEARCH_DAYS}`);
  await db.run(sql`DELETE FROM stat_day WHERE day < ${today - KEEP_STAT_DAYS}`);
  await db.run(sql`DELETE FROM search_pending WHERE at < ${t - KEEP_SEARCH_DAYS * 86400}`);
}
