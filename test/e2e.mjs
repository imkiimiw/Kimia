// End-to-end test: the real handlers (tgcloud/handlers/*.js) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a mock Bot API.
// Run: npm test   (this is the local check; test/cloud/run-tests.mjs runs on Telegram Serverless)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createMockTelegram } from './mock-telegram.mjs';
import { db, setupDatabase, sql } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { fa } from '../tgcloud/lib/text.js';

const BOT_ID = 7000000001;
const OWNER = 5557901897;
const U1 = 1001;
const U2 = 1002;
const U3 = 1003;

// ---------- infrastructure ----------

const mock = createMockTelegram({ botId: BOT_ID });
for (const name of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) mock.addChat(name, { title: `T ${name}` });
for (let i = 1; i <= 9; i += 1) mock.addChat(`extra_chan${i}`);
mock.addChat('not_admin_chan', { admin: false });
mock.addChat('some_person', { type: 'private' });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema); // what `npx tgcloud migrate` does on the platform

// Telegram runs modules in a bare V8 isolate: ECMAScript built-ins, `console` and the `sdk` only.
// Remove Node's web and timer globals so any use of them in the bot fails here too.
for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'atob', 'btoa', 'crypto', 'AbortController', 'AbortSignal', 'Buffer', 'performance', 'navigator']) {
  delete globalThis[name];
}

const { default: onMessage } = await import('../tgcloud/handlers/message.js');
const { default: onCallback } = await import('../tgcloud/handlers/callback_query.js');

const errors = [];
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
console.warn = () => {}; // expected Bot API failures are logged as warnings

let clock = Date.UTC(2026, 9, 25, 8, 0); // 2026-10-25 11:30 Tehran = 1405/08/03
Date.now = () => clock;

let mark = 0;
let messageId = 1;
let updateId = 1;
const person = (id) => ({ id, is_bot: false, first_name: `User${id}`, language_code: 'fa' });

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}

async function say(uid, text, extra = {}) {
  since();
  const message = { message_id: messageId++, from: person(uid), chat: { id: uid, type: 'private', first_name: `User${uid}` }, date: Math.floor(clock / 1000), text, ...extra };
  if (text === undefined) delete message.text;
  const result = await onMessage(message, { update: { update_id: updateId++, message } });
  return { calls: since(), result };
}

async function press(uid, data, { chatType = 'private' } = {}) {
  since();
  const cq = {
    id: `cq${updateId}`,
    from: person(uid),
    chat_instance: '42',
    data,
    message: { message_id: 500, date: Math.floor(clock / 1000) - 5, chat: { id: uid, type: chatType }, text: '.' },
  };
  const result = await onCallback(cq, { update: { update_id: updateId++, callback_query: cq } });
  const calls = since();
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answers.length, 1, `answerCallbackQuery must be called exactly once for "${data}"`);
  return { calls, result, answer: answers[0].params };
}

/** The last screen (sendMessage / editMessageText) sent to `chat`. */
function screen(calls, chat) {
  const shown = calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && (chat === undefined || Number(c.params.chat_id) === chat));
  assert.ok(shown.length, 'expected a message');
  const p = shown[shown.length - 1].params;
  const buttons = (p.reply_markup ? p.reply_markup.inline_keyboard : []).flat();
  for (const b of buttons) if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  return {
    text: p.text,
    data: buttons.filter((b) => b.callback_data).map((b) => b.callback_data),
    labels: buttons.map((b) => b.text),
    urls: buttons.filter((b) => b.url).map((b) => b.url),
  };
}

const q = (strings, ...values) => db.get(sql(strings, ...values));
const qa = (strings, ...values) => db.all(sql(strings, ...values));
const memberCalls = (calls) => calls.filter((c) => c.method === 'getChatMember');
const joinAll = (uid) => ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'].forEach((n) => mock.setMember(n, uid, { status: 'member' }));
const taskIdOf = async (uid, text) => (await q`SELECT id FROM tasks WHERE user_id = ${uid} AND text = ${text}`).id;

