// End-to-end test: the real handlers (tgcloud/handlers/*.js) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a strict mock Bot API.
// Run: npm test   (the local check; test/cloud/run-tests.mjs runs the scenarios on Telegram Serverless)
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
import { db, rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';

const BOT_ID = 7000000001;
const BOT = 'whisper_test_bot';
const OWNER = 5557901897;

// ---------- infrastructure ----------

const mock = createMockTelegram({ botId: BOT_ID, botUsername: BOT });
for (const name of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) mock.addChat(name, { title: `کانال ${name}` });
for (let i = 1; i <= 9; i += 1) mock.addChat(`extra_chan${i}`);
mock.addChat('not_admin_chan', { admin: false });
mock.addChat('some_person', { type: 'private' });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema); // what `npx tgcloud migrate` does on the platform

// Telegram runs modules in a bare V8 isolate: ECMAScript built-ins, `console` and the `sdk` only.
// Remove Node's web and timer globals so any use of them in the bot fails here too.
for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'atob', 'btoa', 'crypto', 'AbortController', 'AbortSignal', 'Buffer', 'performance', 'navigator', 'Intl']) {
  delete globalThis[name];
}

const { default: onMessage } = await import('../tgcloud/handlers/message.js');
const { default: onCallback } = await import('../tgcloud/handlers/callback_query.js');
const { default: onInline } = await import('../tgcloud/handlers/inline_query.js');
const { default: onChosen } = await import('../tgcloud/handlers/chosen_inline_result.js');

const errors = [];
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
console.warn = () => {}; // expected Bot API failures are logged as warnings

let clock = Date.UTC(2026, 9, 29, 6, 0); // 2026-10-29 09:30 Tehran
Date.now = () => clock;
const advance = (sec) => { clock += sec * 1000; };
const nowSec = () => Math.floor(clock / 1000);

let mark = 0;
let seq = 1;
const results = []; // handler return values, scanned for leaked whisper text at the end

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}

const person = (id, username) => ({ id, is_bot: false, first_name: `کاربر${id % 10000}`, ...(username ? { username } : {}), language_code: 'fa' });
const U = {
  ali: person(710000001, 'ali_t'),
  sara: person(710000002, 'Sara_T'),
  reza: person(710000003, 'reza_t'),
  nima: person(710000004, 'nima_t'),
  mina: person(710000005, 'mina_t'),
  joe: person(710000006, 'joe_t'),
  blocker: person(710000007, 'blk_t'),
  newbie: person(710000008), // no username
  owner: person(OWNER, 'owner_t'),
};
for (const ch of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) {
  for (const u of [U.ali, U.sara, U.reza, U.nima, U.mina, U.blocker, U.newbie]) mock.setMember(ch, u.id, { status: 'member' });
}

function track(r) {
  results.push(r);
  assert.ok(r && Array.isArray(r.trace), `handler returned no trace: ${JSON.stringify(r)}`);
  assert.equal(r.error, undefined, `handler error: ${r && r.error}`);
  return r;
}

async function say(u, text, extra = {}) {
  since();
  mock.state.privateChats.add(u.id);
  const message = { message_id: 50000 + seq++, from: u, chat: { id: u.id, type: 'private', first_name: u.first_name }, date: nowSec(), ...extra };
  if (text !== undefined) message.text = text;
  const cmd = /^\/[A-Za-z0-9_]+/.exec(text || '');
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  const r = track(await onMessage(message, { update: { update_id: seq++, message } }));
  return analyse(r, since(), u.id);
}

async function inline(u, query) {
  since();
  const q = { id: `iq${seq++}`, from: u, query, offset: '', chat_type: 'supergroup' };
  const r = track(await onInline(q, { update: { update_id: seq++, inline_query: q } }));
  const calls = since();
  const ans = calls.find((c) => c.method === 'answerInlineQuery');
  assert.ok(ans, 'answerInlineQuery was not called');
  assert.ok(ans.result.ok, `answerInlineQuery rejected: ${JSON.stringify(ans.result)}`);
  return { r, calls, results: ans.params.results, button: ans.params.button, query };
}

/** The client posts a result; then (unless skipChosen) chosen_inline_result arrives. */
async function post(u, inl, resultId, { skipChosen = false } = {}) {
  const res = inl.results.find((x) => x.id === resultId);
  assert.ok(res, `no result ${resultId} in ${inl.results.map((x) => x.id)}`);
  const inlineId = `AgAAA${seq++}xyz`;
  mock.postInline(inlineId, res);
  if (skipChosen) return { inlineId, res };
  since();
  const c = { result_id: resultId, from: u, query: inl.query, inline_message_id: inlineId };
  const r = track(await onChosen(c, { update: { update_id: seq++, chosen_inline_result: c } }));
  return { inlineId, res, r, calls: since() };
}

const mainResult = (inl) => inl.results.find((x) => x.id.startsWith('w.'));
const widOf = (resultId) => {
  const m = /^w\.(\w{8})$|^q\.(\w{8})\.(\d)$/.exec(resultId);
  return m[1] || `${m[2]}${m[3]}`;
};

