// Phase 1 acceptance: "no admin function works for any ID other than 5557901897 (tests call every
// admin handler with another ID)" and "a test broadcast survives an interruption with no
// duplicates". Plus the owner's panel actually working.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, SEED, advance } from './helpers/harness.mjs';
import { ROUTES } from '../tgcloud/lib/bot/router.js';
import { ADMIN_STEPS } from '../tgcloud/lib/admin/panel.js';

const X = 730001; // a normal user
const R = 730002; // a reviewer
const SAMPLE = { uint: '1', int: '1', lang: 'fa', word: 'x', fuid: 'UQ1abcdef' };

const snapshot = (h) => JSON.stringify({
  settings: h.q("SELECT key, value FROM settings WHERE key NOT LIKE 'hk.%' AND key NOT LIKE 'boot.%' ORDER BY key"),
  channels: h.q('SELECT * FROM channels ORDER BY id'),
  staff: h.q('SELECT * FROM staff ORDER BY tg_id'),
  broadcasts: h.q('SELECT id, status, mode, audience, sent, cursor_tg_id FROM broadcasts ORDER BY id'),
  users: h.q('SELECT tg_id, banned, plan, plan_until, points, publish_banned FROM users ORDER BY tg_id'),
  secrets: h.q('SELECT * FROM secrets ORDER BY key'),
  posts: h.q('SELECT id, status FROM pack_posts ORDER BY id'),
  errors: h.q('SELECT count(*) AS n FROM errors'),
  usage: h.q('SELECT * FROM usage_daily ORDER BY tg_id, feature'),
});

async function world() {
  const h = setup();
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  await h.ready(X);
  await h.ready(R);
  await h.press(OWNER, 'a:rv');
  await h.tap(OWNER, 'a:rvadd');
  await h.send(OWNER, String(R));
  // something for every admin route to act on: a broadcast draft and a secret
  await h.press(OWNER, 'a:bcnew');
  await h.send(OWNER, 'hello everyone');
  h.db.prepare("INSERT INTO secrets (key, value, updated_at) VALUES ('API_KEY', 'secret-value', 0)").run();
  return h;
}

test('every owner-only route is refused for a normal user and for a reviewer', async () => {
  const h = await world();
  const ownerOnly = Object.entries(ROUTES).filter(([, r]) => r.perm === 'admin');
  assert.ok(ownerOnly.length >= 45, `only ${ownerOnly.length} admin routes found`);
  for (const who of [X, R]) {
    for (const [name, route] of ownerOnly) {
      const data = [name, ...route.args.map((a) => SAMPLE[a])].join(':');
      const before = snapshot(h);
      const mark = h.mark();
      const r = await h.press(who, data);
      assert.ok(r.ok, `${data} by ${who}: ${JSON.stringify(r)}`);
      assert.equal(snapshot(h), before, `${data} by ${who} changed something`);
      const leaked = h.tg.calls.slice(mark).filter((c) => ['sendDocument', 'copyMessage', 'forwardMessage', 'deleteMessage'].includes(c.method) || (c.method === 'sendMessage' && Number(c.params.chat_id) !== who));
      assert.equal(leaked.length, 0, `${data} by ${who} sent: ${leaked.map((c) => c.method).join(',')}`);
      const ans = h.tg.answers(mark).at(-1);
      assert.ok(ans && ans.show_alert, `${data} by ${who} was not refused with an alert`);
    }
  }
});

test('every owner text step is ignored for anyone else (even with a forged state row)', async () => {
  const h = await world();
  for (const step of [...ADMIN_STEPS, 'a_bc', 'a_chadd', 'a_chlink', 'a_pcset', 'a_rvadd']) {
    for (const who of [X, R]) {
      h.db.prepare('INSERT INTO user_state (tg_id, step, payload, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (tg_id) DO UPDATE SET step = excluded.step, payload = excluded.payload, expires_at = excluded.expires_at')
        .run(who, step, JSON.stringify({ id: X, i: 0, eco: 0 }), Math.floor(Date.now() / 1000) + 600);
      const before = snapshot(h);
      const mark = h.mark();
      await h.send(who, step === 'a_secset' ? 'API_KEY stolen' : step === 'a_us' ? String(OWNER) : '5');
      assert.equal(snapshot(h), before, `${step} by ${who} changed something`);
      assert.equal(h.tg.calls.slice(mark).filter((c) => ['sendDocument', 'copyMessage'].includes(c.method)).length, 0, step);
      assert.equal(h.one('SELECT count(*) AS n FROM user_state WHERE tg_id = ?', who).n, 0, `${step} state not cleared`);
    }
  }
});

