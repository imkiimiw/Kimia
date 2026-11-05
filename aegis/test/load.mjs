// Load, rate-limit and failure-injection tests (Phase 10). Run: npm run test:load
//  1. load — 150 members, 20 groups; thousands of group messages (chat, links, media, commands, floods),
//     private messages and button presses over simulated hours. Per update kind: Bot API calls, database
//     queries and local time, checked against budgets; no update may fail.
//  2. Telegram's rate limits — what Aegis itself sends: at most 20 messages a minute into one group and 30
//     a second overall (Telegram's limits for bots), even during a flood or a raid.
//  3. 429 «Too Many Requests» — a broadcast stops at the first 429 and waits retry_after before the next
//     batch; replies refused with 429 in a group don't break the update.
//  4. duplicates — Telegram re-delivering updates: each is handled once.
//  5. failure injection (the error-handling review) — for representative updates, every Bot API method they
//     use is made to fail in turn, and then each of their database queries in turn: the handler never
//     throws, always returns { trace }, and a pressed button is still answered exactly once.
import assert from 'node:assert/strict';
import { OWNER_ID } from '../tgcloud/lib/config.js';
import * as bc from '../tgcloud/lib/engines/broadcast.js';
import { createCtx } from '../tgcloud/lib/core/tg.js';
import { createHarness, report, rng, section } from './harness.mjs';

const h = await createHarness();
const outcome = [];
const R = rng(7);
let unhandled = 0;
process.on('unhandledRejection', () => {
  unhandled += 1;
});
const log = [];
const record = (x) => {
  log.push(x);
  return x;
};
const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
};

const owner = h.person(OWNER_ID, 'Owner', 'en');
const people = [];
for (let i = 0; i < 150; i += 1) people.push(h.person(820000000 + i, `M${i}`, ['en', 'fa', 'ru', 'zh', 'fr'][i % 5], i % 3 ? { username: `m${i}` } : {}));
const groups = [];

await section(outcome, 'setup: 150 members chose a language, 20 groups with Aegis as an admin', async () => {
  await h.onboard(owner);
  for (const u of people) await h.onboard(u, u.language_code);
  for (let g = 0; g < 20; g += 1) {
    const members = people.filter((_, i) => i % 20 === g || R.next() < 0.15);
    const chat = await h.addGroup(-1008200000 - g, `Load ${g}`, members[0], members.slice(1));
    groups.push({ chat, members });
  }
  /* a few groups switch security on, so the load includes the checks that act */
  for (const g of groups.slice(0, 6)) {
    for (const code of ['flood', 'antilink']) {
      h.db().prepare(`INSERT INTO aegis_guards (chat_id, code, enabled, config, updated_by, updated_at) VALUES (?, ?, 1, '{"on":1}', 0, 0)
        ON CONFLICT(chat_id, code) DO UPDATE SET enabled = 1, config = excluded.config`).run(g.chat.id, code);
    }
  }
  assert.equal(h.row('SELECT count(*) AS n FROM aegis_chats WHERE active = 1').n, 20);
});

const TEXTS = ['hello everyone', 'سلام به همه', 'привет', '大家好', 'bonjour', 'look https://example.com/x', 'join t.me/+abcdef', '😂😂😂', 'ok',
  'what time is the meeting?', 'buy cheap followers now!!! http://spam.example', 'thanks!', 'ممنون', '/rules', '/me', '/top', '/report', '/dice', 'lol',
  'x'.repeat(900), '@admin help', 'CAPS LOCK MESSAGE HERE', 'ـ ـ ـ', 'a​b​c'];