async function press(u, data, { inlineId = null, chatId = null } = {}) {
  since();
  const cq = { id: `cb${seq++}`, from: u, chat_instance: '-517', data };
  if (inlineId) cq.inline_message_id = inlineId;
  else {
    const chat = chatId || u.id;
    let mid = lastBotMessage(chat);
    if (!mid) {
      mid = 90000 + seq++;
      mock.seedMessage(chat, mid);
    }
    cq.message = { message_id: mid, from: { id: BOT_ID, is_bot: true, first_name: 'Whisper' }, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' }, date: nowSec(), text: '…' };
  }
  const r = track(await onCallback(cq, { update: { update_id: seq++, callback_query: cq } }));
  const calls = since();
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery');
  const accepted = answers.filter((c) => c.result.ok);
  assert.equal(accepted.length, 1, `answerCallbackQuery accepted ${accepted.length} times for ${data}: ${JSON.stringify(answers.map((c) => c.result))}`);
  assert.ok(answers.length === 1 || (answers.length === 2 && /URL_INVALID/.test(answers[0].result.description)), `retried for ${data} without a url error`);
  return { ...analyse(r, calls, inlineId ? null : chatId || u.id), answer: accepted[0].params };
}

function lastBotMessage(chat) {
  for (let i = mock.state.calls.length - 1; i >= 0; i -= 1) {
    const c = mock.state.calls[i];
    if (c.method === 'sendMessage' && Number(c.params.chat_id) === chat && c.result.ok) return c.result.result.message_id;
  }
  return null;
}

function analyse(r, calls, chat = null) {
  const screens = calls.filter((c) => (c.method === 'sendMessage' || (c.method === 'editMessageText' && !c.params.inline_message_id))
    && (chat === null || Number(c.params.chat_id) === chat));
  const last = screens[screens.length - 1] || null;
  const failed = calls.filter((c) => !c.result.ok && !['getChatMember'].includes(c.method));
  return { r, calls, screens, last, text: last ? last.params.text : '', kb: last && last.params.reply_markup ? last.params.reply_markup.inline_keyboard : [], failed };
}

const buttons = (kb) => (kb || []).flat();
const dataOf = (kb) => buttons(kb).map((b) => b.callback_data).filter(Boolean);
const inlineEdits = (calls, inlineId) => calls.filter((c) => c.method === 'editMessageText' && c.params.inline_message_id === inlineId);
const sentTo = (calls, chat) => calls.filter((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === chat);
const count = (q) => rawDatabase().prepare(q).get().n;
const row = (q, ...p) => rawDatabase().prepare(q).get(...p);
const rows = (q, ...p) => rawDatabase().prepare(q).all(...p);
const SECRETS = new Set(); // whisper texts, which must never leak

// ---------- scenario runner ----------

const outcome = [];
async function scenario(name, fn) {
  try {
    await fn();
    outcome.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push({ name, ok: false, err });
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 6).join('\n   ')}`);
  }
}

// ---------- scenarios ----------

let w1; // ALI → @Sara_T
let w2; // ALI → 1003

await scenario('owner and users start the bot; channels seeded once (3 defaults)', async () => {
  const o = await say(U.owner, '/start');
  assert.match(o.text, /ربات <b>نجوا<\/b>/);
  assert.equal(count('SELECT count(*) AS n FROM channels'), 3);
  assert.deepEqual(rows('SELECT username FROM channels ORDER BY id').map((r) => r.username), ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']);
  for (const u of [U.ali, U.reza]) {
    const r = await say(u, '/start');
    assert.match(r.text, /سلام/);
    assert.ok(dataOf(r.kb).includes('h:s:0'));
  }
  assert.equal(row('SELECT started, active FROM users WHERE user_id = 710000001').started, 1);
});

await scenario('forced join in PM: non-member gets the lock screen with link buttons + "✅ عضو شدم"', async () => {
  const r = await say(U.joe, '/start');
  assert.match(r.text, /عضو این کانال‌ها شو/);
  const urls = buttons(r.kb).map((b) => b.url).filter(Boolean);
  assert.deepEqual(urls, ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
  assert.ok(dataOf(r.kb).includes('j'));
  assert.equal(r.calls.filter((c) => c.method === 'getChatMember').length, 3);
  const again = await press(U.joe, 'j');
  assert.match(again.answer.text, /هنوز عضو/);
  // restricted counts only with is_member; kicked/left never
  mock.setMember('HIDE_i_SEEK', U.joe.id, { status: 'member' });
  mock.setMember('Nepenthw_ir', U.joe.id, { status: 'restricted', is_member: false });
  mock.setMember('wangerBots', U.joe.id, { status: 'kicked' });
  const r2 = await press(U.joe, 'j');
  assert.deepEqual(buttons(r2.kb).map((b) => b.url).filter(Boolean), ['https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
});

await scenario('forced join: "member not found" (never in the channel) counts as not joined, not as a broken channel', async () => {
  const stranger = person(760000001, 'never_member');
  mock.state.unknownUsers.add(stranger.id);
  const inl = await inline(stranger, 'سلام @Sara_T');
  assert.equal(inl.results.length, 0);
  assert.equal(inl.button.start_parameter, 'join');
  assert.equal(sentTo(inl.calls, OWNER).length, 0, 'the owner is not warned about healthy channels');
  assert.ok(inl.calls.filter((c) => c.method === 'getChatMember').every((c) => /member not found/.test(c.result.description)));
});

await scenario('forced join in inline mode: non-member gets NO whispers, only the "join" button', async () => {
  const inl = await inline(U.joe, 'سلام @Sara_T');
  assert.equal(inl.results.length, 0);
  assert.deepEqual(inl.button, { text: '🔒 برای ارسال نجوا اول عضو کانال‌ها شو', start_parameter: 'join' });
  assert.equal(count('SELECT count(*) AS n FROM drafts WHERE sender_id = 710000006'), 0);
  // the button opens /start join → fresh check → still the lock screen
  const pmJoin = await say(U.joe, '/start join');
  assert.match(pmJoin.text, /عضو این کانال‌ها شو/);
  // after joining: "✅ عضو شدم" lets them in, and the positive result is cached
  mock.setMember('Nepenthw_ir', U.joe.id, { status: 'restricted', is_member: true });
  mock.setMember('wangerBots', U.joe.id, { status: 'administrator' });
  const ok = await press(U.joe, 'j');
  assert.match(ok.answer.text, /تأیید شد/);
  assert.match(ok.text, /عضویتت تأیید شد/);
  const inl2 = await inline(U.joe, 'سلام @Sara_T');
  assert.equal(inl2.results.length, 1);
  assert.equal(inl2.calls.filter((c) => c.method === 'getChatMember').length, 0, 'cached: no getChatMember while typing');
});

await scenario('inline whisper to a @username: result, draft, message without content', async () => {
  const inl = await inline(U.ali, 'سلام خوبی؟ @Sara_T');
  SECRETS.add('سلام خوبی؟');
  const res = mainResult(inl);
  assert.ok(res, 'no whisper result');
  assert.match(res.title, /نجوا برای @Sara_T/);
  const msg = res.input_message_content.message_text;
  assert.equal(msg, '🔒 یک نجوا برای @Sara_T');
  assert.deepEqual(res.reply_markup.inline_keyboard, [[{ text: '👁 نمایش نجوا', callback_data: `s:${widOf(res.id)}` }]]);
  assert.equal(inl.results.length, 1, 'just the whisper');
  const posted = await post(U.ali, inl, res.id);
  w1 = { id: widOf(res.id), inlineId: posted.inlineId };
  assert.equal(posted.r.chosen.created, true);
  const w = row('SELECT * FROM whispers WHERE id = ?', w1.id);
  assert.equal(w.body, 'سلام خوبی؟');
  assert.equal(w.inline_id, posted.inlineId);
  assert.deepEqual({ ...row('SELECT rid, runame, label FROM whisper_rcpts WHERE whisper_id = ?', w1.id) }, { rid: null, runame: 'sara_t', label: '@Sara_T' });
  assert.equal(count('SELECT count(*) AS n FROM drafts WHERE sender_id = 710000001'), 0, 'draft finalized and removed');
});

await scenario('typing many inline queries in a row creates ONE draft row (and no whispers)', async () => {
  const before = count('SELECT count(*) AS n FROM whispers');
  const typed = 'راز بزرگ @reza_t';
  const ids = new Set();
  for (let i = 1; i <= typed.length; i += 1) {
    const inl = await inline(U.ali, typed.slice(0, i));
    for (const r of inl.results) if (r.id.startsWith('w.')) ids.add(r.id);
  }
  // the same query again (Telegram repeats it) keeps the same id and writes nothing
  const a = await inline(U.ali, typed);
  const b = await inline(U.ali, typed);
  assert.equal(mainResult(a).id, mainResult(b).id);
  assert.equal(count('SELECT count(*) AS n FROM drafts'), 2, 'one draft per sender (ali + joe)');
  assert.equal(count('SELECT count(*) AS n FROM drafts WHERE sender_id = 710000001'), 1);
  assert.equal(count('SELECT count(*) AS n FROM whispers'), before, 'no whisper until a result is chosen');
  assert.ok(ids.size >= 1);
});

await scenario('snooper presses: "این نجوا مال تو نیست 😏", counted once, "👀 ۱ فضول" on the message', async () => {
  const p = await press(U.nima, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(p.answer.text, 'این نجوا مال تو نیست 😏');
  assert.equal(p.answer.show_alert, true);
  const edits = inlineEdits(p.calls, w1.inlineId);
  assert.equal(edits.length, 1);
  assert.match(edits[0].params.text, /👀 ۱ فضول/);
  const again = await press(U.nima, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(again.answer.text, 'این نجوا مال تو نیست 😏');
  assert.equal(inlineEdits(again.calls, w1.inlineId).length, 0, 'same snooper is not counted twice');
  assert.equal(row('SELECT snoops FROM whispers WHERE id = ?', w1.id).snoops, 1);
});

await scenario('sender opens own whisper: sees the text, nothing marked seen', async () => {
  const p = await press(U.ali, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(p.answer.text, 'سلام خوبی؟');
  assert.equal(p.answer.show_alert, true);
  assert.equal(row('SELECT seen_at FROM whisper_rcpts WHERE whisper_id = ?', w1.id).seen_at, 0);
});

await scenario('recipient (by @username, case-insensitive) opens: text, "👁 دیده شد" edit, read receipt to sender', async () => {
  const p = await press(person(710000002, 'sara_t'), `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(p.answer.text, 'سلام خوبی؟');
  const edit = inlineEdits(p.calls, w1.inlineId)[0];
  assert.ok(edit, 'seen edit');
  assert.match(edit.params.text, /👁 دیده شد/);
  assert.match(edit.params.text, /👀 ۱ فضول/);
  assert.ok(!edit.params.text.includes('سلام'), 'no content in the message');
  const receipt = sentTo(p.calls, U.ali.id);
  assert.equal(receipt.length, 1);
  assert.match(receipt[0].params.text, /@Sara_T نجوای شما را دید/);
  assert.equal(row('SELECT rid FROM whisper_rcpts WHERE whisper_id = ?', w1.id).rid, 710000002, 'claimed by numeric id');
  const again = await press(U.sara, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(again.answer.text, 'سلام خوبی؟');
  assert.equal(sentTo(again.calls, U.ali.id).length, 0, 'receipt only on the first view');
  // after the claim, a different account with that username is not the recipient
  const imposter = await press(person(710009999, 'Sara_T'), `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(imposter.answer.text, 'این نجوا مال تو نیست 😏');
});

await scenario('inline whisper to a numeric id (and Persian digits): only that id can read it', async () => {
  const inl = await inline(U.ali, 'کد ۴۲ برای تو ۷۱۰۰۰۰۰۰۳');
  SECRETS.add('کد ۴۲ برای تو');
  const res = mainResult(inl);
  assert.match(res.title, /@reza_t/, 'known id shown by its username');
  const posted = await post(U.ali, inl, res.id);
  w2 = { id: widOf(res.id), inlineId: posted.inlineId };
  assert.equal(row('SELECT rid, runame FROM whisper_rcpts WHERE whisper_id = ?', w2.id).rid, 710000003);
  const stranger = await press(person(710007777, 'reza_t'), `s:${w2.id}`, { inlineId: w2.inlineId });
  assert.equal(stranger.answer.text, 'این نجوا مال تو نیست 😏', 'username alone is not enough for an id recipient');
  const p = await press(U.reza, `s:${w2.id}`, { inlineId: w2.inlineId });
  assert.equal(p.answer.text, 'کد ۴۲ برای تو');
  // an id the bot never saw: shown as a mention link with the id
  const unknown = await inline(U.ali, 'hey 77777777');
  assert.match(mainResult(unknown).input_message_content.message_text, /<a href="tg:\/\/user\?id=77777777">77777777<\/a>/);
});

await scenario('3 recipients: each of them and the sender can read; seen list grows; a 4th is refused', async () => {
  await say(U.mina, '/start');
  const inl = await inline(U.ali, 'جلسه ساعت ۵ @Sara_T 710000003 @mina_t');
  SECRETS.add('جلسه ساعت ۵');
  const res = mainResult(inl);
  assert.match(res.title, /@Sara_T، @reza_t، @mina_t/);
  const { inlineId } = await post(U.ali, inl, res.id);
  const id = widOf(res.id);
  assert.equal(count(`SELECT count(*) AS n FROM whisper_rcpts WHERE whisper_id = '${id}'`), 3);
  for (const u of [U.sara, U.reza, U.mina, U.ali]) {
    const p = await press(u, `s:${id}`, { inlineId });
    assert.equal(p.answer.text, 'جلسه ساعت ۵', `${u.username} can read`);
  }
  assert.match(mock.state.inline.get(inlineId).text, /👁 دیده شد: @Sara_T، @reza_t، @mina_t/);
  assert.equal((await press(U.nima, `s:${id}`, { inlineId })).answer.text, 'این نجوا مال تو نیست 😏');
  const four = await inline(U.ali, 'زیاد @Sara_T @reza_t @mina_t @nima_t');
  assert.equal(four.results[0].id, 'h.too_many');
  assert.ok(!four.results.some((r) => r.id.startsWith('w.')));
});

await scenario('settings: read receipts off → no receipt; default expiry applies', async () => {
  const s = await say(U.ali, '/settings');
  assert.match(s.text, /رسید خواندن:<\/b> روشن/);
  const off = await press(U.ali, 'st:r');
  assert.match(off.text, /رسید خواندن:<\/b> خاموش/);
  const inl = await inline(U.ali, 'بی‌صدا @Sara_T');
  SECRETS.add('بی‌صدا');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id);
  const p = await press(U.sara, `s:${widOf(mainResult(inl).id)}`, { inlineId });
  assert.equal(p.answer.text, 'بی‌صدا');
  assert.equal(sentTo(p.calls, U.ali.id).length, 0, 'receipts are off');
  await press(U.ali, 'st:r'); // back on
  const exp = await press(U.ali, 'st:e:3600');
  assert.match(exp.text, /انقضای پیش‌فرض:<\/b> ۱ ساعت/);
  const inl2 = await inline(U.ali, 'با انقضای پیش‌فرض @Sara_T');
  SECRETS.add('با انقضای پیش‌فرض');
  assert.match(mainResult(inl2).input_message_content.message_text, /⏳ مهلت باز کردن: ۱ ساعت/);
  const posted = await post(U.ali, inl2, mainResult(inl2).id);
  const w = row('SELECT expires_at, created_at FROM whispers WHERE id = ?', widOf(mainResult(inl2).id));
  assert.equal(w.expires_at - w.created_at, 3600);
  assert.ok(posted);
  await press(U.ali, 'st:e:0');
});

await scenario('one-time whisper ("!"): first open shows it, then burned; second open fails', async () => {
  const inl = await inline(U.ali, '!رمز وای‌فای 9876 @Sara_T');
  SECRETS.add('رمز وای‌فای 9876');
  const res = mainResult(inl);
  assert.match(res.input_message_content.message_text, /🔥 یک‌بار مصرف/);
  const { inlineId } = await post(U.ali, inl, res.id);
  const id = widOf(res.id);
  const first = await press(U.sara, `s:${id}`, { inlineId });
  assert.equal(first.answer.text, 'رمز وای‌فای 9876');
  const w = row('SELECT body, state FROM whispers WHERE id = ?', id);
  assert.equal(w.body, null, 'content deleted from the db');
  assert.equal(w.state, 1);
  assert.match(mock.state.inline.get(inlineId).text, /🔥 <b>نجوا سوزانده شد<\/b>/);
  assert.equal(mock.state.inline.get(inlineId).markup, 'null', 'no button left');
  const second = await press(U.sara, `s:${id}`, { inlineId });
  assert.match(second.answer.text, /سوزانده شده/);
  assert.ok(!second.answer.text.includes('9876'));
  const sender = await press(U.ali, `s:${id}`, { inlineId });
  assert.match(sender.answer.text, /سوزانده شده/);
});

await scenario('one-time with 2 recipients: each sees it once; burned after both', async () => {
  const inl = await inline(U.ali, '!دو نفره @Sara_T @mina_t');
  SECRETS.add('دو نفره');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id);
  const id = widOf(mainResult(inl).id);
  assert.equal((await press(U.sara, `s:${id}`, { inlineId })).answer.text, 'دو نفره');
  assert.match((await press(U.sara, `s:${id}`, { inlineId })).answer.text, /قبلاً دیده‌ای/);
  assert.equal(row('SELECT state FROM whispers WHERE id = ?', id).state, 0, 'not burned until mina saw it');
  assert.equal((await press(U.mina, `s:${id}`, { inlineId })).answer.text, 'دو نفره');
  assert.equal(row('SELECT state FROM whispers WHERE id = ?', id).state, 1);
});

await scenario('expiry ("30m"): opens before, refused after (checked lazily on click), content removed', async () => {
  const inl = await inline(U.ali, 'تا نیم ساعت @Sara_T 30m');
  SECRETS.add('تا نیم ساعت');
  const res = mainResult(inl);
  assert.match(res.input_message_content.message_text, /⏳ مهلت باز کردن: ۳۰ دقیقه/);
  const { inlineId } = await post(U.ali, inl, res.id);
  const id = widOf(res.id);
  advance(29 * 60);
  assert.equal((await press(U.ali, `s:${id}`, { inlineId })).answer.text, 'تا نیم ساعت');
  advance(2 * 60);
  const late = await press(U.sara, `s:${id}`, { inlineId });
  assert.match(late.answer.text, /مهلت باز کردن این نجوا تمام شده/);
  assert.equal(row('SELECT body, state FROM whispers WHERE id = ?', id).state, 2);
  assert.equal(row('SELECT body FROM whispers WHERE id = ?', id).body, null);
  assert.match(mock.state.inline.get(inlineId).text, /⌛️ <b>نجوا منقضی شد<\/b>/);
  const bad = await inline(U.ali, 'x @Sara_T 9d');
  assert.equal(bad.results[0].id, 'h.bad_expiry');
});

await scenario('long whisper (>200 chars): deep link button; recipient reads it in PM, stranger refused', async () => {
  const long = `${'این یک نجوای طولانی است. '.repeat(10)}پایان`;
  assert.ok(long.length > 200 && long.length < 256);
  SECRETS.add(long);
  const inl = await inline(U.ali, `${long} @Sara_T`);
  const res = mainResult(inl);
  const id = widOf(res.id);
  assert.deepEqual(res.reply_markup.inline_keyboard[1], [{ text: '📖 خواندن در ربات', url: `https://t.me/${BOT}?start=w_${id}` }]);
  const { inlineId } = await post(U.ali, inl, res.id);
  const p = await press(U.sara, `s:${id}`, { inlineId });
  assert.equal(p.answer.url, `https://t.me/${BOT}?start=w_${id}`, 'the button opens the bot');
  mock.state.rejectUrlOnce = true; // if Telegram refuses the url, the press is still answered, once more without it
  const fallback = await press(U.sara, `s:${id}`, { inlineId });
  assert.equal(fallback.answer.url, undefined);
  assert.match(fallback.answer.text, /طولانی است/);
  assert.ok(!String(p.answer.text).includes('طولانی است.'));
  const stranger = await say(U.nima, `/start w_${id}`);
  assert.match(stranger.text, /این نجوا مال تو نیست 😏/);
  assert.ok(!stranger.text.includes('پایان'));
  const read = await say(U.sara, `/start w_${id}`);
  assert.ok(read.text.includes(long.replace(/\.$/, '')), 'full text in PM');
  assert.match(read.text, /نجوا از/);
  assert.ok(dataOf(read.kb).includes(`bk:${U.ali.id}`));
  assert.ok(row('SELECT seen_at FROM whisper_rcpts WHERE whisper_id = ?', id).seen_at > 0, 'seen via deep link');
  assert.match(mock.state.inline.get(inlineId).text, /👁 دیده شد/);
  const own = await say(U.ali, `/start w_${id}`);
  assert.ok(own.text.includes('پایان'));
  // reading does not need forced join
  mock.setMember('HIDE_i_SEEK', U.sara.id, { status: 'left' });
  await say(U.sara, '/start'); // refresh nothing: cache still valid, so drop it explicitly
  rawDatabase().prepare('UPDATE users SET join_until = 0 WHERE user_id = 710000002').run();
  const locked = await say(U.sara, '/history');
  assert.match(locked.text, /عضو این کانال‌ها شو/);
  const stillReads = await say(U.sara, `/start w_${id}`);
  assert.ok(stillReads.text.includes('پایان'), 'recipient never blocked from reading');
  mock.setMember('HIDE_i_SEEK', U.sara.id, { status: 'member' });
});

await scenario('history: last sent (full text) and received (hides one-time/burned); details; snoopers list', async () => {
  const sent = await say(U.ali, '/history');
  assert.match(sent.text, /نجواهای ارسالی/);
  assert.ok(sent.text.includes('سلام خوبی؟'), 'sent shows full text');
  assert.match(sent.text, /سوزانده شد/);
  const page2 = dataOf(sent.kb).find((d) => d === 'h:s:1');
  assert.ok(page2 || count('SELECT count(*) AS n FROM whispers WHERE sender_id = 710000001') <= 10);
  const recv = await press(U.sara, 'h:r:0');
  assert.match(recv.text, /نجواهای دریافتی/);
  assert.ok(recv.text.includes('سلام خوبی؟'));
  assert.ok(!recv.text.includes('رمز وای‌فای'), 'one-time content never in history');
  const det = await press(U.ali, `d:${w1.id}`);
  assert.match(det.text, /👁 دید/);
  assert.match(det.text, /فضول‌ها: ۲/, 'nima + the account that reused Sara_T after the claim');
  const sn = await press(U.ali, `n:${w1.id}`);
  assert.match(sn.text, /@nima_t/);
  assert.match(sn.text, /710000004/);
  const notYours = await press(U.sara, `n:${w1.id}`);
  assert.equal(notYours.answer.text, 'این نجوا مال تو نیست 😏');
  const notYours2 = await press(U.nima, `d:${w1.id}`);
  assert.equal(notYours2.answer.text, 'این نجوا مال تو نیست 😏');
  assert.ok(!notYours2.calls.some((c) => String(c.params.text || '').includes('سلام خوبی')));
  // at most 20 kept in history
  for (let i = 0; i < 22; i += 1) {
    const inl = await inline(U.reza, `پیام ${i} @mina_t`);
    await post(U.reza, inl, mainResult(inl).id);
  }
  const h = await say(U.reza, '/history');
  assert.match(h.text, /\(۲۰ مورد آخر\)/);
  const p2 = await press(U.reza, 'h:s:1');
  assert.match(p2.text, /<b>۲۰\.<\/b>/);
  assert.ok(!dataOf(p2.kb).includes('h:s:2'));
});

await scenario('HTML-special characters (& < > ") in whispers and names are escaped everywhere', async () => {
  const nasty = '<b>&amp; "x" </b> a<b & c>d';
  SECRETS.add(nasty);
  for (let i = 0; i < 10; i += 1) {
    const text = `${'&<>'.repeat(60)} ${i}`;
    const inl = await inline(U.mina, `${text} @Sara_T`);
    await post(U.mina, inl, mainResult(inl).id);
  }
  const inl = await inline(U.mina, `${nasty} @Sara_T`);
  const { inlineId } = await post(U.mina, inl, mainResult(inl).id);
  const id = widOf(mainResult(inl).id);
  assert.equal((await press(U.sara, `s:${id}`, { inlineId })).answer.text, nasty, 'alerts are plain text');
  const h = await say(U.mina, '/history');
  assert.ok(h.last && mock.state.calls.find((c) => c.params === h.last.params).result.ok, 'history accepted by Telegram');
  assert.ok(h.text.includes('&lt;b&gt;&amp;amp; &quot;x&quot;'));
  const d = await press(U.mina, `d:${id}`);
  assert.ok(d.text.includes('&lt;b&gt;&amp;amp;'));
  const recv = await press(U.sara, 'h:r:0');
  assert.ok(mock.state.calls.find((c) => c.params === recv.last.params).result.ok, 'received history accepted');
});

await scenario('quick results: text without recipient suggests the 3 most recent recipients', async () => {
  const inl = await inline(U.ali, 'یک پیام سریع');
  SECRETS.add('یک پیام سریع');
  const quick = inl.results.filter((r) => r.id.startsWith('q.'));
  assert.equal(quick.length, 3);
  assert.ok(quick.every((q) => q.title.startsWith('⚡ ارسال سریع به ')));
  assert.equal(inl.results[inl.results.length - 1].id, 'h.format');
  const first = quick[0];
  const { inlineId } = await post(U.ali, inl, first.id);
  const id = widOf(first.id);
  assert.equal(id.length, 9);
  const target = row('SELECT rid, runame FROM whisper_rcpts WHERE whisper_id = ?', id);
  const who = target.runame === 'sara_t' || target.rid === 710000002 ? U.sara : target.runame === 'mina_t' ? U.mina : U.reza;
  assert.equal((await press(who, `s:${id}`, { inlineId })).answer.text, 'یک پیام سریع');
  const nobody = await inline(U.newbie, 'متن بدون گیرنده');
  assert.equal(nobody.results[0].id, 'h.no_recipient');
});

await scenario('block list: blocked sender cannot create whispers to them; unblock restores', async () => {
  const b = await press(U.sara, `bk:${U.ali.id}`);
  assert.match(b.answer.text, /بلاک شد/);
  assert.match(b.text, /لیست بلاک/);
  const blocked = await inline(U.ali, 'سلام دوباره @Sara_T');
  assert.equal(blocked.results[0].id, 'h.blocked');
  assert.ok(!blocked.results.some((r) => r.id.startsWith('w.')));
  const byId = await inline(U.ali, 'سلام دوباره 710000002');
  assert.equal(byId.results[0].id, 'h.blocked');
  const quick = await inline(U.ali, 'فقط متن');
  assert.ok(!quick.results.some((r) => r.title.includes('Sara_T')), 'not offered as quick recipient either');
  const list = await say(U.sara, '/blocks');
  assert.match(list.text, /@ali_t/);
  assert.ok(dataOf(list.kb).includes(`ub:${U.ali.id}`));
  await press(U.sara, 'bl:add');
  const viaInput = await say(U.sara, '@nima_t');
  assert.match(viaInput.text, /بلاک شد/);
  assert.equal(count('SELECT count(*) AS n FROM blocks WHERE user_id = 710000002'), 2);
  const un = await press(U.sara, `ub:${U.ali.id}`);
  assert.match(un.answer.text, /آنبلاک/);
  const ok = await inline(U.ali, 'سلام دوباره @Sara_T');
  assert.ok(mainResult(ok));
  await press(U.sara, `ub:${U.nima.id}`);
});

await scenario('input validation: no recipient, no text, self, the bot, empty query', async () => {
  assert.deepEqual((await inline(U.ali, '')).results.map((r) => r.id), ['h.format', 'h.anon']);
  assert.equal((await inline(U.ali, '@Sara_T')).results[0].id, 'h.no_text');
  assert.equal((await inline(U.ali, 'hi @ali_t')).results[0].id, 'h.self');
  assert.equal((await inline(U.ali, 'hi 710000001')).results[0].id, 'h.self');
  assert.equal((await inline(U.ali, `hi @${BOT}`)).results[0].id, 'h.bot');
  assert.equal((await inline(U.newbie, 'hi there')).results[0].id, 'h.no_recipient');
  const leading = await inline(U.ali, '@Sara_T متن اول گیرنده');
  assert.match(mainResult(leading).title, /@Sara_T/);
});

await scenario('no chosen_inline_result (feedback off): first press finalizes the draft; stale results stay safe', async () => {
  const inl = await inline(U.ali, 'بدون فیدبک @Sara_T');
  SECRETS.add('بدون فیدبک');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id, { skipChosen: true });
  const id = widOf(mainResult(inl).id);
  assert.equal(count(`SELECT count(*) AS n FROM whispers WHERE id = '${id}'`), 0);
  assert.equal((await press(U.sara, `s:${id}`, { inlineId })).answer.text, 'بدون فیدبک');
  assert.equal(row('SELECT inline_id FROM whispers WHERE id = ?', id).inline_id, inlineId);
  // a result from an older keystroke, without feedback: refused instead of showing other content
  const old = await inline(U.ali, 'قدیمی @Sara_T');
  await inline(U.ali, 'قدیمی‌تر شد @Sara_T');
  const stale = await post(U.ali, old, mainResult(old).id, { skipChosen: true });
  const sp = await press(U.sara, `s:${widOf(mainResult(old).id)}`, { inlineId: stale.inlineId });
  assert.match(sp.answer.text, /پیدا نشد/);
  // the same stale result WITH feedback is rebuilt from the query it came with
  const old2 = await inline(U.ali, 'نسخه یک @Sara_T');
  SECRETS.add('نسخه یک');
  await inline(U.ali, 'نسخه دو @Sara_T');
  const p2 = await post(U.ali, old2, mainResult(old2).id);
  assert.equal(p2.r.chosen.created, true);
  assert.equal((await press(U.sara, `s:${widOf(mainResult(old2).id)}`, { inlineId: p2.inlineId })).answer.text, 'نسخه یک');
});

await scenario('channel check fails (bot not admin): channel skipped, owner warned at most once per 3h', async () => {
  mock.state.botAdmin.delete('@wangerbots');
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
  const r = await say(U.mina, '/history');
  assert.match(r.text, /نجواهای ارسالی/, 'user not locked out by a broken channel');
  const warn = sentTo(r.calls, OWNER);
  assert.equal(warn.length, 1);
  assert.match(warn[0].params.text, /@wangerBots/);
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
  const r2 = await say(U.reza, '/history');
  assert.equal(sentTo(r2.calls, OWNER).length, 0, 'no second warning within 3h');
  advance(3 * 3600 + 60);
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
  const r3 = await say(U.reza, '/history');
  assert.equal(sentTo(r3.calls, OWNER).length, 1, 'warned again after 3h');
  mock.state.botAdmin.add('@wangerbots');
});

await scenario('/admin: owner gets the panel; a normal user and admin buttons are refused', async () => {
  const p = await say(U.owner, '/admin');
  assert.match(p.text, /پنل مالک/);
  assert.deepEqual(dataOf(p.kb), ['a:ch', 'a:add', 'a:j', 'a:ban', 'a:unban', 'a:st', 'a:bc']);
  const no = await say(U.ali, '/admin');
  assert.match(no.text, /فقط برای مالک/);
  for (const d of ['a', 'a:ch', 'a:j', 'a:bc', 'a:ban', 'a:rmy:1']) {
    const x = await press(U.ali, d);
    assert.match(x.answer.text, /فقط برای مالک/);
    assert.equal(x.screens.length, 0);
  }
  // an impersonator with the owner's username but another id
  const fake = await say(person(710004242, 'owner_t'), '/admin');
  assert.match(fake.text, /فقط برای مالک|عضو این کانال/);
});

await scenario('channels: list, add (@name and t.me link), 11th refused, remove then re-add', async () => {
  const list = await press(U.owner, 'a:ch');
  assert.match(list.text, /\(۳ از ۱۰\)/);
  assert.equal((list.text.match(/✅ ربات ادمین است/g) || []).length, 3);
  for (let i = 1; i <= 7; i += 1) {
    await press(U.owner, 'a:add');
    const input = i % 2 ? `@extra_chan${i}` : `https://t.me/extra_chan${i}`;
    const r = await say(U.owner, input);
    assert.match(r.text, new RegExp(`extra_chan${i} اضافه شد`));
  }
  assert.equal(count('SELECT count(*) AS n FROM channels'), 10);
  const eleventh = await press(U.owner, 'a:add');
  assert.match(eleventh.answer.text, /حداکثر ۱۰ کانال/);
  assert.equal(eleventh.answer.show_alert, true);
  // even with the state forced, the insert itself refuses an 11th
  rawDatabase().prepare("INSERT INTO user_state (user_id, state, data, updated_at) VALUES (?, 'add_channel', '{}', ?)").run(OWNER, nowSec());
  const forced = await say(U.owner, '@extra_chan8');
  assert.match(forced.text, /حداکثر ۱۰ کانال؛ @extra_chan8 اضافه نشد/);
  assert.equal(count('SELECT count(*) AS n FROM channels'), 10);
  const target = row("SELECT id FROM channels WHERE uname = 'extra_chan3'").id;
  const confirm = await press(U.owner, `a:rm:${target}`);
  assert.ok(dataOf(confirm.kb).includes(`a:rmy:${target}`));
  const removed = await press(U.owner, `a:rmy:${target}`);
  assert.match(removed.text, /extra_chan3 حذف شد/);
  assert.equal(count('SELECT count(*) AS n FROM channels'), 9);
  await press(U.owner, 'a:add');
  const readd = await say(U.owner, 't.me/extra_chan3');
  assert.match(readd.text, /extra_chan3 اضافه شد/);
  assert.equal(count('SELECT count(*) AS n FROM channels'), 10);
  // refusals: not admin, not found, private link, a user instead of a channel
  rawDatabase().prepare("DELETE FROM channels WHERE uname = 'extra_chan7'").run();
  await press(U.owner, 'a:add');
  assert.match((await say(U.owner, '@not_admin_chan')).text, /ادمین نیست/);
  assert.match((await say(U.owner, '@no_such_chan')).text, /پیدا نشد/);
  assert.match((await say(U.owner, 'https://t.me/+AbCdEf')).text, /معتبر نیست/);
  assert.match((await say(U.owner, '@some_person')).text, /کانال یا گروه نیست/);
  assert.match((await say(U.owner, '@HIDE_i_SEEK')).text, /از قبل در لیست است/);
  // a new channel invalidates cached memberships: ali isn't in extra channels
  const lockout = await inline(U.ali, 'بعد از کانال جدید @Sara_T');
  assert.equal(lockout.results.length, 0);
  assert.equal(lockout.button.start_parameter, 'join');
  rawDatabase().prepare("DELETE FROM channels WHERE uname LIKE 'extra_chan%'").run();
  rawDatabase().prepare("UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'chv'").run();
});

await scenario('forced join on/off toggle', async () => {
  const off = await press(U.owner, 'a:j');
  assert.match(off.text, /عضویت اجباری: خاموش/);
  const outsider = person(740000001, 'outsider');
  const inl = await inline(outsider, 'سلام @Sara_T');
  assert.ok(mainResult(inl), 'join off: anyone may send');
  const on = await press(U.owner, 'a:j');
  assert.match(on.text, /عضویت اجباری: روشن/);
  const inl2 = await inline(outsider, 'سلام @Sara_T');
  assert.equal(inl2.results.length, 0);
});

await scenario('ban / unban by numeric id (owner only; banned can still read)', async () => {
  await press(U.owner, 'a:ban');
  const r = await say(U.owner, '710000004');
  assert.match(r.text, /710000004<\/code> \(@nima_t\) بن شد/);
  const inl = await inline(U.nima, 'سلام @Sara_T');
  assert.equal(inl.results.length, 0);
  assert.equal(inl.button.start_parameter, 'banned');
  assert.match((await say(U.nima, '/start')).text, /مسدود شده‌اید/);
  const inlSara = await inline(U.sara, 'برای نیما @nima_t');
  SECRETS.add('برای نیما');
  const { inlineId } = await post(U.sara, inlSara, mainResult(inlSara).id);
  assert.equal((await press(U.nima, `s:${widOf(mainResult(inlSara).id)}`, { inlineId })).answer.text, 'برای نیما', 'banned users can still read');
  await press(U.owner, 'a:ban');
  assert.match((await say(U.owner, String(OWNER))).text, /مالک را نمی‌شود بن کرد/);
  const usersBefore = row("SELECT value FROM kv WHERE key = 'n_users'").value;
  await press(U.owner, 'a:ban');
  await say(U.owner, '123456789');
  assert.equal(row('SELECT banned, first_seen FROM users WHERE user_id = 123456789').banned, 1);
  assert.equal(row("SELECT value FROM kv WHERE key = 'n_users'").value, usersBefore, 'placeholder is not a user');
  await press(U.owner, 'a:unban');
  assert.match((await say(U.owner, '710000004')).text, /آنبن شد/);
  assert.ok(mainResult(await inline(U.nima, 'دوباره آزاد @Sara_T')));
});

await scenario('stats: counts only, and they match the tables', async () => {
  const s = await press(U.owner, 'a:st');
  const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const users = count('SELECT count(*) AS n FROM users WHERE first_seen > 0');
  const active = count('SELECT count(*) AS n FROM users WHERE started = 1 AND active = 1');
  const whispers = count('SELECT count(*) AS n FROM whispers');
  assert.ok(s.text.includes(`کل کاربران: ${fa(users)}`), s.text);
  assert.ok(s.text.includes(`کاربران فعال (ربات را استارت کرده‌اند و بلاکش نکرده‌اند): ${fa(active)}`), s.text);
  assert.ok(s.text.includes(`کل نجواها: ${fa(whispers)}`), s.text);
  assert.ok(s.text.includes('بن‌شده: ۱'), s.text);
  assert.match(s.text, /نجواهای امروز: [۱-۹]/);
  for (const secret of SECRETS) assert.ok(!s.text.includes(secret), 'no whisper content in stats');
});

await scenario('broadcast: preview + confirm, batches of 25, 403 → inactive, 429 → wait, opportunistic, final report', async () => {
  // 40 more reachable users, one who blocked the bot and one who gets a 429
  const filler = [];
  for (let i = 0; i < 40; i += 1) filler.push(person(720000000 + i, `fill${i}`));
  for (const u of [...filler, U.blocker, U.joe]) await say(u, '/start');
  mock.state.blocked.add(U.blocker.id);
  mock.state.rateLimitOnce.set(720000010, 3);
  rawDatabase().prepare('UPDATE users SET banned = 1 WHERE user_id = 720000039').run(); // banned: excluded
  const reachable = rows('SELECT user_id FROM users WHERE started = 1 AND active = 1 AND banned = 0 AND user_id != ?', OWNER).map((r) => r.user_id);
  const ask = await press(U.owner, 'a:bc');
  assert.match(ask.text, /پیامی را که می‌خواهی/);
  const photo = await say(U.owner, undefined, { photo: [{ file_id: 'AgACphoto', file_unique_id: 'u1', width: 90, height: 90 }], caption: '<b>خبر</b> مهم', caption_entities: [] });
  const preview = photo.calls.find((c) => c.method === 'copyMessage');
  assert.equal(preview.params.chat_id, OWNER, 'preview goes to the owner');
  assert.match(photo.text, /پیش‌نمایش پیام سراسری/);
  const bcId = Number(dataOf(photo.kb)[0].split(':')[2]);
  // a second draft, made before the first one starts
  await press(U.owner, 'a:bc');
  const second = await say(U.owner, 'پیام دوم');
  const secondId = Number(dataOf(second.kb)[0].split(':')[2]);
  assert.ok(secondId > bcId);
  const go = await press(U.owner, `a:bcy:${bcId}`);
  const copies1 = go.calls.filter((c) => c.method === 'copyMessage');
  assert.ok(copies1.length <= 25, `first batch ${copies1.length}`);
  assert.match(go.text, /ارسال‌شده: /);
  assert.ok(dataOf(go.kb).includes(`a:bcc:${bcId}`) && dataOf(go.kb).includes(`a:bcs:${bcId}`));
  // the 429 stopped the batch at that user
  const b1 = row('SELECT * FROM broadcasts WHERE id = ?', bcId);
  assert.ok(b1.next_at > nowSec(), '429 sets a wait');
  assert.ok(b1.last_user < 720000010);
  const tooSoon = await press(U.owner, `a:bcc:${bcId}`);
  assert.match(tooSoon.answer.text, /محدودیت تلگرام/);
  // only one at a time: neither the second draft nor a new one can start now
  const refused = await press(U.owner, `a:bcy:${secondId}`);
  assert.match(refused.answer.text, /فقط یکی در هر زمان/);
  const noNew = await press(U.owner, 'a:bc');
  assert.match(noNew.answer.text, /فقط یکی در هر زمان/);
  // another update after the wait sends a small chunk on the side
  advance(4);
  const side = await inline(U.ali, 'در حین ارسال @Sara_T');
  assert.equal(side.calls.filter((c) => c.method === 'copyMessage').length, 5, 'opportunistic chunk of 5');
  // continue until done
  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await press(U.owner, `a:bcc:${bcId}`);
    if (row('SELECT status FROM broadcasts WHERE id = ?', bcId).status === 'done') break;
  }
  const b = row('SELECT * FROM broadcasts WHERE id = ?', bcId);
  assert.equal(b.status, 'done');
  const report = sentTo(last.calls, OWNER).find((c) => /گزارش نهایی/.test(c.params.text));
  assert.ok(report, 'final report');
  assert.equal(row("SELECT value FROM kv WHERE key = 'bc'").value, null);
  // every reachable user got exactly one copy; the owner and the banned user none
  const copies = mock.state.copied.filter((c) => c.from_chat_id === OWNER && c.message_id === b.message_id).map((c) => c.chat_id);
  assert.equal(copies.filter((id) => id === OWNER).length, 1, 'the owner gets only the preview');
  const got = copies.filter((id) => id !== OWNER);
  const expected = reachable.filter((id) => id !== U.blocker.id).sort((x, y) => x - y);
  assert.deepEqual([...got].sort((x, y) => x - y), expected);
  assert.equal(new Set(got).size, got.length, 'no duplicates');
  assert.ok(!got.includes(720000039) && !got.includes(OWNER));
  assert.equal(b.blocked, 1);
  assert.equal(b.sent, expected.length);
  assert.equal(row('SELECT active FROM users WHERE user_id = ?', U.blocker.id).active, 0, '403 → inactive, not retried');
  // the second one can start now; then stop it
  const go2 = await press(U.owner, `a:bcy:${secondId}`);
  assert.match(go2.text, /پیام سراسری #/);
  const stop = await press(U.owner, `a:bcs:${secondId}`);
  assert.match(stop.answer.text, /متوقف شد/);
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', secondId).status, 'stopped');
  rawDatabase().prepare('UPDATE users SET banned = 0 WHERE user_id = 720000039').run();
  // cancel a draft
  await press(U.owner, 'a:bc');
  const third = await say(U.owner, 'سوم');
  const thirdId = Number(dataOf(third.kb)[0].split(':')[2]);
  assert.match((await press(U.owner, `a:bcn:${thirdId}`)).text, /لغو شد/);
});


// ---------- anonymous chat ----------

let anonCode; // sara's link code
let anonRef; // the anonymous message ali sent sara
const ANON_TEXT = 'سلام، حدس بزن کی‌ام 😄';
const linkRe = new RegExp(`https://t\\.me/${BOT}\\?start=a_([0-9A-Za-z]{10})`);
/**
 * Nothing that identifies `who` in what `chat` can see: texts, captions, buttons, callback_data.
 * (copyMessage's from_chat_id is part of the request only — a copy carries no link to the original.)
 */
function noTrace(calls, chat, who) {
  const toChat = calls.filter((c) => Number(c.params.chat_id) === chat);
  const blob = JSON.stringify(toChat.map(({ params: { from_chat_id, ...visible } }) => visible));
  for (const s of [String(who.id), who.username, who.first_name].filter(Boolean)) {
    assert.ok(!blob.includes(s), `"${s}" leaked to ${chat}: ${blob.slice(0, 300)}`);
  }
}
function dbHas(text) {
  for (const { name } of rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    if (JSON.stringify(rows(`SELECT * FROM "${name}"`)).includes(text)) return name;
  }
  return null;
}

await scenario('anonymous link: /link and the menu button give a personal link; a new link revokes the old', async () => {
  const r = await say(U.sara, '/link');
  assert.match(r.text, /لینک پیام ناشناس تو/);
  const m = linkRe.exec(r.text);
  assert.ok(m, r.text);
  assert.equal(row('SELECT anon_code FROM users WHERE user_id = ?', U.sara.id).anon_code, m[1]);
  assert.ok(buttons(r.kb).some((b) => b.url && b.url.startsWith('https://t.me/share/url?url=https%3A%2F%2Ft.me%2F')), 'share button');
  const again = await press(U.sara, 'an');
  assert.equal(linkRe.exec(again.text)[1], m[1], 'the same link until renewed');
  const renewed = await press(U.sara, 'an:new');
  anonCode = linkRe.exec(renewed.text)[1];
  assert.notEqual(anonCode, m[1]);
  assert.match(renewed.text, /لینک قبلی دیگر کار نمی‌کند/);
  const old = await say(U.ali, `/start a_${m[1]}`);
  assert.match(old.text, /معتبر نیست/);
  assert.match((await say(U.ali, '/start a_short')).text, /معتبر نیست/);
  const menu = await say(U.sara, '/start');
  assert.ok(dataOf(menu.kb).includes('an'), 'main menu has the link button');
});

await scenario('anonymous message: relayed without the sender\'s identity, text and media, never stored', async () => {
  const open = await say(U.ali, `/start a_${anonCode}`);
  assert.match(open.text, new RegExp(`پیامت را برای <b>${U.sara.first_name}</b> بفرست`));
  assert.equal(row('SELECT state FROM user_state WHERE user_id = ?', U.ali.id).state, 'anon_send');
  const sent = await say(U.ali, ANON_TEXT);
  const delivered = sentTo(sent.calls, U.sara.id);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].params.text, `📨 <b>پیام ناشناس جدید</b>\n\n${ANON_TEXT}`);
  const kb = delivered[0].params.reply_markup.inline_keyboard[0];
  assert.deepEqual(kb.map((b) => b.text), ['↩️ پاسخ', '🚫 بلاک']);
  anonRef = kb[0].callback_data.slice(3);
  assert.match(anonRef, /^[0-9A-Za-z]{10}$/);
  assert.equal(kb[1].callback_data, `ab:${anonRef}`);
  noTrace(sent.calls, U.sara.id, U.ali);
  assert.match(sent.text, /پیامت ناشناس فرستاده شد/);
  assert.ok(dataOf(sent.kb).includes(`as:${anonCode}`));
  assert.deepEqual({ ...row('SELECT from_id, to_id, anon FROM anon_msgs WHERE id = ?', anonRef) }, { from_id: U.ali.id, to_id: U.sara.id, anon: 1 });
  assert.equal(row('SELECT anon_count FROM users WHERE user_id = ?', U.sara.id).anon_count, 1);
  assert.equal(dbHas(ANON_TEXT), null, 'content is not stored anywhere');
  assert.equal(row('SELECT count(*) AS n FROM user_state WHERE user_id = ?', U.ali.id).n, 0, 'state cleared');
  // "✍️ پیام دیگر" + a photo: a header, then an exact copy with the buttons
  await press(U.ali, `as:${anonCode}`);
  const photo = await say(U.ali, undefined, { photo: [{ file_id: 'AgACanon', file_unique_id: 'u9', width: 90, height: 90 }], caption: 'این عکس منه؟' });
  const head = sentTo(photo.calls, U.sara.id);
  assert.equal(head[0].params.text, '📨 <b>پیام ناشناس جدید</b> 👇');
  const copy = photo.calls.find((c) => c.method === 'copyMessage' && Number(c.params.chat_id) === U.sara.id);
  assert.ok(copy && copy.result.ok);
  assert.match(copy.params.reply_markup.inline_keyboard[0][0].callback_data, /^ar:[0-9A-Za-z]{10}$/);
  noTrace(photo.calls, U.sara.id, U.ali);
  // the trace never shows the anonymous text either
  assert.ok(!JSON.stringify(sent.r).includes(ANON_TEXT));
});

