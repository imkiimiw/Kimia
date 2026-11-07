// The owner/admin side: /panel permissions, channels, bans, admins, maintenance, broadcast, keys;
// plus idempotency, my_chat_member, the error boundary and housekeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, SEED, advance } from '../helpers/harness.mjs';
import { SAMPLES } from '../helpers/fixtures.mjs';
import { ownerOnly, canUse, parseChannelRef, parseUserId } from '../../tgcloud/lib/panel.js';

const U = 100000001;
const ADMIN = 100000777;

test('/panel: users get nothing, the owner sees the overview with real counters', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/panel');
  assert.match(h.lastText(U), /نمی\u200cشناسم/);
  const mark = h.mark();
  await h.press(U, 'p:mt', 1);
  assert.equal(h.tg.callsOf('editMessageText', U, mark).length, 0, 'no panel screen for a user');
  assert.ok(h.tg.answers(mark).some((a) => /اجازه ندارید/.test(a.text || '')));

  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  await h.tapText(U, '✅ بله');
  await h.send(OWNER, '/panel');
  const t = h.lastText(OWNER);
  assert.match(t, /پنل مدیریت/);
  assert.match(t, /کاربران: ۲ · جدید امروز: ۲ · فعال امروز: ۲/);
  assert.match(t, /امروز: ۱ فایل · ✅ ۱ کار · ❌ ۰ ناموفق/);
  assert.match(t, /Worker: وصل نیست/);
  assert.match(t, /عضویت اجباری: روشن \(۳ کانال\)/);
});

test('admins see the panel but not owner-only actions; the permission is re-checked per button', async () => {
  const h = setup({ members: [U] });
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:adm');
  await h.tap(OWNER, 'p:adma');
  await h.send(OWNER, String(ADMIN));
  assert.match(h.lastText(OWNER), new RegExp(String(ADMIN)));
  await h.send(ADMIN, '/panel');
  const data = h.lastButtons(ADMIN).map((b) => b.callback_data);
  assert.ok(data.includes('p:fail') && data.includes('p:ban') && data.includes('p:ch'));
  for (const d of ['p:mt', 'p:adm', 'p:bc', 'p:sec']) assert.ok(!data.includes(d), d);
  // a forged owner-only press
  const before = h.one("SELECT value FROM settings WHERE key = 'maintenance'");
  await h.press(ADMIN, 'p:mt', 1);
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'maintenance'"), before);
  for (const a of ['mt', 'sec', 'adm', 'adma', 'admd', 'bc', 'bcgo', 'bcn', 'bcx', 'cha', 'chd', 'chD', 'cht', 'chr']) assert.ok(ownerOnly(a), a);
  for (const a of ['', 'r', 'fail', 'act', 'rt', 'ch', 'ban', 'bana', 'ub']) assert.equal(canUse({ actor: 'admin' }, a), true, a);
  assert.equal(canUse({ actor: 'user' }, ''), false);
});

test('maintenance: users get a notice (staff pass); /privacy still works', async () => {
  const h = setup({ members: [U] });
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:mt');
  await h.send(U, '/start');
  assert.match(h.lastText(U), /به\u200cروزرسانی/);
  await h.send(U, '/privacy');
  assert.match(h.lastText(U), /حریم خصوصی/);
  await h.sendFile(OWNER, SAMPLES.png[0], 'a.png');
  assert.match(h.lastText(OWNER), /تصویر دریافت شد/);
});

test('bans: by id from the panel; the banned user is told once a day; the owner can\'t be banned; unban', async () => {
  const h = setup({ members: [U] });
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:ban');
  await h.tap(OWNER, 'p:bana');
  await h.send(OWNER, String(OWNER));
  assert.match(h.lastText(OWNER), /نمی\u200cشود مسدود/);
  await h.tap(OWNER, 'p:bana');
  await h.send(OWNER, '۱۰۰۰۰۰۰۰۱'); // Persian digits are accepted
  assert.match(h.lastText(OWNER), /100000001/);
  await h.send(U, '/start');
  assert.match(h.lastText(U), /مسدود/);
  const mark = h.mark();
  await h.send(U, '/start');
  assert.equal(h.tg.callsOf('sendMessage', U, mark).length, 0, 'once a day');
  await h.tap(OWNER, `p:ub:${U}`);
  await h.send(U, '/start');
  assert.match(h.lastText(U), /ربات مبدل/);
});

