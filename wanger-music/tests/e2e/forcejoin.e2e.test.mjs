// Force-join end to end: the Phase 1 "done when" checks, against the real handlers and SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const U = 111;

test('a non-member gets the join message with 3 join buttons and «✅ عضو شدم»', async () => {
  const h = setup();
  const r = await h.send(U, '/start');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'gated');
  assert.match(h.lastText(U), /^برای استفاده از ربات، اول عضو این کانال‌ها شو 👇/);
  assert.deepEqual(h.lastButtons(U).map((b) => b.url || b.callback_data), ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'https://t.me/wangerBots', 'fj:check']);
  assert.equal(h.lastButtons(U)[3].text, '✅ عضو شدم');
  assert.equal(h.one('SELECT force_join_ok_until AS v FROM users WHERE telegram_id = ?', U).v, -1, 'failure not cached (-1 = gated, for conversion stats)');
});

test('joining some → the message lists only the rest; joining all → unlocked, then /start payload continues', async () => {
  const h = setup();
  await h.send(U, '/start t_AbCdEfGh1');
  assert.equal(h.one('SELECT flow FROM user_flows WHERE user_id = ?', U).flow, 'fj_pending');
  h.tg.setMember(SEED[0], U, 'member');
  const mark = h.mark();
  await h.tap(U, 'fj:check');
  const edit = h.tg.callsOf('editMessageText', U, mark).at(-1);
  assert.deepEqual(buttons(edit.params).map((b) => b.url || b.callback_data), ['https://t.me/Nepenthw_ir', 'https://t.me/wangerBots', 'fj:check']);
  assert.equal(h.tg.answers(mark).at(-1).text, 'هنوز عضو همه‌ی کانال‌ها نشدی 🙂');

  h.tg.setMember(SEED[1], U, 'administrator');
  h.tg.setMember(SEED[2], U, 'restricted', { is_member: true });
  const m2 = h.mark();
  await h.tap(U, 'fj:check');
  const texts = h.tg.calls.slice(m2).filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.params.text);
  assert.match(texts[0], /عضویتت تأیید شد/);
  assert.match(texts[1], /این آهنگ دیگه در دسترس نیست/, 'the t_ payload continued after unlocking (no such track here)');
  assert.equal(h.one('SELECT count(*) AS n FROM user_flows').n, 0);
  assert.ok(h.one('SELECT force_join_ok_until AS v FROM users WHERE telegram_id = ?', U).v > Date.now() / 1000);

  const m3 = h.mark();
  await h.send(U, '/start');
  assert.equal(h.tg.callsOf('getChatMember', undefined, m3).length, 0, 'cached pass: no API calls');
  assert.match(h.lastText(U), /به Wanger Music خوش اومدی/);
});

test('restricted with is_member: false and kicked are not members', async () => {
  const h = setup();
  h.tg.setMember(SEED[0], U, 'restricted', { is_member: false });
  h.tg.setMember(SEED[1], U, 'kicked');
  h.tg.setMember(SEED[2], U, 'member');
  await h.send(U, '/start');
  assert.deepEqual(h.lastButtons(U).map((b) => b.url || b.callback_data), ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'fj:check']);
});

test('bot not admin in a channel: open mode skips it and alerts the owner at most once an hour', async () => {
  const h = setup({ botAdminIn: [SEED[0], SEED[2]] });
  h.tg.setMember(SEED[0], U, 'member');
  h.tg.setMember(SEED[2], U, 'member');
  await h.send(U, '/start');
  assert.match(h.lastText(U), /خوش اومدی/, 'open: the broken channel is skipped');
  const alerts = () => h.tg.callsOf('sendMessage', OWNER).filter((c) => /عضویت اجباری/.test(c.params.text));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].params.text, /Nepenthe.*ربات ادمین نیست/s);
  assert.equal(h.one('SELECT last_check_status AS s FROM force_join_channels WHERE chat_id = ?', SEED[1]).s, 'bot_not_admin');
  h.tg.setMember(SEED[0], 222, 'member');
  h.tg.setMember(SEED[2], 222, 'member');
  await h.send(222, '/start');
  assert.equal(alerts().length, 1, 'throttled');
  advance(3601);
  h.tg.setMember(SEED[0], 333, 'member');
  await h.send(333, '/start');
  assert.equal(alerts().length, 2, 'again after an hour');
});

test('bot not admin + closed mode: the user stays locked', async () => {
  const h = setup({ botAdminIn: [SEED[0], SEED[2]] });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'fjm:home');
  await h.tap(OWNER, 'fjm:mode');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'forcejoin.failure_mode'").value, '"closed"');
  h.tg.setMember(SEED[0], U, 'member');
  h.tg.setMember(SEED[2], U, 'member');
  await h.send(U, '/start');
  assert.deepEqual(h.lastButtons(U).map((b) => b.url || b.callback_data), ['https://t.me/Nepenthw_ir', 'fj:check']);
});

