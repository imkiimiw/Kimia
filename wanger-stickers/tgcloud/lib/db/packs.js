// SQL for `packs`, `pack_items`, `pack_ops`, `pack_posts`. Every query filters by owner or id,
// is index-backed and LIMITed. Children are deleted before parents (no foreign keys).
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;
const commaJoin = (parts) => parts.reduce((acc, p, i) => (i ? sql`${acc}, ${p}` : p), sql``);
const inList = (vals) => commaJoin(vals.map((v) => sql`${v}`));

export const packs = {
  create: (p, now) => db.run(sql`
    INSERT INTO packs (tg_id, platform, tg_name, title, kind, sticker_count, created_at, updated_at)
    VALUES (${p.tg_id}, 'telegram', ${p.tg_name}, ${p.title}, 'mixed', ${p.sticker_count}, ${now}, ${now})
    ON CONFLICT (tg_name) DO NOTHING RETURNING *`).then(first),
  get: (id) => db.get(sql`SELECT * FROM packs WHERE id = ${id}`),
  /** A pack of this user (ownership check in the query itself). */
  getOwned: (id, userId) => db.get(sql`SELECT * FROM packs WHERE id = ${id} AND tg_id = ${userId}`),
  getByName: (name) => db.get(sql`SELECT * FROM packs WHERE tg_name = ${name}`),
  listByUser: (userId, offset, n) => db.all(sql`SELECT * FROM packs WHERE tg_id = ${userId} ORDER BY id DESC LIMIT ${n} OFFSET ${offset}`),
  countByUser: (userId) => db.get(sql`SELECT count(*) AS n FROM packs WHERE tg_id = ${userId}`).then((r) => (r ? r.n : 0)),
  setTitle: (id, title, now) => db.run(sql`UPDATE packs SET title = ${title}, updated_at = ${now} WHERE id = ${id}`),
  setCount: (id, n, now) => db.run(sql`UPDATE packs SET sticker_count = ${n}, updated_at = ${now} WHERE id = ${id}`),
  setPublic: (id, flag) => db.run(sql`UPDATE packs SET is_public = ${flag ? 1 : 0} WHERE id = ${id}`),
  remove: async (id) => {
    await db.run(sql`DELETE FROM pack_items WHERE pack_id = ${id}`);
    return db.run(sql`DELETE FROM packs WHERE id = ${id}`).then((r) => r.rowsAffected);
  },
  totals: () => db.get(sql`SELECT count(*) AS packs, coalesce(sum(sticker_count), 0) AS stickers, sum(is_public) AS public FROM packs`),
  page: (after, n) => db.all(sql`SELECT * FROM packs WHERE id > ${after} ORDER BY id LIMIT ${n}`),
  idsByUser: (userId) => db.all(sql`SELECT id FROM packs WHERE tg_id = ${userId} LIMIT 500`).then((rows) => rows.map((r) => r.id)),

  /* ---- items (mirror of the Telegram set, refreshed from getStickerSet) ---- */
  items: (packId) => db.all(sql`SELECT * FROM pack_items WHERE pack_id = ${packId} ORDER BY position, id LIMIT 200`),
  item: (packId, fuid) => db.get(sql`SELECT * FROM pack_items WHERE pack_id = ${packId} AND file_unique_id = ${fuid}`),
  /** Rewrites a pack's items from Telegram's list, keeping each sticker's origin (2 statements). */
  async replaceItems(packId, list, origins) {
    await db.run(sql`DELETE FROM pack_items WHERE pack_id = ${packId}`);
    if (!list.length) return 0;
    const rows = list.map((s, i) => sql`(${packId}, ${i}, ${s.file_id}, ${s.file_unique_id}, ${s.format}, ${JSON.stringify(s.emojis || [])}, ${JSON.stringify(s.keywords || [])}, ${origins[s.file_unique_id] || 'made'})`);
    return db.run(sql`INSERT INTO pack_items (pack_id, position, file_id, file_unique_id, format, emojis, keywords, origin) VALUES ${commaJoin(rows)}
      ON CONFLICT (pack_id, file_unique_id) DO NOTHING`).then((r) => r.rowsAffected);
  },
  /** Removes a noted origin that never became a sticker (the add failed). */
  dropPlaceholder: (packId, fuid) => db.run(sql`DELETE FROM pack_items WHERE pack_id = ${packId} AND file_unique_id = ${fuid} AND position = 100000`),
  originCount: (packId) => db.get(sql`SELECT count(*) AS total, sum(origin != 'made') AS foreign_n FROM pack_items WHERE pack_id = ${packId}`),
  setItemEmojis: (packId, fuid, list) => db.run(sql`UPDATE pack_items SET emojis = ${JSON.stringify(list)} WHERE pack_id = ${packId} AND file_unique_id = ${fuid}`),
  setItemKeywords: (packId, fuid, list) => db.run(sql`UPDATE pack_items SET keywords = ${JSON.stringify(list)} WHERE pack_id = ${packId} AND file_unique_id = ${fuid}`),
  /** Remembers where a sticker came from before Telegram gives it a new id in the set. */
  noteOrigin: (packId, fuid, fileId, format, origin) => db.run(sql`
    INSERT INTO pack_items (pack_id, position, file_id, file_unique_id, format, emojis, keywords, origin)
    VALUES (${packId}, 100000, ${fileId}, ${fuid}, ${format}, '[]', '[]', ${origin})
    ON CONFLICT (pack_id, file_unique_id) DO UPDATE SET origin = excluded.origin`),
};

