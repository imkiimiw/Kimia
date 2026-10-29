// Test-only endpoint for test/cloud/run-tests.mjs. The script copies it to
// tgcloud/endpoints/zz_devtools.js for the duration of the run (`npx tgcloud run` executes local
// files without deploying them) and deletes it afterwards, so it is never pushed.
// It reads and writes only test users (ids 990000001-990000999), the bot account used for the 403
// test (the @telegram channel's id: the bot isn't a member there, so copyMessage gets a real 403),
// fake channels (zz_fake_*), broadcasts the run created, and — to restore
// the starting state — a channel row, the join setting and the owner's anonymous-section settings the
// script saved before the test (plus the owner's inbox counters for messages the test users sent them).
import { api, db } from 'sdk';
import { sql } from 'sdk/db';

const OWNER_ID = 5557901897;
const TARGET_403 = -1001005640892; // @telegram
const TABLES = ['users', 'kv', 'channels', 'drafts', 'whispers', 'whisper_rcpts', 'snoops', 'blocks', 'user_state', 'broadcasts',
  'anon_msgs', 'anon_blocks', 'anon_words', 'ratings', 'reports', 'strikes'];
// The owner's own anonymous-section fields: saved before the run, restored after it.
const OWNER_FIELDS = ['anon_code', 'anon_on', 'a_filter', 'a_links', 'a_text', 'a_silent', 'q_mode', 'q_text'];
const TEST_IDS = [990000001, 990000002, 990000003, 990000004, 990000005, 990000009];
const isTestUser = (id) => Number.isInteger(id) && ((id >= 990000001 && id <= 990000999) || id === TARGET_403);

function testUser(id) {
  const n = Number(id);
  if (!isTestUser(n)) throw new Error(`not a test user: ${id}`);
  return n;
}

function list(values) {
  let acc = null;
  for (const v of values) acc = acc ? sql`${acc}, ${v}` : sql`${v}`;
  return acc;
}

async function bump(key, delta) {
  await db.run(sql`
    INSERT INTO kv (key, value) VALUES (${key}, '0')
    ON CONFLICT(key) DO UPDATE SET value = CAST(max(0, CAST(value AS INTEGER) + ${delta}) AS TEXT)`);
}

async function testWhisperIds(users) {
  const rows = await db.all(sql`SELECT id FROM whispers WHERE sender_id IN (${list(users)}) LIMIT 500`);
  return rows.map((r) => r.id);
}

