// SQL for `broadcasts`. Every status change is a conditional UPDATE … WHERE status = <expected>.
// (Adapted from wanger-music lib/repositories/broadcasts.js: lease + per-recipient cursor.)
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;
const inList = (list) => list.reduce((acc, v, i) => (i ? sql`${acc}, ${v}` : sql`${v}`), sql``);

export const broadcasts = {
  create: (b, now) => db.run(sql`
    INSERT INTO broadcasts (created_by, source_chat_id, source_message_id, mode, audience, status, created_at)
    VALUES (${b.created_by}, ${b.source_chat_id}, ${b.source_message_id}, 'copy', 'all', 'draft', ${now}) RETURNING *`).then(first),
  get: (id) => db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`),
  recent: (n) => db.all(sql`SELECT * FROM broadcasts WHERE status != 'draft' ORDER BY id DESC LIMIT ${n}`),
  active: () => db.get(sql`SELECT * FROM broadcasts WHERE status IN ('running', 'paused') ORDER BY id LIMIT 1`),
  nextRunnable: (now) => db.get(sql`SELECT * FROM broadcasts WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ${now}) ORDER BY id LIMIT 1`),
  setOptions: (id, mode, audience) => db.run(sql`UPDATE broadcasts SET mode = ${mode}, audience = ${audience} WHERE id = ${id} AND status = 'draft' RETURNING *`).then(first),
  /** draft → running, only if no other broadcast is running or paused. */
  start: (id, total, now, chatId, messageId) => db.run(sql`
    UPDATE broadcasts SET status = 'running', total = ${total}, started_at = ${now}, progress_chat_id = ${chatId}, progress_message_id = ${messageId}
    WHERE id = ${id} AND status = 'draft' AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status IN ('running', 'paused'))
    RETURNING *`).then(first),
  transition: (id, from, to, now) => db.run(sql`
    UPDATE broadcasts SET status = ${to},
      finished_at = CASE WHEN ${to} IN ('done', 'cancelled') THEN ${now} ELSE finished_at END,
      lease_until = CASE WHEN ${to} IN ('done', 'cancelled') THEN NULL ELSE lease_until END
    WHERE id = ${id} AND status IN (${inList(from)}) RETURNING *`).then(first),
  claim: (id, now, until) => db.run(sql`
    UPDATE broadcasts SET lease_until = ${until} WHERE id = ${id} AND status = 'running' AND (lease_until IS NULL OR lease_until < ${now}) RETURNING *`).then(first),
  release: (id) => db.run(sql`UPDATE broadcasts SET lease_until = NULL WHERE id = ${id}`),
  /**
   * Records one recipient's outcome and moves the cursor — only forward, so a recipient is counted
   * (and, because the batch re-reads from the cursor, messaged) at most once.
   * @returns {Promise<string|null>} the broadcast's status, or null when the cursor already passed
   */
  recordOne: (id, tgId, outcome) => db.run(sql`
    UPDATE broadcasts SET cursor_tg_id = ${tgId}, inflight_tg_id = NULL,
      sent = sent + ${outcome === 'sent' ? 1 : 0}, failed = failed + ${outcome === 'failed' ? 1 : 0}, blocked = blocked + ${outcome === 'blocked' ? 1 : 0}
    WHERE id = ${id} AND cursor_tg_id < ${tgId} RETURNING status`).then((r) => (first(r) ? first(r).status : null)),
  /** Marks the next recipient as in flight (only forward of the cursor, only when nothing is in flight). */
  markInflight: (id, tgId) => db.run(sql`
    UPDATE broadcasts SET inflight_tg_id = ${tgId} WHERE id = ${id} AND cursor_tg_id < ${tgId} AND inflight_tg_id IS NULL RETURNING id`).then((r) => r.rows.length > 0),
  /** A recipient left in flight by a dead invocation: skip it as uncertain (never re-send). */
  skipInflight: (id) => db.run(sql`
    UPDATE broadcasts SET cursor_tg_id = max(cursor_tg_id, inflight_tg_id), uncertain = uncertain + 1, inflight_tg_id = NULL
    WHERE id = ${id} AND inflight_tg_id IS NOT NULL RETURNING inflight_tg_id`).then((r) => r.rows.length > 0),
  deleteDraft: (id) => db.run(sql`DELETE FROM broadcasts WHERE id = ${id} AND status = 'draft'`).then((r) => r.rowsAffected),
};
