/*
 * Test-only endpoint for test/cloud/smoke.mjs. The script copies it to
 * tgcloud/endpoints/zz_devtools.js for the run (`tgcloud run` executes local files without
 * deploying them) and always deletes it afterwards, so it is never pushed. It reads bot-wide state
 * and reads/deletes ONLY the fake smoke-test users (ids 990000100-990000199). It never touches the
 * audit log.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';

const LO = 990000100;
const HI = 990000199;

export default async function (input) {
  const action = input && input.action;
  if (action === 'read') {
    return {
      kv: await db.all(sql`SELECT key, value FROM aegis_kv WHERE key IN ('data_version', 'join_enabled', 'join_rev', 'cmd_rev', 'bot_id', 'bot_username') LIMIT 20`),
      channels: await db.all(sql`SELECT id, username, chat_id, title, bot_admin, last_error, position FROM aegis_join_channels ORDER BY position LIMIT 20`),
      users: await db.all(sql`SELECT user_id, lang, lang_set, started, blocked FROM aegis_users WHERE user_id BETWEEN ${LO} AND ${HI} LIMIT 50`),
      tables: await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aegis_%' ORDER BY name LIMIT 50`),
      indexes: await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_aegis_%' ORDER BY name LIMIT 50`),
    };
  }
  if (action === 'cleanup') {
    const u = await db.run(sql`DELETE FROM aegis_users WHERE user_id BETWEEN ${LO} AND ${HI}`);
    const s = await db.run(sql`DELETE FROM aegis_states WHERE user_id BETWEEN ${LO} AND ${HI}`);
    const e = await db.run(sql`DELETE FROM aegis_errors WHERE user_id BETWEEN ${LO} AND ${HI}`);
    return { users: u.rowsAffected, states: s.rowsAffected, errors: e.rowsAffected };
  }
  return { error: 'unknown action' };
}
