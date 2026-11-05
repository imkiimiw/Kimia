// Test-only endpoint for test/cloud/run-tests.mjs. The script copies it to
// tgcloud/endpoints/zz_devtools.js for the duration of the run (`npx tgcloud run` executes local
// files without deploying them) and deletes it afterwards, so it is never pushed.
// It touches only test users (ids 990000000-990000999 and BotFather's id, used as a recipient that
// answers 403), fake channels (zz_fake_*), the owner's settings/cooldown fields (restored at the
// end) and, to restore the starting state, rows the script saved before the test.
import { api, db, fetch } from 'sdk';
import { sql } from 'sdk/db';

const OWNER_ID = 5557901897;
const BOTFATHER_ID = 93372553; // a bot: Telegram answers 403 "bot can't send messages to bots"
const isTestUser = (id) => Number.isInteger(id) && ((id >= 990000000 && id <= 990000999) || id === BOTFATHER_ID);

function testUser(id) {
  if (!isTestUser(id)) throw new Error(`not a test user: ${id}`);
  return id;
}

const OWNER_FIELDS = new Set(['quality', 'cap_text', 'cap_author', 'cap_link', 'last_req', 'busy_until', 'day', 'day_count']);
const USER_FIELDS = new Set([...OWNER_FIELDS, 'active', 'banned', 'first_seen', 'last_seen']);

async function probePlatform() {
  const out = { setTimeout: typeof setTimeout, TextEncoder: typeof TextEncoder, URL: typeof URL, AbortController: typeof AbortController };
  const url = 'https://video.twimg.com/tweet_video/HQMpCLzboAAgZ3Y.mp4'; // a 25042-byte GIF (GIPHY post)
  try {
    const head = await fetch(url, { method: 'HEAD' });
    out.head = { status: head.status, length: head.headers.get('content-length'), url: head.url };
  } catch (e) {
    out.head = { error: String(e && e.message) };
  }
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    out.range = { status: r.status, contentRange: r.headers.get('content-range') };
    try {
      if (r.body && typeof r.body.cancel === 'function') await r.body.cancel();
    } catch (e) {
      out.range.cancelError = String(e && e.message);
    }
  } catch (e) {
    out.range = { error: String(e && e.message) };
  }
  try {
    const r = await fetch(url);
    out.body = { status: r.status, hasAsyncIterator: !!(r.body && typeof r.body[Symbol.asyncIterator] === 'function'), arrayBuffer: typeof r.arrayBuffer, bytes: typeof r.bytes };
    const kinds = new Set();
    let total = 0;
    let head = [];
    for await (const chunk of r.body) {
      kinds.add(typeof chunk === 'string' ? 'string' : chunk && chunk.constructor ? chunk.constructor.name : typeof chunk);
      const n = chunk.length || chunk.byteLength || 0;
      if (!head.length && typeof chunk !== 'string') head = Array.from(chunk.slice(0, 12));
      total += n;
    }
    out.body.chunkTypes = [...kinds];
    out.body.total = total;
    out.body.mp4Header = String.fromCharCode(...head.slice(4, 8)); // "ftyp" for a real mp4
  } catch (e) {
    out.body = { ...(out.body || {}), error: String(e && e.message) };
  }
  return out;
}

