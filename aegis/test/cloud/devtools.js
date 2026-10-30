/*
 * Test-only endpoint for test/cloud/smoke.mjs. The script copies it to
 * tgcloud/endpoints/zz_devtools.js for the run (`tgcloud run` executes local files without
 * deploying them) and always deletes it afterwards, so it is never pushed. It reads bot-wide state
 * and reads/deletes ONLY the fake smoke-test users (ids 990000100-990000199) and the fake chat
 * FAKE_CHAT (lists, admin actions, locks, lock hits, join times). It never touches the audit log.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { csv, utf8Bytes } from '../lib/core/csv.js';
import * as adminActions from '../lib/engines/admin_actions.js';
import * as lists from '../lib/engines/lists.js';
import * as locks from '../lib/engines/locks.js';
import * as members from '../lib/engines/members.js';
import { scan } from '../lib/core/msgscan.js';
import * as punish from '../lib/engines/punish.js';
import * as settings from '../lib/engines/settings.js';

const LO = 990000100;
const HI = 990000199;
const FAKE_CHAT = -990000100;

export default async function (input) {
  const action = input && input.action;
  if (action === 'read') {
    return {
      kv: await db.all(sql`SELECT key, value FROM aegis_kv WHERE key IN ('data_version', 'join_enabled', 'join_rev', 'cmd_rev', 'bot_id', 'bot_username', 'shutdown') LIMIT 20`),
      channels: await db.all(sql`SELECT id, username, chat_id, title, bot_admin, last_error, position FROM aegis_join_channels ORDER BY position LIMIT 20`),
      users: await db.all(sql`SELECT user_id, lang, lang_set, started, blocked FROM aegis_users WHERE user_id BETWEEN ${LO} AND ${HI} LIMIT 50`),
      tables: await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aegis_%' ORDER BY name LIMIT 50`),
      indexes: await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_aegis_%' ORDER BY name LIMIT 50`),
    };
  }
  if (action === 'p3') {
    /* The Phase 3 SQL on the real database, without Telegram and without the audit log. */
    const ctx = {};
    const out = {};
    out.added = await lists.upsert(FAKE_CHAT, 'bwd', { ekey: 'spam', value: 'Spam' }, LO);
    out.again = await lists.upsert(FAKE_CHAT, 'bwd', { ekey: 'spam', value: 'SPAM', note: 'n' }, LO);
    await lists.upsert(FAKE_CHAT, 'mut', { ekey: String(LO), value: 'Smoke', userId: LO, expiresAt: 1 }, LO);
    out.page = (await lists.page(FAKE_CHAT, 'bwd', 0)).total;
    out.expiredHidden = (await lists.page(FAKE_CHAT, 'mut', 0)).total === 0 && !(await lists.has(FAKE_CHAT, 'mut', String(LO)));
    out.counts = await lists.counts(FAKE_CHAT);
    out.search = (await lists.search(FAKE_CHAT, 'bwd', 'spa')).length;
    out.history = (await lists.historyOf(FAKE_CHAT, 'bwd', 'spam')).map((h) => h.action);
    out.removed = await lists.remove(FAKE_CHAT, 'bwd', 'spam', LO);
    await adminActions.record(FAKE_CHAT, LO, LO + 1, 'ban');
    out.actions = (await adminActions.since(FAKE_CHAT, LO, 0)).length;
    out.settings = (await settings.all(ctx, FAKE_CHAT)).steps;
    out.warnCount = await punish.warnCount(ctx, FAKE_CHAT, LO);
    out.warned = (await punish.warned(ctx, FAKE_CHAT, 10, 0)).total;
    out.punishments = await punish.countAll(FAKE_CHAT);
    out.csvBytes = utf8Bytes(csv([['a', 'سلام']])).length;
    return out;
  }
  if (action === 'p4') {
    /* The Phase 4 SQL and the message scanner on the real platform (regex Unicode properties). */
    await db.run(sql`INSERT INTO aegis_locks (chat_id, code, enabled, config, updated_by, updated_at) VALUES (${FAKE_CHAT}, 'link', 1, ${JSON.stringify({ on: 1, s: 'high' })}, 0, 0)
      ON CONFLICT(chat_id, code) DO UPDATE SET enabled = 1, config = excluded.config`);
    const on = await locks.active(FAKE_CHAT);
    const env = locks.listEnv(FAKE_CHAT);
    const bot = { id: 1, username: 'x' };
    const own = new Set();
    const hit = await locks.evaluate(scan({ text: 'visit spam . com', entities: [] }), on, { env, bot, own });
    const mixed = await locks.evaluate(scan({ text: 'سلام دوستان Hello خوبید', entities: [] }),
      new Map([['lang_latin', locks.normalize({ on: 1, s: 'high' })]]), { env, bot, own });
    await locks.recordHit(FAKE_CHAT, 'link', LO, 'deleted', null);
    await members.joined(FAKE_CHAT, LO);
    return {
      active: [...on.keys()],
      hit: hit.map((m) => m.code),
      mixed: mixed.map((m) => m.code),
      hits: (await locks.hits(FAKE_CHAT, 'link')).length,
      hitCount: await locks.hitCount(FAKE_CHAT, 'link', 0),
      joined: (await members.joinedAt(FAKE_CHAT, LO)) > 0,
      counts: await locks.countOn(FAKE_CHAT),
    };
  }
  if (action === 'cleanup') {
    await db.run(sql`DELETE FROM aegis_locks WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_lock_hits WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_members WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_list_entries WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_list_history WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_admin_actions WHERE chat_id = ${FAKE_CHAT}`);
    const u = await db.run(sql`DELETE FROM aegis_users WHERE user_id BETWEEN ${LO} AND ${HI}`);
    const s = await db.run(sql`DELETE FROM aegis_states WHERE user_id BETWEEN ${LO} AND ${HI}`);
    const e = await db.run(sql`DELETE FROM aegis_errors WHERE user_id BETWEEN ${LO} AND ${HI}`);
    return { users: u.rowsAffected, states: s.rowsAffected, errors: e.rowsAffected };
  }
  return { error: 'unknown action' };
}