test('owner manages the list from private chat; every change applies at once', async () => {
  const h = setup();
  for (const c of SEED) h.tg.setMember(c, U, 'member');
  await h.send(U, '/start');
  assert.match(h.lastText(U), /خوش اومدی/);

  // add by @username (bot is admin there)
  h.tg.addChannel({ id: -1004000000001, username: 'NewChan', title: 'New Chan' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'fjm:home');
  await h.tap(OWNER, 'fjm:add');
  await h.send(OWNER, '@NewChan');
  assert.match(h.tg.callsOf('sendMessage', OWNER).at(-2).params.text, /کانال «New Chan» اضافه شد/);
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels').n, 4);
  assert.equal(h.one('SELECT force_join_ok_until AS v FROM users WHERE telegram_id = ?', U).v, 0, 'pass invalidated');
  await h.send(U, 'hi');
  assert.deepEqual(h.lastButtons(U).map((b) => b.url || b.callback_data), ['https://t.me/NewChan', 'fj:check'], 'new channel applies immediately');

  // a channel where the bot is not admin is refused with the fix
  h.tg.addChannel({ id: -1004000000002, username: 'NoAdmin', title: 'No Admin', botAdmin: false });
  await h.tap(OWNER, 'fjm:add');
  await h.send(OWNER, 'https://t.me/NoAdmin');
  assert.match(h.lastText(OWNER), /ربات توی «No Admin» ادمین نیست[\s\S]*Add Admin/);
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels').n, 4);
  // a forwarded post from a private channel (no username) → invite link warning
  h.tg.addChannel({ id: -1004000000003, title: 'Private', invite_link: 'https://t.me/+PrivLink123' });
  await h.send(OWNER, null, { forward_origin: { type: 'channel', chat: { id: -1004000000003, type: 'channel', title: 'Private' }, message_id: 4, date: 0 } });
  assert.equal(h.one('SELECT invite_link AS l FROM force_join_channels WHERE chat_id = -1004000000003').l, 'https://t.me/+PrivLink123');
  await h.send(OWNER, '/cancel');

  const id = h.one('SELECT id FROM force_join_channels WHERE chat_id = -1004000000001').id;
  // disable → applies at once
  await h.tap(OWNER, `fjm:view:${id}`);
  await h.tap(OWNER, `fjm:tog:${id}`);
  assert.equal(h.one('SELECT enabled FROM force_join_channels WHERE id = ?', id).enabled, 0);
  await h.send(U, 'hi');
  assert.deepEqual(h.lastButtons(U).map((b) => b.url || b.callback_data), ['https://t.me/+PrivLink123', 'fj:check'], 'disabled channel no longer required');

  // reorder: move it up
  const before = h.q('SELECT id FROM force_join_channels ORDER BY sort_order, id').map((r) => r.id);
  await h.tap(OWNER, `fjm:up:${id}`);
  const after = h.q('SELECT id FROM force_join_channels ORDER BY sort_order, id').map((r) => r.id);
  assert.equal(after.indexOf(id), before.indexOf(id) - 1);

  // remove with confirmation
  await h.tap(OWNER, `fjm:del:${id}`);
  assert.match(h.lastText(OWNER), /حذف بشه؟/);
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels WHERE id = ?', id).n, 1, 'not removed before confirming');
  await h.tap(OWNER, `fjm:delok:${id}`);
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels WHERE id = ?', id).n, 0);

  // invite link flow
  const pid = h.one('SELECT id FROM force_join_channels WHERE chat_id = -1004000000003').id;
  await h.tap(OWNER, `fjm:view:${pid}`);
  await h.tap(OWNER, `fjm:link:${pid}`);
  await h.send(OWNER, 'not a link');
  assert.match(h.lastText(OWNER), /این لینک معتبر نیست/);
  await h.send(OWNER, 'https://t.me/+NewLink9876');
  assert.equal(h.one('SELECT invite_link AS l FROM force_join_channels WHERE id = ?', pid).l, 'https://t.me/+NewLink9876');

  const actions = h.q('SELECT action FROM audit_log ORDER BY id').map((r) => r.action);
  for (const a of ['forcejoin.add', 'forcejoin.disable', 'forcejoin.reorder', 'forcejoin.remove', 'forcejoin.link']) assert.ok(actions.includes(a), a);
});

test('at most 10 channels', async () => {
  const h = setup();
  for (let i = 0; i < 7; i++) h.tg.addChannel({ id: -1005000000000 - i, username: `Extra${i}x`, title: `Extra ${i}` });
  await h.send(OWNER, '/admin');
  for (let i = 0; i < 7; i++) {
    await h.press(OWNER, 'fjm:add', 1);
    await h.send(OWNER, `@Extra${i}x`);
  }
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels').n, 10);
  h.tg.addChannel({ id: -1006000000000, username: 'Eleventh', title: 'Eleventh' });
  await h.press(OWNER, 'fjm:add', 1);
  await h.send(OWNER, '@Eleventh');
  assert.match(h.lastText(OWNER), /حداکثر ۱۰ کانال/);
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels').n, 10);
});

test('my_chat_member: the bot loses admin in a force-join channel → unhealthy + alert', async () => {
  const h = setup();
  await h.myChatMember({ id: SEED[2], type: 'channel', title: 'Wanger bots' }, OWNER, 'left', 'administrator');
  assert.equal(h.one('SELECT last_check_status AS s FROM force_join_channels WHERE chat_id = ?', SEED[2]).s, 'bot_not_admin');
  assert.match(h.lastText(OWNER), /دیگه ادمین کانال «Wanger bots» نیست/);
  await h.myChatMember({ id: SEED[2], type: 'channel', title: 'Wanger bots' }, OWNER, 'administrator', 'left');
  assert.equal(h.one('SELECT last_check_status AS s FROM force_join_channels WHERE chat_id = ?', SEED[2]).s, 'ok');
});