await section(outcome, 'load: 4000 group messages, 600 private messages, 400 button presses and 300 joins over 3 simulated hours — no update fails, every one stays within its budget', async () => {
  for (let i = 0; i < 4000; i += 1) {
    const g = R.pick(groups);
    const u = R.pick(g.members);
    const text = R.pick(TEXTS);
    const extra = R.next() < 0.08 ? { photo: [{ file_id: `p${i}`, file_unique_id: `u${i}`, width: 90, height: 90 }] } : {};
    record(await h.gmsg(g.chat, u, extra.photo ? null : text, extra));
    if (i % 7 === 0) {
      const v = R.pick(people);
      record(await h.dm(v, R.pick(['/start', '/help', 'hello', '/config', '/language', 'menu', '/me'])));
    }
    if (i % 10 === 0) {
      const v = R.pick(people);
      const home = h.lastBotMessage(v.id);
      if (home) record(await h.press(v, R.pick(['mm', 'hp', 'cl', 'lg', 'db']), v.id, home.message_id));
    }
    if (i % 13 === 0) {
      const g2 = R.pick(groups);
      const newcomer = h.person(830000000 + i, `N${i}`);
      h.mock.state.chats.get(g2.chat.id).members.add(newcomer.id);
      record(await h.run('chat_member', { chat: g2.chat, from: newcomer, date: 0, old_chat_member: { status: 'left', user: newcomer },
        new_chat_member: { status: 'member', user: newcomer } }));
    }
    h.tick(R.int(5) + 1);
  }
  const failed = log.filter((x) => x.r.error);
  assert.deepEqual(failed.map((x) => `${x.kind}: ${x.r.error}`).slice(0, 5), []);
  const kinds = {};
  for (const x of log) (kinds[x.kind] = kinds[x.kind] || []).push(x);
  /* about twice the worst seen when this was written: a regression that doubles the work of an update fails here */
  const BUDGET = { message: { calls: 12, queries: 140 }, callback_query: { calls: 8, queries: 60 }, chat_member: { calls: 6, queries: 60 } };
  console.log('   kind            updates  api avg/p95/max   db avg/p95/max      ms avg/p95');
  for (const [kind, xs] of Object.entries(kinds)) {
    const calls = xs.map((x) => x.calls.length);
    const qs = xs.map((x) => x.queries);
    const ms = xs.map((x) => x.ms);
    const avg = (a) => (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1);
    console.log(`   ${kind.padEnd(15)} ${String(xs.length).padStart(7)}  ${avg(calls).padStart(5)}/${pct(calls, 0.95)}/${Math.max(...calls)}`.padEnd(48)
      + `${avg(qs).padStart(6)}/${pct(qs, 0.95)}/${Math.max(...qs)}`.padEnd(20) + `${avg(ms)}/${pct(ms, 0.95).toFixed(1)}`);
    assert.ok(Math.max(...calls) <= BUDGET[kind].calls, `${kind}: ${Math.max(...calls)} Bot API calls in one update`);
    assert.ok(Math.max(...qs) <= BUDGET[kind].queries, `${kind}: ${Math.max(...qs)} queries in one update`);
    assert.ok(pct(qs, 0.95) <= 80, `${kind}: p95 ${pct(qs, 0.95)} queries`);
  }
  assert.equal(unhandled, 0, 'unhandled promise rejections');
});

