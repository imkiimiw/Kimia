// SQL for `broadcasts`. Every status change is a conditional UPDATE … WHERE status = <expected>.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => r.rows[0] || null;
/** @param {string[]} list */
const inList = (list) => list.reduce((acc, v, i) => (i ? sql`${acc}, ${v}` : sql`${v}`), sql``);

export function createBroadcastsRepo() {
  return {
    create: (b) => db.run(sql`
      INSERT INTO broadcasts (created_by, source_chat_id, source_message_id, status, cursor_user_id, total, sent, failed, blocked, created_at)
      VALUES (${b.created_by}, ${b.source_chat_id}, ${b.source_message_id}, 'draft', 0, 0, 0, 0, 0, ${b.now}) RETURNING *`).then(first),
    get: (id) => db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`),
    recent: (limit) => db.all(sql`SELECT * FROM broadcasts WHERE status != 'draft' ORDER BY id DESC LIMIT ${limit}`),
    active: () => db.get(sql`SELECT * FROM broadcasts WHERE status IN ('running', 'paused') ORDER BY id LIMIT 1`),
    nextRunnable: (now) => db.get(sql`
      SELECT * FROM broadcasts WHERE status = 'running' AND (lock_until IS NULL OR lock_until < ${now}) ORDER BY id LIMIT 1`),

    /** draft → running, only if no other broadcast is running or paused. */
    start: (id, total, now, chatId, messageId) => db.run(sql`
      UPDATE broadcasts SET status = 'running', total = ${total}, started_at = ${now},
        progress_chat_id = ${chatId}, progress_message_id = ${messageId}
      WHERE id = ${id} AND status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM broadcasts WHERE status IN ('running', 'paused'))
      RETURNING *`).then(first),

    /** Conditional status change. @param {string[]} from */
    transition: (id, from, to, now) => db.run(sql`
      UPDATE broadcasts SET status = ${to},
        finished_at = CASE WHEN ${to} IN ('done', 'cancelled') THEN ${now} ELSE finished_at END,
        lock_until = CASE WHEN ${to} IN ('done', 'cancelled') THEN NULL ELSE lock_until END
      WHERE id = ${id} AND status IN (${inList(from)})
      RETURNING *`).then(first),

    /** Lease for one batch, so two invocations never send the same batch. */
    claim: (id, now, until) => db.run(sql`
      UPDATE broadcasts SET lock_until = ${until}
      WHERE id = ${id} AND status = 'running' AND (lock_until IS NULL OR lock_until < ${now}) RETURNING *`).then(first),
    release: (id) => db.run(sql`UPDATE broadcasts SET lock_until = NULL WHERE id = ${id}`),
    releaseExpired: (now) => db.run(sql`UPDATE broadcasts SET lock_until = NULL WHERE lock_until IS NOT NULL AND lock_until < ${now}`).then((r) => r.rowsAffected),

    /** Records one recipient's outcome and moves the cursor; returns the broadcast's status, or null if the cursor already moved past. */
    recordOne: (id, userRowId, outcome) => db.run(sql`
      UPDATE broadcasts SET cursor_user_id = ${userRowId},
        sent = sent + ${outcome === 'sent' ? 1 : 0},
        failed = failed + ${outcome === 'failed' ? 1 : 0},
        blocked = blocked + ${outcome === 'blocked' ? 1 : 0}
      WHERE id = ${id} AND cursor_user_id < ${userRowId} RETURNING status`).then((r) => (r.rows[0] ? r.rows[0].status : null)),

    setProgressMessage: (id, chatId, messageId) => db.run(sql`UPDATE broadcasts SET progress_chat_id = ${chatId}, progress_message_id = ${messageId} WHERE id = ${id}`),
    deleteDraft: (id) => db.run(sql`DELETE FROM broadcasts WHERE id = ${id} AND status = 'draft'`).then((r) => r.rowsAffected),
  };
}
