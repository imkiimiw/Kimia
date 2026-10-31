// Shared setup for test/security.mjs and test/load.mjs: the real handlers (tgcloud/) against the local
// sdk emulation (test/sdk/: SQLite via node:sqlite) and the strict mock Bot API (test/mock-telegram.mjs),
// with the globals a bare V8 isolate lacks removed and a fake clock. Forced join is off: these suites are
// about authorization, load and failures, not channel membership (test/e2e.mjs covers that).
import { createMockTelegram } from './mock-telegram.mjs';
import { faults, rawDatabase, setupDatabase, stats } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';

export const BOT_ID = 7200000001;
const HANDLERS = ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request', 'channel_post',
  'edited_channel_post', 'poll', 'poll_answer', 'message_reaction_count'];
const ISOLATE_MISSING = ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'FormData', 'Headers', 'Request', 'Response', 'fetch',
  'setTimeout', 'setInterval', 'setImmediate', 'structuredClone', 'atob', 'btoa', 'crypto', 'Buffer', 'Intl'];
export const GROUP_RIGHTS = { can_manage_chat: true, can_change_info: true, can_delete_messages: true, can_restrict_members: true, can_invite_users: true,
  can_pin_messages: true, can_promote_members: true };

export async function createHarness() {
  const mock = createMockTelegram({ botId: BOT_ID });
  process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
  setupDatabase(schema);
  rawDatabase().prepare("INSERT INTO aegis_kv (key, value) VALUES ('join_enabled', '0')").run();
  for (const name of ISOLATE_MISSING) delete globalThis[name];
  const H = {};
  for (const name of HANDLERS) H[name] = (await import(`../tgcloud/handlers/${name}.js`)).default;
  const consoleErrors = [];
  console.error = (...a) => consoleErrors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
  console.warn = () => {};
  let clock = Date.UTC(2026, 9, 31, 9, 0);
  Date.now = () => clock;

  const h = {
    mock, H, faults, stats, consoleErrors, db: rawDatabase, seq: 1, msgId: 1,
    now: () => clock,
    tick(sec) {
      clock += sec * 1000;
    },
    row: (q, ...p) => rawDatabase().prepare(q).get(...p),
    rows: (q, ...p) => rawDatabase().prepare(q).all(...p),
    person: (id, firstName, lang = 'en', extra = {}) => ({ id, is_bot: false, first_name: firstName, language_code: lang, ...extra }),

    /* One update through its handler: { r (the handler's result), calls, queries, ms, updateId }. */
    async run(kind, payload, { updateId } = {}) {
      const id = updateId || h.seq++;
      const start = mock.state.calls.length;
      const q0 = stats.queries;
      const t0 = process.hrtime.bigint();
      const r = await H[kind](payload, { update: { update_id: id } });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { r, calls: mock.state.calls.slice(start), queries: stats.queries - q0, ms, updateId: id, kind, at: Math.floor(clock / 1000) };
    },
    dm(u, text, extra = {}) {
      mock.state.started.add(u.id);
      const id = h.msgId++;
      mock.userMessage(u.id, id, { text, plain: text, kind: 'text' });
      return h.run('message', { message_id: id, from: u, chat: { id: u.id, type: 'private' }, date: 0, ...(text !== null ? { text } : {}), ...extra });
    },
    gmsg(chat, u, text, extra = {}) {
      const id = h.msgId++;
      mock.userMessage(chat.id, id, { text, plain: text, from: u });
      return h.run('message', { message_id: id, from: u, chat, date: 0, ...(text !== null ? { text } : {}), ...extra });
    },
    press(u, data, chatId, mid) {
      return h.run('callback_query', { id: `cb${h.seq}`, from: u, chat_instance: 'x', data, message: mock.messageObject(chatId, mid) });
    },
    lastBotMessage: (chatId) => [...mock.state.messages.values()].filter((m) => m.chat === chatId && m.from.id === BOT_ID).pop(),
    async onboard(u, lang = 'en') {
      const c = await h.dm(u, '/start');
      const pick = c.calls.find((x) => x.method === 'sendMessage' && x.params.chat_id === u.id && x.result.ok);
      await h.press(u, `lg:${lang}`, u.id, pick.result.result.message_id);
    },
    /* A supergroup where Aegis is an admin with every right it asks for; `creator` added it. */
    async addGroup(id, title, creator, members = []) {
      const c = mock.addChat({ id, type: 'supergroup', title, count: members.length + 1, botRights: GROUP_RIGHTS });
      c.admins.set(creator.id, { status: 'creator', user: creator });
      for (const u of [creator, ...members]) {
        c.members.add(u.id);
        c.people.set(u.id, u);
      }
      const chat = { id, type: 'supergroup', title };
      await h.run('my_chat_member', { chat, from: creator, date: 0, old_chat_member: { status: 'left', user: mock.bot },
        new_chat_member: { status: 'administrator', user: mock.bot, can_be_edited: false, ...GROUP_RIGHTS } });
      rawDatabase().prepare('UPDATE aegis_chats SET reminder = 0 WHERE chat_id = ?').run(id);
      return chat;
    },
    close: () => mock.close(),
  };
  return h;
}

/* A tiny deterministic random source (tests must be repeatable). */
export function rng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (a) => a[Math.floor(next() * a.length)] };
}

export function report(outcome) {
  const passed = outcome.filter(Boolean).length;
  console.log(`\n${passed}/${outcome.length} passed`);
  if (passed !== outcome.length) process.exit(1);
}

export async function section(outcome, name, fn) {
  try {
    await fn();
    outcome.push(true);
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push(false);
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 8).join('\n   ')}`);
  }
}
