// End-to-end test of the Telegram Serverless bot: the real handlers (tgcloud/handlers/*.js) run against a
// local emulation of the platform's `sdk` (test/sdk/: SQLite database + Bot API client) and a mock Bot API.
// Run: node --import ./test/sdk/register.mjs test/e2e.mjs
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
import { setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { d1 } from '../tgcloud/lib/d1.js';
import { getSetting } from '../tgcloud/lib/store.js';
import { DAY, fromLocal, localParts, MINUTE } from '../tgcloud/lib/time.js';

const BOT_ID = 7000000001;
const OWNER = 5557901897;
const U1 = 1001;
const U2 = 1002;
const U3 = 1003;

// ---------- infrastructure ----------

const mock = createMockTelegram({ botId: BOT_ID });
mock.addChannel('@HIDE_i_SEEK', { title: 'Hide & Seek' });
mock.addChannel('@Nepenthw_ir', { title: 'Nepenthe' });
mock.addChannel('@wangerBots', { title: 'Wanger Bots' });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema); // what `npx tgcloud migrate` does on the platform

// Telegram runs modules in a bare V8 isolate: only ECMAScript built-ins, `console` and the `sdk`.
// Remove Node's web and timer globals so any use of them in the bot fails here too.
for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'atob', 'btoa', 'crypto', 'AbortController', 'AbortSignal', 'Buffer', 'performance', 'navigator']) {
  delete globalThis[name];
}

const { default: onMessage } = await import('../tgcloud/handlers/message.js');
const { default: onCallback } = await import('../tgcloud/handlers/callback_query.js');

// Handler crashes are logged (not thrown) by the handlers, so collect console.error output.
const errors = [];
const logError = console.error;
console.error = (...args) => {
  errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  logError(...args);
};
console.warn = () => {}; // expected Bot API failures (e.g. "chat not found") are logged as warnings

// The platform clock is frozen between steps, so a tick (at most one a minute) runs exactly when a test moves time.
let clock = Date.now();
Date.now = () => clock;
function setClock(t) {
  assert.ok(t >= clock, 'the test clock only moves forward');
  clock = t;
}

let updateId = 1;
let messageId = 1;
let mark = 0;
const user = (id) => ({ id, is_bot: false, first_name: `User${id}`, username: `user${id}` });

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}

async function say(uid, text, extra = {}) {
  since();
  const message = { message_id: messageId++, from: user(uid), chat: { id: uid, type: 'private' }, date: Math.floor(clock / 1000), text, ...extra };
  await onMessage(message, { update: { update_id: updateId++, message } });
  return { calls: since(), messageId: message.message_id };
}

async function press(uid, data) {
  since();
  const cq = { id: String(updateId), from: user(uid), chat_instance: '1', data, message: { message_id: 1, chat: { id: uid, type: 'private' }, date: 0, text: '.' } };
  await onCallback(cq, { update: { update_id: updateId++, callback_query: cq } });
  return since();
}

