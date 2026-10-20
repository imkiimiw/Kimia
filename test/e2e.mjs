// End-to-end test: runs the worker in the real Workers runtime (workerd via `wrangler dev`, with a local D1)
// against a mock Telegram Bot API, then drives it with webhook updates and cron triggers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTelegram } from './mock-telegram.mjs';
import { DAY, fromLocal, localParts, MINUTE } from '../src/time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_ID = 7000000001;
const TOKEN = `${BOT_ID}:TEST_TOKEN`;
const SECRET = 'test_secret_123';
const OWNER = 5557901897;
const U1 = 1001;
const U2 = 1002;
const U3 = 1003;

// ---------- infrastructure ----------

const mock = createMockTelegram({ botId: BOT_ID });
mock.addChannel('@HIDE_i_SEEK', { title: 'Hide & Seek' });
mock.addChannel('@Nepenthw_ir', { title: 'Nepenthe' });
mock.addChannel('@wangerBots', { title: 'Wanger Bots' });
const mockPort = await mock.listen();

const work = mkdtempSync(path.join(tmpdir(), 'todo-bot-e2e-'));
const envFile = path.join(work, '.env');
writeFileSync(envFile, `BOT_TOKEN=${TOKEN}\nWEBHOOK_SECRET=${SECRET}\nTELEGRAM_API=http://127.0.0.1:${mockPort}\n`);
const port = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${port}`;

// E2E_CONFIG runs the same suite against another wrangler config, e.g. the exact files pasted into the dashboard.
const configArgs = process.env.E2E_CONFIG ? ['--config', path.resolve(process.env.E2E_CONFIG)] : [];
const child = spawn(
  'npx',
  ['wrangler', 'dev', ...configArgs, '--local', '--ip', '127.0.0.1', '--port', String(port), '--test-scheduled', '--persist-to', path.join(work, 'state'), '--env-file', envFile, '--show-interactive-dev-session=false'],
  { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let devLog = '';
child.stdout.on('data', (d) => (devLog += d));
child.stderr.on('data', (d) => (devLog += d));

async function shutdown(code) {
  child.kill('SIGTERM');
  await mock.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
}

for (let i = 0; ; i += 1) {
  if (/Ready on/.test(devLog)) break;
  if (i > 600 || child.exitCode !== null) {
    console.error('wrangler dev did not start:\n', devLog);
    await shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
// Ready is printed slightly before the port accepts traffic.
for (let i = 0; i < 100; i += 1) {
  try {
    await fetch(BASE + '/');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

let updateId = 1;
let messageId = 1;
let mark = 0;
const user = (id) => ({ id, is_bot: false, first_name: `User${id}`, username: `user${id}` });

async function post(update, secret = SECRET) {
  const res = await fetch(BASE + '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  });
  return res.status;
}

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}

async function say(uid, text, extra = {}) {
  since();
  const message = { message_id: messageId++, from: user(uid), chat: { id: uid, type: 'private' }, date: Math.floor(Date.now() / 1000), text, ...extra };
  assert.equal(await post({ update_id: updateId++, message }), 200);
  return { calls: since(), messageId: message.message_id };
}

async function press(uid, data) {
  since();
  const cq = { id: String(updateId), from: user(uid), chat_instance: '1', data, message: { message_id: 1, chat: { id: uid, type: 'private' }, date: 0, text: '.' } };
  assert.equal(await post({ update_id: updateId++, callback_query: cq }), 200);
  return since();
}

async function cron(time) {
  since();
  const res = await fetch(`${BASE}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}&time=${time}&format=json`);
  assert.equal(res.status, 200, await res.text());
  return since();
}

const outgoing = (calls, chatId) =>
  calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && (chatId === undefined || Number(c.params.chat_id) === chatId));
const lastText = (calls) => outgoing(calls).at(-1)?.params.text || '';
const lastMarkup = (calls) => outgoing(calls).at(-1)?.params.reply_markup;
const inlineButtons = (calls) => (lastMarkup(calls)?.inline_keyboard || []).flat();
const callbacksOf = (calls) => inlineButtons(calls).map((b) => b.callback_data).filter(Boolean);
const answerOf = (calls) => calls.find((c) => c.method === 'answerCallbackQuery')?.params || {};
const includesAll = (text, parts) => parts.forEach((p) => assert.ok(text.includes(p), `expected «${p}» in:\n${text}`));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✘ ${name}\n${String(err.stack || err).replace(/^/gm, '      ')}`);
  }
}

