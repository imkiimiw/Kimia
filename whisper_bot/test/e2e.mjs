// End-to-end test: the real handlers and endpoints (tgcloud/) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a strict mock Bot API.
// Run: npm test   (the local check; test/cloud/run-tests.mjs runs the scenarios on Telegram Serverless)
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
import { db, rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { isOffensive, normalize } from '../tgcloud/lib/filter.js';

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
const { default: cardDataEndpoint } = await import('../tgcloud/endpoints/cardData.js');
const { default: cardSendEndpoint } = await import('../tgcloud/endpoints/cardSend.js');

const errors = [];
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
console.warn = () => {}; // expected Bot API failures are logged as warnings

let clock = Date.UTC(2026, 9, 29, 6, 0); // 2026-10-29 09:30 Tehran
Date.now = () => clock;
const advance = (sec) => { clock += sec * 1000; };
const nowSec = () => Math.floor(clock / 1000);

let mark = 0;
let seq = 1;
const results = []; // handler return values, scanned for leaked content at the end

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}

const person = (id, username, lang = 'fa', name = null) => ({ id, is_bot: false, first_name: name || `کاربر${id % 10000}`, ...(username ? { username } : {}), language_code: lang });
const U = {
  ali: person(710000001, 'ali_t'),
  sara: person(710000002, 'Sara_T'),
  reza: person(710000003, 'reza_t'),
  nima: person(710000004, 'nima_t'),
  mina: person(710000005, 'mina_t'),
  joe: person(710000006, 'joe_t'),
  blocker: person(710000007, 'blk_t'),
  newbie: person(710000008),
  ivan: person(710000009, 'ivan_t', 'ru', 'Иван'),
  ann: person(710000010, 'ann_t', 'en', 'Ann'),
  owner: person(OWNER, 'owner_t'),
};
const CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
const join = (u) => CHANNELS.forEach((ch) => mock.setMember(ch, u.id, { status: 'member' }));
for (const u of [U.ali, U.sara, U.reza, U.nima, U.mina, U.blocker, U.newbie, U.ivan, U.ann]) join(u);

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
  return { ...analyse(r, since(), u.id), message };
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

async function press(u, data, { inlineId = null, chatId = null, messageId = null } = {}) {
  since();
  const cq = { id: `cb${seq++}`, from: u, chat_instance: '-517', data };
  if (inlineId) cq.inline_message_id = inlineId;
  else {
    const chat = chatId || u.id;
    let mid = messageId || lastBotMessage(chat);
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
    if (['sendMessage', 'sendPhoto'].includes(c.method) && Number(c.params.chat_id) === chat && c.result.ok) return c.result.result.message_id;
  }
  return null;
}

function analyse(r, calls, chat = null) {
  const screens = calls.filter((c) => (['sendMessage', 'sendPhoto'].includes(c.method) || (c.method === 'editMessageText' && !c.params.inline_message_id))
    && (chat === null || Number(c.params.chat_id) === chat));
  const last = screens[screens.length - 1] || null;
  const text = last ? (last.params.text || last.params.caption || '') : '';
  return { r, calls, screens, last, text, kb: last && last.params.reply_markup ? last.params.reply_markup.inline_keyboard : [] };
}

/** Starts the bot and picks a language, like a real first visit. */
async function onboard(u, lang = 'fa') {
  const s = await say(u, '/start');
  if (s.text.includes('Choose the bot')) return press(u, `L:${lang}`);
  return s;
}

const buttons = (kb) => (kb || []).flat();
const dataOf = (kb) => buttons(kb).map((b) => b.callback_data).filter(Boolean);
const inlineEdits = (calls, inlineId) => calls.filter((c) => c.method === 'editMessageText' && c.params.inline_message_id === inlineId);
const sentTo = (calls, chat) => calls.filter((c) => ['sendMessage', 'sendPhoto', 'copyMessage'].includes(c.method) && Number(c.params.chat_id) === chat);
const textsTo = (calls, chat) => sentTo(calls, chat).map((c) => c.params.text || c.params.caption || '').join('\n');
const count = (q) => rawDatabase().prepare(q).get().n;
const row = (q, ...p) => rawDatabase().prepare(q).get(...p);
const rows = (q, ...p) => rawDatabase().prepare(q).all(...p);
const userRow = (u) => row('SELECT * FROM users WHERE user_id = ?', u.id);
const SECRETS = new Set(); // whisper texts, which must never leak
const ANON_SECRETS = new Set(); // anonymous texts: only in the recipient's chat and inbox

/** Nothing that identifies `who` in what `chat` can see (copyMessage's from_chat_id is request-only). */
function noTrace(calls, chat, who) {
  const toChat = calls.filter((c) => Number(c.params.chat_id) === chat);
  const blob = JSON.stringify(toChat.map(({ params: { from_chat_id, ...visible } }) => visible));
  for (const s of [String(who.id), who.username, who.first_name].filter(Boolean)) assert.ok(!blob.includes(s), `"${s}" leaked to ${chat}: ${blob.slice(0, 300)}`);
}

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

// =====================================================================================
// Shell: languages, two sections, help, privacy, forced join
// =====================================================================================