await scenario('reply both ways: the owner answers, the visitor answers back and stays anonymous', async () => {
  const p = await press(U.sara, `ar:${anonRef}`);
  assert.match(p.text, /پاسخت را بفرست/);
  assert.equal(p.calls.filter((c) => c.method === 'editMessageText').length, 0, 'the anonymous message is never replaced');
  const aliOriginal = row('SELECT from_msg FROM anon_msgs WHERE id = ?', anonRef).from_msg;
  const r = await say(U.sara, 'تو کی هستی؟');
  const toAli = sentTo(r.calls, U.ali.id)[0];
  assert.equal(toAli.params.text, '↩️ <b>پاسخ @Sara_T</b>\n\nتو کی هستی؟');
  assert.equal(toAli.params.reply_parameters.message_id, aliOriginal, 'threads under the visitor\'s own message');
  const ref2 = toAli.params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  assert.equal(row('SELECT anon FROM anon_msgs WHERE id = ?', ref2).anon, 0);
  const back = await press(U.ali, `ar:${ref2}`);
  assert.match(back.text, /ناشناس می‌رسد/);
  const r2 = await say(U.ali, 'نمی‌گم 😉');
  const toSara = sentTo(r2.calls, U.sara.id)[0];
  assert.equal(toSara.params.text, '📨 <b>پیام ناشناس جدید</b>\n\nنمی‌گم 😉');
  assert.ok(toSara.params.reply_parameters, 'threads under sara\'s reply');
  noTrace(r2.calls, U.sara.id, U.ali);
  const stranger = await press(U.nima, `ar:${anonRef}`);
  assert.match(stranger.answer.text, /قابل پاسخ نیست/);
  const strangerBlock = await press(U.nima, `ab:${anonRef}`);
  assert.match(strangerBlock.answer.text, /در دسترس نیست/);
});