/** Moves the clock and delivers an update the bot otherwise ignores, which runs the tick (reminders, digests, broadcasts). */
async function tickAt(time) {
  setClock(time);
  since();
  const message = { message_id: messageId++, from: user(9999), chat: { id: -500, type: 'group' }, date: Math.floor(clock / 1000), text: 'tick' };
  await onMessage(message, { update: { update_id: updateId++, message } });
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

console.log('\nServerless basics');

await test('the default channels are seeded once, on the first update', async () => {
  await tickAt(NOW);
  const rows = await d1.prepare('SELECT chat FROM channels ORDER BY id').all();
  assert.deepEqual(rows.results.map((r) => r.chat), ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots']);
  await tickAt(NOW);
  assert.equal((await d1.prepare('SELECT COUNT(*) AS n FROM channels').first()).n, 3);
});

await test('the tick runs at most once a minute, on any update', async () => {
  assert.equal(Number(await getSetting(d1, 'last_tick')), NOW);
  await tickAt(NOW + 30_000);
  assert.equal(Number(await getSetting(d1, 'last_tick')), NOW, 'throttled within the minute');
  await tickAt(NOW + 60_000);
  assert.equal(Number(await getSetting(d1, 'last_tick')), NOW + 60_000);
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

console.log('\nReminders & digests (driven by updates)');

await test('#4 reminder fires at its time, with snooze buttons, exactly once', async () => {
  const calls = await tickAt(NOW + 31 * MINUTE);
  const reminders = outgoing(calls, U1).filter((c) => c.params.text.includes('یادآوری'));
  assert.equal(reminders.length, 1, JSON.stringify(reminders.map((r) => r.params.text)));
  includesAll(reminders[0].params.text, ['زنگ به @ali']);
  const cbs = reminders[0].params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('SN|2|10') && cbs.includes('D|2|p.0'));
  const again = await tickAt(NOW + 32 * MINUTE);
  assert.equal(outgoing(again, U1).filter((c) => c.params.text.includes('زنگ به')).length, 0, 'no duplicate');
});

await test('#4 snooze reschedules the reminder', async () => {
  const calls = await press(U1, 'SN|2|10');
  includesAll(answerOf(calls).text, ['به تعویق']);
  includesAll(lastText(calls), ['موکول شد']);
  const fired = await tickAt(Date.now() + 11 * MINUTE);
  assert.ok(outgoing(fired, U1).some((c) => c.params.text.includes('یادآوری') && c.params.text.includes('زنگ به')), 'snoozed reminder fires');
});

await test('a due reminder rides along with the next ordinary message from anyone', async () => {
  await press(U1, 'RM|3|15|p.0');
  setClock(Date.now() + 16 * MINUTE);
  const { calls } = await say(U1, '📊 آمار');
  const reminder = outgoing(calls, U1).filter((c) => c.params.text.includes('یادآوری'));
  assert.equal(reminder.length, 1, 'reminder delivered during this update');
  includesAll(reminder[0].params.text, ['ورزش']);
  assert.ok(outgoing(calls, U1).some((c) => c.params.text.includes('آمار شما')), 'the user still gets the reply');
});

await test('#6 recurring reminder repeats on the next day', async () => {
  // Task 1: reminder 1h before its (moved) due date the day after tomorrow, repeating daily.
  const t1 = await tickAt(NOW + 3 * DAY);
  assert.ok(outgoing(t1, U1).some((c) => c.params.text.includes('یادآوری') && c.params.text.includes('خرید نان')));
  const t2 = await tickAt(NOW + 4 * DAY);
  assert.ok(outgoing(t2, U1).some((c) => c.params.text.includes('یادآوری') && c.params.text.includes('خرید نان')), 'fires again next day');
});

await test('#10 daily digest is sent at the chosen hour, once per day', async () => {
  const day = localParts(NOW + 6 * DAY);
  const at = fromLocal(day.y, day.m, day.d, 8, 5);
  const calls = await tickAt(at);
  const digest = outgoing(calls, U1).filter((c) => c.params.text.includes('خلاصه روزانه'));
  assert.equal(digest.length, 1);
  includesAll(digest[0].params.text, ['صبح بخیر', 'در جریان', 'خرید نان']);
  const again = await tickAt(at + 10 * MINUTE);
  assert.equal(outgoing(again, U1).filter((c) => c.params.text.includes('خلاصه روزانه')).length, 0);
  const early = localParts(NOW + 7 * DAY);
  const before = await tickAt(fromLocal(early.y, early.m, early.d, 7, 30));
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
  const calls = await tickAt(Date.now() + 16 * MINUTE);
  const attempt = calls.find((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === U2);
  assert.equal(attempt?.result.error_code, 403);
});

await test('a reminder backlog is spread over several ticks, each bounded', async () => {
  const first = mock.state.calls.length;
  for (let i = 1; i <= 20; i += 1) {
    const { calls } = await say(U1, `یادآور انبوه ${i}`);
    const num = Number(callbacksOf(calls).find((c) => c.startsWith('D|')).split('|')[1]);
    await press(U1, `RM|${num}|15|p.0`);
  }
  assert.ok(mock.state.calls.length > first);
  const seen = [];
  const perRun = [];
  for (let run = 0; run < 5; run += 1) {
    const calls = await tickAt(Date.now() + 16 * MINUTE);
    const texts = outgoing(calls, U1).map((c) => c.params.text).filter((t) => t.includes('یادآور انبوه'));
    perRun.push(texts.length);
    assert.ok(calls.length <= 45, `run ${run} made ${calls.length} Telegram calls`);
    seen.push(...texts.map((t) => t.match(/یادآور انبوه (\d+)/)[1]));
  }
  assert.ok(perRun[0] <= 10 && perRun[0] > 0, `first run sent ${perRun[0]}`);
  assert.equal(new Set(seen).size, 20, `delivered ${JSON.stringify(perRun)}`);
  assert.equal(seen.length, 20, 'no duplicates');
});

console.log('\nOwner panel & channel management');

await test('owner skips forced join, sees the admin button, and gets the owner command menu', async () => {
  const { calls } = await say(OWNER, '/start');
  assert.equal(calls.filter((c) => c.method === 'getChatMember').length, 0);
  const keys = outgoing(calls)[0].params.reply_markup.keyboard.flat().map((k) => k.text);
  assert.ok(keys.includes('👑 پنل مدیریت'));
  const menus = calls.filter((c) => c.method === 'setMyCommands');
  assert.equal(menus.length, 1, 'default menu was already published by the first user');
  assert.equal(menus[0].params.scope.chat_id, OWNER);
  assert.ok(menus[0].params.commands.some((c) => c.command === 'addchannel'));
  assert.equal((await say(OWNER, '/start')).calls.filter((c) => c.method === 'setMyCommands').length, 0, 'published once');
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
  includesAll(lastText(await press(OWNER, 'A|ck')), ['No Admin</b> — ربات ادمین نیست', 'Hide &amp; Seek</b> — ربات ادمین است']);
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

await test('broadcast: first batch on confirm, the rest on the next tick, then a report to the owner', async () => {
  await press(OWNER, 'A|bc');
  // An album arrives as separate messages; the bot warns once and keeps waiting for a single message.
  const album = { media_group_id: 'g1', text: undefined, photo: [{ file_id: 'p', width: 1, height: 1 }] };
  includesAll(lastText((await say(OWNER, undefined, album)).calls), ['آلبوم']);
  assert.equal(outgoing((await say(OWNER, undefined, album)).calls).length, 0, 'second album item is ignored');
  const { calls, messageId: bcMsg } = await say(OWNER, 'سلام به همه! نسخه جدید ربات 🎉');
  assert.ok(callbacksOf(calls).includes(`A|bcy|${bcMsg}`));
  includesAll(lastText(calls), ['کاربر ارسال شود']);
  mock.state.failOnce.add(U3); // a rate limit mid-broadcast: resume there later, skip nobody, repeat nobody
  const first = await press(OWNER, `A|bcy|${bcMsg}`); // the first batch goes out right away
  includesAll(lastText(first), ['در جریان است']);
  assert.ok(callbacksOf(first).includes('A|bcgo'));
  const second = await tickAt(Date.now() + MINUTE);
  const copies = [...first, ...second].filter((c) => c.method === 'copyMessage');
  const delivered = copies.filter((c) => c.result.ok).map((c) => Number(c.params.chat_id));
  assert.deepEqual(delivered.sort(), [U1, U3, OWNER].sort(), 'each user exactly once; blocked U2 skipped');
  assert.ok(copies.every((c) => Number(c.params.message_id) === bcMsg && Number(c.params.from_chat_id) === OWNER));
  assert.equal(outgoing(first, OWNER).filter((c) => c.params.text.includes('تمام شد')).length, 0, 'not finished after the 429');
  includesAll(lastText(second.filter((c) => Number(c.params.chat_id) === OWNER)), ['تمام شد', 'موفق: ۳']);
});

console.log('\nRobustness');

await test('owner stats show serverless health instead of a status page', async () => {
  includesAll(lastText(await press(OWNER, 'A|st')), ['🩺 <b>وضعیت سرورلس</b>', '✅ تحویل پیام‌ها بدون خطا', 'آخرین پردازش یادآورها', 'دقیقه پیش']);
});

await test('group messages are ignored', async () => {
  since();
  await onMessage({ message_id: messageId++, from: user(U1), chat: { id: -500, type: 'group' }, date: 0, text: '/start' }, {});
  assert.equal(since().length, 0);
});

await test('long tasks keep list and search messages under 4096 characters', async () => {
  for (let i = 0; i < 10; i += 1) await say(U1, `بلند ${i} ${'متن طولانی '.repeat(26)}`.slice(0, 300));
  const found = (await say(U1, '/search بلند')).calls;
  const search = lastText(found);
  const list = lastText((await say(U1, '/list')).calls);
  assert.ok(search.includes('نتایج جستجو') && search.length < 4096, `search length ${search.length}`);
  assert.ok(list.length < 4096, `list length ${list.length}`);
  const card = lastText(await press(U1, callbacksOf(found).find((c) => c.startsWith('T|'))));
  assert.ok(card.length < 4096 && card.includes('متن طولانی'), `card length ${card.length}`);
});

await test('unknown commands and garbage callbacks do not crash', async () => {
  includesAll(lastText((await say(U1, '/whatever')).calls), ['دستور ناشناخته']);
  const calls = await press(U1, 'ZZ|abc|');
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'));
  assert.deepEqual(errors, [], 'no handler or tick errors were logged');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
if (errors.length) console.log('\nErrors logged by handlers:\n' + errors.join('\n'));
await mock.close();
process.exit(failures.length || errors.length ? 1 : 0);