const NOW = Date.now();
const lp = localParts(NOW);

// ---------- tests ----------

console.log('\nHTTP & setup');

await test('status page: DB, token and secret OK; webhook and cron not yet', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  includesAll(html, ['✅</span><div>دیتابیس D1', '@todo_test_bot', '✅</span><div>رمز وبهوک', '❌</span><div>اتصال وبهوک', '❌</span><div>کرون']);
});

await test('webhook rejects requests without the secret token', async () => {
  assert.equal(await post({ update_id: 1 }, 'wrong'), 403);
});

await test('/setup requires the secret and registers webhook + commands', async () => {
  assert.equal((await fetch(`${BASE}/setup?secret=nope`)).status, 403);
  since();
  const res = await fetch(`${BASE}/setup?secret=${SECRET}`);
  assert.equal(res.status, 200);
  const calls = since();
  const hook = calls.find((c) => c.method === 'setWebhook');
  assert.equal(hook.params.url, `${BASE}/webhook`);
  assert.equal(hook.params.secret_token, SECRET);
  const cmds = calls.filter((c) => c.method === 'setMyCommands');
  assert.equal(cmds.length, 2);
  assert.equal(cmds[1].params.scope.chat_id, OWNER);
});

console.log('\nForced join (default channels)');

await test('new user is blocked until joining the 3 default channels', async () => {
  const { calls } = await say(U1, '/start');
  const checked = calls.filter((c) => c.method === 'getChatMember').map((c) => c.params.chat_id);
  assert.deepEqual(checked.sort(), ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots'].sort());
  const urls = inlineButtons(calls).map((b) => b.url).filter(Boolean);
  assert.deepEqual(urls.sort(), ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'https://t.me/wangerBots'].sort());
  assert.ok(callbacksOf(calls).includes('J'));
  includesAll(lastText(calls), ['عضو شوید']);
});

await test('plain messages are also gated (no task is created)', async () => {
  const { calls } = await say(U1, 'یک کار');
  includesAll(lastText(calls), ['عضو شوید']);
});

await test('joining only 2 of 3 still shows the missing channel', async () => {
  mock.join('@HIDE_i_SEEK', U1);
  mock.join('@Nepenthw_ir', U1);
  const calls = await press(U1, 'J');
  assert.equal(answerOf(calls).show_alert, true);
  const urls = inlineButtons(calls).map((b) => b.url).filter(Boolean);
  assert.deepEqual(urls, ['https://t.me/wangerBots']);
});

await test('after joining all channels the user gets the welcome menu', async () => {
  mock.join('@wangerBots', U1);
  const calls = await press(U1, 'J');
  includesAll(answerOf(calls).text, ['تأیید']);
  const welcome = outgoing(calls).find((c) => c.params.reply_markup?.keyboard);
  assert.ok(welcome, 'welcome with reply keyboard');
  const keys = welcome.params.reply_markup.keyboard.flat().map((k) => k.text);
  assert.ok(keys.includes('📋 کارهای من'));
  assert.ok(!keys.includes('👑 پنل مدیریت'), 'non-owner must not see the admin button');
});

await test('leaving a channel blocks the user again', async () => {
  mock.leave('@Nepenthw_ir', U1);
  const r = await press(U1, 'J'); // forced re-check (bypasses the short cache)
  assert.deepEqual(inlineButtons(r).map((b) => b.url).filter(Boolean), ['https://t.me/Nepenthw_ir']);
  mock.join('@Nepenthw_ir', U1);
  await press(U1, 'J');
});

console.log('\nTasks (features 1–9)');

await test('#1 smart quick add parses #category !priority @due', async () => {
  const { calls } = await say(U1, 'خرید نان #خانه !1 @فردا 18:00');
  const text = lastText(calls);
  includesAll(text, ['به لیست اضافه شد', 'خرید نان', 'دسته: خانه', '🔴 بالا', 'ساعت ۱۸:۰۰', '(فردا ۱۸:۰۰)']);
  assert.ok(!text.includes('@فردا') && !text.includes('#خانه'));
  assert.ok(callbacksOf(calls).includes('D|1|p.0'));
});

