// SQL for `settings` (key → JSON value).
import { db } from 'sdk';
import { sql } from 'sdk/db';

export function createSettingsRepo() {
  return {
    all: () => db.all(sql`SELECT key, value FROM settings LIMIT 200`),

    upsert: (key, valueJson, actorId, now) => db.run(sql`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${valueJson}, ${now}, ${actorId})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),

    insertIfMissing: (key, valueJson, now) => db.run(sql`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${valueJson}, ${now}, 0) ON CONFLICT (key) DO NOTHING`),

    /**
     * Elects one winner: sets an integer setting to `now` only if it is at least `gap` seconds old.
     * @returns {Promise<boolean>} true for the single caller that won
     */
    claimInterval: (key, now, gap) => db.run(sql`
      UPDATE settings SET value = ${String(now)}, updated_at = ${now}
      WHERE key = ${key} AND CAST(value AS INTEGER) <= ${now - gap} RETURNING key`).then((r) => r.rows.length > 0),

    ping: () => db.get(sql`SELECT 1 AS ok`),
  };
}
