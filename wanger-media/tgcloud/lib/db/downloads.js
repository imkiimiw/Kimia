// Download history. Reads are keyed by user_id on idx_downloads_user (user_id, id) and capped, so a
// heavy user can never push a query past the platform's rows-read limit.
import { db } from 'sdk';
import { sql } from 'sdk/db';

/** How many of the user's latest `cap` downloads exist (reads at most `cap` index entries). */
export async function countRecent(userId, cap) {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM downloads WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${cap})`);
  return r ? r.n : 0;
}

/** One page of the user's downloads, newest first. */
export async function page(userId, offset, limit) {
  return db.all(sql`SELECT id, platform, url, status, created_at FROM downloads
    WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`);
}
