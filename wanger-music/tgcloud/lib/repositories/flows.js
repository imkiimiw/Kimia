// SQL for `user_flows` (one pending multi-step input per user).
import { db } from 'sdk';
import { sql } from 'sdk/db';

export function createFlowsRepo() {
  return {
    get: (userId, now) => db.get(sql`SELECT * FROM user_flows WHERE user_id = ${userId} AND expires_at > ${now}`),
    set: (userId, flow, step, dataJson, expiresAt) => db.run(sql`
      INSERT INTO user_flows (user_id, flow, step, data, expires_at) VALUES (${userId}, ${flow}, ${step}, ${dataJson}, ${expiresAt})
      ON CONFLICT (user_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data = excluded.data, expires_at = excluded.expires_at`),
    clear: (userId) => db.run(sql`DELETE FROM user_flows WHERE user_id = ${userId}`).then((r) => r.rowsAffected),
    deleteExpired: (now, cap) => db.run(sql`
      DELETE FROM user_flows WHERE user_id IN (SELECT user_id FROM user_flows WHERE expires_at <= ${now} LIMIT ${cap})`).then((r) => r.rowsAffected),
  };
}
