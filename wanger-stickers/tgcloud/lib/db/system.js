// SQL for the operational tables: settings, secrets, errors, alerts, processed_updates,
// stats_daily, rate_limits, audit_log, user_state, pending_actions, staff, and housekeeping.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const first = (r) => (r && r.rows && r.rows[0]) || null;

export const system = {
  /* ---- settings / secrets ---- */
  allSettings: () => db.all(sql`SELECT key, value FROM settings LIMIT 500`),
  setSetting: (key, value, actor, now) => db.run(sql`
    INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${JSON.stringify(value)}, ${now}, ${actor})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  /** Sets a setting only if it is absent (seeds, one-time markers). @returns {Promise<boolean>} inserted */
  claimSetting: (key, value, now) => db.run(sql`
    INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${JSON.stringify(value)}, ${now}, 0)
    ON CONFLICT (key) DO NOTHING RETURNING key`).then((r) => r.rows.length > 0),
  /** Compare-and-set on a numeric setting (housekeeping election). */
  casSetting: (key, expected, value, now) => db.run(sql`
    UPDATE settings SET value = ${JSON.stringify(value)}, updated_at = ${now} WHERE key = ${key} AND value = ${JSON.stringify(expected)} RETURNING key`).then((r) => r.rows.length > 0),

  secretNames: () => db.all(sql`SELECT key, length(value) AS len, updated_at FROM secrets ORDER BY key LIMIT 50`),
  getSecret: (key) => db.get(sql`SELECT value FROM secrets WHERE key = ${key}`).then((r) => (r ? r.value : null)),
  setSecret: (key, value, now) => db.run(sql`
    INSERT INTO secrets (key, value, updated_at) VALUES (${key}, ${value}, ${now})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  deleteSecret: (key) => db.run(sql`DELETE FROM secrets WHERE key = ${key}`).then((r) => r.rowsAffected),

  /* ---- errors and alerts ---- */
  insertError: (e) => db.run(sql`INSERT INTO errors (at, tg_id, scope, code, message) VALUES (${e.at}, ${e.tg_id}, ${e.scope}, ${e.code}, ${e.message})`),
  recentErrors: (n) => db.all(sql`SELECT * FROM errors ORDER BY id DESC LIMIT ${n}`),
  errorGroups: (n) => db.all(sql`SELECT scope, code, count(*) AS n, max(at) AS last_at FROM (SELECT scope, code, at FROM errors ORDER BY id DESC LIMIT ${n}) GROUP BY scope, code ORDER BY n DESC LIMIT 20`),
  errorsSince: (since) => db.get(sql`SELECT count(*) AS n FROM (SELECT at FROM errors ORDER BY id DESC LIMIT 200) WHERE at >= ${since}`).then((r) => (r ? r.n : 0)),
  clearErrors: () => db.run(sql`DELETE FROM errors WHERE id IN (SELECT id FROM errors ORDER BY id LIMIT 5000)`).then((r) => r.rowsAffected),
  pruneErrors: (keep) => db.run(sql`DELETE FROM errors WHERE id IN (
    SELECT id FROM errors WHERE id <= (SELECT coalesce(max(id), 0) FROM errors) - ${keep} ORDER BY id LIMIT 5000)`).then((r) => r.rowsAffected),
  /** One statement elects who may send an alert: first time for the key, or `every` seconds later. */
  claimAlert: (key, now, every) => db.run(sql`
    INSERT INTO alerts (key, last_sent_at, count) VALUES (${key}, ${now}, 1)
    ON CONFLICT (key) DO UPDATE SET last_sent_at = excluded.last_sent_at, count = alerts.count + 1
    WHERE alerts.last_sent_at <= ${now - every} RETURNING key`).then((r) => r.rows.length > 0),

  /* ---- updates ---- */
  claimUpdate: (id, now) => db.run(sql`INSERT INTO processed_updates (update_id, created_at) VALUES (${id}, ${now}) ON CONFLICT (update_id) DO NOTHING RETURNING update_id`).then((r) => r.rows.length > 0),
  pruneUpdates: (before) => db.run(sql`DELETE FROM processed_updates WHERE update_id IN (SELECT update_id FROM processed_updates WHERE created_at < ${before} LIMIT 5000)`).then((r) => r.rowsAffected),

  /* ---- stats ---- */
  /** Adds buffered counters in one statement. @param {number} day @param {[string, number][]} pairs */
  addStats: (day, pairs) => {
    if (!pairs.length) return Promise.resolve(0);
    const values = pairs.reduce((acc, [m, v], i) => (i ? sql`${acc}, (${day}, ${m}, ${v})` : sql`(${day}, ${m}, ${v})`), sql``);
    return db.run(sql`INSERT INTO stats_daily (day, metric, value) VALUES ${values} ON CONFLICT (day, metric) DO UPDATE SET value = value + excluded.value`);
  },
  statsSince: (fromDay) => db.all(sql`SELECT metric, sum(value) AS n FROM stats_daily WHERE day >= ${fromDay} GROUP BY metric LIMIT 200`),

  /* ---- rate limits (token bucket, read-then-write; a lost race only lets one extra event through) ---- */
  getBucket: (id, bucket) => db.get(sql`SELECT tokens, updated_at FROM rate_limits WHERE tg_id = ${id} AND bucket = ${bucket}`),
  setBucket: (id, bucket, tokens, now) => db.run(sql`
    INSERT INTO rate_limits (tg_id, bucket, tokens, updated_at) VALUES (${id}, ${bucket}, ${tokens}, ${now})
    ON CONFLICT (tg_id, bucket) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`),
  pruneBuckets: (before) => db.run(sql`DELETE FROM rate_limits WHERE (tg_id, bucket) IN (SELECT tg_id, bucket FROM rate_limits WHERE updated_at < ${before} LIMIT 5000)`).then((r) => r.rowsAffected),

  /* ---- audit ---- */
  audit: (a) => db.run(sql`INSERT INTO audit_log (at, actor_id, action, target, details) VALUES (${a.at}, ${a.actor_id}, ${a.action}, ${a.target}, ${a.details})`),
  pruneAudit: (keep) => db.run(sql`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE id <= (SELECT coalesce(max(id), 0) FROM audit_log) - ${keep} ORDER BY id LIMIT 5000)`).then((r) => r.rowsAffected),

  /* ---- conversation state and pending actions ---- */
  getState: (id, now) => db.get(sql`SELECT step, payload FROM user_state WHERE tg_id = ${id} AND expires_at > ${now}`),
  setState: (id, step, payload, until) => db.run(sql`
    INSERT INTO user_state (tg_id, step, payload, expires_at) VALUES (${id}, ${step}, ${JSON.stringify(payload || {})}, ${until})
    ON CONFLICT (tg_id) DO UPDATE SET step = excluded.step, payload = excluded.payload, expires_at = excluded.expires_at`),
  clearState: (id) => db.run(sql`DELETE FROM user_state WHERE tg_id = ${id}`).then((r) => r.rowsAffected),
  setPending: (id, action, until) => db.run(sql`
    INSERT INTO pending_actions (tg_id, action, expires_at) VALUES (${id}, ${JSON.stringify(action)}, ${until})
    ON CONFLICT (tg_id) DO UPDATE SET action = excluded.action, expires_at = excluded.expires_at`),
  /** Takes the pending action (read + delete in one statement). */
  takePending: (id, now) => db.run(sql`DELETE FROM pending_actions WHERE tg_id = ${id} AND expires_at > ${now} RETURNING action`).then((r) => (first(r) ? first(r).action : null)),
  clearPending: (id) => db.run(sql`DELETE FROM pending_actions WHERE tg_id = ${id}`),

  /* ---- staff (reviewers) ---- */
  getStaff: (id) => db.get(sql`SELECT * FROM staff WHERE tg_id = ${id}`),
  listStaff: () => db.all(sql`SELECT s.*, u.first_name, u.username FROM staff s LEFT JOIN users u ON u.tg_id = s.tg_id ORDER BY s.added_at LIMIT 50`),
  addStaff: (id, role, by, now) => db.run(sql`INSERT INTO staff (tg_id, role, added_by, added_at) VALUES (${id}, ${role}, ${by}, ${now}) ON CONFLICT (tg_id) DO NOTHING RETURNING tg_id`).then((r) => r.rows.length > 0),
  removeStaff: (id) => db.run(sql`DELETE FROM staff WHERE tg_id = ${id}`).then((r) => r.rowsAffected),
  countStaff: () => db.get(sql`SELECT count(*) AS n FROM staff`).then((r) => (r ? r.n : 0)),

  /* ---- housekeeping (each ≤ 5000 rows per statement) ---- */
  pruneExpired: async (now) => {
    const a = await db.run(sql`DELETE FROM user_state WHERE tg_id IN (SELECT tg_id FROM user_state WHERE expires_at <= ${now} LIMIT 5000)`);
    const b = await db.run(sql`DELETE FROM pending_actions WHERE tg_id IN (SELECT tg_id FROM pending_actions WHERE expires_at <= ${now} LIMIT 5000)`);
    const c = await db.run(sql`DELETE FROM membership_cache WHERE tg_id IN (SELECT tg_id FROM membership_cache WHERE ok_until <= ${now} LIMIT 5000)`);
    return a.rowsAffected + b.rowsAffected + c.rowsAffected;
  },
};