await test('#1 non-date @mentions stay in the task text', async () => {
  const { calls } = await say(U1, 'زنگ به @ali درباره پروژه');
  includesAll(lastText(calls), ['زنگ به @ali درباره پروژه', '🟡 متوسط', 'ددلاین: —']);
});

await test('#1 add via the ➕ button flow', async () => {
  const r1 = await say(U1, '➕ کار جدید');
  includesAll(lastText(r1.calls), ['متن کار جدید']);
  const r2 = await say(U1, 'ورزش صبحگاهی !3 #سلامتی');
  includesAll(lastText(r2.calls), ['کار شماره ۳', '🟢 کم', 'سلامتی']);
});

await test('#2 list is sorted by priority', async () => {
  const { calls } = await say(U1, '📋 کارهای من');
  const text = lastText(calls);
  const a = text.indexOf('خرید نان');
  const b = text.indexOf('زنگ به');
  const c = text.indexOf('ورزش');
  assert.ok(a > -1 && a < b && b < c, text);
  assert.ok(callbacksOf(calls).includes('T|1|p.0'));
});

await test('#2 change priority from the task card', async () => {
  includesAll(lastText(await press(U1, 'T|2|p.0')), ['کار شماره ۲']);
  assert.ok(callbacksOf(await press(U1, 'E|2|p|p.0')).includes('P|2|1|p.0'));
  const calls = await press(U1, 'P|2|1|p.0');
  includesAll(answerOf(calls).text, ['بالا']);
  includesAll(lastText(calls), ['🔴 بالا']);
});

await test('#3 due date typed in Jalali', async () => {
  await press(U1, 'E|2|d|p.0');
  const { calls } = await say(U1, '۱۴۰۵/۰۸/۱۰');
  includesAll(lastText(calls), ['ذخیره شد', '۱۰ آبان']);
});

await test('#3 invalid date asks again, then accepts', async () => {
  await press(U1, 'E|3|d|p.0');
  includesAll(lastText((await say(U1, 'یه روزی')).calls), ['متوجه نشدم']);
  includesAll(lastText((await say(U1, 'دیروز ساعت 10')).calls), ['متوجه نشدم']);
  includesAll(lastText((await say(U1, 'پس‌فردا')).calls), ['ذخیره شد', '(پس‌فردا)']);
});

await test('#3 due presets and overdue warning', async () => {
  const calls = await press(U1, 'DD|3|0|p.0');
  includesAll(lastText(calls), ['(امروز)']);
  // A date in the past is shown as overdue.
  await press(U1, 'E|3|d|p.0');
  const past = localParts(NOW - 3 * DAY);
  includesAll(lastText((await say(U1, `${past.y}-${past.m}-${past.d}`)).calls), ['⚠️', '۳ روز پیش']);
});

await test('#4 reminder typed as relative time', async () => {
  await press(U1, 'E|2|r|p.0');
  const { calls } = await say(U1, '30 دقیقه دیگر');
  const text = lastText(calls);
  assert.ok(!/⏰ یادآور: —/.test(text), text);
});

await test('#4 reminder preset buttons', async () => {
  const calls = await press(U1, 'RM|3|60|p.0');
  includesAll(answerOf(calls).text, ['یادآور']);
  assert.ok(callbacksOf(await press(U1, 'E|1|r|p.0')).includes('RM|1|due|p.0'), 'due-time preset for a task with a timed due date');
  includesAll(lastText(await press(U1, 'RM|1|due60|p.0')), ['ساعت ۱۷:۰۰']);
});

await test('#4 reminder in the past is rejected', async () => {
  await press(U1, 'E|3|r|p.0');
  includesAll(lastText((await say(U1, '1400/01/01 10:00')).calls), ['گذشته']);
  await press(U1, 'CX');
});