await scenario('block an anonymous sender without learning who; unblock from the message or the list', async () => {
  const deliveredId = sentTo(mock.state.calls, U.sara.id).find((c) => c.params.reply_markup && JSON.stringify(c.params.reply_markup).includes(`ab:${anonRef}`)).result.result.message_id;
  since();
  const cq = { id: `cb${seq++}`, from: U.sara, chat_instance: '1', data: `ab:${anonRef}`, message: { message_id: deliveredId, chat: { id: U.sara.id, type: 'private' }, date: nowSec() } };
  track(await onCallback(cq, {}));
  const calls = since();
  assert.match(calls.find((c) => c.method === 'answerCallbackQuery').params.text, /بلاک شد/);
  const markup = calls.find((c) => c.method === 'editMessageReplyMarkup');
  assert.deepEqual(markup.params.reply_markup.inline_keyboard[0].map((b) => b.text), ['↩️ پاسخ', '🔓 آنبلاک']);
  assert.ok(markup.result.ok);
  const refused = await say(U.ali, `/start a_${anonCode}`);
  assert.match(refused.text, /پیام‌های تو را نمی‌پذیرد/);
  const list = await say(U.sara, '/blocks');
  assert.match(list.text, /فرستنده‌های ناشناس بلاک‌شده/);
  noTrace(list.calls, U.sara.id, U.ali);
  const uba = dataOf(list.kb).find((d) => d.startsWith('uba:'));
  assert.match(uba, /^uba:[0-9A-Za-z]{10}$/);
  const un = await press(U.sara, uba);
  assert.match(un.answer.text, /آنبلاک شد/);
  assert.ok(!/ناشناس —/.test(un.text));
  assert.match((await say(U.ali, `/start a_${anonCode}`)).text, /پیامت را برای/);
  await say(U.ali, '/cancel');
  // the button toggles too
  since();
  track(await onCallback({ ...cq, id: `cb${seq++}` }, {}));
  track(await onCallback({ ...cq, id: `cb${seq++}` }, {}));
  assert.equal(count(`SELECT count(*) AS n FROM anon_blocks WHERE owner_id = ${U.sara.id}`), 0, 'block + unblock');
});

