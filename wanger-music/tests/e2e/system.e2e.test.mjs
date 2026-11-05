// System Status, settings, the tick, the error boundary, update dedupe, my_chat_member, opsTick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, logs, OWNER, SEED } from '../helpers/harness.mjs';

const U = 111;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };

test('System Status shows real data and runs a tick', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  const text = h.lastText(OWNER);
  assert.match(text, /وضعیت سیستم/);
  assert.match(text, /@Wange_Musicbot/);
  assert.match(text, /getWebhookInfo برای ربات‌ها بسته‌ست/, 'the platform restriction is shown honestly');
  assert.match(text, /دیتابیس: پاسخ در [۰-۹]+ میلی‌ثانیه/);
  assert.match(text, /کاربران: ۲ \(بلاک‌کرده: ۰\)/);
  assert.match(text, /آخرین تیک: .* · همراه آپدیت/);
  assert.match(text, /🟢 HIDE &amp; SEEK · 🟢 Nepenthe · 🟢 Wanger bots/);
  assert.match(text, /خطایی ثبت نشده/);
  const mark = h.mark();
  await h.tap(OWNER, 'sys:tick');
  assert.match(h.tg.answers(mark).at(-1).text, /تیک اجرا شد/);
  assert.match(h.lastText(OWNER), /آخرین تیک: .* · دستی/);
});

test('piggyback tick: at most one per interval, elected by one conditional UPDATE', async () => {
  const h = setup();
  join(h, U);
  const r1 = await h.send(U, '/start');
  assert.ok(r1.tick, 'first update runs a tick');
  const r2 = await h.send(U, '/help');
  assert.equal(r2.tick, null, 'within the interval: no tick');
  advance(61);
  const r3 = await h.send(U, '/help');
  assert.ok(r3.tick);
});

test('error boundary: a failing update is logged, stored, alerted once per 30 min, and returns normally', async () => {
  const h = setup();
  join(h, U);
  h.tg.failNext('getChatMember', 400, 'Bad Request: boom', { times: 1 });
  h.tg.failNext('sendMessage', 400, 'Bad Request: unexpected', { times: 2, match: (p) => p.chat_id === U });
  const r = await h.send(U, '/start');
  assert.equal(r.ok, false);
  const errs = h.q('SELECT handler, code, message, update_id, user_id FROM error_log');
  assert.equal(errs.length, 1);
  assert.deepEqual({ ...errs[0] }, { handler: 'message', code: '400', message: 'Bad Request: unexpected', update_id: 1, user_id: U });
  const alerts = () => h.tg.callsOf('sendMessage', OWNER).filter((c) => /خطا در message/.test(c.params.text));
  assert.equal(alerts().length, 1);
  await h.send(U, '/start');
  assert.equal(h.q('SELECT id FROM error_log').length, 2);
  assert.equal(alerts().length, 1, 'alert throttled');
  assert.ok(logs.some(([lvl, line]) => lvl === 'error' && JSON.parse(line).event === 'handler_failed'));
  for (const [, line] of logs) assert.doesNotMatch(line, /\/start/, 'no message text in logs');
});

test('a failing callback is still answered', async () => {
  const h = setup();
  await h.send(OWNER, '/admin');
  h.tg.failNext('editMessageText', 500, 'Internal Server Error', { times: 1 });
  h.tg.failNext('sendMessage', 500, 'Internal Server Error', { times: 1 });
  const mark = h.mark();
  const r = await h.tap(OWNER, 'usr:home');
  assert.equal(r.ok, false);
  assert.equal(h.tg.answers(mark).length, 1);
});

test('update dedupe: the same update_id is processed once', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start', {}, 777);
  const mark = h.mark();
  const r = await h.send(U, '/start', {}, 777);
  assert.equal(r.duplicate, true);
  assert.equal(h.tg.calls.length, mark);
});