let passed = 0;
async function step(name, fn) {
  const before = errors.length;
  try {
    await fn();
    assert.equal(errors.length, before, `unexpected console.error: ${errors.slice(before).join('\n')}`);
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.log(`  ✘ ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}

// ---------- mandatory join ----------
console.log('mandatory join');

await step('first update seeds the 3 default channels; non-member /start sees the join screen', async () => {
  const { calls, result } = await say(U1, '/start');
  const rows = await qa`SELECT username FROM channels ORDER BY id`;
  assert.deepEqual(rows.map((r) => r.username), ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']);
  assert.equal(memberCalls(calls).length, 3);
  const s = screen(calls);
  assert.match(s.text, /عضویت اجباری/);
  assert.match(s.text, /خوش آمدید/);
  assert.deepEqual(s.urls, ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
  assert.deepEqual(s.data, ['j']);
  assert.ok(result.trace.some((t) => t.view === 'join'));
  assert.equal((await q`SELECT value FROM settings WHERE key = 'seeded'`).value, '1');
});

await step('a non-member cannot use features (text, commands, buttons)', async () => {
  let r = await say(U1, 'خرید نان');
  assert.match(screen(r.calls).text, /عضویت اجباری/);
  assert.equal((await q`SELECT count(*) AS n FROM tasks`).n, 0);
  r = await say(U1, '/list');
  assert.match(screen(r.calls).text, /عضویت اجباری/);
  const p = await press(U1, 'l:0:0');
  assert.equal(p.answer.show_alert, true);
  assert.match(screen(p.calls).text, /عضویت اجباری/);
});

await step('"✅ عضو شدم" lists only the channels still missing', async () => {
  mock.setMember('HIDE_i_SEEK', U1, { status: 'member' });
  mock.setMember('Nepenthw_ir', U1, { status: 'administrator' });
  const p = await press(U1, 'j');
  assert.equal(p.answer.show_alert, true);
  const s = screen(p.calls);
  assert.deepEqual(s.urls, ['https://t.me/wangerBots']);
  assert.doesNotMatch(s.text, /HIDE_i_SEEK/);
});

await step('restricted counts only with is_member: true; left/kicked do not', async () => {
  mock.setMember('wangerBots', U1, { status: 'restricted', is_member: false });
  assert.equal(screen((await press(U1, 'j')).calls).urls.length, 1);
  mock.setMember('wangerBots', U1, { status: 'kicked' });
  assert.equal(screen((await press(U1, 'j')).calls).urls.length, 1);
  mock.setMember('wangerBots', U1, { status: 'restricted', is_member: true });
  const p = await press(U1, 'j');
  assert.match(p.answer.text, /تأیید شد/);
  assert.match(screen(p.calls).text, /سلام/);
  assert.ok(screen(p.calls).data.includes('l:0:0'));
});

await step('creator counts as joined; leaving a channel locks the user again', async () => {
  mock.setMember('wangerBots', U1, { status: 'creator' });
  assert.match(screen((await say(U1, '/help')).calls).text, /راهنمای ربات/);
  mock.setMember('wangerBots', U1, { status: 'left' });
  assert.match(screen((await say(U1, '/help')).calls).text, /عضویت اجباری/);
  mock.setMember('wangerBots', U1, { status: 'member' });
});

await step('an unknown user id ("user not found") counts as not joined, not as a broken channel', async () => {
  mock.state.unknownUsers.add(4040);
  const { calls } = await say(4040, '/start');
  assert.equal(screen(calls).urls.length, 3);
  assert.equal(calls.filter((c) => Number(c.params.chat_id) === OWNER).length, 0, 'no owner warning');
});

await step('owner skips the join check and sees the admin button', async () => {
  const { calls } = await say(OWNER, '/start');
  assert.equal(memberCalls(calls).length, 0);
  const s = screen(calls);
  assert.match(s.text, /سلام User5557901897/);
  assert.ok(s.data.includes('a'));
  assert.ok(!screen((await say(U1, '/start')).calls).data.includes('a'), 'no admin button for others');
});

await step('a channel whose check errors is skipped, and the owner is warned at most once per 3h', async () => {
  await db.run(sql`INSERT INTO channels (uname, username, created_at) VALUES ('not_admin_chan', 'not_admin_chan', 0)`);
  let r = await say(U1, '/help');
  assert.match(screen(r.calls, U1).text, /راهنمای ربات/, 'user is not locked out');
  const warning = screen(r.calls, OWNER);
  assert.match(warning.text, /هشدار عضویت اجباری/);
  assert.match(warning.text, /not_admin_chan/);
  assert.match(warning.text, /member list is inaccessible/);
  r = await say(U2, '/start'); // U2 isn't a member: still blocked by the working channels
  assert.equal(screen(r.calls, U2).urls.length, 3);
  assert.equal(r.calls.filter((c) => Number(c.params.chat_id) === OWNER).length, 0, 'no second warning');
  clock += 3 * 3600 * 1000 + 1000;
  r = await say(U1, '/help');
  assert.match(screen(r.calls, OWNER).text, /not_admin_chan/, 'warned again after 3h');
  await db.run(sql`DELETE FROM channels WHERE uname = 'not_admin_chan'`);
});

// ---------- 1. add ----------
console.log('to-do features');
joinAll(U2);

await step('1. add a task by plain text', async () => {
  const { calls } = await say(U1, 'خرید نان');
  const s = screen(calls);
  assert.match(s.text, /کار جدید اضافه شد/);
  assert.match(s.text, /خرید نان/);
  const row = await q`SELECT * FROM tasks WHERE user_id = ${U1}`;
  assert.equal(row.text, 'خرید نان');
  assert.equal(row.priority, 2);
  assert.equal(row.done, 0);
});

await step('1. add with /add text, and /add alone asks for the text', async () => {
  await say(U1, '/add  تماس با علي  ');
  assert.ok(await q`SELECT id FROM tasks WHERE user_id = ${U1} AND text = 'تماس با علی'`, 'Arabic yeh normalized');
  let s = screen((await say(U1, '/add')).calls);
  assert.match(s.text, /متن کار جدید را بفرستید/);
  assert.equal((await q`SELECT state FROM user_state WHERE user_id = ${U1}`).state, 'add');
  s = screen((await say(U1, 'پرداخت قبض')).calls);
  assert.match(s.text, /کار جدید اضافه شد/);
  assert.equal(await q`SELECT state FROM user_state WHERE user_id = ${U1}`, null);
  s = screen((await press(U1, 'add')).calls);
  assert.match(s.text, /متن کار جدید/);
  assert.match(screen((await press(U1, 'x')).calls).text, /لغو شد/);
});

await step('1. text over 500 characters is refused', async () => {
  const { calls } = await say(U1, 'ا'.repeat(501));
  assert.match(screen(calls).text, /حداکثر ۵۰۰ کاراکتر/);
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U1}`).n, 3);
  await say(U1, 'ب'.repeat(500));
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U1}`).n, 4);
  await db.run(sql`DELETE FROM tasks WHERE user_id = ${U1} AND length(text) = 500`);
});

await step('1. a user is capped at 500 tasks', async () => {
  for (let i = 0; i < 497; i += 100) {
    const n = Math.min(100, 497 - i);
    const values = Array.from({ length: n }, (_, k) => `(${U3}, 'filler ${i + k}', 0, 2, 0)`).join(',');
    await db.run(`INSERT INTO tasks (user_id, text, done, priority, created_at) VALUES ${values}`);
  }
  joinAll(U3);
  await say(U3, 'کار ۴۹۸');
  await say(U3, 'کار ۴۹۹');
  await say(U3, 'کار ۵۰۰');
  const { calls } = await say(U3, 'کار ۵۰۱');
  assert.match(screen(calls).text, /سقف ۵۰۰ کار/);
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U3}`).n, 500);
  await db.run(sql`DELETE FROM tasks WHERE user_id = ${U3}`);
});