await scenario('anonymous chat rules: own link, link off, join kept, banned, rate limit, 403, uncopyable', async () => {
  assert.match((await say(U.sara, `/start a_${anonCode}`)).text, /این لینک خودت است/);
  await press(U.sara, 'an:t');
  assert.equal(row('SELECT anon_on FROM users WHERE user_id = ?', U.sara.id).anon_on, 0);
  assert.match((await say(U.ali, `/start a_${anonCode}`)).text, /معتبر نیست یا صاحبش دریافت پیام را خاموش کرده/);
  assert.deepEqual((await inline(U.sara, '')).results.map((r) => r.id), ['h.format'], 'no share result while off');
  await press(U.sara, 'an:t');
  // a non-member: the join screen first, the target kept, then straight to writing
  const out = person(750000001, 'anon_out');
  const lock = await say(out, `/start a_${anonCode}`);
  assert.match(lock.text, /عضو این کانال‌ها شو/);
  for (const ch of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) mock.setMember(ch, out.id, { status: 'member' });
  const joined = await press(out, 'j');
  assert.match(joined.text, /پیامت را برای/);
  const viaJoin = await say(out, 'از طرف یک عضو جدید');
  assert.equal(sentTo(viaJoin.calls, U.sara.id).length, 1);
  noTrace(viaJoin.calls, U.sara.id, out);
  // banned users can't write
  rawDatabase().prepare('UPDATE users SET banned = 1 WHERE user_id = ?').run(U.newbie.id);
  assert.match((await say(U.newbie, `/start a_${anonCode}`)).text, /مسدود شده‌اید/);
  rawDatabase().prepare('UPDATE users SET banned = 0 WHERE user_id = ?').run(U.newbie.id);
  // 30 per hour
  const ins = rawDatabase().prepare('INSERT INTO anon_msgs (id, from_id, to_id, anon, created_at) VALUES (?, ?, ?, 1, ?)');
  for (let i = 0; i < 30; i += 1) ins.run(`rate${String(i).padStart(6, '0')}`, U.reza.id, U.mina.id, nowSec() - 60);
  await say(U.reza, `/start a_${anonCode}`);
  assert.match((await say(U.reza, 'پیام سی‌ویکم')).text, /حداکثر ۳۰ پیام/);
  rawDatabase().prepare("DELETE FROM anon_msgs WHERE id LIKE 'rate%'").run();
  assert.equal(sentTo((await say(U.reza, 'حالا رسید')).calls, U.sara.id).length, 1, 'state kept after the limit');
  // the recipient blocked the bot: 403 → inactive, and the sender is told
  rawDatabase().prepare("UPDATE users SET anon_code = 'BLOCKERxyz' WHERE user_id = ?").run(U.blocker.id);
  rawDatabase().prepare('UPDATE users SET active = 1 WHERE user_id = ?').run(U.blocker.id);
  await say(U.mina, '/start a_BLOCKERxyz');
  const r403 = await say(U.mina, 'سلام');
  assert.match(r403.text, /گیرنده ربات را بلاک کرده/);
  assert.equal(row('SELECT active FROM users WHERE user_id = ?', U.blocker.id).active, 0);
  // a message that can't be copied: refused, the header removed, and the user may try again
  await say(U.mina, `/start a_${anonCode}`);
  const mid = 50000 + seq;
  mock.state.uncopyable.add(`${U.mina.id}:${mid}`);
  const bad = await say(U.mina, undefined, { dice: { emoji: '🎲', value: 3 } });
  assert.match(bad.text, /این نوع پیام را نمی‌شود فرستاد/);
  assert.equal(mock.state.deleted.length, 1, 'dangling header deleted');
  assert.equal(sentTo((await say(U.mina, 'پس متن')).calls, U.sara.id).length, 1);
});