await scenario('first /start shows the language picker; each language leads to the two sections', async () => {
  const pick = await say(U.owner, '/start');
  assert.match(pick.text, /زبان ربات را انتخاب کنید[\s\S]*Choose the bot's language[\s\S]*Выберите язык/);
  assert.deepEqual(dataOf(pick.kb), ['L:fa', 'L:en', 'L:ru']);
  assert.equal(count('SELECT count(*) AS n FROM channels'), 3, 'channels seeded on the first update');
  assert.ok(pick.calls.some((c) => c.method === 'setMyCommands' && c.params.language_code === 'ru'), 'localized commands set');
  const fa = await press(U.owner, 'L:fa');
  assert.match(fa.text, /دو بخش داریم/);
  assert.deepEqual(dataOf(fa.kb).slice(0, 2), ['ws', 'an']);
  assert.equal(userRow(U.owner).lang, 'fa');
  await say(U.ivan, '/start');
  const ru = await press(U.ivan, 'L:ru');
  assert.match(ru.text, /Здесь два раздела/);
  assert.equal(buttons(ru.kb)[0].text, '🤫 Шёпот');
  await say(U.ann, '/start');
  const en = await press(U.ann, 'L:en');
  assert.match(en.text, /There are two sections/);
  const again = await say(U.ann, '/lang');
  assert.deepEqual(dataOf(again.kb), ['L:fa', 'L:en', 'L:ru']);
  for (const u of [U.ali, U.reza, U.sara, U.mina]) await onboard(u);
  const second = await say(U.ali, '/start');
  assert.match(second.text, /دو بخش داریم/, 'no picker once chosen');
  assert.equal(mock.state.calls.filter((c) => c.method === 'setMyCommands').length, 4, 'bot texts set once (default + 3 languages)');
});

await scenario('help (index, whispers, anonymous) and the privacy page, in Persian, English and Russian', async () => {
  const h = await press(U.ali, 'hp');
  assert.deepEqual(dataOf(h.kb).slice(0, 2), ['hp:w', 'hp:a']);
  assert.match((await press(U.ali, 'hp:w')).text, /کنجکاوها/);
  assert.match((await press(U.ali, 'hp:a')).text, /سؤال روز/);
  assert.match((await press(U.ann, 'hp:a')).text, /Question of the day/);
  assert.match((await press(U.ivan, 'hp:w')).text, /Любопытные/);
  const pv = await press(U.ali, 'pv');
  assert.match(pv.text, /هیچ پیام جعلی/);
  assert.match(pv.text, /هیچ قابلیت پولی/);
  assert.match((await say(U.ivan, '/privacy')).text, /Фейковых или сгенерированных сообщений нет/);
});

await scenario('forced join in PM: lock screen with link buttons; restricted counts only with is_member', async () => {
  const pick = await say(U.joe, '/start');
  assert.match(pick.text, /Choose the bot/);
  const r = await press(U.joe, 'L:fa');
  assert.match(r.text, /عضو این کانال‌ها شو/);
  assert.deepEqual(buttons(r.kb).map((b) => b.url).filter(Boolean), CHANNELS.map((c) => `https://t.me/${c}`));
  assert.ok(dataOf(r.kb).includes('j'));
  mock.setMember('HIDE_i_SEEK', U.joe.id, { status: 'member' });
  mock.setMember('Nepenthw_ir', U.joe.id, { status: 'restricted', is_member: false });
  mock.setMember('wangerBots', U.joe.id, { status: 'kicked' });
  const r2 = await press(U.joe, 'j');
  assert.match(r2.answer.text, /هنوز عضو/);
  assert.deepEqual(buttons(r2.kb).map((b) => b.url).filter(Boolean), ['https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
});

await scenario('forced join inline: non-member gets NO whispers, only the join button; "member not found" = not joined', async () => {
  const stranger = person(760000001, 'never_member');
  mock.state.unknownUsers.add(stranger.id);
  const s = await inline(stranger, 'سلام @Sara_T');
  assert.equal(s.results.length, 0);
  assert.equal(s.button.start_parameter, 'join');
  assert.equal(sentTo(s.calls, OWNER).length, 0, 'no false warning to the owner');
  const inl = await inline(U.joe, 'سلام @Sara_T');
  assert.equal(inl.results.length, 0);
  assert.deepEqual(inl.button, { text: '🔒 برای ارسال نجوا اول عضو کانال‌ها شو', start_parameter: 'join' });
  mock.setMember('Nepenthw_ir', U.joe.id, { status: 'restricted', is_member: true });
  mock.setMember('wangerBots', U.joe.id, { status: 'administrator' });
  const ok = await press(U.joe, 'j');
  assert.match(ok.text, /دو بخش داریم/);
  const inl2 = await inline(U.joe, 'سلام @Sara_T');
  assert.equal(inl2.results.length, 1);
  assert.equal(inl2.calls.filter((c) => c.method === 'getChatMember').length, 0, 'cached while typing');
});

// =====================================================================================
// Whispers
// =====================================================================================

let w1;
let w2;

await scenario('whisper to a @username: one result, no content in the message, chosen → stored', async () => {
  const inl = await inline(U.ali, 'سلام خوبی؟ @Sara_T');
  SECRETS.add('سلام خوبی؟');
  const res = mainResult(inl);
  assert.equal(inl.results.length, 1);
  assert.equal(res.input_message_content.message_text, '🔒 یک نجوا برای @Sara_T');
  assert.deepEqual(res.reply_markup.inline_keyboard, [[{ text: '👁 نمایش نجوا', callback_data: `s:${widOf(res.id)}` }]]);
  const posted = await post(U.ali, inl, res.id);
  w1 = { id: widOf(res.id), inlineId: posted.inlineId };
  const w = row('SELECT * FROM whispers WHERE id = ?', w1.id);
  assert.equal(w.body, 'سلام خوبی؟');
  assert.equal(w.lang, 'fa');
  assert.equal(count('SELECT count(*) AS n FROM drafts WHERE sender_id = 710000001'), 0);
});

await scenario('an English sender\'s whisper is posted in English; a Russian clicker gets Russian popups', async () => {
  const inl = await inline(U.ann, 'see you at 5 @ivan_t');
  SECRETS.add('see you at 5');
  const res = mainResult(inl);
  assert.equal(res.input_message_content.message_text, '🔒 A whisper for @ivan_t');
  assert.equal(res.title, '🔒 Whisper for @ivan_t');
  const { inlineId } = await post(U.ann, inl, res.id);
  const id = widOf(res.id);
  const pyotr = person(710000077, 'pyotr_t', 'ru');
  join(pyotr);
  const nosy = await press(pyotr, `s:${id}`, { inlineId });
  assert.equal(nosy.answer.text, 'Этот шёпот не для вас 😏');
  assert.match(mock.state.inline.get(inlineId).text, /👀 Curious: 1/, 'the message stays in the sender\'s language');
  const read = await press(U.ivan, `s:${id}`, { inlineId });
  assert.equal(read.answer.text, 'see you at 5');
  assert.match(textsTo(read.calls, U.ann.id), /@ivan_t opened your whisper/);
});

await scenario('typing many inline queries in a row creates ONE draft row (and no whispers)', async () => {
  const before = count('SELECT count(*) AS n FROM whispers');
  const typed = 'راز بزرگ @reza_t';
  for (let i = 1; i <= typed.length; i += 1) await inline(U.ali, typed.slice(0, i));
  const a = await inline(U.ali, typed);
  const b = await inline(U.ali, typed);
  assert.equal(mainResult(a).id, mainResult(b).id);
  assert.equal(count('SELECT count(*) AS n FROM drafts WHERE sender_id = 710000001'), 1);
  assert.equal(count('SELECT count(*) AS n FROM whispers'), before);
});

await scenario('a curious person (polite word, not «فضول»): counted once, "👀 کنجکاوها: ۱", sender told at once', async () => {
  const p = await press(U.nima, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(p.answer.text, 'این نجوا مال تو نیست 😏');
  const edit = inlineEdits(p.calls, w1.inlineId)[0];
  assert.match(edit.params.text, /👀 کنجکاوها: ۱/);
  assert.ok(!/فضول/.test(edit.params.text));
  assert.match(textsTo(p.calls, U.ali.id), /@nima_t کنجکاو شد/);
  const again = await press(U.nima, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(inlineEdits(again.calls, w1.inlineId).length, 0);
  assert.equal(sentTo(again.calls, U.ali.id).length, 0, 'told once per curious person');
  assert.equal(row('SELECT snoops FROM whispers WHERE id = ?', w1.id).snoops, 1);
});

await scenario('sender opens own whisper: sees it, nothing marked seen, no notification', async () => {
  const p = await press(U.ali, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(p.answer.text, 'سلام خوبی؟');
  assert.equal(row('SELECT seen_at, opens FROM whisper_rcpts WHERE whisper_id = ?', w1.id).opens, 0);
  assert.equal(sentTo(p.calls, U.ali.id).length, 0);
});

await scenario('recipient opens: "👁 دیده شد", and EVERY open is announced to the sender at once, with the count', async () => {
  const p = await press(person(U.sara.id, 'sara_t'), `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(p.answer.text, 'سلام خوبی؟');
  assert.match(inlineEdits(p.calls, w1.inlineId)[0].params.text, /👁 دیده شد/);
  assert.match(textsTo(p.calls, U.ali.id), /@Sara_T نجوای شما را باز کرد\./);
  const p2 = await press(U.sara, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.match(textsTo(p2.calls, U.ali.id), /@Sara_T دوباره نجوای شما را باز کرد — بار ۲م/);
  const p3 = await press(U.sara, `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.match(textsTo(p3.calls, U.ali.id), /بار ۳م/);
  assert.equal(row('SELECT opens FROM whisper_rcpts WHERE whisper_id = ?', w1.id).opens, 3);
  const imposter = await press(person(710009999, 'Sara_T'), `s:${w1.id}`, { inlineId: w1.inlineId });
  assert.equal(imposter.answer.text, 'این نجوا مال تو نیست 😏', 'claimed by id after the first open');
});

await scenario('the curious list: visible to the sender AND the recipient, refused to anyone else', async () => {
  const bySender = await press(U.ali, `n:${w1.id}`);
  assert.match(bySender.text, /کنجکاوهای این نجوا \(۲\)/);
  assert.match(bySender.text, /@nima_t/);
  const byRecipient = await press(U.sara, `n:${w1.id}`);
  assert.match(byRecipient.text, /@nima_t/);
  assert.equal((await press(U.reza, `n:${w1.id}`)).answer.text, 'این نجوا مال تو نیست 😏');
  const det = await press(U.sara, `d:${w1.id}`);
  assert.match(det.text, /کنجکاوها: ۲/);
  assert.ok(dataOf(det.kb).includes(`n:${w1.id}`));
});

await scenario('whisper to a numeric id (Persian digits): only that id can read it', async () => {
  const inl = await inline(U.ali, 'کد ۴۲ برای تو ۷۱۰۰۰۰۰۰۳');
  SECRETS.add('کد ۴۲ برای تو');
  const res = mainResult(inl);
  assert.match(res.title, /@reza_t/);
  const posted = await post(U.ali, inl, res.id);
  w2 = { id: widOf(res.id), inlineId: posted.inlineId };
  assert.equal((await press(person(710007777, 'reza_t'), `s:${w2.id}`, { inlineId: w2.inlineId })).answer.text, 'این نجوا مال تو نیست 😏');
  assert.equal((await press(U.reza, `s:${w2.id}`, { inlineId: w2.inlineId })).answer.text, 'کد ۴۲ برای تو');
  assert.match(mainResult(await inline(U.ali, 'hey 77777777')).input_message_content.message_text, /tg:\/\/user\?id=77777777/);
});

await scenario('3 recipients: each and the sender can read; seen list grows; a 4th is refused', async () => {
  const inl = await inline(U.ali, 'جلسه ساعت ۵ @Sara_T 710000003 @mina_t');
  SECRETS.add('جلسه ساعت ۵');
  const res = mainResult(inl);
  const { inlineId } = await post(U.ali, inl, res.id);
  const id = widOf(res.id);
  for (const u of [U.sara, U.reza, U.mina, U.ali]) assert.equal((await press(u, `s:${id}`, { inlineId })).answer.text, 'جلسه ساعت ۵');
  assert.match(mock.state.inline.get(inlineId).text, /👁 دیده شد: @Sara_T، @reza_t، @mina_t/);
  assert.equal((await inline(U.ali, 'زیاد @Sara_T @reza_t @mina_t @nima_t')).results[0].id, 'h.too_many');
});

await scenario('whisper settings: open alerts off → no notification; default expiry applies', async () => {
  const s = await say(U.ali, '/settings');
  assert.match(s.text, /خبر باز شدن:<\/b> روشن/);
  assert.match((await press(U.ali, 'st:r')).text, /خبر باز شدن:<\/b> خاموش/);
  const inl = await inline(U.ali, 'بی‌خبر ۴۴ @Sara_T');
  SECRETS.add('بی‌خبر ۴۴');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id);
  const p = await press(U.sara, `s:${widOf(mainResult(inl).id)}`, { inlineId });
  assert.equal(sentTo(p.calls, U.ali.id).length, 0);
  await press(U.ali, 'st:r');
  assert.match((await press(U.ali, 'st:e:3600')).text, /انقضای پیش‌فرض:<\/b> ۱ ساعت/);
  const inl2 = await inline(U.ali, 'با انقضای پیش‌فرض @Sara_T');
  SECRETS.add('با انقضای پیش‌فرض');
  assert.match(mainResult(inl2).input_message_content.message_text, /⏳ مهلت باز کردن: ۱ ساعت/);
  await press(U.ali, 'st:e:0');
});

await scenario('one-time whisper: first open shows it and burns it; second open fails', async () => {
  const inl = await inline(U.ali, '!رمز وای‌فای 9876 @Sara_T');
  SECRETS.add('رمز وای‌فای 9876');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id);
  const id = widOf(mainResult(inl).id);
  const first = await press(U.sara, `s:${id}`, { inlineId });
  assert.equal(first.answer.text, 'رمز وای‌فای 9876');
  assert.match(textsTo(first.calls, U.ali.id), /سوزانده شد/);
  assert.equal(row('SELECT body, state FROM whispers WHERE id = ?', id).state, 1);
  assert.match(mock.state.inline.get(inlineId).text, /🔥 <b>نجوا سوزانده شد<\/b>/);
  assert.match((await press(U.sara, `s:${id}`, { inlineId })).answer.text, /سوزانده شده/);
});

await scenario('expiry: opens before, refused after (lazy check on click), content removed', async () => {
  const inl = await inline(U.ali, 'تا نیم ساعت @Sara_T 30m');
  SECRETS.add('تا نیم ساعت');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id);
  const id = widOf(mainResult(inl).id);
  advance(29 * 60);
  assert.equal((await press(U.ali, `s:${id}`, { inlineId })).answer.text, 'تا نیم ساعت');
  advance(2 * 60);
  assert.match((await press(U.sara, `s:${id}`, { inlineId })).answer.text, /مهلت باز کردن این نجوا تمام شده/);
  assert.equal(row('SELECT body FROM whispers WHERE id = ?', id).body, null);
  assert.equal((await inline(U.ali, 'x @Sara_T 9d')).results[0].id, 'h.bad_expiry');
});

await scenario('long whisper: deep link; recipient reads in PM (counted as an open), stranger refused', async () => {
  const long = `${'این یک نجوای طولانی است. '.repeat(10)}پایان`;
  SECRETS.add(long);
  const inl = await inline(U.ali, `${long} @Sara_T`);
  const res = mainResult(inl);
  const id = widOf(res.id);
  assert.deepEqual(res.reply_markup.inline_keyboard[1], [{ text: '📖 خواندن در ربات', url: `https://t.me/${BOT}?start=w_${id}` }]);
  const { inlineId } = await post(U.ali, inl, res.id);
  assert.equal((await press(U.sara, `s:${id}`, { inlineId })).answer.url, `https://t.me/${BOT}?start=w_${id}`);
  mock.state.rejectUrlOnce = true;
  assert.match((await press(U.sara, `s:${id}`, { inlineId })).answer.text, /طولانی است/);
  assert.match((await say(U.nima, `/start w_${id}`)).text, /این نجوا مال تو نیست 😏/);
  const read = await say(U.sara, `/start w_${id}`);
  assert.ok(read.text.includes('پایان'));
  assert.match(textsTo(read.calls, U.ali.id), /باز کرد/);
  assert.ok(row('SELECT seen_at FROM whisper_rcpts WHERE whisper_id = ?', id).seen_at > 0);
});

await scenario('history: sent (full text, opens count) and received (hides one-time); 20 kept', async () => {
  const sent = await say(U.ali, '/history');
  assert.ok(sent.text.includes('سلام خوبی؟'));
  assert.match(sent.text, /باز شده: ۳ بار/);
  const recv = await press(U.sara, 'h:r:0');
  assert.ok(recv.text.includes('سلام خوبی؟'));
  assert.ok(!recv.text.includes('رمز وای‌فای'));
  for (let i = 0; i < 22; i += 1) {
    const inl = await inline(U.reza, `پیام ${i} @mina_t`);
    await post(U.reza, inl, mainResult(inl).id);
  }
  assert.match((await say(U.reza, '/history')).text, /\(۲۰ مورد آخر\)/);
});

await scenario('quick results: text without a recipient suggests the 3 most recent recipients', async () => {
  const inl = await inline(U.ali, 'یک پیام سریع');
  SECRETS.add('یک پیام سریع');
  const quick = inl.results.filter((r) => r.id.startsWith('q.'));
  assert.equal(quick.length, 3);
  const { inlineId } = await post(U.ali, inl, quick[0].id);
  const id = widOf(quick[0].id);
  const target = row('SELECT rid, runame FROM whisper_rcpts WHERE whisper_id = ?', id);
  const who = target.runame === 'sara_t' || target.rid === U.sara.id ? U.sara : target.runame === 'mina_t' ? U.mina : U.reza;
  assert.equal((await press(who, `s:${id}`, { inlineId })).answer.text, 'یک پیام سریع');
});

await scenario('whisper block list: blocked sender can\'t create whispers to them; unblock restores', async () => {
  await press(U.sara, `bk:${U.ali.id}`);
  assert.equal((await inline(U.ali, 'سلام دوباره @Sara_T')).results[0].id, 'h.blocked');
  assert.equal((await inline(U.ali, 'سلام دوباره 710000002')).results[0].id, 'h.blocked');
  const list = await say(U.sara, '/blocks');
  assert.match(list.text, /@ali_t/);
  await press(U.sara, 'bl:add');
  assert.match((await say(U.sara, '@nima_t')).text, /بلاک شد/);
  await press(U.sara, `ub:${U.ali.id}`);
  await press(U.sara, `ub:${U.nima.id}`);
  assert.ok(mainResult(await inline(U.ali, 'سلام دوباره @Sara_T')));
});

await scenario('input validation and the no-feedback fallback', async () => {
  assert.equal((await inline(U.ali, '@Sara_T')).results[0].id, 'h.no_text');
  assert.equal((await inline(U.ali, 'hi @ali_t')).results[0].id, 'h.self');
  assert.equal((await inline(U.ali, `hi @${BOT}`)).results[0].id, 'h.bot');
  assert.equal((await inline(U.newbie, 'hi there')).results[0].id, 'h.no_recipient');
  const inl = await inline(U.ali, 'بدون فیدبک @Sara_T');
  SECRETS.add('بدون فیدبک');
  const { inlineId } = await post(U.ali, inl, mainResult(inl).id, { skipChosen: true });
  assert.equal((await press(U.sara, `s:${widOf(mainResult(inl).id)}`, { inlineId })).answer.text, 'بدون فیدبک');
});

// =====================================================================================
// Owner: panel, channels, join toggle, ban, stats, broadcast
// =====================================================================================

await scenario('/admin: only numeric id 5557901897; everyone else refused', async () => {
  const p = await say(U.owner, '/admin');
  assert.match(p.text, /پنل مالک/);
  assert.deepEqual(dataOf(p.kb), ['a:ch', 'a:add', 'a:j', 'a:ban', 'a:unban', 'a:st', 'a:rp', 'a:bc']);
  assert.match((await say(U.ali, '/admin')).text, /فقط برای مالک/);
  for (const d of ['a', 'a:ch', 'a:bc', 'a:rp', 'a:rb:1']) assert.match((await press(U.ali, d)).answer.text, /فقط برای مالک/);
  assert.match((await say(person(710004242, 'owner_t'), '/admin')).text, /فقط برای مالک|Choose|عضو/);
});

await scenario('channels: add (@name / t.me link), 11th refused, remove and re-add, refusals', async () => {
  for (let i = 1; i <= 7; i += 1) {
    await press(U.owner, 'a:add');
    assert.match((await say(U.owner, i % 2 ? `@extra_chan${i}` : `https://t.me/extra_chan${i}`)).text, new RegExp(`extra_chan${i} اضافه شد`));
  }
  assert.equal(count('SELECT count(*) AS n FROM channels'), 10);
  assert.match((await press(U.owner, 'a:add')).answer.text, /حداکثر ۱۰ کانال/);
  const target = row("SELECT id FROM channels WHERE uname = 'extra_chan3'").id;
  await press(U.owner, `a:rm:${target}`);
  assert.match((await press(U.owner, `a:rmy:${target}`)).text, /extra_chan3 حذف شد/);
  await press(U.owner, 'a:add');
  assert.match((await say(U.owner, 't.me/extra_chan3')).text, /extra_chan3 اضافه شد/);
  rawDatabase().prepare("DELETE FROM channels WHERE uname = 'extra_chan7'").run();
  await press(U.owner, 'a:add');
  assert.match((await say(U.owner, '@not_admin_chan')).text, /ادمین نیست/);
  assert.match((await say(U.owner, 'https://t.me/+AbCdEf')).text, /معتبر نیست/);
  assert.match((await say(U.owner, '@some_person')).text, /کانال یا گروه نیست/);
  await say(U.owner, '/cancel');
  rawDatabase().prepare("DELETE FROM channels WHERE uname LIKE 'extra_chan%'").run();
  rawDatabase().prepare("UPDATE kv SET value = CAST(value AS INTEGER) + 1 WHERE key = 'chv'").run();
});

await scenario('channel check error: skipped, owner warned at most once per 3h', async () => {
  mock.state.botAdmin.delete('@wangerbots');
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
  const r = await say(U.mina, '/history');
  assert.match(r.text, /نجواهای ارسالی/);
  assert.equal(sentTo(r.calls, OWNER).length, 1);
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
  assert.equal(sentTo((await say(U.reza, '/history')).calls, OWNER).length, 0);
  mock.state.botAdmin.add('@wangerbots');
  rawDatabase().prepare('UPDATE users SET join_until = 0').run();
});

await scenario('forced join on/off; ban / unban (banned can still read, can\'t send anonymously)', async () => {
  assert.match((await press(U.owner, 'a:j')).text, /عضویت اجباری: خاموش/);
  assert.ok(mainResult(await inline(person(740000001, 'outsider'), 'سلام @Sara_T')));
  await press(U.owner, 'a:j');
  await press(U.owner, 'a:ban');
  assert.match((await say(U.owner, '710000004')).text, /710000004<\/code> \(@nima_t\) بن شد/);
  assert.equal((await inline(U.nima, 'سلام @Sara_T')).button.start_parameter, 'banned');
  const inl = await inline(U.sara, 'برای نیما @nima_t');
  SECRETS.add('برای نیما');
  const { inlineId } = await post(U.sara, inl, mainResult(inl).id);
  assert.equal((await press(U.nima, `s:${widOf(mainResult(inl).id)}`, { inlineId })).answer.text, 'برای نیما');
  await press(U.owner, 'a:ban');
  assert.match((await say(U.owner, String(OWNER))).text, /مالک را نمی‌شود بن کرد/);
  await press(U.owner, 'a:unban');
  assert.match((await say(U.owner, '710000004')).text, /آنبن شد/);
});

await scenario('stats: counts only, matching the tables', async () => {
  const s = await press(U.owner, 'a:st');
  const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  assert.ok(s.text.includes(`کل کاربران: ${fa(count('SELECT count(*) AS n FROM users WHERE first_seen > 0'))}`), s.text);
  assert.ok(s.text.includes(`کل نجواها: ${fa(count('SELECT count(*) AS n FROM whispers'))}`), s.text);
  for (const secret of SECRETS) assert.ok(!s.text.includes(secret));
});

await scenario('broadcast: preview, batches of 25, 403 → inactive, 429 → wait, opportunistic chunk, report', async () => {
  const filler = [];
  for (let i = 0; i < 40; i += 1) filler.push(person(720000000 + i, `fill${i}`));
  for (const u of [...filler, U.blocker]) {
    join(u);
    await onboard(u);
  }
  mock.state.blocked.add(U.blocker.id);
  mock.state.rateLimitOnce.set(720000010, 3);
  const reachable = rows('SELECT user_id FROM users WHERE started = 1 AND active = 1 AND banned = 0 AND user_id != ?', OWNER).map((r) => r.user_id);
  await press(U.owner, 'a:bc');
  const photo = await say(U.owner, undefined, { photo: [{ file_id: 'AgACphoto', file_unique_id: 'u1', width: 90, height: 90 }], caption: 'خبر' });
  assert.equal(photo.calls.find((c) => c.method === 'copyMessage').params.chat_id, OWNER);
  const bcId = Number(dataOf(photo.kb)[0].split(':')[2]);
  await press(U.owner, 'a:bc');
  const second = await say(U.owner, 'پیام دوم');
  const secondId = Number(dataOf(second.kb)[0].split(':')[2]);
  const go = await press(U.owner, `a:bcy:${bcId}`);
  assert.ok(go.calls.filter((c) => c.method === 'copyMessage').length <= 25);
  assert.ok(row('SELECT next_at FROM broadcasts WHERE id = ?', bcId).next_at > nowSec(), '429 sets a wait');
  assert.match((await press(U.owner, `a:bcc:${bcId}`)).answer.text, /محدودیت تلگرام/);
  assert.match((await press(U.owner, `a:bcy:${secondId}`)).answer.text, /فقط یکی در هر زمان/);
  advance(4);
  assert.equal((await inline(U.ali, 'در حین ارسال @Sara_T')).calls.filter((c) => c.method === 'copyMessage').length, 5);
  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await press(U.owner, `a:bcc:${bcId}`);
    if (row('SELECT status FROM broadcasts WHERE id = ?', bcId).status === 'done') break;
  }
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', bcId).status, 'done');
  assert.ok(sentTo(last.calls, OWNER).some((c) => /گزارش نهایی/.test(c.params.text)));
  const got = mock.state.copied.filter((c) => c.from_chat_id === OWNER && c.message_id === photo.message.message_id && c.chat_id !== OWNER).map((c) => c.chat_id);
  assert.deepEqual([...got].sort((x, y) => x - y), reachable.filter((id) => id !== U.blocker.id).sort((x, y) => x - y));
  assert.equal(new Set(got).size, got.length, 'no duplicates');
  assert.equal(userRow(U.blocker).active, 0);
  await press(U.owner, `a:bcy:${secondId}`);
  assert.match((await press(U.owner, `a:bcs:${secondId}`)).answer.text, /متوقف شد/);
});

// =====================================================================================
// Anonymous messages
// =====================================================================================

let code; // sara's link code
let firstRef; // ali's anonymous message to sara
const linkRe = new RegExp(`https://t\\.me/${BOT}\\?start=a_([0-9A-Za-z]{10})`);

await scenario('anonymous section and personal link; a new link revokes the old; pause', async () => {
  const sec = await press(U.sara, 'an');
  assert.match(sec.text, /پیام ناشناس/);
  assert.deepEqual(dataOf(sec.kb), ['al', 'ib:0:-:0', 'qd', 'cd', 'pf', 'fs', 'as', 'm']);
  const link = await say(U.sara, '/link');
  const old = linkRe.exec(link.text)[1];
  assert.ok(buttons(link.kb).some((b) => b.url && b.url.startsWith('https://t.me/share/url?url=')));
  code = linkRe.exec((await press(U.sara, 'al:new')).text)[1];
  assert.notEqual(code, old);
  assert.match((await say(U.ali, `/start a_${old}`)).text, /معتبر نیست/);
  await press(U.sara, 'al:t');
  assert.match((await say(U.ali, `/start a_${code}`)).text, /معتبر نیست/);
  await press(U.sara, 'al:t');
  assert.match((await say(U.sara, `/start a_${code}`)).text, /این لینک خودت است/);
});

await scenario('profile: name, bio, link photo; offensive or link-bearing names refused; preview = what visitors see', async () => {
  await press(U.sara, 'pf:n');
  assert.match((await say(U.sara, 'کص‌کش')).text, /مجاز نیست/);
  assert.match((await say(U.sara, 't.me/spam')).text, /مجاز نیست/);
  assert.match((await say(U.sara, 'سارا 🌸')).text, /ذخیره شد/);
  await press(U.sara, 'pf:b');
  await say(U.sara, 'عاشق کتاب و قهوه ☕️');
  await press(U.sara, 'pf:p');
  assert.match((await say(U.sara, 'not a photo')).text, /یک عکس بفرست/);
  assert.match((await say(U.sara, undefined, { photo: [{ file_id: 'AgACsaraPhoto', file_unique_id: 'p1', width: 640, height: 640 }] })).text, /عکس لینک ذخیره شد/);
  const pv = await press(U.sara, 'pf:v');
  const media = pv.calls.find((c) => c.method === 'sendPhoto');
  assert.equal(media.params.photo, 'AgACsaraPhoto');
  assert.match(media.params.caption, /در حال ارسال پیام ناشناس به <b>سارا 🌸<\/b> هستی/);
  assert.match(media.params.caption, /عاشق کتاب و قهوه/);
});

await scenario('opening a link: the photo + "در حال ارسال پیام به …", rating, bio; categories; the visitor stays anonymous', async () => {
  const open = await say(U.ali, `/start a_${code}`);
  const card = open.calls.find((c) => c.method === 'sendPhoto');
  assert.ok(card, 'the link photo is sent');
  assert.match(card.params.caption, /در حال ارسال پیام ناشناس به <b>سارا 🌸<\/b> هستی/);
  assert.match(card.params.caption, /هنوز امتیازی ندارد/);
  assert.deepEqual(dataOf(card.params.reply_markup.inline_keyboard).slice(0, 6), ['ac:q', 'ac:c', 'ac:o', 'ac:f', 'ac:h', 'ac:g']);
  const cardMsg = card.result.result.message_id;
  const pick = await press(U.ali, 'ac:c', { messageId: cardMsg });
  assert.match(pick.answer.text, /اعتراف/);
  assert.ok(pick.calls.some((c) => c.method === 'editMessageReplyMarkup' && JSON.stringify(c.params.reply_markup).includes('✅ 💌')));
  const text = 'راستش از اول ازت خوشم میومد 🙈';
  ANON_SECRETS.add(text);
  const sent = await say(U.ali, text);
  const delivered = sentTo(sent.calls, U.sara.id)[0];
  assert.equal(delivered.params.text, `📨 <b>پیام ناشناس جدید</b> · 💌 اعتراف\n\n${text}`);
  firstRef = delivered.params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  assert.deepEqual(dataOf(delivered.params.reply_markup.inline_keyboard), [`ar:${firstRef}`, `ab:${firstRef}`, `ap:${firstRef}`, `iv:${firstRef}`]);
  noTrace(sent.calls, U.sara.id, U.ali);
  assert.match(sent.text, /پیامت ناشناس فرستاده شد/);
  assert.deepEqual({ ...row('SELECT from_id, to_id, cat, folder, unread FROM anon_msgs WHERE id = ?', firstRef) }, { from_id: U.ali.id, to_id: U.sara.id, cat: 'c', folder: 0, unread: 1 });
  assert.equal(userRow(U.sara).anon_unread, 1);
  assert.ok(!JSON.stringify(sent.r).includes(text), 'not in the trace');
});

await scenario('media: a header, then an exact copy with the buttons; stored with its file_id for the inbox', async () => {
  advance(5); // past the 3-second flood gap
  await press(U.ali, `aw:${code}`);
  const photo = await say(U.ali, undefined, { photo: [{ file_id: 'AgACanon', file_unique_id: 'u9', width: 90, height: 90 }], caption: 'حدس بزن کجام' });
  ANON_SECRETS.add('حدس بزن کجام');
  assert.match(sentTo(photo.calls, U.sara.id)[0].params.text, /پیام ناشناس جدید<\/b> · 📝 عمومی 👇/);
  const copy = photo.calls.find((c) => c.method === 'copyMessage' && Number(c.params.chat_id) === U.sara.id);
  assert.ok(copy.result.ok);
  noTrace(photo.calls, U.sara.id, U.ali);
  assert.equal(row("SELECT file_id FROM anon_msgs WHERE kind = 'photo' AND to_id = ?", U.sara.id).file_id, 'AgACanon');
});

await scenario('reply both ways: the owner answers (threaded), the visitor answers back and stays anonymous', async () => {
  const p = await press(U.sara, `ar:${firstRef}`);
  assert.match(p.text, /پاسخت را بفرست/);
  const r = await say(U.sara, 'تو کی هستی؟');
  const toAli = sentTo(r.calls, U.ali.id)[0];
  assert.ok(toAli, r.text);
  assert.equal(toAli.params.text, '↩️ <b>پاسخ سارا 🌸</b>\n\nتو کی هستی؟');
  assert.ok(toAli.params.reply_parameters, 'threaded under the visitor\'s own message');
  const ref2 = toAli.params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  advance(5);
  await press(U.ali, `ar:${ref2}`);
  const r2 = await say(U.ali, 'نمی‌گم 😉');
  assert.match(sentTo(r2.calls, U.sara.id)[0].params.text, /^📨 <b>پیام ناشناس جدید<\/b>/);
  noTrace(r2.calls, U.sara.id, U.ali);
  assert.match((await press(U.nima, `ar:${firstRef}`)).answer.text, /قابل پاسخ نیست/);
});

await scenario('ratings: visitors rate 1-5 (one each, changeable); the average shows when the link is opened', async () => {
  await press(U.ali, `rt:${code}`);
  assert.match((await press(U.ali, `rt:${code}:5`)).answer.text, /میانگین: ۵٫۰ از ۵ \(۱ رأی\)/);
  await press(U.reza, `rt:${code}:3`);
  assert.match((await press(U.ali, `rt:${code}:4`)).answer.text, /میانگین: ۳٫۵ از ۵ \(۲ رأی\)/);
  assert.match((await press(U.sara, `rt:${code}:5`)).answer.text, /به خودت نمی‌شود امتیاز داد/);
  assert.deepEqual({ ...row('SELECT rating_sum, rating_count FROM users WHERE user_id = ?', U.sara.id) }, { rating_sum: 7, rating_count: 2 });
  const open = await say(U.mina, `/start a_${code}`);
  assert.match(open.calls.find((c) => c.method === 'sendPhoto').params.caption, /⭐️ امتیاز: ۳٫۵ از ۵ \(۲ رأی\)/);
  const enOpen = await say(U.ann, `/start a_${code}`);
  assert.match(enOpen.calls.find((c) => c.method === 'sendPhoto').params.caption, /You're sending an anonymous message to <b>سارا 🌸<\/b>[\s\S]*Rating: 3\.5 \/ 5 \(2 ratings\)/);
  await press(U.sara, 'pf:r');
  assert.ok(!(await say(U.mina, `/start a_${code}`)).calls.find((c) => c.method === 'sendPhoto').params.caption.includes('امتیاز'), 'hidden');
  await press(U.sara, 'pf:r');
  await say(U.mina, '/cancel');
  await say(U.ann, '/cancel');
});

await scenario('question of the day: on the link, the visitor sees it, the answer is filed with it; own question; off', async () => {
  const q = await press(U.sara, 'qd');
  assert.match(q.text, /سؤال امروز/);
  await press(U.sara, 'qd:d');
  const open = await say(U.reza, `/start a_${code}`);
  const caption = open.calls.find((c) => c.method === 'sendPhoto').params.caption;
  assert.match(caption, /❓ <b>سؤال:<\/b>/);
  assert.ok(dataOf(open.calls.find((c) => c.method === 'sendPhoto').params.reply_markup.inline_keyboard).includes('ac:d'));
  const r = await say(U.reza, 'جوابم اینه');
  ANON_SECRETS.add('جوابم اینه');
  assert.match(sentTo(r.calls, U.sara.id)[0].params.text, /🌟 جواب سؤال\n❓ در جواب: «/);
  assert.equal(row("SELECT cat FROM anon_msgs WHERE body = 'جوابم اینه'").cat, 'd');
  await press(U.sara, 'qd:c');
  await say(U.sara, 'بزرگ‌ترین آرزوت چیه؟');
  assert.match((await say(U.ivan, `/start a_${code}`)).calls.find((c) => c.method === 'sendPhoto').params.caption, /بزرگ‌ترین آرزوت چیه؟/);
  await say(U.ivan, '/cancel');
  await press(U.sara, 'qd:0');
  assert.equal(userRow(U.sara).q_mode, 0);
});

await scenario('anti-spam: flood gap, 5 per person per 10 min, 30 per hour, duplicates', async () => {
  await say(U.mina, `/start a_${code}`);
  await say(U.mina, 'یک');
  await say(U.mina, `/start a_${code}`);
  assert.match((await say(U.mina, 'دو')).text, /کمی آرام‌تر/, 'flood: < 3 s');
  advance(5);
  assert.match((await say(U.mina, 'یک')).text, /قبلاً برای همین کاربر فرستاده‌ای/, 'duplicate');
  for (const w of ['سه', 'چهار', 'پنج', 'شش']) {
    advance(5);
    await say(U.mina, `/start a_${code}`);
    await say(U.mina, w);
  }
  advance(5);
  await say(U.mina, `/start a_${code}`);
  assert.match((await say(U.mina, 'هفت')).text, /در ۱۰ دقیقه حداکثر ۵ پیام/);
  const ins = rawDatabase().prepare('INSERT INTO anon_msgs (id, from_id, to_id, anon, created_at) VALUES (?, ?, ?, 1, ?)');
  for (let i = 0; i < 30; i += 1) ins.run(`rate${String(i).padStart(6, '0')}`, U.newbie.id, U.mina.id, nowSec() - 60);
  await onboard(U.newbie);
  await say(U.newbie, `/start a_${code}`);
  assert.match((await say(U.newbie, 'سی‌ویکم')).text, /در یک ساعت حداکثر ۳۰/);
  rawDatabase().prepare("DELETE FROM anon_msgs WHERE id LIKE 'rate%'").run();
  advance(11 * 60);
  await say(U.mina, '/cancel');
  // the previous message stamped by a machine whose clock runs a minute ahead: not a flood
  rawDatabase().prepare('UPDATE users SET last_anon_at = ? WHERE user_id = ?').run(nowSec() + 60, U.mina.id);
  await say(U.mina, `/start a_${code}`);
  assert.match((await say(U.mina, 'ساعت سرورها یکی نیست')).text, /پیامت ناشناس فرستاده شد/, 'clock skew is not a flood');
});

await scenario('filters: offensive words, links, own words → "filtered" folder (not delivered, sender not told); text only; silent', async () => {
  await say(U.reza, `/start a_${code}`);
  const blocked = await say(U.reza, 'تو یه کصکش هستی');
  assert.equal(sentTo(blocked.calls, U.sara.id).length, 0, 'offensive: not delivered');
  assert.match(blocked.text, /پیامت ناشناس فرستاده شد/, 'shadow: the sender sees the usual confirmation');
  assert.equal(blocked.r.filtered, 'offensive');
  assert.equal(row("SELECT folder FROM anon_msgs WHERE body = 'تو یه کصکش هستی'").folder, 2);
  advance(5);
  await press(U.sara, 'fs:l');
  await say(U.reza, `/start a_${code}`);
  assert.equal((await say(U.reza, 'بیا اینجا t.me/spamchannel')).r.filtered, 'link');
  await press(U.sara, 'fw:add');
  assert.match((await say(U.sara, 'پیتزا, Брокколи')).text, /۲ کلمه اضافه شد/);
  advance(5);
  await say(U.ivan, `/start a_${code}`);
  assert.equal((await say(U.ivan, 'Я люблю брокколи')).r.filtered, 'word', 'case-insensitive Cyrillic');
  await press(U.sara, 'fs:t');
  advance(5);
  await say(U.ann, `/start a_${code}`);
  assert.match((await say(U.ann, undefined, { sticker: { file_id: 'CAACsticker', file_unique_id: 's1' } })).text, /accepts text only/);
  await press(U.sara, 'fs:t');
  await press(U.sara, 'fs:s');
  const quiet = await say(U.ann, 'hello there');
  assert.equal(sentTo(quiet.calls, U.sara.id)[0].params.disable_notification, true);
  await press(U.sara, 'fs:s');
  await press(U.sara, 'fs:l');
  const filtered = await press(U.sara, 'ib:2:-:0');
  assert.match(filtered.text, /فیلترشده/);
  assert.equal(filtered.r.trace.find((e) => e.view === 'inbox').meta.ids.length, 3);
});

await scenario('blocking without learning who; 3 people blocking the same sender restrict them automatically', async () => {
  const deliveredId = sentTo(mock.state.calls, U.sara.id).find((c) => JSON.stringify(c.params.reply_markup || '').includes(`ab:${firstRef}`)).result.result.message_id;
  const b = await press(U.sara, `ab:${firstRef}`, { messageId: deliveredId });
  assert.match(b.answer.text, /بلاک شد/);
  assert.deepEqual(b.calls.find((c) => c.method === 'editMessageReplyMarkup').params.reply_markup.inline_keyboard[0].map((x) => x.text), ['↩️ پاسخ', '🔓 آنبلاک']);
  assert.match((await say(U.ali, `/start a_${code}`)).text, /پیام‌های تو را نمی‌پذیرد/);
  const list = await say(U.sara, '/blocks');
  assert.match(list.text, /فرستنده‌های ناشناس بلاک‌شده/);
  noTrace(list.calls, U.sara.id, U.ali);
  assert.equal(userRow(U.ali).strikes, 1);
  // the same person unblocking and blocking again is still one strike
  for (let i = 0; i < 3; i += 1) {
    assert.match((await press(U.sara, `ab:${firstRef}`, { messageId: deliveredId })).answer.text, /^🔓 آنبلاک شد/);
    assert.match((await press(U.sara, `ab:${firstRef}`, { messageId: deliveredId })).answer.text, /^🚫 بلاک شد/);
  }
  assert.equal(userRow(U.ali).strikes, 1, 'one person = one strike');
  assert.ok(userRow(U.ali).restricted_until <= nowSec(), 'not restricted by one person');
  // two more people block ali's anonymous messages → restricted for 24h
  for (const victim of [U.mina, U.reza]) {
    const link = linkRe.exec((await say(victim, '/link')).text)[1];
    advance(5);
    await say(U.ali, `/start a_${link}`);
    const s = await say(U.ali, `سلام ${victim.username}`);
    const ref = sentTo(s.calls, victim.id)[0].params.reply_markup.inline_keyboard[0][1].callback_data.slice(3);
    await press(victim, `ab:${ref}`);
  }
  assert.ok(userRow(U.ali).restricted_until > nowSec());
  const link = linkRe.exec((await say(U.ivan, '/link')).text)[1];
  advance(5);
  await say(U.ali, `/start a_${link}`);
  assert.match((await say(U.ali, 'یک پیام دیگر')).text, /چند نفر پیام‌هایت را گزارش یا بلاک کرده‌اند/);
  assert.equal(userRow(U.ali).strikes, 3);
  rawDatabase().prepare('UPDATE users SET restricted_until = 0, strikes = 0 WHERE user_id = ?').run(U.ali.id);
  rawDatabase().prepare('DELETE FROM strikes WHERE sender_id = ?').run(U.ali.id);
  await say(U.ali, '/cancel');
  const uba = dataOf((await say(U.sara, '/blocks')).kb).find((d) => d.startsWith('uba:'));
  assert.match((await press(U.sara, uba)).answer.text, /آنبلاک/);
});

await scenario('report: confirmation, auto-block, owner reviews the content without the sender\'s identity, restricts by report', async () => {
  advance(5);
  await say(U.joe, `/start a_${code}`);
  const nasty = 'یه پیام آزاردهنده ولی بدون فحش';
  ANON_SECRETS.add(nasty);
  const s = await say(U.joe, nasty);
  const ref = sentTo(s.calls, U.sara.id)[0].params.reply_markup.inline_keyboard[1][0].callback_data.slice(3);
  const ask = await press(U.sara, `ap:${ref}`);
  assert.match(ask.text, /هویت فرستنده نه به تو نشان داده می‌شود و نه به مدیر/);
  const done = await press(U.sara, `apy:${ref}`);
  assert.match(done.answer.text, /گزارش شد/);
  assert.match(textsTo(done.calls, OWNER), /گزارش تازه/);
  assert.equal(count(`SELECT count(*) AS n FROM anon_blocks WHERE owner_id = ${U.sara.id} AND blocked_id = ${U.joe.id}`), 1);
  const list = await press(U.owner, 'a:rp');
  const rv = dataOf(list.kb).find((d) => d.startsWith('a:rv:'));
  const review = await press(U.owner, rv);
  assert.ok(review.text.includes(nasty), 'the reported content');
  noTrace(review.calls, OWNER, U.joe);
  assert.match((await press(U.owner, rv.replace('a:rv:', 'a:rr:'))).answer.text, /۷ روز محدود شد/);
  assert.ok(userRow(U.joe).restricted_until > nowSec() + 6 * 86400);
  assert.match((await press(U.sara, `apy:${ref}`)).answer.text, /قبلاً گزارش شده/);
});

await scenario('inbox: unread markers, read on view, category filter, archive, re-categorize, delete, search (fa + ru)', async () => {
  const box = await say(U.sara, '/inbox');
  assert.match(box.text, /صندوق پیام/);
  assert.match(box.text, /🔵/);
  const before = userRow(U.sara).anon_unread;
  const view = await press(U.sara, `iv:${firstRef}`);
  assert.ok(view.text.includes('راستش از اول ازت خوشم میومد'));
  assert.match(view.text, /💌 اعتراف/);
  assert.equal(userRow(U.sara).anon_unread, before - 1);
  assert.ok(buttons(view.kb).some((b) => b.web_app && b.web_app.url.startsWith(`https://app${BOT_ID}.tgcloud.ai/?k=msg&id=${firstRef}`)), 'card button');
  const confessions = (await press(U.sara, 'ib:0:c:0')).r.trace.find((e) => e.view === 'inbox').meta.ids;
  assert.ok(confessions.includes(firstRef), 'the confession; replies in its thread keep its category');
  for (const id of confessions) assert.equal(row('SELECT cat FROM anon_msgs WHERE id = ?', id).cat, 'c');
  await press(U.sara, `ia:${firstRef}`);
  assert.equal(row('SELECT folder FROM anon_msgs WHERE id = ?', firstRef).folder, 1);
  assert.deepEqual((await press(U.sara, 'ib:1:-:0')).r.trace.find((e) => e.view === 'inbox').meta.ids, [firstRef]);
  assert.ok(!(await press(U.sara, 'ib:0:c:0')).r.trace.find((e) => e.view === 'inbox').meta.ids.includes(firstRef), 'archived: out of the inbox');
  await press(U.sara, `ic:${firstRef}`);
  await press(U.sara, `ic:${firstRef}:h`);
  assert.equal(row('SELECT cat FROM anon_msgs WHERE id = ?', firstRef).cat, 'h');
  await press(U.sara, 'is:1');
  assert.equal((await say(U.sara, 'خوشم')).r.trace.find((e) => e.view === 'inbox_search').meta.found, 1);
  await press(U.sara, 'is:2');
  assert.equal((await say(U.sara, 'БРОККОЛИ')).r.trace.find((e) => e.view === 'inbox_search').meta.found, 1, 'Cyrillic, any case');
  const media = await press(U.sara, `iv:${row("SELECT id FROM anon_msgs WHERE kind = 'photo' AND to_id = ?", U.sara.id).id}`);
  assert.equal(media.calls.find((c) => c.method === 'sendPhoto').params.photo, 'AgACanon');
  await press(U.sara, `ix:${firstRef}`);
  await press(U.sara, `ixy:${firstRef}`);
  assert.equal(count(`SELECT count(*) AS n FROM anon_msgs WHERE id = '${firstRef}'`), 0);
  assert.equal(userRow(U.sara).inbox_size, count(`SELECT count(*) AS n FROM anon_msgs WHERE to_id = ${U.sara.id}`));
});

await scenario('image cards: web_app buttons to the Mini App; cardData only for your own; cardSend posts the JPEG', async () => {
  const cd = await press(U.sara, 'cd');
  const urls = buttons(cd.kb).filter((b) => b.web_app).map((b) => b.web_app.url);
  assert.deepEqual(urls, [`https://app${BOT_ID}.tgcloud.ai/?k=link&l=fa`, `https://app${BOT_ID}.tgcloud.ai/?k=q&l=fa`]);
  const ctx = { initData: { user: { id: U.sara.id } } };
  const link = await cardDataEndpoint({ k: 'link' }, ctx);
  assert.equal(link.link, `https://t.me/${BOT}?start=a_${code}`);
  assert.equal(link.name, 'سارا 🌸');
  assert.equal(link.labels.send, '📩 بفرست به چت');
  const msgId = row("SELECT id FROM anon_msgs WHERE to_id = ? AND kind = 'text' AND folder = 0 LIMIT 1", U.sara.id).id;
  const msg = await cardDataEndpoint({ k: 'msg', id: msgId }, ctx);
  assert.equal(msg.kind, 'msg');
  assert.ok(!JSON.stringify(msg).includes(String(U.ali.id)) && !JSON.stringify(msg).includes('ali_t'), 'nothing about the sender');
  await assert.rejects(() => cardDataEndpoint({ k: 'msg', id: msgId }, { initData: { user: { id: U.ali.id } } }), /Not available/);
  await assert.rejects(() => cardDataEndpoint({ k: 'link' }, {}), /Open this from the bot/);
  const jpeg = new Uint8Array(4000);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  let b64 = '';
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < jpeg.length; i += 3) {
    const n = (jpeg[i] << 16) | ((jpeg[i + 1] || 0) << 8) | (jpeg[i + 2] || 0);
    b64 += B[(n >> 18) & 63] + B[(n >> 12) & 63] + (i + 1 < jpeg.length ? B[(n >> 6) & 63] : '=') + (i + 2 < jpeg.length ? B[n & 63] : '=');
  }
  const r = await cardSendEndpoint({ k: 'link', image: `data:image/jpeg;base64,${b64}` }, ctx);
  assert.equal(r.bytes, 4000);
  const photo = mock.state.media[mock.state.media.length - 1];
  assert.equal(photo.chat_id, U.sara.id);
  assert.deepEqual(photo.upload.head, [0xff, 0xd8, 0xff, 0xe0]);
  assert.match(photo.caption, /کارتت آماده است/);
  await assert.rejects(() => cardSendEndpoint({ k: 'link', image: 'bm90IGFuIGltYWdlIGF0IGFsbCwganVzdCB0ZXh0IHRoYXQgaXMgbG9uZyBlbm91Z2ggdG8gcGFzcyB0aGUgc2l6ZSBjaGVjayBmb3Igc3VyZSB5ZXM=' }, ctx), /Card not sent/);
});

await scenario('inline: an empty query offers the anonymous link to share', async () => {
  const inl = await inline(U.sara, '');
  assert.deepEqual(inl.results.map((r) => r.id), ['h.format', 'h.anon']);
  assert.equal(inl.results[1].reply_markup.inline_keyboard[0][0].url, `https://t.me/${BOT}?start=a_${code}`);
  assert.equal((await inline(U.ann, '')).results[1].title, '💬 My anonymous link');
});

await scenario('a non-member visitor: the join screen first, then straight to the profile card', async () => {
  const out = person(750000001, 'anon_out');
  await say(out, '/start');
  await press(out, 'L:fa');
  const lock = await say(out, `/start a_${code}`);
  assert.match(lock.text, /عضو این کانال‌ها شو/);
  join(out);
  const ok = await press(out, 'j');
  assert.ok(ok.calls.some((c) => c.method === 'sendPhoto' && /در حال ارسال پیام ناشناس به/.test(c.params.caption)));
  assert.equal(sentTo((await say(out, 'از طرف یک عضو جدید')).calls, U.sara.id).length, 1);
});

await scenario('a visitor whose first contact is the link (no language chosen) gets everything in their Telegram language, replies too', async () => {
  const olya = person(750000002, 'olya_t', 'ru', 'Оля');
  join(olya);
  advance(5);
  const open = await say(olya, `/start a_${code}`);
  assert.match(open.calls.find((c) => c.method === 'sendPhoto').params.caption, /Вы пишете анонимное сообщение для <b>سارا 🌸<\/b>/);
  const sent = await say(olya, 'Привет, это тест');
  ANON_SECRETS.add('Привет, это тест');
  const delivered = sentTo(sent.calls, U.sara.id)[0];
  assert.match(delivered.params.text, /^📨 <b>پیام ناشناس جدید<\/b>/, 'the recipient reads it in her own language');
  const ref = delivered.params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  await press(U.sara, `ar:${ref}`);
  const r = await say(U.sara, 'سلام اولیا');
  assert.match(sentTo(r.calls, olya.id)[0].params.text, /^↩️ <b>Ответ от سارا 🌸<\/b>/, 'a reply sent from someone else\'s update');
  assert.deepEqual([userRow(olya).lang, userRow(olya).tg_lang], [null, 'ru'], 'no language chosen; the Telegram one is remembered');
  assert.match((await say(olya, '/start')).text, /Choose the bot's language/, 'the picker still comes on a plain /start');
});

await scenario('delete my data: inbox, profile, photo, words, ratings erased; a fresh link', async () => {
  const ask = await press(U.sara, 'dd');
  assert.match(ask.text, /برگشت‌پذیر نیست/);
  const done = await press(U.sara, 'ddy');
  assert.match(done.text, /داده‌هایت پاک شد/);
  const u = userRow(U.sara);
  assert.equal(count(`SELECT count(*) AS n FROM anon_msgs WHERE to_id = ${U.sara.id}`), 0);
  assert.equal(count(`SELECT count(*) AS n FROM anon_words WHERE user_id = ${U.sara.id}`), 0);
  assert.equal(count(`SELECT count(*) AS n FROM ratings WHERE target_id = ${U.sara.id}`), 0);
  assert.deepEqual([u.p_name, u.p_bio, u.p_photo, u.inbox_size, u.anon_unread, u.rating_count], [null, null, null, 0, 0, 0]);
  assert.notEqual(u.anon_code, code);
  assert.match((await say(U.ali, `/start a_${code}`)).text, /معتبر نیست/);
});

// =====================================================================================
// Maintenance, errors, security
// =====================================================================================

await scenario('lazy cleanup: drafts older than 24h in batches of 20; filtered messages older than 30 days', async () => {
  for (let i = 0; i <= 30; i += 1) join(person(730000000 + i));
  for (let i = 0; i < 25; i += 1) await inline(person(730000000 + i, `d${i}`), `پیش‌نویس ${i} @Sara_T`);
  const link = linkRe.exec((await say(U.mina, '/link')).text)[1];
  advance(5);
  await say(U.reza, `/start a_${link}`);
  await say(U.reza, 'یه کیر کلفت');
  advance(31 * 86400);
  const r1 = await say(U.ali, '/help');
  assert.equal(r1.r.gc.drafts, 20);
  assert.ok(r1.r.gc.anon >= 1, `filtered purge ${JSON.stringify(r1.r.gc)}`);
  assert.equal((await say(U.ali, '/help')).r.gc, undefined, 'at most once per 10 minutes');
});

await scenario('the filter catches evasions and leaves innocent words alone', async () => {
  for (const w of ['کـــیر', 'مادر جنده', 'ک ی ر', 'fuuuck', 'f*ck', 'sh1t', 'ASSHOLE', 'Bitch!', 'xуй', 'похуй', 'пиздец', 'долбоёб']) assert.ok(isOffensive(normalize(w)), `missed ${w}`);
  for (const w of ['هیچ کس نیامد', 'کسی اینجا نیست', 'تخم مرغ', 'себе', 'мандарин', 'рубля', 'колебаться', 'Scunthorpe', 'cocktail party', 'I passed the class']) assert.ok(!isOffensive(normalize(w)), `false positive ${w}`);
});

await scenario('groups ignored; a raw error never reaches a user; every press answered', async () => {
  assert.equal(track(await onMessage({ message_id: 1, from: U.ali, chat: { id: -100555, type: 'supergroup' }, date: nowSec(), text: '/start' }, {})).trace.length, 0);
  const orig = db.get;
  db.get = async () => {
    db.get = orig;
    throw new Error('D1_ERROR: simulated outage');
  };
  since();
  const r = await onCallback({ id: `cb${seq++}`, from: U.ali, chat_instance: '1', data: 'st', message: { message_id: lastBotMessage(U.ali.id), chat: { id: U.ali.id, type: 'private' }, date: nowSec() } }, {});
  const calls = since();
  assert.match(calls.find((c) => c.method === 'answerCallbackQuery').params.text, /خطایی پیش آمد/);
  assert.ok(!JSON.stringify(calls.map((c) => c.params)).includes('simulated outage'));
  assert.match(r.error, /simulated outage/);
  errors.length = 0;
  assert.match((await press(U.sara, 'zz:1')).answer.text, /قدیمی/);
});

await scenario('security: whisper and anonymous texts never in callback_data or traces; Telegram rejected nothing unexpected', async () => {
  const leaks = [];
  for (const c of mock.state.calls) {
    const kb = JSON.stringify(c.params.reply_markup || (c.params.results || []).map((x) => x.reply_markup) || '');
    const posted = [...(c.params.results || []).map((x) => x.input_message_content.message_text), c.params.inline_message_id ? c.params.text : ''].join('\n');
    for (const s of [...SECRETS, ...ANON_SECRETS]) {
      if (kb.includes(s)) leaks.push(`${c.method} keyboard has "${s.slice(0, 20)}"`);
      if (posted.includes(s)) leaks.push(`${c.method} posted message has "${s.slice(0, 20)}"`);
    }
    for (const b of buttons(c.params.reply_markup && c.params.reply_markup.inline_keyboard)) {
      if (b.callback_data && !/^[\x20-\x7e]{1,64}$/.test(b.callback_data)) leaks.push(`bad callback_data ${b.callback_data}`);
    }
  }
  const traces = JSON.stringify(results);
  for (const s of [...SECRETS, ...ANON_SECRETS]) if (traces.includes(s)) leaks.push(`trace has "${s.slice(0, 20)}"`);
  assert.deepEqual(leaks, []);
  const rejected = mock.state.calls.filter((c) => !c.result.ok
    && !['getChatMember', 'copyMessage', 'sendMessage', 'answerCallbackQuery', 'getChat'].includes(c.method)
    && !/message is not modified/.test(c.result.description));
  assert.deepEqual(rejected.map((c) => `${c.method}: ${c.result.description}`), []);
  const badSends = mock.state.calls.filter((c) => ['sendMessage', 'copyMessage', 'sendPhoto'].includes(c.method) && !c.result.ok && c.result.error_code === 400 && !/can't be copied|chat not found/.test(c.result.description));
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
