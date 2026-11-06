// Phase 8 hardening: monitoring (warnings + throttled owner alerts, the webhook report from the
// scheduled job), quiet handling of senders who can't be reached, the flood guard, the inline
// fallback when Telegram refuses a file, and the platform limits mirrored by the local SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, setClock, OWNER, SEED } from '../helpers/harness.mjs';
import { parseWebhookOutput } from '../../scripts/webhook-state.mjs';
import { senderUnreachable } from '../../tgcloud/lib/core/boundary.js';

const U = 111;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
const alertsTo = (h, re) => h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER && re.test(c.params.text));

test('monitoring: rising errors and publication failures alert the owner once per 3 hours; System Status lists them', async () => {
  const h = setup();
  setClock('2026-11-06T10:00:00Z');
  await h.send(OWNER, '/admin');
  const now = Math.floor(Date.now() / 1000);
  const ins = h.db().prepare('INSERT INTO error_log (created_at, handler, code, message) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 9; i++) ins.run(now - 60, 'message', 'E', 'boom');
  ins.run(now - 7200, 'message', 'E', 'old'); // outside the hour
  let r = await h.opsTick(OWNER);
  assert.deepEqual(r.result.results.monitor.warnings, [], '9 errors in the hour: below the threshold');
  ins.run(now - 30, 'message', 'E', 'boom');
  r = await h.opsTick(OWNER);
  assert.deepEqual(r.result.results.monitor, { warnings: ['errors'], sent: 1 });
  assert.equal(alertsTo(h, /پایش Wanger Music[\s\S]*۱۰ خطا در یک ساعت گذشته/).length, 1);
  advance(3600);
  for (let i = 0; i < 10; i++) ins.run(now + 3600, 'message', 'E', 'boom');
  r = await h.opsTick(OWNER);
  assert.equal(r.result.results.monitor.sent, 0, 'throttled: one alert per kind per 3 hours');
  advance(2 * 3600 + 60);
  for (let i = 0; i < 10; i++) ins.run(now + 3 * 3600 + 60, 'message', 'E', 'boom');
  r = await h.opsTick(OWNER);
  assert.equal(r.result.results.monitor.sent, 1, 'again after 3 hours');

  // publication failures in the last 24 h (on real tracks: maintenance sweeps orphans first)
  const trackIds = [];
  for (let i = 1; i <= 4; i++) {
    advance(61);
    await h.send(OWNER, null, { audio: { file_id: `PF${i}`, file_unique_id: `PU${i}`, duration: 100 + i, title: `Song ${i}`, performer: `Artist ${i}`, file_name: 'x.mp3' } });
    trackIds.push(h.one('SELECT id FROM tracks ORDER BY id DESC LIMIT 1').id);
  }
  const t = Math.floor(Date.now() / 1000);
  const p = h.db().prepare("INSERT INTO publications (track_id, channel_id, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, 1, ?, 6, 0, ?, ?)");
  p.run(trackIds[0], 'failed', t, t);
  p.run(trackIds[1], 'uncertain', t, t);
  p.run(trackIds[2], 'failed', t - 2 * 86400, t - 2 * 86400);
  r = await h.opsTick(OWNER);
  assert.ok(!r.result.results.monitor.warnings.includes('pub_failed'), '2 in the last day');
  p.run(trackIds[3], 'failed', t, t);
  r = await h.opsTick(OWNER);
  assert.ok(r.result.results.monitor.warnings.includes('pub_failed'));
  assert.equal(alertsTo(h, /۳ انتشار ناموفق یا نامشخص/).length, 1);

  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  const text = h.lastText(OWNER);
  assert.match(text, /⚠️ <b>هشدارها<\/b>/);
  assert.match(text, /انتشار ناموفق یا نامشخص در ۲۴ ساعت گذشته/);
});

test('monitoring: the scheduled job reports the webhook; out of sync, a long queue or a recent error alert the owner', async () => {
  const h = setup();
  setClock('2026-11-06T10:00:00Z');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  assert.match(h.lastText(OWNER), /تیک زمان‌بندی‌شده هنوز اجرا نشده/, 'no schedule yet: shown on System Status…');
  assert.equal(alertsTo(h, /پایش/).length, 0, '…but not alerted (the owner may not want the GitHub job)');

  const ok = parseWebhookOutput('Webhook:\n  pending updates:  0\n  ✓ in sync with your deployed handlers\n');
  let r = await h.opsTick(OWNER, ok);
  assert.deepEqual(r.result.results.monitor.warnings, []);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  assert.match(h.lastText(OWNER), /🔗 وبهوک \(گزارش اجرای زمان‌بندی‌شده، .*\): ✅ همگام · ۰ آپدیت در صف/);

  const nowIso = new Date(Date.now()).toISOString().slice(0, 16).replace('T', ' ');
  const bad = parseWebhookOutput(`Webhook:\n  pending updates:  250\n  last error:       Read timeout expired (${nowIso} UTC)\n  ✗ OUT OF SYNC with your deployed handlers\n`);
  r = await h.opsTick(OWNER, bad);
  assert.deepEqual(r.result.results.monitor.warnings.sort(), ['webhook_error', 'webhook_pending', 'webhook_sync']);
  assert.equal(r.result.results.monitor.sent, 3);
  assert.equal(alertsTo(h, /Read timeout expired/).length, 1);

  // junk from a caller is cleaned: only booleans / counts / a short text are stored
  await h.opsTick(OWNER, { webhook: { in_sync: 'yes', pending: -5, last_error: '<b>x</b>'.repeat(100), last_error_at: 'soon', extra: { a: 1 } } });
  const stored = JSON.parse(h.one("SELECT value FROM settings WHERE key = 'monitor.webhook'").value);
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'in_sync', 'last_error', 'last_error_at', 'pending']);
  assert.deepEqual([stored.in_sync, stored.pending, stored.last_error.length, stored.last_error_at], [false, 0, 200, null]);

  // the schedule stops → after 2 hours, an alert
  advance(2 * 3600 + 60);
  await h.send(U, '/start'); // traffic still runs piggyback ticks
  join(h, U);
  advance(120);
  r = await h.send(U, '/help');
  assert.ok(r.tick && r.tick.monitor.warnings.includes('schedule_stopped'));
  assert.equal(alertsTo(h, /تیک زمان‌بندی‌شده \d+|تیک زمان‌بندی‌شده [۰-۹]+ ساعت/).length, 1);
});