test('channels: list with the bot\'s status, add (validated), remove, toggle, recheck', async () => {
  const h = setup({ members: [U], botAdminIn: [SEED[0], SEED[1]] });
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:ch');
  let t = h.lastText(OWNER);
  assert.match(t, /✅ @HIDE_i_SEEK/);
  assert.match(t, /⚠️ @wangerBots .*ادمین نیست/);
  // add: invalid, not found, not admin, ok
  h.tg.addChannel({ id: -100777, username: 'newchan', title: 'New', botAdmin: false });
  await h.tap(OWNER, 'p:cha');
  await h.send(OWNER, 'not a channel!');
  assert.match(h.lastText(OWNER), /معتبر نیست/);
  await h.send(OWNER, '@nochannelhere');
  assert.match(h.lastText(OWNER), /پیدا نشد/);
  await h.send(OWNER, 'https://t.me/newchan');
  assert.match(h.lastText(OWNER), /ادمین نیست/);
  h.tg.setBotStatus(-100777, 'administrator');
  await h.send(OWNER, 't.me/newchan');
  t = h.lastText(OWNER);
  assert.match(t, /✅ @newchan/);
  assert.equal(h.q('SELECT count(*) AS n FROM channels')[0].n, 4);
  // a non-member of the new channel is now held
  advance(301);
  await h.send(U, '/start');
  assert.match(h.lastText(U), /عضو شوید/);
  // remove it
  const id = h.one("SELECT id FROM channels WHERE username = 'newchan'").id;
  await h.tap(OWNER, `p:chd:${id}`);
  await h.tap(OWNER, `p:chD:${id}`);
  assert.equal(h.q('SELECT count(*) AS n FROM channels')[0].n, 3);
  // recheck picks up the fixed channel
  h.tg.setBotStatus(SEED[2], 'administrator');
  await h.tap(OWNER, 'p:chr');
  assert.match(h.lastText(OWNER), /✅ @wangerBots/);
  // switch forced join off
  await h.tap(OWNER, 'p:cht');
  h.tg.channels.get(SEED[0]).members.delete(U);
  advance(301);
  await h.send(U, '/start');
  assert.match(h.lastText(U), /ربات مبدل/);
});

test('my_chat_member: losing admin in a forced channel alerts the owner; blocks are recorded', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/start');
  const r = await h.myChatMember({ id: SEED[1], type: 'channel', title: 'Nepenthe', username: 'Nepenthw_ir' }, 'member', 'administrator');
  assert.equal(r.view, 'forced_channel');
  assert.equal(h.one('SELECT bot_status FROM channels WHERE chat_id = ?', SEED[1]).bot_status, 'not_admin');
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /دیگر در @Nepenthw_ir ادمین نیست/.test(c.params.text)));
  await h.myChatMember({ id: U, type: 'private' }, 'kicked', 'member', U);
  assert.equal(h.one('SELECT blocked FROM users WHERE id = ?', U).blocked, 1);
  const g = await h.myChatMember({ id: -5, type: 'group', title: 'g' }, 'member', 'left');
  assert.equal(g.view, 'group_ignored');
});

