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

/** One history row per request (ok, failed or denied — brief §6: record the decision). */
export async function record({ userId, chatId, platform = null, method = null, url = null, status, reason = null, bytes = 0, items = 0 }, now) {
  await db.run(sql`INSERT INTO downloads (user_id, chat_id, platform, method, url, status, reason, bytes, items, created_at)
    VALUES (${userId}, ${chatId}, ${platform}, ${method}, ${url}, ${status}, ${reason}, ${bytes}, ${items}, ${now})`);
}

/** The cached delivery for (url key, variant), or null. items = [{ type, file_id }]. */
export async function cacheGet(urlKey, variant) {
  const r = await db.get(sql`SELECT items, title, bytes FROM file_cache WHERE url_key = ${urlKey} AND variant = ${variant}`);
  if (!r) return null;
  try {
    const items = JSON.parse(r.items);
    return Array.isArray(items) && items.length ? { items, title: r.title, bytes: r.bytes } : null;
  } catch {
    return null;
  }
}

export async function cachePut(urlKey, variant, platform, items, title, bytes, now) {
  await db.run(sql`INSERT INTO file_cache (url_key, variant, platform, items, title, bytes, created_at, last_hit_at)
    VALUES (${urlKey}, ${variant}, ${platform}, ${JSON.stringify(items)}, ${title}, ${bytes}, ${now}, ${now})
    ON CONFLICT(url_key, variant) DO UPDATE SET items = excluded.items, title = excluded.title, bytes = excluded.bytes, created_at = excluded.created_at`);
}

export async function cacheHit(urlKey, variant, now) {
  await db.run(sql`UPDATE file_cache SET hits = hits + 1, last_hit_at = ${now} WHERE url_key = ${urlKey} AND variant = ${variant}`);
}

/** Removes every cached variant of a URL key (a stale file_id, or the owner's purge in Phase 4). */
export async function cacheDrop(urlKey) {
  await db.run(sql`DELETE FROM file_cache WHERE url_key = ${urlKey}`);
}

/**
 * Is any of these on the owner's blocklist? urlKey "platform:id", account "platform:name",
 * domains = the link's host and its parents. → the first matching { kind, value } or null.
 */
export async function blockedBy({ urlKey = null, account = null, domains = [] }) {
  const doms = domains.length ? domains : [''];
  const list = doms.reduce((acc, d, i) => (i ? sql`${acc}, ${d}` : sql`${d}`), null);
  return db.get(sql`SELECT kind, value FROM blocklist
    WHERE (kind = 'url' AND value = ${urlKey || ''})
       OR (kind = 'account' AND value = ${account || ''})
       OR (kind = 'domain' AND value IN (${list}))
    LIMIT 1`);
}
