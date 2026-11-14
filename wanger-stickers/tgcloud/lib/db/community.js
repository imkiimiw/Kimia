// SQL for Phase 5: the Wanger Points ledger, the public gallery (likes, reports, moderation) and
// Telegram Stars payments. One statement per state change; every query LIMITed and index-backed.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;

export const ledger = {
  /** Records an award / spend once per key; returns the row, or null when the key was used before. */
  insert: (e) => db.run(sql`
    INSERT INTO points_ledger (key, tg_id, delta, reason, day, at) VALUES (${e.key}, ${e.tg_id}, ${e.delta}, ${e.reason}, ${e.day}, ${e.at})
    ON CONFLICT (key) DO NOTHING RETURNING *`).then(first),
  /** Points already given today for one reason (daily caps). */
  sumToday: (userId, day, reason) => db.get(sql`SELECT coalesce(sum(delta), 0) AS n FROM points_ledger WHERE tg_id = ${userId} AND day = ${day} AND reason = ${reason}`).then((r) => (r ? r.n : 0)),
  recent: (userId, n = 10) => db.all(sql`SELECT * FROM points_ledger WHERE tg_id = ${userId} ORDER BY at DESC LIMIT ${n}`),
  /** Undo one entry (a spend whose effect failed): removes the row so the key can be used again. */
  remove: (key) => db.run(sql`DELETE FROM points_ledger WHERE key = ${key}`),
  deleteOfUser: (userId) => db.run(sql`DELETE FROM points_ledger WHERE key IN (SELECT key FROM points_ledger WHERE tg_id = ${userId} LIMIT 5000)`),
};