test('a reply to a sender who deleted the chat or blocked the bot is not an error: no error row, no owner alert, marked unreachable', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  h.tg.failNext('sendMessage', 400, 'Bad Request: chat not found', { match: (p) => p.chat_id === U });
  const r = await h.send(U, 'love');
  assert.equal(r.ok, false);
  assert.equal(h.one('SELECT count(*) AS n FROM error_log').n, 0);
  assert.equal(alertsTo(h, /.*/).length, 0);
  assert.equal(h.one('SELECT is_blocked FROM users WHERE telegram_id = ?', U).is_blocked, 1);
  // a 429 for that one chat: quiet too, but not "blocked"
  await h.send(U, '/start');
  h.tg.failNext('sendMessage', 429, 'Too Many Requests: retry after 5', { parameters: { retry_after: 5 }, match: (p) => p.chat_id === U });
  await h.send(U, 'love');
  assert.equal(h.one('SELECT count(*) AS n FROM error_log').n, 0);
  assert.equal(h.one('SELECT is_blocked FROM users WHERE telegram_id = ?', U).is_blocked, 0);
  // the same error on ANOTHER chat (e.g. a channel during an admin action) is still a real error
  const fake = (chatId) => ({ tg: { trace: [{ method: 'sendMessage', chat_id: U, ok: true }, { method: 'sendMessage', chat_id: chatId, ok: false }] } });
  const err = { code: 400, description: 'Bad Request: chat not found' };
  assert.equal(senderUnreachable(fake(U), U, err), 'chat_gone');
  assert.equal(senderUnreachable(fake(-100123), U, err), null, 'a channel is not the sender');
  assert.equal(senderUnreachable(fake(U), U, { code: 500, description: 'Internal' }), null, 'a server error is a real error');
  assert.equal(senderUnreachable(fake(U), null, err), null, 'no sender (channel posts, endpoints)');
});

test('flood guard: more than 30 messages or presses a minute are ignored (one notice); staff are never limited', async () => {
  const h = setup();
  join(h, U);
  for (let i = 0; i < 30; i++) await h.send(U, '/help');
  const before = h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === U).length;
  assert.equal((await h.send(U, '/help')).result, 'flood');
  assert.match(h.lastText(U), /خیلی سریع پیام می‌دی/);
  for (let i = 0; i < 5; i++) assert.equal((await h.send(U, '/help')).result, 'flood');
  assert.equal(h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === U).length, before + 1, 'one notice, then silence');
  const res = await h.press(U, 'u:help', 1);
  assert.equal(res.ok, true);
  assert.match(h.tg.answers().at(-1).text, /خیلی سریع/);
  advance(61);
  assert.notEqual((await h.send(U, '/help')).result, 'flood', 'a new window after a minute');
  for (let i = 0; i < 40; i++) await h.send(OWNER, '/help');
  assert.notEqual((await h.send(OWNER, '/help')).result, 'flood', 'the owner is never limited');
});

test('inline: when Telegram refuses a file among the results, the user still gets an answer and the owner one note', async () => {
  const h = setup();
  join(h, U);
  advance(61);
  await h.send(OWNER, null, { audio: { file_id: 'BROKEN', file_unique_id: 'UB', duration: 200, title: 'Broken Song', performer: 'Band', file_name: 'x.mp3' } });
  const tr = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  await h.press(OWNER, `trk:act:${tr.id}`, 1);
  h.tg.failNext('answerInlineQuery', 400, 'Bad Request: wrong file identifier/HTTP URL specified', { match: (p) => p.results.length > 0, times: 2 });
  const r = await h.inline(U, 'broken');
  assert.equal(r.result.ok, true);
  const answers = r.calls.filter((c) => c.method === 'answerInlineQuery');
  assert.equal(answers.length, 2);
  assert.deepEqual([answers[1].params.results.length, answers[1].params.button.start_parameter], [0, 'search']);
  assert.equal(alertsTo(h, /تلگرام فایل یکی از آهنگ‌های نتیجه را قبول نکرد/).length, 1);
  await h.inline(U, 'broken song');
  assert.equal(alertsTo(h, /تلگرام فایل یکی از آهنگ‌های نتیجه/).length, 1, 'throttled');
  assert.equal(h.one('SELECT count(*) AS n FROM error_log').n, 0);
});

test('webhook-state parser: in sync, out of sync with an error, unreadable output', () => {
  assert.deepEqual(parseWebhookOutput('Webhook:\n  url: x\n  pending updates:  3\n  \u001b[32m  ✓ in sync with your deployed handlers\u001b[39m\n'), { webhook: { in_sync: true, pending: 3, last_error: null, last_error_at: null } });
  assert.deepEqual(parseWebhookOutput('  pending updates:  7\n  last error:       Connection refused (2026-11-06 03:10 UTC)\n  ✗ OUT OF SYNC with your deployed handlers\n'), { webhook: { in_sync: false, pending: 7, last_error: 'Connection refused', last_error_at: Date.parse('2026-11-06T03:10:00Z') / 1000 } });
  assert.deepEqual(parseWebhookOutput('Error: network down'), {});
});