export default async function (input) {
  const now = Math.floor(Date.now() / 1000);
  switch (input.op) {
    case 'me': {
      const me = await api.getMe();
      return { id: me.id, username: me.username, inline: !!me.supports_inline_queries, groups: !!me.can_join_groups };
    }
    case 'bot_texts': {
      // What the bot set on its first update (lib/menu.js ensureBotTexts), read back from Telegram.
      const out = [];
      for (const lang of ['', 'fa', 'en', 'ru']) {
        const p = lang ? { language_code: lang } : {};
        const commands = await api.getMyCommands(p);
        const { description } = await api.getMyDescription(p);
        const { short_description: short } = await api.getMyShortDescription(p);
        out.push({ lang: lang || 'default', commands: commands.map((c) => c.command), description, short });
      }
      return out;
    }
    case 'tables': {
      const out = {};
      for (const t of TABLES) {
        try {
          await db.get(sql.raw(`SELECT 1 AS x FROM ${t} LIMIT 1`));
          out[t] = 'ok';
        } catch (err) {
          out[t] = `missing: ${err.message}`;
        }
      }
      return out;
    }
    case 'snapshot':
      return {
        channels: await db.all(sql`SELECT * FROM channels ORDER BY id LIMIT 20`),
        kv: await db.all(sql`SELECT key, value FROM kv WHERE key IN ('join', 'chv', 'seeded', 'bc', 'bot_username', 'n_users', 'n_active', 'n_whispers', 'day')`),
        maxBroadcast: (await db.get(sql`SELECT max(id) AS m FROM broadcasts`) || {}).m || 0,
      };
    case 'real_reachable': {
      // Real users a test broadcast would reach (besides the owner): the runner skips the broadcast if any.
      const rows = await db.all(sql`
        SELECT user_id FROM users WHERE started = 1 AND active = 1 AND banned = 0 AND user_id > 0
          AND (user_id < 990000001 OR user_id > 990000999) AND user_id != ${OWNER_ID}
        ORDER BY user_id LIMIT 5`);
      return rows.map((r) => r.user_id);
    }
    case 'join_cache': {
      const chv = Number(((await db.get(sql`SELECT value FROM kv WHERE key = 'chv'`)) || {}).value || 0);
      for (const id of input.users.map(testUser)) {
        await db.run(sql`UPDATE users SET join_ok = 1, join_until = ${now + 3600}, join_ver = ${chv} WHERE user_id = ${id}`);
      }
      return chv;
    }
    case 'drop_join_cache':
      for (const id of input.users.map(testUser)) await db.run(sql`UPDATE users SET join_until = 0 WHERE user_id = ${id}`);
      return true;
    case 'user':
      return db.get(sql`SELECT * FROM users WHERE user_id = ${testUser(input.user)}`);
    case 'draft_count':
      return (await db.get(sql`SELECT count(*) AS n FROM drafts WHERE sender_id = ${testUser(input.user)}`)).n;
    case 'whisper_count':
      return (await db.get(sql`SELECT count(*) AS n FROM whispers WHERE sender_id = ${testUser(input.user)}`)).n;
    case 'whisper': {
      const w = await db.get(sql`SELECT * FROM whispers WHERE id = ${input.id}`);
      if (!w || !isTestUser(Number(w.sender_id))) return null;
      return {
        ...w,
        rcpts: await db.all(sql`SELECT slot, rid, runame, label, seen_at, opens FROM whisper_rcpts WHERE whisper_id = ${input.id} ORDER BY slot`),
        snoopers: await db.all(sql`SELECT user_id, username FROM snoops WHERE whisper_id = ${input.id} ORDER BY at LIMIT 50`),
      };
    }
    case 'age_whisper': {
      const w = await db.get(sql`SELECT sender_id FROM whispers WHERE id = ${input.id}`);
      testUser(w && w.sender_id);
      // Well in the past: the machine that runs this endpoint and the one that runs the next handler
      // call can disagree about the time by about a minute.
      await db.run(sql`UPDATE whispers SET expires_at = ${now - 600} WHERE id = ${input.id}`);
      return true;
    }
    case 'age_drafts': {
      for (const id of input.users.map(testUser)) {
        await db.run(sql`UPDATE drafts SET updated_at = ${now - 25 * 3600} WHERE sender_id = ${id}`);
      }
      await db.run(sql`UPDATE kv SET value = '0' WHERE key = 'gc_at'`);
      return true;
    }
    case 'seed_403_target': {
      // A queue entry whose copyMessage Telegram answers with a real 403. Counted like a real user, so
      // markInactive's decrement and the cleanup at the end leave the counters exact.
      await db.run(sql`DELETE FROM users WHERE user_id = ${TARGET_403}`);
      await db.run(sql`
        INSERT INTO users (user_id, username, first_name, first_seen, last_seen, active, started)
        VALUES (${TARGET_403}, NULL, 'zz 403 target', ${now}, ${now}, 1, 1)`);
      await bump('n_users', 1);
      await bump('n_active', 1);
      return true;
    }
    case 'bc_start_below': {
      // Lets the draft broadcast's queue start below the (negative) 403 target, so it is sent first.
      const r = await db.run(sql`
        UPDATE broadcasts SET last_user = ${TARGET_403 - 1}
        WHERE id = ${Number(input.id)} AND status = 'draft' AND from_chat = ${OWNER_ID} AND id > ${Number(input.after)}`);
      return r.rowsAffected;
    }
    case 'state': {
      const id = Number(input.user);
      if (!isTestUser(id) && id !== OWNER_ID) throw new Error('not allowed');
      return db.get(sql`SELECT state, data FROM user_state WHERE user_id = ${id}`);
    }
    case 'owner_anon': // the owner's anonymous-section settings, saved before the run and restored after it
      return db.get(sql.raw(`SELECT ${OWNER_FIELDS.join(', ')} FROM users WHERE user_id = ${OWNER_ID}`));
    case 'owner_anon_on': // the owner's link must accept messages for the delivery test
      await db.run(sql`UPDATE users SET anon_on = 1, a_text = 0 WHERE user_id = ${OWNER_ID}`);
      return true;
    case 'restore_owner_anon': {
      const o = input.value;
      if (!o) return false;
      await db.run(sql`
        UPDATE users SET anon_code = ${o.anon_code ?? null}, anon_on = ${o.anon_on ?? 1}, a_filter = ${o.a_filter ?? 1},
          a_links = ${o.a_links ?? 0}, a_text = ${o.a_text ?? 0}, a_silent = ${o.a_silent ?? 0},
          q_mode = ${o.q_mode ?? 0}, q_text = ${o.q_text ?? null}
        WHERE user_id = ${OWNER_ID}`);
      return true;
    }
    case 'unflood': // lets the next anonymous message through the 3-second gap (each `tgcloud run` takes ~1-2 s)
      for (const id of input.users.map(testUser)) await db.run(sql`UPDATE users SET last_anon_at = 0 WHERE user_id = ${id}`);
      return true;
    case 'anon_msgs_to': {
      const id = testUser(input.user);
      return db.all(sql`
        SELECT id, from_id, anon, kind, cat, q, folder, unread, to_msg FROM anon_msgs
        WHERE to_id = ${id} ORDER BY created_at DESC LIMIT 20`);
    }
    case 'ratings_of':
      return db.get(sql`SELECT rating_sum, rating_count FROM users WHERE user_id = ${testUser(input.user)}`);
    case 'reports_by': {
      const id = testUser(input.user);
      return db.all(sql`SELECT id, msg_id, status FROM reports WHERE reporter_id = ${id} ORDER BY id LIMIT 20`);
    }
    case 'kv_get':
      return db.all(sql`SELECT key, value FROM kv WHERE key IN (${list(input.keys)})`);
    case 'restore_n_anon': {
      // The run's anonymous messages counted in n_anon: put it back to the starting value plus the real
      // messages sent since then (by anyone but the test users).
      const real = await db.get(sql`
        SELECT count(*) AS n FROM anon_msgs WHERE folder IN (0, 1, 2) AND created_at >= ${Number(input.since)}
          AND from_id NOT IN (${list(TEST_IDS)}) LIMIT 1`);
      const value = Number(input.value || 0) + Number(real.n || 0);
      await db.run(sql`INSERT INTO kv (key, value) VALUES ('n_anon', ${String(value)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      return value;
    }
    case 'anon_blocks_of_owner':
      return (await db.get(sql`SELECT count(*) AS n FROM anon_blocks WHERE owner_id = ${OWNER_ID} AND blocked_id IN (${list(TEST_IDS)})`)).n;
    case 'clear_owner_state':
      await db.run(sql`DELETE FROM user_state WHERE user_id = ${OWNER_ID}`);
      return true;
    case 'channels':
      return db.all(sql`SELECT id, uname, username, chat_id FROM channels ORDER BY id LIMIT 20`);
    case 'fill_channels': {
      // Fake channels up to the limit, already "warned" so the owner gets no warnings about them.
      const { n } = await db.get(sql`SELECT count(*) AS n FROM channels`);
      const added = [];
      for (let i = Number(n) + 1; i <= input.to; i += 1) {
        const name = `zz_fake_${i}`;
        await db.run(sql`INSERT INTO channels (uname, username, warned_at, created_at) VALUES (${name}, ${name}, ${now}, ${now}) ON CONFLICT(uname) DO NOTHING`);
        added.push(name);
      }
      return added;
    }
    case 'drop_fake_channels':
      return (await db.run(sql`DELETE FROM channels WHERE uname LIKE 'zz_fake_%'`)).rowsAffected;
    case 'restore_channel': {
      const c = input.channel;
      const r = await db.run(sql`
        INSERT INTO channels (uname, username, chat_id, title, warned_at, created_at)
        VALUES (${c.uname}, ${c.username}, ${c.chat_id ?? null}, ${c.title ?? null}, ${c.warned_at ?? 0}, ${c.created_at ?? now})
        ON CONFLICT(uname) DO NOTHING`);
      return r.rowsAffected;
    }
    case 'restore_kv':
      for (const { key, value } of input.kv) {
        if (!['join', 'chv'].includes(key)) continue;
        await db.run(sql`INSERT INTO kv (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      }
      return true;
    case 'bump_chv':
      await bump('chv', 1);
      return true;
    case 'drop_broadcasts': {
      // Only broadcasts this run created (ids above the starting maximum), never a running real one.
      const rows = await db.all(sql`SELECT id, status FROM broadcasts WHERE id > ${Number(input.after)} AND from_chat = ${OWNER_ID} LIMIT 20`);
      for (const b of rows) {
        await db.run(sql`DELETE FROM broadcasts WHERE id = ${b.id}`);
        await db.run(sql`UPDATE kv SET value = NULL WHERE key = 'bc' AND value = ${String(b.id)}`);
      }
      return rows.length;
    }
    case 'cleanup': {
      const users = input.users.map(testUser);
      const wids = await testWhisperIds(users);
      for (const id of wids) {
        await db.run(sql`DELETE FROM whisper_rcpts WHERE whisper_id = ${id}`);
        await db.run(sql`DELETE FROM snoops WHERE whisper_id = ${id}`);
        await db.run(sql`DELETE FROM whispers WHERE id = ${id}`);
      }
      // Anonymous messages from test users to a real user (the owner): take them off that user's counters.
      const toReal = await db.all(sql`
        SELECT to_id, count(*) AS n, sum(unread) AS u, sum(anon) AS a FROM anon_msgs
        WHERE from_id IN (${list(users)}) AND to_id NOT IN (${list(users)}) GROUP BY to_id LIMIT 20`);
      for (const r of toReal) {
        await db.run(sql`
          UPDATE users SET inbox_size = max(0, inbox_size - ${Number(r.n)}), anon_unread = max(0, anon_unread - ${Number(r.u || 0)}),
            anon_count = max(0, anon_count - ${Number(r.a || 0)})
          WHERE user_id = ${r.to_id}`);
      }
      await db.run(sql`DELETE FROM anon_msgs WHERE from_id IN (${list(users)})`);
      await db.run(sql`DELETE FROM anon_msgs WHERE to_id IN (${list(users)})`);
      await db.run(sql`DELETE FROM anon_blocks WHERE owner_id IN (${list(users)}) OR blocked_id IN (${list(users)})`);
      await db.run(sql`DELETE FROM anon_words WHERE user_id IN (${list(users)})`);
      // ratings given by test users to real users: take them off that user's totals
      const given = await db.all(sql`SELECT target_id, stars FROM ratings WHERE rater_id IN (${list(users)}) AND target_id NOT IN (${list(users)}) LIMIT 50`);
      for (const g of given) {
        await db.run(sql`UPDATE users SET rating_sum = max(0, rating_sum - ${Number(g.stars)}), rating_count = max(0, rating_count - 1) WHERE user_id = ${g.target_id}`);
      }
      await db.run(sql`DELETE FROM ratings WHERE rater_id IN (${list(users)}) OR target_id IN (${list(users)})`);
      await db.run(sql`DELETE FROM reports WHERE reporter_id IN (${list(users)}) OR sender_id IN (${list(users)})`);
      await db.run(sql`DELETE FROM strikes WHERE sender_id IN (${list(users)}) OR by_id IN (${list(users)})`);
      let removed = 0;
      let reachable = 0;
      for (const id of users) {
        await db.run(sql`DELETE FROM drafts WHERE sender_id = ${id}`);
        await db.run(sql`DELETE FROM blocks WHERE user_id = ${id} OR blocked_id = ${id}`);
        await db.run(sql`DELETE FROM user_state WHERE user_id = ${id}`);
        await db.run(sql`DELETE FROM snoops WHERE user_id = ${id}`);
        const u = await db.get(sql`SELECT first_seen, started, active FROM users WHERE user_id = ${id}`);
        if (u) {
          if (Number(u.first_seen) > 0) removed += 1;
          if (Number(u.started) === 1 && Number(u.active) === 1) reachable += 1;
          await db.run(sql`DELETE FROM users WHERE user_id = ${id}`);
        }
      }
      if (removed) await bump('n_users', -removed);
      if (reachable) await bump('n_active', -reachable);
      if (wids.length) {
        await bump('n_whispers', -wids.length);
        // they were all made today: take them off today's counter too ("YYYYMMDD:n")
        await db.run(sql`
          UPDATE kv SET value = substr(value, 1, 9) || max(0, CAST(substr(value, 10) AS INTEGER) - ${wids.length})
          WHERE key = 'day' AND length(value) > 9`);
      }
      return { removedUsers: removed, removedWhispers: wids.length };
    }
    default:
      throw new Error(`unknown op ${input.op}`);
  }
}