test('/admin opens nothing for a normal user; reviewers get the queue only', async () => {
  const h = await world();
  const mark = h.mark();
  await h.send(X, '/admin');
  assert.ok(h.texts(X, mark).every((t) => !/پنل مدیریت/.test(t)));
  await h.send(R, '/admin');
  assert.deepEqual(h.lastButtons(R).map((b) => b.callback_data), ['a:q', 'm:home']);
});

test('the owner panel works: stats, settings, flags, maintenance, user ban/pro/points, secrets, backup', async () => {
  const h = await world();
  await h.send(OWNER, '/admin');
  assert.ok(h.lastButtons(OWNER).some((b) => b.callback_data === 'a:st'));
  await h.tap(OWNER, 'a:st');
  assert.match(h.lastText(OWNER), /کاربران<\/b>: ۳/);
  // a numeric setting
  await h.press(OWNER, 'a:set');
  const i = h.lastButtons(OWNER).findIndex((b) => b.callback_data && b.callback_data.startsWith('a:setv:'));
  const data = h.lastButtons(OWNER)[i].callback_data;
  await h.tap(OWNER, data);
  await h.send(OWNER, '120');
  assert.equal(JSON.parse(h.one("SELECT value FROM settings WHERE key = 'gate.cache_sec'").value), 120);
  // a flag for an unbuilt feature can't be turned on
  await h.press(OWNER, 'a:flags');
  const studio = h.lastButtons(OWNER).find((b) => /استودیو \(/.test(b.text)).callback_data;
  const r = await h.tap(OWNER, studio);
  assert.equal(r.result, 'refused:adm.err.not_built');
  // maintenance on → users get the maintenance text, the owner doesn't
  await h.press(OWNER, 'a:maint');
  const mark = h.mark();
  await h.send(X, '/menu');
  assert.ok(h.texts(X, mark).some((t) => /به‌روزرسانی/.test(t)));
  await h.press(OWNER, 'a:maint');
  // users: find, ban (ecosystem scope recorded), unban, Pro, points
  await h.press(OWNER, 'a:us');
  await h.send(OWNER, `@user${X}`);
  assert.ok(h.lastText(OWNER).includes(String(X)));
  await h.tap(OWNER, `a:uban:${X}:1`);
  await h.send(OWNER, 'spam');
  let u = h.one('SELECT * FROM users WHERE tg_id = ?', X);
  assert.deepEqual([u.banned, u.ban_scope, u.ban_reason], [1, 'ecosystem', 'spam']);
  await h.tap(OWNER, `a:uunb:${X}`);
  await h.tap(OWNER, `a:upro:${X}`);
  await h.send(OWNER, '30');
  await h.tap(OWNER, `a:upts:${X}`);
  await h.send(OWNER, '-5');
  await h.tap(OWNER, `a:upts:${X}`);
  await h.send(OWNER, '50');
  u = h.one('SELECT * FROM users WHERE tg_id = ?', X);
  assert.equal(u.banned, 0);
  assert.equal(u.plan, 'pro');
  assert.equal(u.points, 50);
  // the owner can't ban herself
  const self = await h.press(OWNER, `a:uban:${OWNER}:0`);
  assert.equal(self.result, 'refused:adm.err.self');
  // secrets: stored, the owner's message deleted
  await h.press(OWNER, 'a:secset');
  const m2 = h.mark();
  await h.send(OWNER, 'GEMINI_KEY abc123');
  assert.equal(h.one("SELECT value FROM secrets WHERE key = 'GEMINI_KEY'").value, 'abc123');
  assert.equal(h.tg.callsOf('deleteMessage', OWNER, m2).length, 1);
  assert.ok(!h.texts(OWNER, m2).some((t) => t.includes('abc123')), 'the key is never echoed');
  // backup: four JSON documents to the owner
  await h.press(OWNER, 'a:bkgo');
  assert.equal(h.tg.callsOf('sendDocument', OWNER).length, 4);
});

test('the owner manages forced-join channels: add (must be admin), reorder, disable, link, remove, gate off', async () => {
  const h = await world();
  h.tg.addChannel({ id: -1001111111111, username: 'NewOne', title: 'New one' });
  h.tg.addChannel({ id: -1002222222222, username: 'NotAdmin', title: 'Not admin', botAdmin: false });
  await h.press(OWNER, 'a:ch');
  await h.tap(OWNER, 'a:chadd');
  let r = await h.send(OWNER, '@NotAdmin');
  assert.equal(r.result, 'step_error:a_chadd');
  r = await h.send(OWNER, 'https://t.me/NewOne');
  assert.equal(r.result, 'step:a_chadd');
  const row = h.one("SELECT * FROM channels WHERE username = 'NewOne'");
  assert.equal(row.position, 4);
  await h.press(OWNER, `a:chup:${row.id}`);
  assert.equal(h.q('SELECT username FROM channels ORDER BY position').map((c) => c.username)[2], 'NewOne');
  await h.press(OWNER, `a:chtog:${row.id}`);
  assert.equal(h.one('SELECT enabled FROM channels WHERE id = ?', row.id).enabled, 0);
  await h.press(OWNER, `a:chlnk:${row.id}`);
  await h.send(OWNER, 'https://t.me/+AbCdEf123456');
  assert.equal(h.one('SELECT invite_link FROM channels WHERE id = ?', row.id).invite_link, 'https://t.me/+AbCdEf123456');
  await h.press(OWNER, `a:chdel:${row.id}`);
  await h.tap(OWNER, `a:chdok:${row.id}`);
  assert.equal(h.one('SELECT count(*) AS n FROM channels').n, 3);
  // the 10-channel limit
  for (let i = 0; i < 7; i++) {
    h.tg.addChannel({ id: -1003000000000 - i, username: `Chan${i}xx`, title: `C${i}` });
    await h.press(OWNER, 'a:chadd');
    await h.send(OWNER, `@Chan${i}xx`);
  }
  assert.equal(h.one('SELECT count(*) AS n FROM channels').n, 10);
  h.tg.addChannel({ id: -1004000000000, username: 'Eleventh', title: 'E' });
  await h.press(OWNER, 'a:chadd');
  r = await h.send(OWNER, '@Eleventh');
  assert.equal(h.one('SELECT count(*) AS n FROM channels').n, 10);
  await h.send(OWNER, '/cancel');
  // gate off → a non-member passes
  await h.press(OWNER, 'a:gtog');
  const Y = 730009;
  await h.send(Y, '/start');
  await h.tap(Y, 'l:set:en');
  assert.ok(h.texts(Y).some((t) => /Welcome to/.test(t)));
});

/* ---------------- broadcast ---------------- */

async function crowd(n) {
  const h = setup({ settings: { 'broadcast.batch': 10 } });
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = 740000 + i;
    ids.push(id);
    await h.ready(id, i % 3 ? 'fa' : 'en');
  }
  await h.press(OWNER, 'a:bcnew');
  await h.send(OWNER, 'Big news!');
  h.afterDraft = h.mark(); // the owner's preview copy is not a broadcast message
  return { h, ids, b: h.one('SELECT * FROM broadcasts') };
}
const copies = (h) => {
  const per = new Map();
  for (const c of h.tg.callsOf('copyMessage', undefined, h.afterDraft)) if (c.result) per.set(Number(c.params.chat_id), (per.get(Number(c.params.chat_id)) || 0) + 1);
  return per;
};