await test('#5 categories: pick existing, type new, browse', async () => {
  const picker = await press(U1, 'E|2|c|p.0');
  assert.ok(callbacksOf(picker).includes('C|2|خانه|p.0'));
  includesAll(lastText(await press(U1, 'C|2|خانه|p.0')), ['دسته: خانه']);
  await press(U1, 'E|3|c|p.0');
  includesAll(lastText((await say(U1, 'کار شرکت')).calls), ['دسته: کار شرکت']);
  const { calls } = await say(U1, '🗂 دسته‌ها');
  includesAll(lastText(calls), ['خانه', 'کار شرکت']);
  const list = await press(U1, 'L|cخانه|0');
  includesAll(lastText(list), ['دسته «خانه»', 'خرید نان', 'زنگ به']);
  assert.ok(callbacksOf(list).includes('T|1|cخانه.0'), 'card keeps the list context');
  assert.ok(callbacksOf(await press(U1, 'T|1|cخانه.0')).includes('L|cخانه|0'), 'back button returns to the category');
});

await test('#6 recurring task: completing moves it to the next occurrence and logs history', async () => {
  includesAll(answerOf(await press(U1, 'RP|1|d|p.0')).text, ['روزانه']);
  const calls = await press(U1, 'D|1|p.0');
  includesAll(answerOf(calls).text, ['نوبت بعد']);
  includesAll(lastText(calls), ['⏳ در جریان', 'تکرار: روزانه', '(پس‌فردا ۱۸:۰۰)']);
  includesAll(lastText(await press(U1, 'L|d|0')), ['خرید نان']);
});

await test('#7 note + text edit', async () => {
  await press(U1, 'E|1|n|p.0');
  includesAll(lastText((await say(U1, 'نان سنگک بگیر')).calls), ['یادداشت:', 'نان سنگک بگیر']);
  await press(U1, 'E|3|t|p.0');
  includesAll(lastText((await say(U1, 'ورزش صبحگاهی ۳۰ دقیقه')).calls), ['ورزش صبحگاهی ۳۰ دقیقه']);
  assert.ok(callbacksOf(await press(U1, 'E|1|n|p.0')).includes('NX|1||p.0'));
  await press(U1, 'CX');
});

await test('#7 done / undo for a normal task', async () => {
  includesAll(answerOf(await press(U1, 'D|3|p.0')).text, ['انجام شد']);
  includesAll(answerOf(await press(U1, 'D|3|p.0')).text, ['برگشت']);
});

await test('#8 search in text, note and via /search', async () => {
  await say(U1, '🔍 جستجو');
  includesAll(lastText((await say(U1, 'سنگک')).calls), ['نتایج جستجو', 'خرید نان']);
  includesAll(lastText((await say(U1, '/search پروژه')).calls), ['زنگ به']);
  includesAll(lastText((await say(U1, '/search چیزی_که_نیست')).calls), ['پیدا نشد']);
});

await test('#9 stats with progress bar', async () => {
  const { calls } = await say(U1, '📊 آمار');
  includesAll(lastText(calls), ['آمار شما', 'پیشرفت کلی', '▰', 'کارهای تکراری']);
});

await test('today view and pagination', async () => {
  includesAll(lastText((await say(U1, '📅 امروز')).calls), ['کارهای امروز و عقب‌افتاده', 'ورزش']);
  for (let i = 1; i <= 8; i += 1) await say(U1, `کار شماره‌دار ${i}`);
  const { calls } = await say(U1, '/list');
  includesAll(lastText(calls), ['صفحه ۱ از ۲']);
  assert.ok(callbacksOf(calls).includes('L|p|1'));
  includesAll(lastText(await press(U1, 'L|p|1')), ['صفحه ۲ از ۲']);
});

await test('delete with confirmation', async () => {
  includesAll(lastText(await press(U1, 'X|5|p.0')), ['حذف شود']);
  includesAll(answerOf(await press(U1, 'XX|5|p.0')).text, ['حذف شد']);
  assert.equal(answerOf(await press(U1, 'T|5|p.0')).show_alert, true);
});

await test('settings: daily digest hour, export file, clear done', async () => {
  includesAll(lastText((await say(U1, '⚙️ تنظیمات')).calls), ['خلاصه روزانه: خاموش']);
  assert.ok(callbacksOf(await press(U1, 'S|dg')).includes('S|dh|8'));
  includesAll(lastText(await press(U1, 'S|dh|8')), ['ساعت ۰۸:۰۰']);
  const doc = (await press(U1, 'S|ex')).find((c) => c.method === 'sendDocument');
  assert.ok(doc, 'sendDocument called');
  assert.match(doc.params.filename, /^todo-\d{4}-\d{2}-\d{2}\.txt$/);
  includesAll(doc.params.document, ['خرید نان', 'یادداشت: نان سنگک بگیر', 'در جریان']);
});