// ---------- 2. list ----------

await step('2. list is paginated 8 per page with next/previous', async () => {
  for (let i = 1; i <= 7; i += 1) await say(U1, `کار شماره ${i}`);
  // U1 now has 10 tasks
  let s = screen((await press(U1, 'l:0:0')).calls);
  assert.match(s.text, /۱۰ کار \| صفحه ۱ از ۲/);
  assert.equal(s.data.filter((d) => d.startsWith('v:')).length, 8);
  assert.equal(s.data.filter((d) => d.startsWith('tl:')).length, 8);
  assert.ok(s.data.includes('l:1:0'));
  assert.ok(!s.data.some((d) => d === 'l:-1:0'));
  s = screen((await press(U1, 'l:1:0')).calls);
  assert.match(s.text, /صفحه ۲ از ۲/);
  assert.equal(s.data.filter((d) => d.startsWith('v:')).length, 2);
  assert.ok(s.data.includes('l:0:0'));
  s = screen((await press(U1, 'l:99:0')).calls);
  assert.match(s.text, /صفحه ۲ از ۲/, 'page is clamped');
  s = screen((await say(U2, '/list')).calls);
  assert.match(s.text, /هنوز کاری ثبت نکرده‌اید/);
});

// ---------- 3. toggle ----------

await step('3. toggle done/undone from the list and from the task card', async () => {
  const id = await taskIdOf(U1, 'خرید نان');
  let p = await press(U1, `tl:${id}:l0.0`);
  assert.match(p.answer.text, /انجام شد/);
  assert.equal((await q`SELECT done FROM tasks WHERE id = ${id}`).done, 1);
  assert.ok((await q`SELECT done_at FROM tasks WHERE id = ${id}`).done_at > 0);
  assert.match(screen(p.calls).text, /صفحه ۱ از ۲/, 'the list is shown again');
  assert.doesNotMatch(screen(p.calls).text, /خرید نان/, 'done tasks sink to the end of the list');
  assert.match(screen((await press(U1, 'l:1:0')).calls).text, /✅ 🟡 <s>خرید نان<\/s>/);
  p = await press(U1, `tv:${id}:l0.0`);
  assert.equal((await q`SELECT done FROM tasks WHERE id = ${id}`).done, 0);
  assert.equal((await q`SELECT done_at FROM tasks WHERE id = ${id}`).done_at, null);
  assert.match(screen(p.calls).text, /جزئیات کار/);
  assert.match(screen(p.calls).text, /انجام‌نشده/);
});

// ---------- 4. edit ----------

await step('4. edit a task text', async () => {
  const id = await taskIdOf(U1, 'پرداخت قبض');
  let s = screen((await press(U1, `e:${id}:l0.0`)).calls);
  assert.match(s.text, /متن جدید/);
  assert.ok(s.data.includes(`v:${id}:l0.0`), 'cancel goes back to the task');
  s = screen((await say(U1, 'ج'.repeat(501))).calls);
  assert.match(s.text, /حداکثر ۵۰۰ کاراکتر/);
  assert.equal((await q`SELECT state FROM user_state WHERE user_id = ${U1}`).state, 'edit', 'still waiting');
  s = screen((await say(U1, 'پرداخت قبض برق')).calls);
  assert.match(s.text, /متن کار ویرایش شد/);
  assert.equal((await q`SELECT text FROM tasks WHERE id = ${id}`).text, 'پرداخت قبض برق');
  assert.equal(await q`SELECT state FROM user_state WHERE user_id = ${U1}`, null);
});