await scenario('inline: an empty query also offers the anonymous link to share; stats count it', async () => {
  const inl = await inline(U.sara, '');
  const share = inl.results.find((r) => r.id === 'h.anon');
  assert.equal(share.reply_markup.inline_keyboard[0][0].url, `https://t.me/${BOT}?start=a_${anonCode}`);
  assert.ok(!share.input_message_content.message_text.includes('Sara'));
  const created = inline(U.newbie, '');
  const r = await created;
  assert.ok(r.results.some((x) => x.id === 'h.anon'), 'a link is made on first use');
  assert.match(row('SELECT anon_code FROM users WHERE user_id = ?', U.newbie.id).anon_code, /^[0-9A-Za-z]{10}$/);
  const st = await press(U.owner, 'a:st');
  assert.match(st.text, /پیام‌های ناشناس: [۱-۹]/);
  assert.equal(dbHas(ANON_TEXT), null);
});

await scenario('lazy cleanup: unsent drafts older than 24h are deleted in batches of 20', async () => {
  for (let i = 0; i <= 100; i += 1) for (const ch of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) mock.setMember(ch, 730000000 + i, { status: 'member' });
  for (let i = 0; i < 25; i += 1) await inline(person(730000000 + i, `d${i}`), `پیش‌نویس ${i} @Sara_T`);
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
  advance(25 * 3600);
  const fresh = person(730000100, 'freshd');
  await inline(fresh, 'تازه @Sara_T'); // a recent draft, must survive
  const stale = count(`SELECT count(*) AS n FROM drafts WHERE updated_at < ${nowSec() - 86400}`);
  assert.ok(stale >= 25);
  rawDatabase().prepare('UPDATE anon_msgs SET created_at = ? WHERE id = ?').run(nowSec() - 31 * 86400, anonRef);
  const r1 = await say(U.ali, '/help');
  assert.equal(r1.r.gc.drafts, 20);
  assert.equal(r1.r.gc.anon, 1, 'anonymous-chat refs older than 30 days');
  const r2 = await say(U.ali, '/help');
  assert.equal(r2.r.gc, undefined, 'at most once per 10 minutes');
  advance(11 * 60);
  const r3 = await say(U.ali, '/help');
  assert.equal(r3.r.gc.drafts, stale - 20);
  assert.equal(count('SELECT count(*) AS n FROM drafts WHERE sender_id = 730000100'), 1);
});