console.log('\nCron (reminders, digest)');

await test('#4 reminder fires at its time, with snooze buttons, exactly once', async () => {
  const calls = await cron(NOW + 31 * MINUTE);
  const reminders = outgoing(calls, U1).filter((c) => c.params.text.includes('یادآوری'));
  assert.equal(reminders.length, 1, JSON.stringify(reminders.map((r) => r.params.text)));
  includesAll(reminders[0].params.text, ['زنگ به @ali']);
  const cbs = reminders[0].params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('SN|2|10') && cbs.includes('D|2|p.0'));
  const again = await cron(NOW + 32 * MINUTE);
  assert.equal(outgoing(again, U1).filter((c) => c.params.text.includes('زنگ به')).length, 0, 'no duplicate');
});

await test('#4 snooze reschedules the reminder', async () => {
  const calls = await press(U1, 'SN|2|10');
  includesAll(answerOf(calls).text, ['به تعویق']);
  includesAll(lastText(calls), ['موکول شد']);
  const fired = await cron(Date.now() + 11 * MINUTE);
  assert.ok(outgoing(fired, U1).some((c) => c.params.text.includes('یادآوری') && c.params.text.includes('زنگ به')), 'snoozed reminder fires');
});

await test('#6 recurring reminder repeats on the next day', async () => {
  // Task 1: reminder 1h before its (moved) due date the day after tomorrow, repeating daily.
  const t1 = await cron(NOW + 3 * DAY);
  assert.ok(outgoing(t1, U1).some((c) => c.params.text.includes('یادآوری') && c.params.text.includes('خرید نان')));
  const t2 = await cron(NOW + 4 * DAY);
  assert.ok(outgoing(t2, U1).some((c) => c.params.text.includes('یادآوری') && c.params.text.includes('خرید نان')), 'fires again next day');
});

await test('#10 daily digest is sent at the chosen hour, once per day', async () => {
  const day = localParts(NOW + 6 * DAY);
  const at = fromLocal(day.y, day.m, day.d, 8, 5);
  const calls = await cron(at);
  const digest = outgoing(calls, U1).filter((c) => c.params.text.includes('خلاصه روزانه'));
  assert.equal(digest.length, 1);
  includesAll(digest[0].params.text, ['صبح بخیر', 'در جریان', 'خرید نان']);
  const again = await cron(at + 10 * MINUTE);
  assert.equal(outgoing(again, U1).filter((c) => c.params.text.includes('خلاصه روزانه')).length, 0);
  const early = localParts(NOW + 7 * DAY);
  const before = await cron(fromLocal(early.y, early.m, early.d, 7, 30));
  assert.equal(outgoing(before, U1).filter((c) => c.params.text.includes('خلاصه روزانه')).length, 0, 'not before 08:00');
});

await test('clear done tasks', async () => {
  const calls = await press(U1, 'S|cly');
  includesAll(answerOf(calls).text, ['پاک شد']);
  includesAll(lastText(await press(U1, 'L|d|0')), ['چیزی برای نمایش نیست']);
});