test('broadcast: an invocation that dies mid-send never causes a second copy', async () => {
  const { h, ids, b } = await crowd(24);
  await h.tap(OWNER, `a:bcgo:${b.id}`);
  let row = h.one('SELECT * FROM broadcasts');
  assert.equal(row.status, 'running');
  const sentSoFar = row.sent;
  assert.ok(sentSoFar >= 10 && sentSoFar < 25, String(sentSoFar));
  // simulate a crash: the next recipient was copied, then the invocation died before recordOne
  const next = h.one('SELECT tg_id FROM users WHERE tg_id > ? AND blocked_bot = 0 AND banned = 0 ORDER BY tg_id LIMIT 1', row.cursor_tg_id).tg_id;
  h.db.prepare('UPDATE broadcasts SET inflight_tg_id = ? WHERE id = ?').run(next, b.id);
  await h.tg.handler('copyMessage', { chat_id: next, from_chat_id: OWNER, message_id: row.source_message_id });
  // resume: «ادامه» and piggybacked slices until done
  for (let k = 0; k < 10 && h.one('SELECT status FROM broadcasts').status === 'running'; k++) await h.press(OWNER, `a:bcnext:${b.id}`);
  row = h.one('SELECT * FROM broadcasts');
  assert.equal(row.status, 'done');
  assert.equal(row.uncertain, 1);
  const per = copies(h);
  for (const id of [OWNER, ...ids]) assert.equal(per.get(id) || 0, 1, `user ${id} got ${per.get(id) || 0} copies`);
  assert.equal(row.sent + row.uncertain, row.total);
  // the report is on the progress message
  assert.ok(h.texts(OWNER).some((t) => /گزارش پیام همگانی/.test(t)));
});