await section(outcome, 'Telegram\'s limits on what Aegis sends: ≤ 20 messages a minute into one group, ≤ 30 a second overall — also during a flood and a link raid', async () => {
  const g = groups[0];
  const spammers = [];
  for (let i = 0; i < 40; i += 1) {
    const s = h.person(840000000 + i, `Spam${i}`);
    spammers.push(s);
    h.mock.state.chats.get(g.chat.id).members.add(s.id);
    record(await h.run('chat_member', { chat: g.chat, from: s, date: 0, old_chat_member: { status: 'left', user: s }, new_chat_member: { status: 'member', user: s } }));
  }
  for (let round = 0; round < 10; round += 1) {
    for (const s of spammers) {
      record(await h.gmsg(g.chat, s, R.pick(['FREE MONEY http://spam.example/x', 'join t.me/+spam', 'flood', 'flood', 'flood'])));
    }
    h.tick(3);
  }
  assert.deepEqual(log.filter((x) => x.r.error).map((x) => x.r.error).slice(0, 3), []);
  const perGroupMinute = new Map();
  const perSecond = new Map();
  for (const x of log) {
    for (const c of x.calls) {
      if (!['sendMessage', 'sendPhoto', 'sendDocument', 'sendDice', 'sendPoll', 'copyMessage', 'forwardMessage'].includes(c.method) || !c.result.ok) continue;
      const sec = x.at;
      perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
      if (Number(c.params.chat_id) < 0) {
        const key = `${c.params.chat_id}:${Math.floor(sec / 60)}`;
        perGroupMinute.set(key, (perGroupMinute.get(key) || 0) + 1);
      }
    }
  }
  const worstGroup = Math.max(0, ...perGroupMinute.values());
  console.log(`   worst group minute: ${worstGroup} messages · worst second overall: ${Math.max(0, ...perSecond.values())}`);
  assert.ok(worstGroup <= 20, `${worstGroup} messages in one minute into one group`);
  assert.ok(Math.max(0, ...perSecond.values()) <= 30, 'messages in one second overall');
  const muted = h.row("SELECT count(*) AS n FROM aegis_punishments WHERE chat_id = ? AND status = 'active'", g.chat.id).n;
  const deleted = log.flatMap((x) => x.calls).filter((c) => (c.method === 'deleteMessage' || c.method === 'deleteMessages') && Number(c.params.chat_id) === g.chat.id).length;
  console.log(`   raid: ${muted} punishments active, ${deleted} delete calls`);
  assert.ok(deleted > 0, 'the links were deleted');
  assert.ok(muted > 0, 'the flooders were muted');
});

await section(outcome, '429 Too Many Requests: a broadcast stops at the first 429 and waits retry_after; replies refused with 429 don\'t break an update', async () => {
  const id = await bc.createDraft({ audience: 'users', mode: 'copy', fromChat: OWNER_ID, messageId: 1, contentType: 'text', createdBy: OWNER_ID });
  h.mock.userMessage(OWNER_ID, 1, { text: 'news', plain: 'news', from: owner });
  await bc.start(id, OWNER_ID);
  const ctx = createCtx({ kind: 'test' });
  h.mock.state.faults.set('copyMessage', { code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 }, times: 1 });
  const first = await bc.runBatch(ctx, id, { limit: 25, budgetMs: 5000 });
  assert.equal(first.limited, true);
  assert.ok(Number(first.row.next_at_ms) >= h.now() + 7000, 'waits retry_after');
  assert.equal(Number(first.row.wait_sec), 7);
  const early = await bc.runBatch(ctx, id, { limit: 25, budgetMs: 5000 });
  assert.equal(early.ran, false);
  assert.equal(early.reason, 'wait');
  let guard = 0;
  let r = early;
  while (guard < 20 && !(r.ran && r.finished)) {
    h.tick(8);
    r = await bc.runBatch(ctx, id, { limit: 25, budgetMs: 5000 });
    guard += 1;
  }
  assert.ok(r.finished, 'the broadcast finishes after waiting');
  const row = await bc.get(id);
  assert.equal(Number(row.failed), 0, 'nothing was lost to the 429');
  assert.ok(Number(row.sent) >= 150);
  h.mock.state.faults.set('sendMessage', { code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } });
  for (let i = 0; i < 30; i += 1) {
    const x = await h.gmsg(groups[1].chat, R.pick(groups[1].members), R.pick(['/rules', '/me', '/top', 'hello']));
    assert.equal(x.r.error, undefined, x.r.error);
    const y = await h.dm(R.pick(people), '/help');
    assert.equal(y.r.error, undefined, y.r.error);
  }
  h.mock.state.faults.delete('sendMessage');
});

await section(outcome, 'duplicates: 300 updates delivered again are each handled once (no Bot API call the second time)', async () => {
  const again = log.filter((x) => x.kind === 'message').slice(-300);
  let dup = 0;
  for (const x of again) {
    const y = await h.run('message', { message_id: 1, from: owner, chat: { id: OWNER_ID, type: 'private' }, date: 0, text: '/start' }, { updateId: x.updateId });
    if (y.r.duplicate) dup += 1;
    assert.equal(y.calls.length, 0);
  }
  assert.equal(dup, 300);
});