await scenario('groups are ignored; errors never reach users raw; every press is answered', async () => {
  const g = track(await onMessage({ message_id: 1, from: U.ali, chat: { id: -100555, type: 'supergroup', title: 'g' }, date: nowSec(), text: '/start' }, {}));
  assert.equal(g.trace.length, 0);
  // a database failure in the middle of a button press
  const orig = db.get;
  db.get = async () => {
    db.get = orig;
    throw new Error('D1_ERROR: simulated outage');
  };
  since();
  const cq = { id: `cb${seq++}`, from: U.ali, chat_instance: '1', data: 'st', message: { message_id: lastBotMessage(U.ali.id), chat: { id: U.ali.id, type: 'private' }, date: nowSec() } };
  const r = await onCallback(cq, {});
  const calls = since();
  const ans = calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(ans.length, 1);
  assert.match(ans[0].params.text, /خطایی پیش آمد/);
  assert.ok(!JSON.stringify(calls.map((c) => c.params)).includes('simulated outage'), 'no raw error to the user');
  assert.match(r.error, /simulated outage/, 'but the trace (tgcloud run output) has it');
  errors.length = 0; // that console.error was expected
  // an unknown whisper id / an old button
  const missing = await press(U.sara, 's:ZZZZZZZZ', { inlineId: 'AgAAAnope' });
  assert.match(missing.answer.text, /پیدا نشد/);
  const old = await press(U.sara, 'zz:1');
  assert.match(old.answer.text, /قدیمی/);
});

