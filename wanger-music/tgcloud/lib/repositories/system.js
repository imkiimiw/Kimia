// SQL for the operational tables: processed_updates, error_log, alerts, audit_log.
import { db } from 'sdk';
import { sql } from 'sdk/db';

export function createSystemRepo() {
  return {
    /** Update dedupe: true the first time an update_id is seen. */
    claimUpdate: (updateId, now) => db.run(sql`
      INSERT INTO processed_updates (update_id, created_at) VALUES (${updateId}, ${now})
      ON CONFLICT (update_id) DO NOTHING RETURNING update_id`).then((r) => r.rows.length > 0),
    pruneUpdates: (before, cap) => db.run(sql`
      DELETE FROM processed_updates WHERE update_id IN (SELECT update_id FROM processed_updates WHERE created_at < ${before} LIMIT ${cap})`).then((r) => r.rowsAffected),

    insertError: (e) => db.run(sql`
      INSERT INTO error_log (created_at, handler, update_id, user_id, code, message, stack, context)
      VALUES (${e.created_at}, ${e.handler}, ${e.update_id}, ${e.user_id}, ${e.code}, ${e.message}, ${e.stack}, ${e.context})`),
    recentErrors: (n) => db.all(sql`SELECT id, created_at, handler, code, message FROM error_log ORDER BY id DESC LIMIT ${n}`),
    pruneErrors: (keep) => db.run(sql`DELETE FROM error_log WHERE id <= (SELECT coalesce(max(id), 0) FROM error_log) - ${keep}`).then((r) => r.rowsAffected),

    /**
     * Throttle election in one statement: a row comes back only when the alert may be sent
     * (first time for the key, or `every` seconds after the last one). `count` = alerts sent.
     */
    claimAlert: (key, now, every) => db.run(sql`
      INSERT INTO alerts (key, last_sent_at, count) VALUES (${key}, ${now}, 1)
      ON CONFLICT (key) DO UPDATE SET last_sent_at = excluded.last_sent_at, count = alerts.count + 1
      WHERE alerts.last_sent_at <= ${now - every}
      RETURNING key`).then((r) => r.rows.length > 0),

    insertAudit: (a) => db.run(sql`
      INSERT INTO audit_log (actor_id, action, target_type, target_id, details, created_at)
      VALUES (${a.actor_id}, ${a.action}, ${a.target_type}, ${a.target_id}, ${a.details}, ${a.created_at})`),
    recentAudit: (n) => db.all(sql`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${n}`),
  };
}