await step('4. a stale prompt (over 30 min) is dropped and the text becomes a new task', async () => {
  const id = await taskIdOf(U1, 'پرداخت قبض برق');
  await press(U1, `e:${id}:l0.0`);
  clock += 31 * 60 * 1000;
  await say(U1, 'کار تازه');
  assert.equal((await q`SELECT text FROM tasks WHERE id = ${id}`).text, 'پرداخت قبض برق');
  assert.ok(await taskIdOf(U1, 'کار تازه'));
  clock = Date.UTC(2026, 9, 25, 8, 0) + 4 * 3600 * 1000; // same Tehran day
});

// ---------- 6. priority ----------

await step('6. set priority and sort by priority', async () => {
  const bread = await taskIdOf(U1, 'خرید نان');
  const call = await taskIdOf(U1, 'تماس با علی');
  let p = await press(U1, `ps:${call}:1:l0.0`);
  assert.match(p.answer.text, /بالا/);
  assert.equal((await q`SELECT priority FROM tasks WHERE id = ${call}`).priority, 1);
  assert.match(screen(p.calls).text, /🔴 بالا/);
  p = await press(U1, `ps:${bread}:3:l0.0`);
  assert.equal((await q`SELECT priority FROM tasks WHERE id = ${bread}`).priority, 3);
  await press(U1, `ps:${bread}:7:l0.0`); // invalid value is ignored
  assert.equal((await q`SELECT priority FROM tasks WHERE id = ${bread}`).priority, 3);
  const s = screen((await press(U1, 'l:0:0')).calls);
  assert.match(s.text, /مرتب‌سازی: 🔥 اولویت/);
  assert.match(s.text.split('\n').find((l) => l.startsWith('۱.')), /🔴 تماس با علی/, 'high priority first');
  const page2 = screen((await press(U1, 'l:1:0')).calls).text;
  assert.match(page2.split('\n').filter((l) => /^[۰-۹]+\./.test(l)).pop(), /🟢 خرید نان/, 'low priority last');
});

await step('6. the sort button cycles priority → date → newest', async () => {
  let p = await press(U1, 'so:0:0');
  assert.match(p.answer.text, /تاریخ/);
  assert.equal((await q`SELECT sort FROM users WHERE id = ${U1}`).sort, 'd');
  p = await press(U1, 'so:0:0');
  assert.match(screen(p.calls).text, /جدیدترین/);
  assert.match(screen(p.calls).text.split('\n').find((l) => l.startsWith('۱.')), /کار تازه/);
  await press(U1, 'so:0:0');
  assert.equal((await q`SELECT sort FROM users WHERE id = ${U1}`).sort, 'p');
});

// ---------- 7. due date ----------

await step('7. due date in Jalali and Gregorian; overdue shows ⏰', async () => {
  const bread = await taskIdOf(U1, 'خرید نان');
  const bill = await taskIdOf(U1, 'پرداخت قبض برق');
  let s = screen((await press(U1, `u:${bread}:l0.0`)).calls);
  assert.match(s.text, /تاریخ سررسید/);
  assert.ok(s.data.includes(`ud:${bread}:t:l0.0`));
  s = screen((await say(U1, '1405/08/01')).calls);
  assert.match(s.text, /سررسید ثبت شد: 📅 ۱۴۰۵\/۰۸\/۰۱/);
  assert.match(s.text, /این تاریخ گذشته است/);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bread}`).due_date, '2026-10-23');
  await press(U1, `u:${bill}:l0.0`);
  s = screen((await say(U1, '2026-11-01')).calls);
  assert.match(s.text, /۱۴۰۵\/۰۸\/۱۰/);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bill}`).due_date, '2026-11-01');
  s = screen((await press(U1, 'l:0:0')).calls);
  const all = s.text + screen((await press(U1, 'l:1:0')).calls).text;
  assert.match(all, /خرید نان — 📅 ۱۴۰۵\/۰۸\/۰۱ ⏰/);
  assert.match(all, /پرداخت قبض برق — 📅 ۱۴۰۵\/۰۸\/۱۰(?! ⏰)/);
  s = screen((await press(U1, `v:${bread}:l0.0`)).calls);
  assert.match(s.text, /⏰ <b>عقب‌افتاده<\/b>/);
});

await step('7. invalid dates are refused; quick buttons and clearing work', async () => {
  const bread = await taskIdOf(U1, 'خرید نان');
  await press(U1, `u:${bread}:l0.0`);
  let s = screen((await say(U1, '1405/13/40')).calls);
  assert.match(s.text, /معتبر نیست/);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bread}`).due_date, '2026-10-23');
  assert.equal((await q`SELECT state FROM user_state WHERE user_id = ${U1}`).state, 'due');
  s = screen((await press(U1, `ud:${bread}:m:l0.0`)).calls);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bread}`).due_date, '2026-10-26');
  assert.equal(await q`SELECT state FROM user_state WHERE user_id = ${U1}`, null, 'button press ends the prompt');
  await press(U1, `ud:${bread}:w:l0.0`);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bread}`).due_date, '2026-11-01');
  await press(U1, `ud:${bread}:x:l0.0`);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bread}`).due_date, null);
  await press(U1, `ud:${bread}:t:l0.0`);
  assert.equal((await q`SELECT due_date FROM tasks WHERE id = ${bread}`).due_date, '2026-10-25');
  s = screen((await press(U1, `v:${bread}:l0.0`)).calls);
  assert.doesNotMatch(s.text, /عقب‌افتاده/, 'due today is not overdue');
  await press(U1, `u:${bread}:l0.0`);
  await say(U1, '1405/08/01'); // back to overdue for the stats test
});