export const ops = {
  create: (o, now) => db.run(sql`
    INSERT INTO pack_ops (tg_id, kind, src, dst_pack_id, items, cursor, total, status, title, delete_src, created_at, updated_at)
    VALUES (${o.tg_id}, ${o.kind}, ${o.src || null}, ${o.dst_pack_id || null}, ${JSON.stringify(o.items)}, 0, ${o.items.length}, 'running', ${o.title || null}, ${o.delete_src ? 1 : 0}, ${now}, ${now})
    RETURNING *`).then(first),
  get: (id) => db.get(sql`SELECT * FROM pack_ops WHERE id = ${id}`),
  activeOf: (userId) => db.get(sql`SELECT * FROM pack_ops WHERE tg_id = ${userId} AND status = 'running' ORDER BY id LIMIT 1`),
  nextRunnable: (now) => db.get(sql`SELECT * FROM pack_ops WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ${now}) ORDER BY id LIMIT 1`),
  claim: (id, now, until) => db.run(sql`
    UPDATE pack_ops SET lease_until = ${until} WHERE id = ${id} AND status = 'running' AND (lease_until IS NULL OR lease_until < ${now}) RETURNING *`).then(first),
  /** Records one item's outcome and moves the cursor only forward (no item is processed twice). */
  advance: (id, from, ok, now) => db.run(sql`
    UPDATE pack_ops SET cursor = ${from + 1}, done = done + ${ok ? 1 : 0}, failed = failed + ${ok ? 0 : 1}, updated_at = ${now}
    WHERE id = ${id} AND cursor = ${from} AND status = 'running' RETURNING cursor`).then((r) => r.rows.length > 0),
  setDst: (id, packId) => db.run(sql`UPDATE pack_ops SET dst_pack_id = ${packId} WHERE id = ${id} AND dst_pack_id IS NULL`),
  finish: (id, status, now) => db.run(sql`UPDATE pack_ops SET status = ${status}, lease_until = NULL, updated_at = ${now} WHERE id = ${id} AND status = 'running' RETURNING *`).then(first),
  release: (id) => db.run(sql`UPDATE pack_ops SET lease_until = NULL WHERE id = ${id}`),
  setProgress: (id, chatId, messageId) => db.run(sql`UPDATE pack_ops SET progress_chat_id = ${chatId}, progress_message_id = ${messageId} WHERE id = ${id}`),
  cancelOfUser: (userId, now) => db.run(sql`UPDATE pack_ops SET status = 'cancelled', updated_at = ${now} WHERE tg_id = ${userId} AND status = 'running'`).then((r) => r.rowsAffected),
  deleteOfUser: (userId) => db.run(sql`DELETE FROM pack_ops WHERE id IN (SELECT id FROM pack_ops WHERE tg_id = ${userId} LIMIT 500)`),
  pruneOld: (before) => db.run(sql`DELETE FROM pack_ops WHERE id IN (SELECT id FROM pack_ops WHERE status != 'running' AND updated_at < ${before} LIMIT 5000)`).then((r) => r.rowsAffected),
};