await section(outcome, 'failure injection: every Bot API method an update uses, then each of its database queries, fails in turn — the handler never throws, returns { trace }, and answers a pressed button once', async () => {
  const g = groups[2];
  const admin = g.members[0];
  const someone = g.members[1] || people[5];
  const ownerHome = h.lastBotMessage(OWNER_ID).message_id;
  const templates = {
    'private /start': () => h.dm(R.pick(people), '/start'),
    'private /config': () => h.dm(admin, '/config'),
    'owner /panel': () => h.dm(owner, '/panel'),
    'owner /status': () => h.dm(owner, '/status'),
    'button: main menu': () => h.press(people[7], 'mm', people[7].id, h.lastBotMessage(people[7].id).message_id),
    'button: my chats': () => h.press(admin, 'cl', admin.id, h.lastBotMessage(admin.id).message_id),
    'button: a chat\'s panel': () => h.press(admin, `g:${g.chat.id}`, admin.id, h.lastBotMessage(admin.id).message_id),
    'button: health (owner)': () => h.press(owner, 'sa:h', OWNER_ID, ownerHome),
    'button: chats (owner)': () => h.press(owner, 'sa:c:f:a:0', OWNER_ID, ownerHome),
    'group: chat': () => h.gmsg(g.chat, someone, 'hello there'),
    'group: link': () => h.gmsg(groups[0].chat, R.pick(groups[0].members), 'see http://spam.example/x'),
    'group: /warn reply': () => h.gmsg(g.chat, admin, '/warn spam', { reply_to_message: { message_id: 1, from: someone, chat: g.chat, date: 0, text: 'x' } }),
    'group: join': () => {
      const n = h.person(850000000 + h.seq, 'Joiner');
      return h.run('chat_member', { chat: g.chat, from: n, date: 0, old_chat_member: { status: 'left', user: n }, new_chat_member: { status: 'member', user: n } });
    },
    'bot promoted': () => h.run('my_chat_member', { chat: g.chat, from: admin, date: 0, old_chat_member: { status: 'administrator', user: h.mock.bot, can_be_edited: false },
      new_chat_member: { status: 'administrator', user: h.mock.bot, can_be_edited: false, can_manage_chat: true, can_delete_messages: true } }),
  };
  let runs = 0;
  let recorded = 0;
  for (const [name, make] of Object.entries(templates)) {
    h.tick(61);
    const normal = await make();
    assert.equal(normal.r.error, undefined, `${name} fails even without faults: ${normal.r.error}`);
    const methods = [...new Set(normal.calls.map((c) => c.method))];
    for (const m of methods) {
      h.tick(2);
      h.mock.state.faults.set(m, { code: 500, description: 'Internal Server Error: injected' });
      let x;
      try {
        x = await make();
      } finally {
        h.mock.state.faults.delete(m);
      }
      runs += 1;
      assert.ok(x && Array.isArray(x.r.trace), `${name} with ${m} failing: no trace`);
      if (x.kind === 'callback_query') assert.equal(x.calls.filter((c) => c.method === 'answerCallbackQuery').length, 1, `${name} with ${m} failing: answered once`);
      if (x.r.error) recorded += 1;
    }
    const q = normal.queries;
    const step = Math.max(1, Math.ceil(q / 60));
    for (let k = 1; k <= q; k += step) {
      h.tick(2);
      h.faults.failAt = h.stats.queries + k;
      const x = await make();
      h.faults.failAt = 0;
      runs += 1;
      assert.ok(x && Array.isArray(x.r.trace), `${name} with query ${k} failing: no trace`);
      if (x.kind === 'callback_query') assert.equal(x.calls.filter((c) => c.method === 'answerCallbackQuery').length, 1, `${name} with query ${k} failing: answered once`);
      if (x.r.error) recorded += 1;
    }
  }
  console.log(`   ${runs} runs with a failure injected; ${recorded} ended with the failure recorded (aegis_errors), the rest absorbed where they happened`);
  assert.ok(runs > 300);
  assert.equal(unhandled, 0, 'unhandled promise rejections');
});

await h.close();
report(outcome);