await test('users who blocked the bot are marked and skipped', async () => {
  for (const c of ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots']) mock.join(c, U2);
  await say(U2, '/start');
  await say(U2, 'تست بلاک');
  await press(U2, 'RM|1|15|p.0');
  mock.state.blocked.add(U2);
  const calls = await cron(Date.now() + 16 * MINUTE);
  const attempt = calls.find((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === U2);
  assert.equal(attempt?.result.error_code, 403);
});

console.log('\nOwner panel & channel management');

await test('owner skips forced join and sees the admin button', async () => {
  const { calls } = await say(OWNER, '/start');
  assert.equal(calls.filter((c) => c.method === 'getChatMember').length, 0);
  const keys = outgoing(calls)[0].params.reply_markup.keyboard.flat().map((k) => k.text);
  assert.ok(keys.includes('👑 پنل مدیریت'));
});

await test('non-owners cannot use admin commands or buttons', async () => {
  includesAll(lastText((await say(U1, '/addchannel @evil_channel')).calls), ['دستور ناشناخته']);
  includesAll(lastText((await say(U1, '/admin')).calls), ['دستور ناشناخته']);
  const calls = await press(U1, 'A|cdy|1');
  assert.equal(answerOf(calls).show_alert, true);
  includesAll(answerOf(calls).text, ['فقط برای مالک']);
  includesAll(lastText(await press(OWNER, 'A|ch')), ['@HIDE_i_SEEK'], 'channel 1 still there');
});

await test('admin panel shows 3/10 channels', async () => {
  includesAll(lastText((await say(OWNER, '👑 پنل مدیریت')).calls), ['پنل مدیریت', '۳ از ۱۰']);
  const calls = await press(OWNER, 'A|ch');
  includesAll(lastText(calls), ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots']);
  const cbs = callbacksOf(calls);
  ['A|cd|1', 'A|cd|2', 'A|cd|3', 'A|ca', 'A|ck'].forEach((c) => assert.ok(cbs.includes(c), c));
});

await test('status check reports admin rights and refreshes titles', async () => {
  const text = lastText(await press(OWNER, 'A|ck'));
  includesAll(text, ['Hide &amp; Seek', 'Nepenthe', 'Wanger Bots', 'ربات ادمین است']);
});

await test('owner adds a channel via the button flow', async () => {
  mock.addChannel('@NewChan4', { title: 'New Channel 4' });
  includesAll(lastText(await press(OWNER, 'A|ca')), ['افزودن کانال']);
  includesAll(lastText((await say(OWNER, '@NewChan4')).calls), ['اضافه شد', 'New Channel 4', '۴ از ۱۰']);
});

await test('new channel is enforced for existing users immediately', async () => {
  const { calls } = await say(U1, '📋 کارهای من');
  assert.deepEqual(inlineButtons(calls).map((b) => b.url).filter(Boolean), ['https://t.me/NewChan4']);
  mock.join('@NewChan4', U1);
  includesAll(answerOf(await press(U1, 'J')).text, ['تأیید']);
});

await test('duplicate channels are rejected (case-insensitive, link form)', async () => {
  includesAll(lastText((await say(OWNER, '/addchannel https://t.me/newchan4')).calls), ['از قبل']);
});

await test('add by t.me link, private id + invite link, and forwarded post', async () => {
  mock.addChannel('@Chan5', { title: 'Chan Five' });
  includesAll(lastText((await say(OWNER, '/addchannel https://t.me/Chan5')).calls), ['Chan Five', '۵ از ۱۰']);

  mock.addChannel('-1009876543210', { title: 'Private VIP', id: -1009876543210 });
  includesAll(lastText((await say(OWNER, '/addchannel -1009876543210 https://t.me/+AbCdEf')).calls), ['Private VIP', 'https://t.me/+AbCdEf']);

  const fwd = mock.addChannel('@FwdChan', { title: 'Forwarded' });
  await press(OWNER, 'A|ca');
  const { calls } = await say(OWNER, 'یک پست کانال', { forward_origin: { type: 'channel', chat: fwd, message_id: 7, date: 0 } });
  includesAll(lastText(calls), ['Forwarded', '۷ از ۱۰']);
});

await test('channel where the bot is not admin: added with warning, users are not locked out', async () => {
  mock.addChannel('@NoAdmin', { title: 'No Admin', admin: false });
  includesAll(lastText((await say(OWNER, '/addchannel @NoAdmin')).calls), ['ادمین نیست']);
  mock.join('@Chan5', U1);
  mock.join('-1009876543210', U1);
  mock.join('@FwdChan', U1);
  const { calls } = await say(U1, '/stats');
  includesAll(lastText(calls), ['آمار شما']);
});

await test('limit of 10 channels is enforced', async () => {
  for (const name of ['@Chan9', '@Chan10']) {
    mock.addChannel(name);
    await say(OWNER, `/addchannel ${name}`);
  }
  mock.addChannel('@Chan11');
  includesAll(lastText((await say(OWNER, '/addchannel @Chan11')).calls), ['حداکثر']);
  const list = await press(OWNER, 'A|ch');
  includesAll(lastText(list), ['۱۰ از ۱۰']);
  assert.ok(callbacksOf(list).includes('A|full') && !callbacksOf(list).includes('A|ca'));
  assert.equal(answerOf(await press(OWNER, 'A|ca')).show_alert, true);
});

await test('remove a channel via button (with confirmation)', async () => {
  includesAll(lastText(await press(OWNER, 'A|cd|10')), ['حذف شود']);
  const calls = await press(OWNER, 'A|cdy|10');
  includesAll(answerOf(calls).text, ['حذف شد']);
  includesAll(lastText(calls), ['۹ از ۱۰']);
});

await test('remove via /delchannel by index and by username (incl. a default channel)', async () => {
  includesAll(lastText((await say(OWNER, '/delchannel 9')).calls), ['۸ از ۱۰']);
  includesAll(lastText((await say(OWNER, '/delchannel @noadmin')).calls), ['۷ از ۱۰']);
  includesAll(lastText((await say(OWNER, '/delchannel @wangerBots')).calls), ['حذف شد', '۶ از ۱۰']);
  includesAll(lastText((await say(OWNER, '/delchannel @unknown_one')).calls), ['پیدا نشد']);
});

await test('a fresh user sees exactly the current 6 channels', async () => {
  const { calls } = await say(U3, '/start');
  const urls = inlineButtons(calls).map((b) => b.url).filter(Boolean);
  assert.equal(urls.length, 6, urls.join(', '));
  assert.ok(!urls.includes('https://t.me/wangerBots'));
  assert.ok(urls.includes('https://t.me/+AbCdEf'));
});

await test('bot stats for the owner', async () => {
  includesAll(lastText(await press(OWNER, 'A|st')), ['کل کاربران: ۴', 'بلاک کرده‌اند: ۱']);
});

await test('broadcast is queued, delivered by cron, and reported to the owner', async () => {
  await press(OWNER, 'A|bc');
  const { calls, messageId: bcMsg } = await say(OWNER, 'سلام به همه! نسخه جدید ربات 🎉');
  assert.ok(callbacksOf(calls).includes(`A|bcy|${bcMsg}`));
  includesAll(lastText(calls), ['کاربر ارسال شود']);
  includesAll(lastText(await press(OWNER, `A|bcy|${bcMsg}`)), ['شروع شد']);
  const sent = await cron(Date.now());
  const copies = sent.filter((c) => c.method === 'copyMessage');
  assert.deepEqual(copies.map((c) => Number(c.params.chat_id)).sort(), [U1, U3, OWNER].sort(), 'blocked U2 skipped');
  assert.ok(copies.every((c) => Number(c.params.message_id) === bcMsg && Number(c.params.from_chat_id) === OWNER));
  includesAll(lastText(sent.filter((c) => Number(c.params.chat_id) === OWNER)), ['تمام شد', 'موفق: ۳']);
});

console.log('\nRobustness');

await test('status page is all green once webhook and cron are running', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(!html.includes('❌'), html);
  includesAll(html, ['همه‌چیز آماده است', 'کانال‌های جوین اجباری: ۶', 'مالک: <code>5557901897</code>']);
});

await test('group messages are ignored', async () => {
  since();
  await post({ update_id: updateId++, message: { message_id: messageId++, from: user(U1), chat: { id: -500, type: 'group' }, date: 0, text: '/start' } });
  assert.equal(since().length, 0);
});

await test('long tasks keep list and search messages under 4096 characters', async () => {
  for (let i = 0; i < 10; i += 1) await say(U1, `بلند ${i} ${'متن طولانی '.repeat(26)}`.slice(0, 300));
  const search = lastText((await say(U1, '/search بلند')).calls);
  const list = lastText((await say(U1, '/list')).calls);
  assert.ok(search.includes('نتایج جستجو') && search.length < 4096, `search length ${search.length}`);
  assert.ok(list.length < 4096, `list length ${list.length}`);
  const card = lastText(await press(U1, 'T|20|p.0'));
  assert.ok(card.length < 4096 && card.includes('متن طولانی'), `card length ${card.length}`);
});

await test('unknown commands and garbage callbacks do not crash', async () => {
  includesAll(lastText((await say(U1, '/whatever')).calls), ['دستور ناشناخته']);
  const calls = await press(U1, 'ZZ|abc|');
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'));
  assert.ok(!/update failed/.test(devLog), devLog);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
if (/update failed|cron job failed|Uncaught/.test(devLog)) {
  console.log('\nWorker errors in log:\n', devLog.split('\n').filter((l) => /fail|error|Uncaught/i.test(l)).join('\n'));
}
await shutdown(failures.length ? 1 : 0);