test('broadcast: draft → confirm → batches of 25, blocked users marked, nobody twice, 429 resumes', async () => {
  const h = setup({ members: [] });
  const ids = Array.from({ length: 30 }, (_, i) => 200000000 + i);
  for (const id of ids) { h.join(id); await h.send(id, '/start'); }
  h.tg.blocked.add(ids[3]);
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:bc');
  await h.send(OWNER, 'سلام به همه');
  assert.match(h.lastText(OWNER), /برای همه\u200cی کاربران فرستاده شود/);
  const bcId = h.one('SELECT id FROM broadcasts').id;
  h.tg.failNext('copyMessage', 429, 'Too Many Requests: retry after 3', { parameters: { retry_after: 3 }, match: (p) => p.chat_id === ids[10] });
  await h.tap(OWNER, `p:bcgo:${bcId}`);
  assert.match(h.lastText(OWNER), /محدود کرد/);
  let row = h.one('SELECT * FROM broadcasts');
  assert.equal(row.sent, 9);
  assert.equal(row.blocked_count, 1);
  assert.equal(row.cursor, ids[9]);
  await h.tap(OWNER, `p:bcn:${bcId}`);
  advance(2);
  await h.tap(OWNER, `p:bcn:${bcId}`);
  row = h.one('SELECT * FROM broadcasts');
  assert.equal(row.status, 'done');
  assert.equal(row.sent, ids.length - 1, 'all 30 users except the one who blocked the bot (the sender is skipped)');
  const copies = h.tg.callsOf('copyMessage').filter((c) => c.result).map((c) => c.params.chat_id);
  assert.equal(new Set(copies).size, copies.length, 'nobody got it twice');
  assert.ok(!copies.includes(OWNER));
  assert.equal(h.one('SELECT blocked FROM users WHERE id = ?', ids[3]).blocked, 1);
  assert.match(h.lastText(OWNER), /تمام شد/);
});

test('/secret: owner only, the message is deleted, values are never shown or traced', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/secret set GEMINI_API_KEY abc');
  assert.equal(h.q('SELECT count(*) AS n FROM secrets')[0].n, 0);
  const r = await h.send(OWNER, '/secret set GEMINI_API_KEY AIzaSecretValue123');
  assert.equal(h.one('SELECT value FROM secrets').value, 'AIzaSecretValue123');
  assert.ok(h.tg.callsOf('deleteMessage', OWNER).length >= 1, 'the message with the key was deleted');
  assert.match(h.lastText(OWNER), /ذخیره شد/);
  assert.ok(!JSON.stringify(r).includes('AIzaSecretValue123'), 'not in the run result');
  for (const c of h.tg.calls) assert.ok(!JSON.stringify(c.params).includes('AIzaSecretValue123'), `${c.method} never carries it`);
  await h.send(OWNER, '/secret set WORKER_URL http://insecure.example');
  assert.match(h.lastText(OWNER), /https:\/\//);
  await h.send(OWNER, '/secret set NOPE x');
  assert.match(h.lastText(OWNER), /GEMINI_API_KEY/);
  await h.send(OWNER, '/secret');
  assert.match(h.lastText(OWNER), /✅ <code>GEMINI_API_KEY<\/code>/);
  assert.doesNotMatch(h.lastText(OWNER), /AIza/);
  await h.send(OWNER, '/panel');
  assert.match(h.lastText(OWNER), /Gemini: کلید ثبت شده/);
  await h.send(OWNER, '/secret del GEMINI_API_KEY');
  assert.equal(h.q('SELECT count(*) AS n FROM secrets')[0].n, 0);
});

test('failed jobs: listed with codes; staff retry sends the result to the user', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  h.tg.failNext('sendDocument', 500, 'Internal Server Error');
  await h.tapText(U, '✅ بله');
  const failed = h.one('SELECT * FROM jobs');
  assert.equal(failed.error_code, 'UPLOAD_FAILED');
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:fail');
  assert.match(h.lastText(OWNER), new RegExp(`${failed.code}.*UPLOAD_FAILED`));
  const mark = h.mark();
  await h.tap(OWNER, `p:rt:${failed.id}`);
  const docs = h.docs(U, mark);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].document.file_name, 'a.png');
  assert.match(h.lastText(OWNER), /دوباره انجام شد/);
});

test('duplicate updates are handled once; a double tap is ignored', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/start', {}, 500);
  const mark = h.mark();
  const r = await h.send(U, '/start', {}, 500);
  assert.equal(r.view, 'duplicate');
  assert.equal(h.tg.callsOf('sendMessage', U, mark).length, 0);
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  const card = h.tg.callsOf('sendMessage', U).at(-1).result.message_id;
  const ref = h.one('SELECT ref FROM files').ref;
  await h.press(U, `fx:${ref}`, card);
  const second = await h.press(U, `fx:${ref}`, card);
  assert.equal(second.view, 'double_tap');
  assert.equal(h.q('SELECT count(*) AS n FROM jobs')[0].n, 1);
});

