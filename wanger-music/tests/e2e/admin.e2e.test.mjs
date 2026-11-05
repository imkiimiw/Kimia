// Authorization and the admin panel, end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, SEED } from '../helpers/harness.mjs';
import { CALLBACK_ROUTES } from '../../tgcloud/lib/bot/routes.js';
import { can } from '../../tgcloud/lib/permissions/policy.js';

const U = 111;
const ADMIN = 222;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
const sampleArgs = (spec) => spec.map((t) => ({ uint: '1', int: '-1', lang: 'en', key: 'time_zone', word: 'music', tlang: 'en', field: 'title' })[t]);

test('only the owner sees and uses /admin; a normal user gets the unknown-command reply', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/admin');
  assert.match(h.lastText(U), /این دستور رو نمی‌شناسم/);
  await h.send(OWNER, '/admin');
  assert.match(h.lastText(OWNER), /پنل مدیریت Wanger Music/);
  assert.deepEqual(h.lastButtons(OWNER).map((b) => b.text), ['🎵 موزیک', '📡 منابع', '📢 کانال‌های مقصد', '🔐 عضویت اجباری', '👥 کاربران', '📣 پیام همگانی', '📊 آمار', '⚙️ تنظیمات', '🧪 وضعیت سیستم']);
  await h.tap(OWNER, 'adm:sec:sources');
  assert.match(h.lastText(OWNER), /در فاز ۴ اضافه می‌شود/);
});

test('every registered admin route rejects a normal user (table-driven over the registry)', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  const adminRoutes = CALLBACK_ROUTES.filter((r) => r.perm);
  assert.ok(adminRoutes.length >= 35, `${adminRoutes.length} admin routes`);
  for (const r of adminRoutes) {
    const data = [r.ns, r.action, ...sampleArgs(r.args)].join(':');
    assert.ok(!data.includes('undefined'), `sample args for ${r.ns}:${r.action}`);
    const mark = h.mark();
    const res = await h.press(U, data, 1);
    assert.equal(res.ok, true, data);
    const after = h.tg.calls.slice(mark).map((c) => c.method);
    assert.deepEqual(after, ['answerCallbackQuery'], `${data}: nothing but the answer`);
    assert.equal(h.tg.answers(mark)[0].text, 'این دکمه دیگه کار نمی‌کنه؛ دوباره /start رو بزن.', data);
  }
  assert.equal(h.one('SELECT count(*) AS n FROM audit_log').n, 0);
  assert.equal(h.one('SELECT count(*) AS n FROM broadcasts').n, 0);
});

test('an admin without a permission is denied; with it, allowed; admin features are private-chat only', async () => {
  const h = setup();
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, String(ADMIN));
  assert.equal(h.one('SELECT role FROM users WHERE telegram_id = ?', ADMIN).role, 'admin');
  const scoped = h.tg.callsOf('setMyCommands').filter((c) => c.params.scope && c.params.scope.chat_id === ADMIN);
  assert.equal(scoped.length, 1, 'the new admin gets a chat-scoped command menu');
  assert.ok(scoped[0].params.commands.some((c) => c.command === 'admin'));

  await h.send(ADMIN, '/admin');
  assert.deepEqual(h.lastButtons(ADMIN).map((b) => b.callback_data), ['mus:home', 'adm:sec:stats'], 'only permitted sections');
  const user = { telegram_id: ADMIN, role: 'admin' };
  for (const r of CALLBACK_ROUTES.filter((x) => x.perm && !can(user, x.perm))) {
    const mark = h.mark();
    await h.press(ADMIN, [r.ns, r.action, ...sampleArgs(r.args)].join(':'), 1);
    assert.deepEqual(h.tg.calls.slice(mark).map((c) => c.method), ['answerCallbackQuery'], r.ns + ':' + r.action);
    assert.equal(h.tg.answers(mark)[0].text, '⛔️ به این بخش دسترسی نداری.');
  }
  const mark = h.mark();
  await h.press(ADMIN, 'adm:home', 5, { id: -100999, type: 'supergroup' });
  assert.equal(h.tg.answers(mark)[0].text, 'این کار فقط توی چت خصوصی با ربات انجام می‌شه.');

  // removal with confirmation; the admin loses access at once and their menu is deleted
  await h.tap(OWNER, `usr:view:${ADMIN}`);
  await h.tap(OWNER, `usr:rmadm:${ADMIN}`);
  await h.tap(OWNER, `usr:rmadmok:${ADMIN}`);
  assert.equal(h.one('SELECT role FROM users WHERE telegram_id = ?', ADMIN).role, 'user');
  assert.equal(h.tg.callsOf('deleteMyCommands').at(-1).params.scope.chat_id, ADMIN);
  join(h, ADMIN);
  await h.send(ADMIN, '/admin');
  assert.match(h.lastText(ADMIN), /نمی‌شناسم/);
  assert.deepEqual(h.q('SELECT action FROM audit_log ORDER BY id').map((r) => r.action), ['admins.add', 'admins.remove']);
});