await scenario('security: whisper text never in callback_data, posted messages, or handler traces', async () => {
  const leaks = [];
  for (const c of mock.state.calls) {
    const kb = JSON.stringify((c.params.reply_markup) || (c.params.results || []).map((x) => x.reply_markup));
    const posted = [
      ...(c.params.results || []).map((x) => x.input_message_content.message_text),
      c.params.inline_message_id ? c.params.text : '',
    ].join('\n');
    for (const s of SECRETS) {
      if (kb.includes(s)) leaks.push(`${c.method} keyboard has "${s.slice(0, 20)}"`);
      if (posted.includes(s)) leaks.push(`${c.method} posted message has "${s.slice(0, 20)}"`);
    }
    for (const b of buttons(c.params.reply_markup && c.params.reply_markup.inline_keyboard)) {
      if (b.callback_data && !/^[\x20-\x7e]{1,64}$/.test(b.callback_data)) leaks.push(`bad callback_data ${b.callback_data}`);
    }
  }
  const traces = JSON.stringify(results);
  for (const s of SECRETS) if (traces.includes(s)) leaks.push(`trace has "${s.slice(0, 20)}"`);
  assert.deepEqual(leaks, []);
  // expected refusals: unknown chats/users, 403/429 in broadcasts, and "not modified" when a screen is re-shown unchanged
  const rejected = mock.state.calls.filter((c) => !c.result.ok && !['getChatMember', 'copyMessage', 'sendMessage', 'answerCallbackQuery', 'getChat'].includes(c.method)
    && !/message is not modified/.test(c.result.description));
  assert.deepEqual(rejected.map((c) => `${c.method}: ${c.result.description}`), [], 'Telegram rejected a call');
  const badSends = mock.state.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'copyMessage') && !c.result.ok && c.result.error_code === 400
    && !/can't be copied/.test(c.result.description)); // the uncopyable-message test
  assert.deepEqual(badSends.map((c) => `${c.method}: ${c.result.description}`), []);
});

await scenario('no unexpected console.error during the whole run', async () => {
  assert.deepEqual(errors, []);
});

// ---------- summary ----------

await mock.close();
const failed = outcome.filter((o) => !o.ok);
console.log(`\n${outcome.length - failed.length}/${outcome.length} scenarios passed; ${mock.state.calls.length} Bot API calls`);
process.exit(failed.length ? 1 : 0);