test('someone else\'s file ref does nothing', async () => {
  const h = setup({ members: [U, U + 1] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  const ref = h.one('SELECT ref FROM files').ref;
  const mark = h.mark();
  await h.press(U + 1, `fx:${ref}`, 1);
  assert.equal(h.docs(U + 1, mark).length, 0);
  assert.match(h.lastText(U + 1), /منقضی/);
});

test('error boundary: an unexpected failure → friendly line, error row, owner alert; never throws', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/start');
  h.tg.failNext('sendMessage', 400, "Bad Request: can't parse entities", { match: (p) => p.chat_id === U && /راهنما/.test(p.text) });
  const r = await h.send(U, '/help');
  assert.equal(r.ok, false);
  assert.equal(h.one('SELECT source, code FROM errors').code, 'EXCEPTION');
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /خطا در/.test(c.params.text)));
  assert.match(h.lastText(U), /مشکلی پیش آمد/);
});

test('groups and channels are ignored without touching the database', async () => {
  const h = setup();
  const r = await h.send(-1001, 'hi', { chat: { id: -1001, type: 'supergroup' } });
  assert.equal(r.view, 'ignored');
  assert.equal(h.q('SELECT count(*) AS n FROM processed_updates')[0].n, 0);
});

test('housekeeping: old jobs, files, updates go; stale running jobs expire', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  await h.tapText(U, '✅ بله');
  h.q("UPDATE jobs SET status = 'UPLOADING'");
  advance(31 * 86400);
  h.join(U);
  await h.send(OWNER, '/panel'); // the panel runs housekeeping
  assert.equal(h.q('SELECT count(*) AS n FROM jobs')[0].n, 0, 'older than JOB_HISTORY_DAYS');
  assert.equal(h.q('SELECT count(*) AS n FROM files')[0].n, 0);
  assert.ok(h.q('SELECT count(*) AS n FROM processed_updates')[0].n <= 1);
});

test('panel parsers', () => {
  assert.equal(parseChannelRef('@wangerBots'), 'wangerBots');
  assert.equal(parseChannelRef('https://t.me/wangerBots/'), 'wangerBots');
  assert.equal(parseChannelRef('telegram.me/abcde'), 'abcde');
  assert.equal(parseChannelRef('t.me/+inviteHash'), null);
  assert.equal(parseChannelRef('abc'), null, 'too short');
  assert.equal(parseUserId(' ۱۲۳۴۵۶ '), 123456);
  assert.equal(parseUserId('12a'), null);
});

test('a banned user can still read /privacy and delete their data; the ban survives', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/start');
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:ban');
  await h.tap(OWNER, 'p:bana');
  await h.send(OWNER, String(U));
  await h.send(U, '/privacy');
  assert.match(h.lastText(U), /حریم خصوصی/);
  await h.send(U, '/deletemydata');
  await h.tap(U, 'dd:y');
  assert.match(h.lastText(U), /پاک شد/);
  const row = h.one('SELECT * FROM users WHERE id = ?', U);
  assert.equal(row.banned, 1);
  assert.equal(row.first_name, null);
});

test('the gate skips a channel it knows it can\'t check for 10 minutes, then asks again', async () => {
  const h = setup({ botAdminIn: [SEED[0], SEED[1]], members: [U, U + 1] });
  await h.send(U, '/start'); // marks @wangerBots not_admin
  let mark = h.mark();
  await h.send(U + 1, '/start');
  const asked = h.tg.callsOf('getChatMember', undefined, mark).map((c) => c.params.chat_id);
  assert.ok(!asked.includes(SEED[2]), 'not asked again within 10 minutes');
  assert.equal(h.one('SELECT join_ok_until FROM users WHERE id = ?', U + 1).join_ok_until, 0, 'a partial check is not cached as a pass');
  advance(601);
  mark = h.mark();
  await h.send(U + 1, '/help');
  await h.send(U + 1, '/settings');
  assert.ok(h.tg.callsOf('getChatMember', undefined, mark).some((c) => c.params.chat_id === SEED[2]), 'asked again after 10 minutes');
});