export const gallery = {
  /** A published pack enters the gallery (first publication only). */
  enter: (packId, now) => db.run(sql`UPDATE packs SET gallery_at = ${now} WHERE id = ${packId} AND gallery_at IS NULL`),
  /** Visible packs, newest or most liked first. */
  page: (sort, offset, n) => (sort === 'top'
    ? db.all(sql`SELECT * FROM packs WHERE gallery_hidden = 0 AND gallery_at IS NOT NULL AND platform = 'telegram' ORDER BY likes DESC, gallery_at DESC LIMIT ${n} OFFSET ${offset}`)
    : db.all(sql`SELECT * FROM packs WHERE gallery_hidden = 0 AND gallery_at IS NOT NULL AND platform = 'telegram' ORDER BY gallery_at DESC LIMIT ${n} OFFSET ${offset}`)),
  count: () => db.get(sql`SELECT count(*) AS n FROM packs WHERE gallery_hidden = 0 AND gallery_at IS NOT NULL AND platform = 'telegram'`).then((r) => (r ? r.n : 0)),
  get: (packId) => db.get(sql`SELECT * FROM packs WHERE id = ${packId} AND gallery_at IS NOT NULL AND platform = 'telegram'`),
  /** Like / unlike: the like row and the counter move together (two conditional statements). */
  async like(packId, userId, now) {
    const r = await db.run(sql`INSERT INTO gallery_likes (pack_id, tg_id, at) VALUES (${packId}, ${userId}, ${now}) ON CONFLICT (pack_id, tg_id) DO NOTHING RETURNING pack_id`);
    if (!first(r)) return false;
    await db.run(sql`UPDATE packs SET likes = likes + 1 WHERE id = ${packId}`);
    return true;
  },
  async unlike(packId, userId) {
    const r = await db.run(sql`DELETE FROM gallery_likes WHERE pack_id = ${packId} AND tg_id = ${userId} RETURNING pack_id`);
    if (!first(r)) return false;
    await db.run(sql`UPDATE packs SET likes = max(0, likes - 1) WHERE id = ${packId}`);
    return true;
  },
  liked: (packId, userId) => db.get(sql`SELECT 1 AS y FROM gallery_likes WHERE pack_id = ${packId} AND tg_id = ${userId}`).then((r) => !!r),
  /** A report (one per person per pack); returns the pack's open report count, or null if already reported. */
  async report(packId, userId, reason, now) {
    const r = await db.run(sql`INSERT INTO gallery_reports (pack_id, tg_id, reason, status, at) VALUES (${packId}, ${userId}, ${reason}, 'open', ${now}) ON CONFLICT (pack_id, tg_id) DO NOTHING RETURNING id`);
    if (!first(r)) return null;
    const p = await db.run(sql`UPDATE packs SET reports = reports + 1 WHERE id = ${packId} RETURNING reports`);
    return first(p) ? first(p).reports : 0;
  },
  /** Hide once (auto-hide or a moderator); returns true for the caller who hid it. */
  hide: (packId) => db.run(sql`UPDATE packs SET gallery_hidden = 1 WHERE id = ${packId} AND gallery_hidden = 0 RETURNING id`).then((r) => !!first(r)),
  /** Back in the gallery: open reports are dismissed. */
  async restore(packId) {
    await db.run(sql`UPDATE gallery_reports SET status = 'dismissed' WHERE pack_id = ${packId} AND status = 'open'`);
    return db.run(sql`UPDATE packs SET gallery_hidden = 0, reports = 0 WHERE id = ${packId} RETURNING id`).then((r) => !!first(r));
  },
  /** Removed for good: reports upheld, the pack leaves the gallery (gallery_at cleared). */
  async remove(packId) {
    await db.run(sql`UPDATE gallery_reports SET status = 'upheld' WHERE pack_id = ${packId} AND status = 'open'`);
    return db.run(sql`UPDATE packs SET gallery_hidden = 1, gallery_at = NULL, reports = 0 WHERE id = ${packId} RETURNING id`).then((r) => !!first(r));
  },
  /** Packs with open reports, most reported first. */
  reported: (n) => db.all(sql`SELECT p.*, (SELECT group_concat(reason) FROM gallery_reports r WHERE r.pack_id = p.id AND r.status = 'open') AS reasons FROM packs p WHERE p.reports > 0 ORDER BY p.reports DESC, p.id LIMIT ${n}`),
  reasons: (packId) => db.all(sql`SELECT reason, count(*) AS n FROM gallery_reports WHERE pack_id = ${packId} AND status = 'open' GROUP BY reason LIMIT 10`),
  totals: () => db.get(sql`SELECT coalesce(sum(CASE WHEN gallery_at IS NOT NULL AND gallery_hidden = 0 THEN 1 ELSE 0 END), 0) AS visible, coalesce(sum(CASE WHEN gallery_hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden, coalesce(sum(likes), 0) AS likes, coalesce(sum(reports), 0) AS reports FROM packs`),
  /** The creator withdrew the publication: the pack leaves the gallery (likes stay for a re-publication). */
  leave: (packId) => db.run(sql`UPDATE packs SET gallery_at = NULL WHERE id = ${packId}`),
  /** Children first (no foreign keys): a pack's likes and reports. */
  async dropPack(packId) {
    await db.run(sql`DELETE FROM gallery_likes WHERE pack_id = ${packId}`);
    await db.run(sql`DELETE FROM gallery_reports WHERE pack_id = ${packId}`);
  },
  deleteOfUser: async (userId) => {
    await db.run(sql`DELETE FROM gallery_likes WHERE (pack_id, tg_id) IN (SELECT pack_id, tg_id FROM gallery_likes WHERE tg_id = ${userId} LIMIT 5000)`);
    await db.run(sql`DELETE FROM gallery_reports WHERE id IN (SELECT id FROM gallery_reports WHERE tg_id = ${userId} LIMIT 5000)`);
  },
};

export const payments = {
  /** Stores a successful payment once (charge_id is unique); returns the row or null for a repeat. */
  insert: (p) => db.run(sql`
    INSERT INTO payments (tg_id, charge_id, stars, product, payload, recurring, until, created_at, refunded)
    VALUES (${p.tg_id}, ${p.charge_id}, ${p.stars}, ${p.product}, ${p.payload}, ${p.recurring ? 1 : 0}, ${p.until}, ${p.now}, 0)
    ON CONFLICT (charge_id) DO NOTHING RETURNING *`).then(first),
  lastOf: (userId) => db.get(sql`SELECT * FROM payments WHERE tg_id = ${userId} ORDER BY id DESC LIMIT 1`),
  listOf: (userId, n = 10) => db.all(sql`SELECT * FROM payments WHERE tg_id = ${userId} ORDER BY id DESC LIMIT ${n}`),
  markRefunded: (id) => db.run(sql`UPDATE payments SET refunded = 1 WHERE id = ${id} AND refunded = 0 RETURNING *`).then(first),
  totals: () => db.get(sql`SELECT count(*) AS n, coalesce(sum(CASE WHEN refunded = 0 THEN stars ELSE 0 END), 0) AS stars, coalesce(sum(refunded), 0) AS refunds FROM payments`),
};