test('broadcast: a 429 stops the slice; it resumes after the cooldown with no duplicates; blocked users are counted', async () => {
  const { h, ids, b } = await crowd(15);
  h.tg.blocked.add(ids[3]);
  h.tg.failNext('copyMessage', 429, 'Too Many Requests: retry after 5', { parameters: { retry_after: 5 }, match: (p) => p.chat_id === ids[6] });
  await h.press(OWNER, `a:bcaud:${b.id}:0`);
  await h.tap(OWNER, `a:bcgo:${b.id}`);
  let row = h.one('SELECT * FROM broadcasts');
  assert.equal(row.status, 'running');
  const r = await h.press(OWNER, `a:bcnext:${b.id}`);
  assert.ok(r.ok);
  advance(6);
  for (let k = 0; k < 10 && h.one('SELECT status FROM broadcasts').status === 'running'; k++) await h.press(OWNER, `a:bcnext:${b.id}`);
  row = h.one('SELECT * FROM broadcasts');
  assert.equal(row.status, 'done');
  assert.equal(row.blocked, 1);
  const per = copies(h);
  for (const id of [OWNER, ...ids]) if (id !== ids[3]) assert.equal(per.get(id) || 0, 1, `user ${id}`);
  assert.equal(h.one('SELECT blocked_bot FROM users WHERE tg_id = ?', ids[3]).blocked_bot, 1);
});

test('broadcast: audience English only, pause / resume / cancel', async () => {
  const { h, ids, b } = await crowd(9);
  await h.press(OWNER, `a:bcaud:${b.id}:2`);
  assert.equal(h.one('SELECT audience FROM broadcasts').audience, 'en');
  await h.tap(OWNER, `a:bcgo:${b.id}`);
  const en = ids.filter((_, i) => i % 3 === 0);
  const per = copies(h);
  for (const id of ids) assert.equal(per.get(id) || 0, en.includes(id) ? 1 : 0, `user ${id}`);
  const { h: h2, b: b2 } = await crowd(30);
  await h2.tap(OWNER, `a:bcgo:${b2.id}`);
  await h2.press(OWNER, `a:bcpause:${b2.id}`);
  assert.equal(h2.one('SELECT status FROM broadcasts').status, 'paused');
  const sent = h2.one('SELECT sent FROM broadcasts').sent;
  await h2.send(740001, '/menu'); // piggyback must not send while paused
  assert.equal(h2.one('SELECT sent FROM broadcasts').sent, sent);
  await h2.press(OWNER, `a:bcres:${b2.id}`);
  await h2.press(OWNER, `a:bccan:${b2.id}`);
  assert.equal(h2.one('SELECT status FROM broadcasts').status, 'cancelled');
});
