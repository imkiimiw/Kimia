// Test-only endpoint for test/cloud/run-tests.mjs. The script copies it to
// tgcloud/endpoints/zz_devtools.js for the duration of the run (`npx tgcloud run` executes local
// files without deploying them) and deletes it afterwards, so it is never pushed.
// It touches only test users (ids 990000000-990000999), fake channels (zz_fake_*) and,
// to restore the starting state, a channel row the script saved before the test.
import { db } from 'sdk';
import { sql } from 'sdk/db';

const OWNER_ID = 5557901897;
const isTestUser = (id) => Number.isInteger(id) && id >= 990000000 && id <= 990000999;

function testUser(id) {
  if (!isTestUser(id)) throw new Error(`not a test user: ${id}`);
  return id;
}

export default async function (input) {
  const now = Math.floor(Date.now() / 1000);
  switch (input.op) {
    case 'snapshot':
      return {
        channels: await db.all(sql`SELECT * FROM channels ORDER BY id`),
        settings: await db.all(sql`SELECT key, value FROM settings`),
      };
    case 'tables':
      return db.all(sql`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`);
    case 'tasks':
      return db.all(sql`
        SELECT id, user_id, text, done, priority, due_date, category_id FROM tasks
        WHERE user_id = ${testUser(input.user)} ORDER BY id`);
    case 'cats':
      return db.all(sql`SELECT id, name FROM categories WHERE user_id = ${testUser(input.user)} ORDER BY id`);
    case 'state': {
      if (!isTestUser(input.user) && input.user !== OWNER_ID) throw new Error('not allowed');
      return db.get(sql`SELECT state, data FROM user_state WHERE user_id = ${input.user}`);
    }
    case 'set_owner_state':
      await db.run(sql`
        INSERT INTO user_state (user_id, state, data, updated_at) VALUES (${OWNER_ID}, ${input.state}, '{}', ${now})
        ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`);
      return true;
    case 'fill_channels': {
      // Fake channels up to the limit, already "warned" so the owner gets no warnings about them.
      const { n } = await db.get(sql`SELECT count(*) AS n FROM channels`);
      const added = [];
      for (let i = Number(n) + 1; i <= input.to; i += 1) {
        const name = `zz_fake_${i}`;
        await db.run(sql`INSERT OR IGNORE INTO channels (uname, username, warned_at, created_at) VALUES (${name}, ${name}, ${now}, ${now})`);
        added.push(name);
      }
      return added;
    }
    case 'drop_fake_channels':
      return (await db.run(sql`DELETE FROM channels WHERE uname LIKE 'zz_fake_%'`)).rowsAffected;
    case 'restore_channel': {
      const c = input.channel;
      const r = await db.run(sql`
        INSERT OR IGNORE INTO channels (uname, username, chat_id, title, warned_at, created_at)
        VALUES (${c.uname}, ${c.username}, ${c.chat_id ?? null}, ${c.title ?? null}, ${c.warned_at ?? 0}, ${c.created_at ?? now})`);
      return r.rowsAffected;
    }
    case 'set_join':
      await db.run(sql`
        INSERT INTO settings (key, value) VALUES ('join', ${input.value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      return true;
    case 'cleanup': {
      let removed = 0;
      for (const id of input.users.map(testUser)) {
        await db.run(sql`DELETE FROM tasks WHERE user_id = ${id}`);
        await db.run(sql`DELETE FROM categories WHERE user_id = ${id}`);
        await db.run(sql`DELETE FROM user_state WHERE user_id = ${id}`);
        removed += (await db.run(sql`DELETE FROM users WHERE id = ${id}`)).rowsAffected;
      }
      if (removed) {
        await db.run(sql`
          UPDATE settings SET value = CAST(max(0, CAST(value AS INTEGER) - ${removed}) AS TEXT) WHERE key = 'users'`);
      }
      return { removedUsers: removed };
    }
    default:
      throw new Error(`unknown op ${input.op}`);
  }
}