// ---------- 8. categories ----------

await step('8. create categories, assign tasks and filter the list', async () => {
  let s = screen((await say(U1, '/cats')).calls);
  assert.match(s.text, /هنوز دسته‌ای نساخته‌اید/);
  await press(U1, 'cn');
  s = screen((await say(U1, 'خانه')).calls);
  assert.match(s.text, /دسته‌ی «خانه» ساخته شد/);
  const home = (await q`SELECT id FROM categories WHERE user_id = ${U1} AND name = 'خانه'`).id;
  const bread = await taskIdOf(U1, 'خرید نان');
  const bill = await taskIdOf(U1, 'پرداخت قبض برق');
  s = screen((await press(U1, `c:${bread}:l0.0`)).calls);
  assert.ok(s.data.includes(`cs:${bread}:${home}:l0.0`));
  s = screen((await press(U1, `cs:${bread}:${home}:l0.0`)).calls);
  assert.match(s.text, /دسته: 🗂 خانه/);
  // new category straight from a task
  await press(U1, `cn:${bill}:l0.0`);
  s = screen((await say(U1, 'کار اداری')).calls);
  assert.match(s.text, /دسته‌ی «کار اداری» ساخته شد و به این کار داده شد/);
  const office = (await q`SELECT id FROM categories WHERE user_id = ${U1} AND name = 'کار اداری'`).id;
  assert.equal((await q`SELECT category_id FROM tasks WHERE id = ${bill}`).category_id, office);
  // filter
  s = screen((await press(U1, `l:0:${home}`)).calls);
  assert.match(s.text, /کارهای شما<\/b> — 🗂 خانه/);
  assert.match(s.text, /خرید نان/);
  assert.doesNotMatch(s.text, /پرداخت قبض/);
  assert.equal(s.data.filter((d) => d.startsWith('v:')).length, 1);
  s = screen((await press(U1, 'cats')).calls);
  assert.ok(s.labels.some((l) => l.includes('خانه (۱)')));
  // duplicate name
  await press(U1, 'cn');
  s = screen((await say(U1, 'خانه')).calls);
  assert.match(s.text, /از قبل وجود داشت/);
  assert.equal((await q`SELECT count(*) AS n FROM categories WHERE user_id = ${U1}`).n, 2);
  // remove category from task
  await press(U1, `cs:${bill}:0:l0.0`);
  assert.equal((await q`SELECT category_id FROM tasks WHERE id = ${bill}`).category_id, null);
});

await step('8. deleting a category keeps its tasks (uncategorized)', async () => {
  const office = (await q`SELECT id FROM categories WHERE user_id = ${U1} AND name = 'کار اداری'`).id;
  const bill = await taskIdOf(U1, 'پرداخت قبض برق');
  await press(U1, `cs:${bill}:${office}:l0.0`);
  let s = screen((await press(U1, `cd:${office}`)).calls);
  assert.match(s.text, /حذف نمی‌شوند/);
  s = screen((await press(U1, `cdy:${office}`)).calls);
  assert.match(s.text, /دسته حذف شد/);
  assert.equal(await q`SELECT id FROM categories WHERE id = ${office}`, null);
  assert.equal((await q`SELECT category_id FROM tasks WHERE id = ${bill}`).category_id, null);
  assert.ok(await taskIdOf(U1, 'پرداخت قبض برق'));
});

// ---------- 9. search ----------

await step('9. /search finds the user\'s tasks (both yeh spellings, case-insensitive Latin)', async () => {
  await say(U1, 'Call MOM');
  let s = screen((await say(U1, '/search نان')).calls);
  assert.match(s.text, /نتایج جستجو<\/b> برای «نان»/);
  assert.match(s.text, /۱ مورد پیدا شد/);
  assert.match(s.text, /خرید نان/);
  s = screen((await say(U1, '/search علي')).calls);
  assert.match(s.text, /تماس با علی/);
  s = screen((await say(U1, '/search mom')).calls);
  assert.match(s.text, /Call MOM/);
  s = screen((await press(U1, 's')).calls);
  assert.match(s.text, /دنبالش هستید/);
  s = screen((await say(U1, 'کار شماره')).calls);
  assert.match(s.text, /۷ مورد پیدا شد/);
  // a task opened from the results comes back to the results
  const v = s.data.find((d) => d.startsWith('v:'));
  assert.match(v, /:s0$/);
  s = screen((await press(U1, v)).calls);
  assert.ok(s.data.includes('sr:0'));
  s = screen((await say(U1, '/search چیزینیست')).calls);
  assert.match(s.text, /چیزی پیدا نشد/);
  s = screen((await say(U2, '/search نان')).calls);
  assert.match(s.text, /چیزی پیدا نشد/, 'other users\' tasks are never found');
});

// ---------- 10. stats + clear completed ----------