export default async function (input) {
  const now = Math.floor(Date.now() / 1000);
  switch (input.op) {
    case 'probe':
      return probePlatform();
    case 'tables':
      return db.all(sql`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`);
    case 'snapshot':
      return {
        channels: await db.all(sql`SELECT * FROM channels ORDER BY id`),
        settings: await db.all(sql`SELECT key, value FROM settings`),
        counters: await db.all(sql`SELECT key, value FROM counters`),
        owner: await db.get(sql`SELECT quality, cap_text, cap_author, cap_link, day, day_count FROM users WHERE id = ${OWNER_ID}`),
        realUsers: (await db.get(sql`
          SELECT count(*) AS n FROM users
          WHERE id <> ${OWNER_ID} AND NOT (id BETWEEN 990000000 AND 990000999) AND id <> ${BOTFATHER_ID}
            AND active = 1 AND banned = 0 AND first_seen > 0`)).n,
        running: await db.get(sql`SELECT id FROM broadcasts WHERE status = 'running' LIMIT 1`),
      };
    case 'daily':
      return db.get(sql`SELECT * FROM daily ORDER BY day DESC LIMIT 1`);
    case 'user': {
      if (!isTestUser(input.user) && input.user !== OWNER_ID) throw new Error('not allowed');
      return db.get(sql`SELECT * FROM users WHERE id = ${input.user}`);
    }
    case 'set_user': {
      const owner = input.user === OWNER_ID;
      if (!owner) testUser(input.user);
      const allowed = owner ? OWNER_FIELDS : USER_FIELDS;
      for (const [k, v] of Object.entries(input.set || {})) {
        if (!allowed.has(k)) throw new Error(`field not allowed: ${k}`);
        await db.run(sql`UPDATE users SET ${sql.raw(k)} = ${v} WHERE id = ${input.user}`);
      }
      return db.get(sql`SELECT * FROM users WHERE id = ${input.user}`);
    }
    case 'add_test_user': {
      const id = testUser(input.user);
      // Counted like a real user (lib/store.js createUser), so cleanup leaves the counters as they were.
      const r = await db.run(sql`
        INSERT INTO users (id, first_name, first_seen, last_seen, active) VALUES (${id}, ${input.name || 'Test'}, ${now}, ${now}, 1)
        ON CONFLICT(id) DO NOTHING`);
      if (r.rowsAffected) {
        await db.run(sql`INSERT INTO counters (key, value) VALUES ('users_total', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1`);
        await db.run(sql`INSERT INTO counters (key, value) VALUES ('users_active', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1`);
        return 1;
      }
      const re = await db.run(sql`UPDATE users SET active = 1, banned = 0 WHERE id = ${id} AND active = 0`);
      if (re.rowsAffected) await db.run(sql`UPDATE counters SET value = value + 1 WHERE key = 'users_active'`);
      await db.run(sql`UPDATE users SET banned = 0 WHERE id = ${id}`);
      return 0;
    }
    case 'downloads':
      return db.all(sql`SELECT id, post_id, kind FROM downloads WHERE user_id = ${input.user === OWNER_ID ? OWNER_ID : testUser(input.user)} ORDER BY id DESC LIMIT 25`);
    case 'state': {
      if (!isTestUser(input.user) && input.user !== OWNER_ID) throw new Error('not allowed');
      return db.get(sql`SELECT state, data FROM user_state WHERE user_id = ${input.user}`);
    }
    case 'post':
      return db.get(sql`SELECT id, source, fetched_at, length(media) AS media_len FROM posts WHERE id = ${String(input.id)}`);
    case 'post_set_source':
      return (await db.run(sql`UPDATE posts SET source = ${input.source}, fetched_at = ${input.fetchedAt} WHERE id = ${String(input.id)}`)).rowsAffected;
    case 'post_forget':
      // Only the post row: cached file_ids stay valid (they are Telegram's, keyed by post/item/quality).
      return (await db.run(sql`DELETE FROM posts WHERE id = ${String(input.id)}`)).rowsAffected;
    case 'cache_forget':
      // The test posts' cached file_ids, so a re-run downloads and uploads again (B1, B3, B4, B11).
      return (await db.run(sql`DELETE FROM file_cache WHERE post_id = ${String(input.id)}`)).rowsAffected;
    case 'cache':
      return db.all(sql`SELECT item, q, kind, size FROM file_cache WHERE post_id = ${String(input.id)} ORDER BY item, q LIMIT 50`);
    case 'fill_channels': {
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
    case 'set_setting':
      await db.run(sql`
        INSERT INTO settings (key, value) VALUES (${input.key}, ${input.value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      return true;
    case 'owner_test_message': {
      // A real message in the owner's chat, so a broadcast test has something copyMessage can copy.
      const m = await api.sendMessage({ chat_id: OWNER_ID, text: input.text || '🧪 پیام آزمایشی پیام سراسری' });
      return { message_id: m.message_id, chat_id: m.chat.id };
    }
    case 'latest_broadcast':
      return db.get(sql`SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1`);
    case 'broadcast_clear_retry':
      return (await db.run(sql`UPDATE broadcasts SET retry_at = 0 WHERE id = ${input.id}`)).rowsAffected;
    case 'cleanup': {
      let removed = 0;
      let active = 0;
      for (const id of input.users.map(testUser)) {
        const u = await db.get(sql`SELECT active, first_seen FROM users WHERE id = ${id}`);
        await db.run(sql`DELETE FROM downloads WHERE user_id = ${id}`);
        await db.run(sql`DELETE FROM user_state WHERE user_id = ${id}`);
        const r = await db.run(sql`DELETE FROM users WHERE id = ${id}`);
        if (r.rowsAffected && u && Number(u.first_seen) > 0) {
          removed += 1;
          if (Number(u.active) === 1) active += 1;
        }
      }
      if (removed) await db.run(sql`UPDATE counters SET value = max(0, value - ${removed}) WHERE key = 'users_total'`);
      if (active) await db.run(sql`UPDATE counters SET value = max(0, value - ${active}) WHERE key = 'users_active'`);
      return { removedUsers: removed };
    }
    default:
      throw new Error(`unknown op ${input.op}`);
  }
}