test('my_chat_member in private chat keeps is_blocked current; a 403 marks a user blocked', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  await h.myChatMember({ id: U, type: 'private' }, U, 'kicked');
  assert.equal(h.one('SELECT is_blocked AS b FROM users WHERE telegram_id = ?', U).b, 1);
  await h.myChatMember({ id: U, type: 'private' }, U, 'member', 'kicked');
  assert.equal(h.one('SELECT is_blocked AS b FROM users WHERE telegram_id = ?', U).b, 0);
  h.tg.blocked.add(U);
  await h.send(U, '/help');
  assert.equal(h.one('SELECT is_blocked AS b FROM users WHERE telegram_id = ?', U).b, 1);
});

test('settings: enums cycle, numbers are validated in a flow, the archive channel is verified, commands sync', async () => {
  const h = setup();
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:ui.default_language');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'ui.default_language'").value, '"en"');
  assert.match(h.lastText(OWNER), /^⚙️ <b>Settings<\/b>/, 'the owner has no own choice, so the new default applies at once');
  assert.ok(h.lastButtons(OWNER).some((b) => b.text === 'Default language: English'));
  await h.tap(OWNER, 'set:e:forcejoin.ttl_seconds');
  await h.send(OWNER, '5');
  assert.match(h.lastText(OWNER), /a number from 60 to 86400/);
  await h.send(OWNER, '۱۲۰');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'forcejoin.ttl_seconds'").value, '120');
  h.tg.addChannel({ id: -1007000000001, username: 'ArchiveCh', title: 'Archive' });
  h.tg.addChannel({ id: -1007000000002, username: 'NotOurs', title: 'Not ours', botAdmin: false });
  await h.tap(OWNER, 'set:e:archive.chat_id');
  await h.send(OWNER, '@NotOurs');
  assert.match(h.lastText(OWNER), /Post messages/);
  await h.send(OWNER, '@ArchiveCh');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'archive.chat_id'").value, '-1007000000001');
  const mark = h.mark();
  await h.tap(OWNER, 'set:sync');
  const calls = h.tg.callsOf('setMyCommands', undefined, mark);
  assert.equal(calls.length, 3, 'default fa, default en, owner chat scope');
  assert.deepEqual(calls[0].params.commands.map((c) => c.command), ['start', 'search', 'help', 'lang', 'cancel']);
  assert.ok(calls[2].params.commands.some((c) => c.command === 'admin'));
  assert.ok(h.q('SELECT action FROM audit_log').every((r) => r.action === 'settings.set'));
});

test('opsTick endpoint: owner only, runs a scheduled tick', async () => {
  const h = setup();
  await assert.rejects(h.opsTick(U), (e) => e.name === 'EndpointError' && e.parameters.code === 'FORBIDDEN');
  const r = await h.opsTick(OWNER);
  assert.equal(r.ok, true);
  assert.equal(r.result.trigger, 'scheduled');
  assert.equal(JSON.parse(h.one("SELECT value FROM settings WHERE key = 'tick.last'").value).trigger, 'scheduled');
});

test('maintenance prunes processed updates after 48 h and expired flows', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'fjm:home');
  await h.tap(OWNER, 'fjm:add');
  assert.equal(h.one('SELECT count(*) AS n FROM user_flows').n, 1);
  advance(48 * 3600 + 10);
  await h.opsTick(OWNER);
  assert.equal(h.one('SELECT count(*) AS n FROM processed_updates').n, 0);
  assert.equal(h.one('SELECT count(*) AS n FROM user_flows').n, 0);
});

test('command menus are set up automatically on the owner\'s first update, once', async () => {
  const h = setup();
  await h.send(OWNER, '/start');
  const calls = h.tg.callsOf('setMyCommands');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => (c.params.scope ? c.params.scope.chat_id : c.params.language_code || 'default')), ['default', 'en', OWNER]);
  await h.send(OWNER, '/help');
  assert.equal(h.tg.callsOf('setMyCommands').length, 3, 'not again');
  const h2 = setup();
  h2.tg.failNext('setMyCommands', 502, 'Bad Gateway');
  await h2.send(OWNER, '/start');
  await h2.send(OWNER, '/help');
  assert.equal(h2.tg.callsOf('setMyCommands').length, 6, 'retried after a failure');
});