await step('10. stats: total, done, open, overdue', async () => {
  const a = await taskIdOf(U1, 'کار شماره 1');
  const b = await taskIdOf(U1, 'کار شماره 2');
  await press(U1, `tl:${a}:l0.0`);
  await press(U1, `tl:${b}:l0.0`);
  const s = screen((await say(U1, '/stats')).calls);
  assert.match(s.text, /کل کارها: ۱۲/);
  assert.match(s.text, /انجام‌شده: ۲/);
  assert.match(s.text, /باز: ۱۰/);
  assert.match(s.text, /عقب‌افتاده: ۱/);
  assert.match(s.text, /۱۷٪/);
  assert.ok(s.data.includes('cc'));
});

await step('10. clear completed asks first, then deletes only done tasks of this user', async () => {
  await say(U2, 'کار کاربر دوم');
  await press(U2, `tl:${await taskIdOf(U2, 'کار کاربر دوم')}:l0.0`);
  let p = await press(U1, 'cc');
  assert.match(screen(p.calls).text, /۲ کار انجام‌شده برای همیشه حذف شود/);
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U1}`).n, 12, 'nothing deleted yet');
  p = await press(U1, 'ccy');
  assert.match(p.answer.text, /۲ کار پاک شد/);
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U1}`).n, 10);
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U1} AND done = 1`).n, 0);
  assert.equal((await q`SELECT count(*) AS n FROM tasks WHERE user_id = ${U2} AND done = 1`).n, 1, 'U2 untouched');
  p = await press(U1, 'cc');
  assert.equal(p.answer.show_alert, true);
});

// ---------- 5. delete ----------

await step('5. delete asks for confirmation, then deletes', async () => {
  const id = await taskIdOf(U1, 'Call MOM');
  let s = screen((await press(U1, `d:${id}:l0.0`)).calls);
  assert.match(s.text, /این کار حذف شود/);
  assert.ok(s.data.includes(`dy:${id}:l0.0`) && s.data.includes(`v:${id}:l0.0`));
  assert.ok(await q`SELECT id FROM tasks WHERE id = ${id}`, 'not deleted before confirming');
  s = screen((await press(U1, `dy:${id}:l0.0`)).calls);
  assert.match(s.text, /کار حذف شد/);
  assert.match(s.text, /کارهای شما/);
  assert.equal(await q`SELECT id FROM tasks WHERE id = ${id}`, null);
  const again = await press(U1, `dy:${id}:l0.0`);
  assert.match(again.answer.text, /پیدا نشد/);
});

// ---------- isolation ----------
console.log('isolation between users');

await step('another user\'s task id in callback_data is always "not found"', async () => {
  const id = await taskIdOf(U1, 'خرید نان');
  const before = await q`SELECT * FROM tasks WHERE id = ${id}`;
  for (const data of [`v:${id}:l0.0`, `tl:${id}:l0.0`, `tv:${id}:l0.0`, `e:${id}:l0.0`, `ps:${id}:1:l0.0`,
    `u:${id}:l0.0`, `ud:${id}:x:l0.0`, `c:${id}:l0.0`, `cs:${id}:0:l0.0`, `cn:${id}:l0.0`, `d:${id}:l0.0`, `dy:${id}:l0.0`]) {
    const p = await press(U2, data);
    assert.match(p.answer.text, /پیدا نشد/, data);
    assert.equal(p.answer.show_alert, true, data);
    assert.doesNotMatch(screen(p.calls).text, /خرید نان/, `${data} must not reveal the task`);
  }
  assert.deepEqual(await q`SELECT * FROM tasks WHERE id = ${id}`, before, 'U1 task unchanged');
  assert.equal(await q`SELECT state FROM user_state WHERE user_id = ${U2}`, null, 'no state was set');
});

await step('another user\'s category can\'t be used, filtered or deleted', async () => {
  const home = (await q`SELECT id FROM categories WHERE user_id = ${U1} AND name = 'خانه'`).id;
  const mine = await taskIdOf(U2, 'کار کاربر دوم');
  let p = await press(U2, `cs:${mine}:${home}:l0.0`);
  assert.match(p.answer.text, /دسته پیدا نشد/);
  assert.equal((await q`SELECT category_id FROM tasks WHERE id = ${mine}`).category_id, null);
  p = await press(U2, `l:0:${home}`);
  assert.doesNotMatch(screen(p.calls).text, /خانه|خرید نان/);
  p = await press(U2, `cdy:${home}`);
  assert.match(p.answer.text, /پیدا نشد/);
  assert.ok(await q`SELECT id FROM categories WHERE id = ${home}`);
  p = await press(U2, `cd:${home}`);
  assert.match(p.answer.text, /پیدا نشد/);
});

await step('garbage callback_data is handled', async () => {
  for (const data of ['', 'zzz', 'v', 'v:abc:l0.0', 'l:-5:x', 'ps:1:2', 'constructor', '__proto__', 'tl:99999999999999999999:l0.0']) {
    const p = await press(U1, data);
    assert.ok(p.answer);
  }
});

// ---------- owner panel ----------
console.log('owner panel');

await step('/admin from the owner opens the panel', async () => {
  const s = screen((await say(OWNER, '/admin')).calls);
  assert.match(s.text, /پنل مدیریت/);
  assert.match(s.text, /عضویت اجباری: ✅ روشن/);
  assert.match(s.text, /کانال‌ها: ۳ از ۱۰/);
  const users = (await q`SELECT count(*) AS n FROM users`).n;
  assert.ok(users >= 5);
  assert.ok(s.text.includes(`کاربران: ${fa(users)}`), 'user count kept in settings matches the table');
  assert.deepEqual(s.data, ['al', 'aa', 'at', 'm']);
});

await step('/admin from anyone else is an unknown command, and owner buttons are refused', async () => {
  let s = screen((await say(U1, '/admin')).calls);
  assert.match(s.text, /این دستور را نمی‌شناسم/);
  assert.doesNotMatch(s.text, /پنل مدیریت/);
  s = screen((await say(9999, '/admin')).calls); // not joined: the join screen
  assert.match(s.text, /عضویت اجباری/);
  for (const data of ['a', 'al', 'aa', 'ar:1', 'ary:1', 'at']) {
    const p = await press(U1, data);
    assert.match(p.answer.text, /دسترسی ندارید/, data);
    assert.equal(p.calls.filter((c) => c.method !== 'answerCallbackQuery').length, 0, `${data}: nothing else happens`);
  }
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 3);
  assert.equal(await q`SELECT value FROM settings WHERE key = 'join'`, null);
  // a forged state can't add channels either
  await db.run(sql`INSERT INTO user_state (user_id, state, data, updated_at) VALUES (${U1}, 'admin_add', '{}', ${Math.floor(clock / 1000)})`);
  await say(U1, '@extra_chan1');
  assert.equal(await q`SELECT id FROM channels WHERE uname = 'extra_chan1'`, null);
  assert.ok(await taskIdOf(U1, '@extra_chan1'), 'treated as a plain task');
  await db.run(sql`DELETE FROM tasks WHERE user_id = ${U1} AND text = '@extra_chan1'`);
  // /admin in a group does nothing
  const g = await say(OWNER, '/admin', { chat: { id: -100555, type: 'supergroup', title: 'g' } });
  assert.equal(g.calls.length, 0);
});

await step('channel list shows whether the bot is admin in each', async () => {
  const s = screen((await press(OWNER, 'al')).calls);
  assert.match(s.text, /کانال‌های عضویت اجباری<\/b> \(۳ از ۱۰\)/);
  assert.match(s.text, /@HIDE_i_SEEK ✅/);
  assert.equal(s.data.filter((d) => d.startsWith('ar:')).length, 3);
});

await step('add a channel: validation (format, private link, not found, not a channel, bot not admin, duplicate)', async () => {
  let s = screen((await press(OWNER, 'aa')).calls);
  assert.match(s.text, /یوزرنیم یا لینک کانال/);
  assert.equal((await q`SELECT state FROM user_state WHERE user_id = ${OWNER}`).state, 'admin_add');
  s = screen((await say(OWNER, 'سلام')).calls);
  assert.match(s.text, /معتبر نیست/);
  s = screen((await say(OWNER, 'https://t.me/+AbCdEf')).calls);
  assert.match(s.text, /لینک دعوت خصوصی/);
  s = screen((await say(OWNER, '@no_such_chan')).calls);
  assert.match(s.text, /پیدا نشد/);
  s = screen((await say(OWNER, '@some_person')).calls);
  assert.match(s.text, /کانال نیست/);
  s = screen((await say(OWNER, 'https://t.me/not_admin_chan')).calls);
  assert.match(s.text, /ادمین نیست/);
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 3, 'nothing saved yet');
  s = screen((await say(OWNER, '@WANGERBOTS')).calls);
  assert.match(s.text, /از قبل در لیست هست/);
  assert.equal(await q`SELECT state FROM user_state WHERE user_id = ${OWNER}`, null);
});

await step('add a channel by t.me link (normalized, saved with id and title)', async () => {
  await press(OWNER, 'aa');
  const { calls } = await say(OWNER, 'https://t.me/extra_chan1');
  assert.ok(calls.some((c) => c.method === 'getChat' && c.params.chat_id === '@extra_chan1'));
  assert.ok(calls.some((c) => c.method === 'getChatMember' && Number(c.params.user_id) === BOT_ID));
  assert.match(screen(calls).text, /اضافه شد/);
  const row = await q`SELECT * FROM channels WHERE uname = 'extra_chan1'`;
  assert.equal(row.username, 'extra_chan1');
  assert.ok(row.chat_id < 0);
  assert.equal(row.title, 'extra_chan1');
  // users must now join it too
  const r = await say(U2, '/list');
  assert.deepEqual(screen(r.calls).urls, ['https://t.me/extra_chan1']);
  mock.setMember('extra_chan1', U2, { status: 'member' });
  mock.setMember('extra_chan1', U1, { status: 'member' });
});

await step('the 11th channel is refused (button and typed input)', async () => {
  for (let i = 2; i <= 7; i += 1) {
    await press(OWNER, 'aa');
    await say(OWNER, `@extra_chan${i}`);
    for (const uid of [U1, U2]) mock.setMember(`extra_chan${i}`, uid, { status: 'member' });
  }
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 10);
  let p = await press(OWNER, 'aa');
  assert.equal(p.answer.show_alert, true);
  assert.match(p.answer.text, /سقف ۱۰ کانال/);
  assert.match(screen(p.calls).text, /سقف کانال‌ها پر است/);
  assert.equal(await q`SELECT state FROM user_state WHERE user_id = ${OWNER}`, null, 'not waiting for a channel');
  // even if the owner was already waiting for a channel when the list filled up
  await db.run(sql`INSERT INTO user_state (user_id, state, data, updated_at) VALUES (${OWNER}, 'admin_add', '{}', ${Math.floor(clock / 1000)})`);
  const r = await say(OWNER, '@extra_chan8');
  assert.match(screen(r.calls).text, /سقف کانال‌ها پر است/);
  assert.equal(await q`SELECT id FROM channels WHERE uname = 'extra_chan8'`, null);
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 10);
});

await step('remove a channel (with confirmation) and add it back', async () => {
  const ch = await q`SELECT id FROM channels WHERE uname = 'hide_i_seek'`;
  let p = await press(OWNER, `ar:${ch.id}`);
  assert.match(screen(p.calls).text, /@HIDE_i_SEEK از عضویت اجباری حذف شود/);
  assert.ok(await q`SELECT id FROM channels WHERE id = ${ch.id}`);
  p = await press(OWNER, `ary:${ch.id}`);
  assert.match(p.answer.text, /کانال حذف شد/);
  assert.equal(await q`SELECT id FROM channels WHERE id = ${ch.id}`, null);
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 9);
  p = await press(OWNER, `ary:${ch.id}`);
  assert.match(p.answer.text, /در لیست نیست/);
  await press(OWNER, 'aa');
  const r = await say(OWNER, '@HIDE_i_SEEK');
  assert.match(screen(r.calls).text, /T HIDE_i_SEEK.*اضافه شد/);
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 10);
});

await step('removing every channel never re-seeds the defaults', async () => {
  const saved = await qa`SELECT * FROM channels`;
  await db.run(sql`DELETE FROM channels`);
  await say(U3, '/start');
  assert.equal((await q`SELECT count(*) AS n FROM channels`).n, 0);
  for (const r of saved) {
    await db.run(sql`INSERT INTO channels (id, uname, username, chat_id, title, warned_at, created_at)
      VALUES (${r.id}, ${r.uname}, ${r.username}, ${r.chat_id}, ${r.title}, ${r.warned_at}, ${r.created_at})`);
  }
});

await step('forced join can be turned off and on', async () => {
  let r = await say(U3, '/list');
  assert.match(screen(r.calls).text, /عضویت اجباری/);
  let p = await press(OWNER, 'at');
  assert.match(p.answer.text, /خاموش شد/);
  assert.match(screen(p.calls).text, /عضویت اجباری: ⛔️ خاموش/);
  r = await say(U3, '/list');
  assert.match(screen(r.calls).text, /کارهای شما/);
  assert.equal(memberCalls(r.calls).length, 0);
  p = await press(OWNER, 'at');
  assert.match(p.answer.text, /روشن شد/);
  r = await say(U3, '/list');
  assert.match(screen(r.calls).text, /عضویت اجباری/);
});

// ---------- robustness ----------
console.log('robustness');

await step('non-text messages, unknown commands, groups and bots', async () => {
  let s = screen((await say(U1, undefined, { sticker: { file_id: 'x' } })).calls);
  assert.match(s.text, /فقط پیام متنی/);
  s = screen((await say(U1, '/foo')).calls);
  assert.match(s.text, /این دستور را نمی‌شناسم/);
  const g = await say(U1, 'سلام', { chat: { id: -100777, type: 'group', title: 'g' } });
  assert.equal(g.calls.length, 0);
  const b = await say(U1, 'سلام', { from: { id: 5, is_bot: true, first_name: 'b' } });
  assert.equal(b.calls.length, 0);
  const p = await press(U1, 'l:0:0', { chatType: 'group' });
  assert.equal(p.calls.length, 1);
});

await step('a database error shows a friendly message, never the raw error', async () => {
  const realGet = db.get;
  const logged = errors.length;
  db.get = async () => { throw new Error('SQLITE_BUSY: internal detail'); };
  const r = await say(U1, '/list');
  const p = await press(U1, 'l:0:0');
  db.get = realGet;
  assert.equal(errors.length, logged + 2, 'logged for the developer');
  errors.length = logged;
  assert.match(screen(r.calls).text, /مشکلی پیش آمد/);
  assert.doesNotMatch(screen(r.calls).text, /SQLITE/);
  assert.match(p.answer.text, /مشکلی پیش آمد/);
  assert.doesNotMatch(JSON.stringify(p.calls), /SQLITE/);
});

await step('a user who blocked the bot does not crash the handler', async () => {
  mock.state.blocked.add(U2);
  const r = await say(U2, '/list');
  mock.state.blocked.delete(U2);
  assert.ok(r.result.trace.some((t) => t.ok === false && /blocked/.test(t.err)));
});

await step('handlers return a trace of every Bot API call', async () => {
  const { result } = await say(U1, '/stats');
  assert.ok(Array.isArray(result.trace));
  const last = result.trace[result.trace.length - 1];
  assert.equal(last.m, 'sendMessage');
  assert.equal(last.view, 'stats');
  assert.equal(last.ok, true);
  assert.ok(last.kb.flat().some((b) => b.includes('[l:0:0]')));
});

await mock.close();
console.log(`\n${passed} scenarios passed${process.exitCode ? ', some FAILED' : ''}`);