test('forged, stale and oversized callback data are handled', async () => {
  const h = setup();
  for (const data of ['zzz:yyy', 'fjm:view:abc', 'fjm:view', 'fjm:view:1:2', 'x'.repeat(65), '', 'fjm:view:<b>', 'usr:view:99999999999999999']) {
    const mark = h.mark();
    const r = await h.press(OWNER, data, 1);
    assert.equal(r.ok, true);
    assert.deepEqual(h.tg.calls.slice(mark).map((c) => c.method), ['answerCallbackQuery'], data);
    assert.equal(h.tg.answers(mark)[0].text, 'این منو منقضی شده؛ دوباره /admin را بزن.');
  }
  const mark = h.mark();
  await h.press(OWNER, 'fjm:view:999', 1);
  assert.equal(h.tg.answers(mark)[0].text, 'این کانال دیگه توی لیست نیست.', 'a stale id is re-checked on the server');
});

test('the owner cannot be banned or demoted; banned users get one notice on /start only', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  await h.send(OWNER, '/admin');
  let mark = h.mark();
  await h.press(OWNER, `usr:banok:${OWNER}`, 1);
  assert.match(h.tg.answers(mark)[0].text, /مالک همیشه دسترسی کامل داره/);
  mark = h.mark();
  await h.press(OWNER, `usr:mkadm:${OWNER}`, 1);
  assert.match(h.tg.answers(mark)[0].text, /مالک همیشه/);

  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:find');
  await h.send(OWNER, '@user111');
  assert.match(h.lastText(OWNER), /User111/);
  await h.tap(OWNER, `usr:ban:${U}`);
  await h.tap(OWNER, `usr:banok:${U}`);
  assert.equal(h.one('SELECT is_banned AS b FROM users WHERE telegram_id = ?', U).b, 1);
  mark = h.mark();
  await h.send(U, 'hello');
  assert.equal(h.tg.calls.slice(mark).filter((c) => c.method === 'sendMessage').length, 0, 'ignored');
  await h.send(U, '/start');
  assert.match(h.lastText(U), /مسدود شده/);
  await h.tap(OWNER, `usr:unban:${U}`);
  assert.equal(h.one('SELECT is_banned AS b FROM users WHERE telegram_id = ?', U).b, 0);
});

test('admins can be added by a forwarded message, not by a hidden forward', async () => {
  const h = setup();
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, null, { forward_origin: { type: 'hidden_user', sender_user_name: 'Anon', date: 0 }, text: 'fwd' });
  assert.match(h.lastText(OWNER), /مخفی کرده/);
  await h.send(OWNER, null, { forward_origin: { type: 'user', sender_user: { id: 333, is_bot: false, first_name: 'Sara' }, date: 0 }, text: 'fwd' });
  assert.equal(h.one('SELECT role FROM users WHERE telegram_id = 333').role, 'admin');
});

test('/lang switches the interface; /help and /cancel work', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/lang');
  await h.tap(U, 'lang:set:en');
  assert.equal(h.one('SELECT ui_language AS l FROM users WHERE telegram_id = ?', U).l, 'en');
  await h.send(U, '/help');
  assert.match(h.lastText(U), /^❓ <b>Help<\/b>/);
  await h.send(U, '/cancel');
  assert.equal(h.lastText(U), 'Nothing is in progress right now.');
  await h.send(U, 'some song');
  assert.match(h.lastText(U), /Nothing found for «some song»/, 'plain text is a search (empty catalog here)');
});