export const posts = {
  create: (p, now) => db.run(sql`
    INSERT INTO pack_posts (pack_id, tg_id, status, show_name, show_username, requested_at, review_msgs)
    SELECT ${p.pack_id}, ${p.tg_id}, 'pending', ${p.show_name ? 1 : 0}, ${p.show_username ? 1 : 0}, ${now}, '[]'
    WHERE NOT EXISTS (SELECT 1 FROM pack_posts WHERE pack_id = ${p.pack_id} AND status IN ('pending', 'approved', 'posting', 'published'))
    RETURNING *`).then(first),
  get: (id) => db.get(sql`SELECT * FROM pack_posts WHERE id = ${id}`),
  /** The live (pending / approved / published) post of a pack, if any. */
  liveOf: (packId) => db.get(sql`SELECT * FROM pack_posts WHERE pack_id = ${packId} AND status IN ('pending', 'approved', 'posting', 'published') ORDER BY id DESC LIMIT 1`),
  lastOf: (packId) => db.get(sql`SELECT * FROM pack_posts WHERE pack_id = ${packId} ORDER BY id DESC LIMIT 1`),
  countSince: (userId, since) => db.get(sql`SELECT count(*) AS n FROM pack_posts WHERE tg_id = ${userId} AND requested_at >= ${since}`).then((r) => (r ? r.n : 0)),
  byStatus: (statuses, n) => db.all(sql`SELECT p.*, k.title, k.tg_name, k.sticker_count FROM pack_posts p LEFT JOIN packs k ON k.id = p.pack_id WHERE p.status IN (${inList(statuses)}) ORDER BY p.id LIMIT ${n}`),
  liveOfUser: (userId) => db.all(sql`SELECT * FROM pack_posts WHERE tg_id = ${userId} AND status IN ('pending', 'approved', 'posting', 'published') LIMIT 500`),
  /** Conditional status change. @param {string[]} from */
  transition: (id, from, to, f, now) => db.run(sql`
    UPDATE pack_posts SET status = ${to},
      decided_at = CASE WHEN ${to} IN ('approved', 'rejected') THEN ${now} ELSE decided_at END,
      decided_by = CASE WHEN ${to} IN ('approved', 'rejected') THEN ${f.by ?? null} ELSE decided_by END,
      reason = coalesce(${f.reason ?? null}, reason),
      chat_id = coalesce(${f.chat_id ?? null}, chat_id),
      removed_at = CASE WHEN ${to} IN ('withdrawn', 'removed') THEN ${now} ELSE removed_at END,
      lease_until = NULL
    WHERE id = ${id} AND status IN (${inList(from)}) RETURNING *`).then(first),
  /** approved → posting with a lease, only when no message was sent yet. */
  claimPost: (id, now, until) => db.run(sql`
    UPDATE pack_posts SET status = 'posting', lease_until = ${until}
    WHERE id = ${id} AND status = 'approved' AND message_id IS NULL RETURNING *`).then(first),
  published: (id, messageId, now) => db.run(sql`
    UPDATE pack_posts SET status = 'published', message_id = ${messageId}, published_at = ${now}, lease_until = NULL WHERE id = ${id} AND status = 'posting' RETURNING *`).then(first),
  /** A post whose lease expired without a message id: we can't know whether it went out. */
  expiredPosting: (now, n) => db.all(sql`SELECT * FROM pack_posts WHERE status = 'posting' AND lease_until < ${now} ORDER BY id LIMIT ${n}`),
  nextApproved: () => db.get(sql`SELECT * FROM pack_posts WHERE status = 'approved' AND message_id IS NULL ORDER BY id LIMIT 1`),
  lastPublishedAt: () => db.get(sql`SELECT max(published_at) AS t FROM (SELECT published_at FROM pack_posts WHERE status = 'published' ORDER BY id DESC LIMIT 20)`).then((r) => (r && r.t) || 0),
  addReviewMsg: (id, chatId, messageId) => db.run(sql`
    UPDATE pack_posts SET review_msgs = json_insert(coalesce(review_msgs, '[]'), '$[#]', json_array(${chatId}, ${messageId})) WHERE id = ${id}`),
  counts: () => db.all(sql`SELECT status, count(*) AS n FROM pack_posts GROUP BY status LIMIT 20`),
  deleteOfUser: (userId) => db.run(sql`DELETE FROM pack_posts WHERE id IN (SELECT id FROM pack_posts WHERE tg_id = ${userId} LIMIT 500)`),
  page: (after, n) => db.all(sql`SELECT * FROM pack_posts WHERE id > ${after} ORDER BY id LIMIT ${n}`),
};
