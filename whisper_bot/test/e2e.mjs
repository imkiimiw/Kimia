// End-to-end test: the real handlers and endpoints (tgcloud/) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a strict mock Bot API.
// Run: npm test   (the local check; test/cloud/run-tests.mjs runs the scenarios on Telegram Serverless)
import assert from 'node:assert/strict';
import http from 'node:http';
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
mock.addChat('wake_room', { title: 'Wake room' }); // the owner's private channel for the bot's wakes
mock.addChat('confess_room', { title: 'Confessions' }); // the confession channel
mock.addChat('qbox_chan', { title: 'Q Channel' }); // a user's channel with a question box
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
const { default: inboxEndpoint } = await import('../tgcloud/endpoints/inbox.js');
const { default: onPoll } = await import('../tgcloud/handlers/poll.js');
const { default: onChannelPost } = await import('../tgcloud/handlers/channel_post.js');
const { wakeSoon } = await import('../tgcloud/lib/wake.js');
const { createCtx } = await import('../tgcloud/lib/tg.js');

const errors = [];
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
// expected Bot API failures are logged as warnings; SHOW_WARN=1 prints them
console.warn = (...args) => { if (process.env.SHOW_WARN) process.stderr.write(`warn: ${args.join(' ')}\n`); };

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
  mock.seedMessage(u.id, message.message_id, text || '…'); // the user's message is in the chat (the bot may delete it)
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

/**
 * Telegram's side of the bot waking itself up: every poll the bot stopped comes back as a `poll`
 * update. Delivers them (and the ones those runs stop in turn) until none is left.
 */
let pollMark = 0;
async function deliverWakes(max = 200) {
  since();
  let n = 0;
  while (pollMark < mock.state.stoppedPolls.length && n < max) {
    const poll = mock.state.stoppedPolls[pollMark++];
    track(await onPoll(poll, { update: { update_id: seq++, poll } }));
    n += 1;
  }
  return { n, calls: since() };
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
  assert.match(fa.text, /🎲 <b>چت تصادفی<\/b>/);
  assert.deepEqual(dataOf(fa.kb).slice(0, 2), ['ws', 'an']);
  assert.equal(userRow(U.owner).lang, 'fa');
  await say(U.ivan, '/start');
  const ru = await press(U.ivan, 'L:ru');
  assert.match(ru.text, /Случайный чат/);
  assert.equal(buttons(ru.kb)[0].text, '🤫 Шёпот');
  await say(U.ann, '/start');
  const en = await press(U.ann, 'L:en');
  assert.match(en.text, /Random chat/);
  const again = await say(U.ann, '/lang');
  assert.deepEqual(dataOf(again.kb), ['L:fa', 'L:en', 'L:ru']);
  for (const u of [U.ali, U.reza, U.sara, U.mina]) await onboard(u);
  const second = await say(U.ali, '/start');
  assert.match(second.text, /🎲 <b>چت تصادفی<\/b>/, 'no picker once chosen');
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
  assert.match(ok.text, /🎲 <b>چت تصادفی<\/b>/);
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
  assert.deepEqual(dataOf(p.kb), ['a:ch', 'a:add', 'a:j', 'a:ban', 'a:unban', 'a:st', 'a:rp', 'a:cf', 'a:bc', 'a:ad', 'a:cfs', 'a:wk', 'a:hl', 'a:ai']);
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
// Scheduler: the bot waking itself up (lib/wake.js), the wake channel, the outside clock
// =====================================================================================

const wakeRoom = mock.state.chats.get('@wake_room').id;
const reachableNow = () => rows('SELECT user_id FROM users WHERE started = 1 AND active = 1 AND banned = 0 AND user_id != ?', OWNER).map((r) => r.user_id);
const ownerPolls = () => [...mock.state.messages.entries()].filter(([k, m]) => k.startsWith(`${OWNER}:`) && m.poll).length;

/** The owner starts a text broadcast: the first batch goes at once. */
async function startBroadcast(text) {
  await press(U.owner, 'a:bc');
  const draft = await say(U.owner, text);
  const id = Number(dataOf(draft.kb)[0].split(':')[2]);
  const start = await press(U.owner, `a:bcy:${id}`);
  return { id, start, mid: draft.message.message_id };
}

await scenario('self-wake: one press and a broadcast runs to the end by itself; wake polls are silent and leave nothing behind', async () => {
  await deliverWakes(); // wakes the earlier broadcast scenario left pending
  advance(61);
  const reachable = reachableNow();
  const { id, start, mid } = await startBroadcast('پیام سراسری که خودش تا آخر می‌رود');
  assert.equal(start.calls.filter((c) => c.method === 'copyMessage' && c.params.chat_id !== OWNER).length, 25);
  const poll = start.calls.find((c) => c.method === 'sendPoll');
  assert.ok(poll, 'the first batch wakes the bot for the next');
  assert.equal(Number(poll.params.chat_id), OWNER);
  assert.equal(poll.params.disable_notification, true);
  assert.ok(start.calls.some((c) => c.method === 'stopPoll'));
  assert.ok(start.calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === poll.result.result.message_id), 'the poll is deleted');
  const { n, calls } = await deliverWakes();
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', id).status, 'done', 'done without another press');
  // the owner takes a slot in the queue (skipped: they saw the preview); a batch short of 25 ends it
  assert.equal(n, Math.floor((reachable.length + 1) / 25), 'one wake per remaining batch');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === OWNER && /گزارش نهایی/.test(c.params.text)), 'final report');
  const got = mock.state.copied.filter((c) => c.from_chat_id === OWNER && c.message_id === mid && c.chat_id !== OWNER).map((c) => c.chat_id);
  assert.deepEqual([...got].sort((x, y) => x - y), [...reachable].sort((x, y) => x - y), 'everyone, once');
  assert.equal(ownerPolls(), 0, 'no poll left in the owner\'s chat');
  assert.equal(row("SELECT value FROM kv WHERE key = 'wake_poll'").value, '', 'no wake pending');
});

await scenario('self-wake guards: foreign or repeated poll updates do nothing; one wake at a time; the hourly cap', async () => {
  assert.equal(track(await onPoll({ id: '42', is_closed: true }, {})).wake, undefined, 'not our poll');
  for (let i = 0; i < 40; i += 1) { // enough recipients for several batches
    const u = person(770000000 + i, `more${i}`);
    join(u);
    await onboard(u);
  }
  const { id } = await startBroadcast('آزمایش نگهبان‌ها');
  assert.equal(mock.state.stoppedPolls.length - pollMark, 1, 'one wake pending');
  advance(5);
  const side = await inline(U.ali, 'یک نجوا @Sara_T');
  assert.equal(side.calls.filter((c) => c.method === 'copyMessage').length, 5, 'a chunk on the side of a user\'s update');
  assert.equal(side.calls.filter((c) => c.method === 'sendPoll').length, 0, 'no second wake while one is pending');
  const pending = mock.state.stoppedPolls[pollMark];
  const hour = Math.floor(nowSec() / 3600);
  rawDatabase().prepare("UPDATE kv SET value = ? WHERE key = 'wake_rate'").run(`${hour}:600`);
  const first = await deliverWakes(1);
  assert.equal(first.n, 1);
  assert.ok(first.calls.filter((c) => c.method === 'copyMessage').length > 5, 'a woken step sends a full batch, not a side chunk');
  assert.equal(first.calls.filter((c) => c.method === 'sendPoll').length, 0, 'over the hourly cap: no new wake');
  assert.equal(track(await onPoll(pending, {})).wake, undefined, 'a repeated delivery does nothing');
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', id).status, 'running', 'it waits for the next update');
  rawDatabase().prepare("DELETE FROM kv WHERE key = 'wake_rate'").run();
  advance(5);
  const resumed = await press(U.owner, `a:bcc:${id}`);
  assert.ok(resumed.calls.some((c) => c.method === 'sendPoll'), 'the next run wakes again');
  await deliverWakes();
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', id).status, 'done');
});

await scenario('the scheduler page; wakes move to a private channel picked by a forwarded post, then back to the private chat', async () => {
  const page = await press(U.owner, 'a:wk');
  assert.match(page.text, /زمان‌بند/);
  assert.match(page.text, /جای بیدارباش:<\/b> چت خودت با ربات/);
  assert.doesNotMatch(page.text, /آخرین بیدارباش:<\/b> هنوز نه/, 'it has woken');
  assert.match(page.text, /ساعت بیرونی:<\/b> وصل نیست/);
  assert.deepEqual(dataOf(page.kb), ['a:wkc', 'a:wkg', 'a']);
  assert.match((await press(U.owner, 'a:wkg')).text, /اول یک کانال برای بیدارباش انتخاب کن/);
  assert.match((await press(U.ali, 'a:wk')).answer.text, /فقط برای مالک/);
  await press(U.owner, 'a:wkc');
  assert.match((await say(U.owner, 'سلام')).text, /پیدا نکردم/);
  rawDatabase().prepare("DELETE FROM kv WHERE key = 'wake_rate'").run(); // whatever an earlier scenario left
  const notAdmin = mock.state.chats.get('@not_admin_chan');
  assert.match((await say(U.owner, 'فوروارد', { forward_origin: { type: 'channel', chat: { id: notAdmin.id, type: 'channel', title: notAdmin.title }, message_id: 1, date: nowSec() } })).text, /ادمین نیست/);
  const saved = await say(U.owner, 'فوروارد', { forward_origin: { type: 'channel', chat: { id: wakeRoom, type: 'channel', title: 'Wake room' }, message_id: 1, date: nowSec() } });
  assert.match(saved.text, /بیدارباش‌ها در «Wake room» است/);
  assert.equal(Number(row("SELECT value FROM kv WHERE key = 'wake_chat'").value), wakeRoom);
  assert.ok(dataOf(saved.kb).includes('a:wkp'));
  const guide = await press(U.owner, 'a:wkg');
  assert.ok(guide.text.includes(`chat_id=${wakeRoom}&amp;text=tick`), 'the address to call, for this channel');
  assert.ok(guide.last.result.ok, 'Telegram accepted the HTML');
  advance(61);
  since();
  assert.equal(await wakeSoon(createCtx({}), 'test'), true);
  const calls = since();
  assert.equal(Number(calls.find((c) => c.method === 'sendPoll').params.chat_id), wakeRoom, 'wakes go to the channel');
  await deliverWakes();
  assert.match((await press(U.owner, 'a:wkp')).text, /دوباره در چت خودت است/);
  assert.equal(row("SELECT value FROM kv WHERE key = 'wake_chat'").value, null);
});

await scenario('outside clock: a post in the wake channel runs a full step and is deleted; other posts don\'t tick', async () => {
  rawDatabase().prepare("UPDATE kv SET value = ? WHERE key = 'wake_chat'").run(String(wakeRoom));
  const { id } = await startBroadcast('تیک ساعت بیرونی');
  mock.state.stoppedPolls.length = pollMark; // Telegram lost that wake: the outside clock has to move it
  advance(61);
  mock.seedMessage(wakeRoom, 9001);
  since();
  const tick = track(await onChannelPost({ message_id: 9001, chat: { id: wakeRoom, type: 'channel' }, date: nowSec(), text: 'tick' }, {}));
  const calls = since();
  assert.equal(tick.wake, 'tick');
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === 9001), 'the tick post is deleted');
  assert.ok(calls.filter((c) => c.method === 'copyMessage').length > 5, 'a full batch, not a side chunk');
  assert.ok(Number(row("SELECT value FROM kv WHERE key = 'tick_last'").value) > 0);
  assert.equal(track(await onChannelPost({ message_id: 9002, chat: { id: wakeRoom, type: 'channel' }, date: nowSec(), poll: { id: '1', is_closed: true } }, {})).wake, undefined, 'a poll is not a tick');
  const other = mock.state.chats.get('@hide_i_seek').id;
  assert.equal(track(await onChannelPost({ message_id: 5, chat: { id: other, type: 'channel' }, date: nowSec(), text: 'خبر' }, {})).wake, undefined, 'posts elsewhere don\'t tick');
  await deliverWakes();
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', id).status, 'done');
  assert.match((await press(U.owner, 'a:wk')).text, /ساعت بیرونی:<\/b> آخرین تیک/);
  rawDatabase().prepare("UPDATE kv SET value = NULL WHERE key = 'wake_chat'").run();
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
  assert.deepEqual(dataOf(sec.kb), ['al', 'ib:0:-:0', 'qd', 'cd', 'pf', 'fs', 'qb', 'as', 'm']);
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
  assert.deepEqual(dataOf(delivered.params.reply_markup.inline_keyboard), [`ar:${firstRef}`, `ab:${firstRef}`, `ap:${firstRef}`, `iv:${firstRef}`,
    ...[0, 1, 2, 3, 4].map((i) => `ae:${firstRef}:${i}`)]);
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
  // phone numbers (someone else's, often): hidden by default, and the receiver can turn it off
  advance(5);
  await say(U.ann, `/start a_${code}`);
  assert.equal((await say(U.ann, 'call me 0912 345 6789')).r.filtered, 'phone');
  const fs = await press(U.sara, 'fs');
  assert.ok(buttons(fs.kb).some((b) => b.callback_data === 'fs:p' && /فیلتر شماره تلفن: روشن/.test(b.text)));
  await press(U.sara, 'fs:p');
  assert.equal(userRow(U.sara).a_phone, 0);
  advance(5);
  await say(U.ann, `/start a_${code}`);
  const ph = await say(U.ann, 'my number is +7 912 345 67 89');
  assert.equal(ph.r.filtered, undefined);
  assert.equal(sentTo(ph.calls, U.sara.id).length, 1, 'delivered');
  await press(U.sara, 'fs:p');
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
// Admins (lib/staff.js)
// =====================================================================================

const permsOf = (u) => (row('SELECT perms FROM admins WHERE user_id = ?', u.id) || {}).perms;
const fwdFrom = (u) => ({ forward_origin: { type: 'user', sender_user: { id: u.id, is_bot: false, first_name: u.first_name }, date: nowSec() } });

await scenario('admins: the owner adds one from a forwarded message; the admin sees and may use only what they were given', async () => {
  assert.match((await press(U.owner, 'a:ad')).text, /ادمین‌ها<\/b> \(۰ از ۲۰\)/);
  await press(U.owner, 'a:adn');
  assert.match((await say(U.owner, 'hello there')).text, /نشناختم/);
  const added = await say(U.owner, 'fwd', fwdFrom(U.reza));
  assert.match(added.text, /ادمین شد/);
  assert.ok(sentTo(added.calls, U.reza.id).some((c) => /تو را ادمین کرد/.test(c.params.text)), 'the new admin is told');
  assert.equal(permsOf(U.reza), 'cf,rp,ban,st');
  const panel = await say(U.reza, '/admin');
  assert.match(panel.text, /پنل ادمین/);
  assert.deepEqual(dataOf(panel.kb), ['a:ban', 'a:unban', 'a:st', 'a:rp', 'a:cf']);
  for (const d of ['a:ch', 'a:add', 'a:j', 'a:bc', 'a:ad', 'a:adn', 'a:wk', 'a:hl', 'a:cfs', `a:adp:${U.reza.id}:bc`]) {
    assert.match((await press(U.reza, d)).answer.text, /دسترسی‌های تو نیست/, d);
  }
  assert.match((await press(U.reza, 'a:st')).text, /آمار/);
  await press(U.owner, `a:adp:${U.reza.id}:bc`);
  assert.equal(permsOf(U.reza), 'cf,rp,ban,st,bc');
  assert.ok(dataOf((await say(U.reza, '/admin')).kb).includes('a:bc'));
  await press(U.owner, `a:adp:${U.reza.id}:ban`);
  assert.match((await press(U.reza, 'a:ban')).answer.text, /دسترسی‌های تو نیست/, 'turned off');
  await press(U.owner, `a:adp:${U.reza.id}:ban`);
  // a second admin, by numeric id; admins can't ban each other or the owner
  await press(U.owner, 'a:adn');
  assert.match((await say(U.owner, String(U.mina.id))).text, /ادمین شد/);
  await press(U.owner, `a:adp:${U.mina.id}:ban`);
  assert.equal(permsOf(U.mina), 'cf,rp,st');
  await press(U.reza, 'a:ban');
  assert.match((await say(U.reza, String(U.mina.id))).text, /فقط مالک/);
  await press(U.reza, 'a:ban');
  assert.match((await say(U.reza, String(OWNER))).text, /مالک را نمی‌شود بن کرد/);
  await press(U.owner, 'a:adn');
  assert.match((await say(U.owner, String(U.reza.id))).text, /از قبل ادمین است/);
  // removing: the panel closes for them, and a pending admin input of theirs does nothing
  await press(U.reza, 'a:ban');
  await press(U.owner, `a:adx:${U.reza.id}`);
  assert.match((await press(U.owner, `a:adxy:${U.reza.id}`)).text, /دیگر ادمین نیست/);
  assert.match((await say(U.reza, String(U.nima.id))).text, /یکی از بخش‌ها را انتخاب کن/, 'the stale state is dropped');
  assert.equal(userRow(U.nima).banned, 0);
  assert.match((await say(U.reza, '/admin')).text, /فقط برای مالک و ادمین‌های/);
  assert.match((await press(U.reza, 'a:st')).answer.text, /فقط برای مالک/);
});

await scenario('broadcast by an admin, to one language, with a link button: only those users get it; the report goes to the admin', async () => {
  const { parseButton } = await import('../tgcloud/lib/admin.js');
  assert.deepEqual(parseButton('Site | example.com/x'), { text: 'Site', url: 'https://example.com/x' });
  assert.deepEqual(parseButton('کانال ما\nt.me/wangerBots'), { text: 'کانال ما', url: 'https://t.me/wangerBots' });
  for (const bad of ['no link here', 'x | javascript:alert(1)', 'x | ftp://a.b', ' | https://a.b', `${'x'.repeat(65)} | https://a.b`]) assert.equal(parseButton(bad), null, bad);
  await deliverWakes();
  advance(61);
  const faNum = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  assert.match((await press(U.mina, 'a:bc')).answer.text, /دسترسی‌های تو نیست/);
  await press(U.owner, `a:adp:${U.mina.id}:bc`);
  await press(U.mina, 'a:bc');
  const draft = await say(U.mina, 'Hello, English speakers!');
  const id = Number(dataOf(draft.kb)[0].split(':')[2]);
  assert.deepEqual(dataOf(draft.kb), ['all', 'fa', 'en', 'ru'].map((a) => `a:bca:${id}:${a}`).concat([`a:bcb:${id}`, `a:bcy:${id}`, `a:bcn:${id}`]));
  assert.match(draft.text, /مخاطب‌ها: 👥 همه\n🔗 دکمه: ندارد/);
  const en = rows("SELECT user_id FROM users WHERE blang = 'en' AND started = 1 AND active = 1 AND banned = 0").map((r) => r.user_id);
  assert.ok(en.length >= 1 && !en.includes(U.mina.id));
  const pick = await press(U.mina, `a:bca:${id}:en`);
  assert.match(pick.text, new RegExp(`حدود <b>${faNum(en.length)}</b> کاربر[\\s\\S]*مخاطب‌ها: 🇬🇧 English`));
  assert.equal(buttons(pick.kb)[2].text, '✅ 🇬🇧 English');
  assert.equal(row('SELECT lang FROM broadcasts WHERE id = ?', id).lang, 'en');
  await press(U.mina, `a:bcb:${id}`);
  assert.match((await say(U.mina, 'no link here')).text, /این‌طور بفرست/);
  const withBtn = await say(U.mina, 'Our channel | @wangerBots');
  const preview = withBtn.calls.find((c) => c.method === 'copyMessage');
  assert.deepEqual(preview.params.reply_markup.inline_keyboard, [[{ text: 'Our channel', url: 'https://t.me/wangerBots' }]]);
  assert.match(withBtn.text, /دکمه اضافه شد[\s\S]*«Our channel» ← https:\/\/t\.me\/wangerBots/);
  assert.ok(dataOf(withBtn.kb).includes(`a:bcbx:${id}`));
  const go = await press(U.mina, `a:bcy:${id}`);
  const wakes = await deliverWakes();
  assert.equal(row('SELECT status FROM broadcasts WHERE id = ?', id).status, 'done');
  const got = mock.state.copied.filter((c) => c.from_chat_id === U.mina.id && c.message_id === draft.message.message_id && c.chat_id !== U.mina.id);
  assert.deepEqual(got.map((c) => c.chat_id).sort((x, y) => x - y), [...en].sort((x, y) => x - y), 'the English speakers, once each');
  assert.ok(got.every((c) => c.reply_markup.inline_keyboard[0][0].url === 'https://t.me/wangerBots'), 'with the button');
  const all = [...go.calls, ...wakes.calls];
  assert.ok(sentTo(all, U.mina.id).some((c) => /گزارش نهایی/.test(c.params.text)), 'the report goes to whoever started it');
  assert.ok(!sentTo(all, OWNER).some((c) => /گزارش نهایی/.test(c.params.text)));
  await press(U.owner, `a:adp:${U.mina.id}:bc`);
});

await scenario('join stats: a channel the join screen showed as missing counts once when the person joins it', async () => {
  const chans = rows('SELECT id, username, joins FROM channels ORDER BY id');
  const checked = chans.filter((c) => mock.state.botAdmin.has(`@${c.username.toLowerCase()}`));
  assert.ok(checked.length >= 2, 'channels the bot can check');
  const joinsOf = () => Object.fromEntries(rows('SELECT id, joins FROM channels').map((c) => [c.id, c.joins]));
  const before = joinsOf();
  const u = person(793000001, 'jn_t');
  await say(u, '/start');
  const lock = await press(u, 'L:fa');
  assert.ok(dataOf(lock.kb).includes('j'), 'the join screen');
  assert.deepEqual(JSON.parse(userRow(u).join_missing), checked.map((c) => c.id));
  mock.setMember(checked[0].username, u.id, { status: 'member' });
  assert.match((await press(u, 'j')).answer.text, /هنوز/);
  assert.deepEqual(JSON.parse(userRow(u).join_missing), checked.slice(1).map((c) => c.id));
  for (const c of checked.slice(1)) mock.setMember(c.username, u.id, { status: 'member' });
  await press(u, 'j');
  assert.equal(userRow(u).join_missing, null);
  await press(u, 'j');
  advance(3600);
  await say(u, '/start');
  const after = joinsOf();
  for (const c of chans) assert.equal(after[c.id] - before[c.id], checked.some((x) => x.id === c.id) ? 1 : 0, `@${c.username}`);
  const health = await press(U.owner, 'a:hl');
  assert.match(health.text, new RegExp(`@${checked[0].username} · ${String(after[checked[0].id]).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])} عضو از طریق ربات`));
  assert.match((await press(U.owner, 'a:ch')).text, /عضو از طریق ربات/);
});

await scenario('link views: "👀 N people opened your link today", once per person per day; the owner\'s own visits don\'t count', async () => {
  const host = person(794000001, 'lv_host');
  join(host);
  await onboard(host);
  const code = /start=a_(\w+)/.exec((await say(host, '/link')).text)[1];
  assert.match((await say(host, '/link')).text, /👀 امروز ۰ نفر لینکت را باز کردند · در کل ۰/);
  await say(host, `/start a_${code}`); // their own link: not a visit
  for (const u of [U.ali, U.reza, U.ali]) {
    await say(u, `/start a_${code}`);
    await say(u, '/cancel');
  }
  assert.deepEqual([userRow(host).lv_today, userRow(host).lv_total], [2, 2], 'ali twice = once');
  assert.match((await press(host, 'an')).text, /👀 امروز ۲ نفر لینکت را باز کردند · در کل ۲/);
  advance(86400);
  await say(U.ali, `/start a_${code}`);
  await say(U.ali, '/cancel');
  assert.match((await say(host, '/link')).text, /👀 امروز ۱ نفر لینکت را باز کردند · در کل ۳/, 'a new day');
  advance(86400);
  assert.match((await press(host, 'an')).text, /👀 امروز ۰ نفر لینکت را باز کردند · در کل ۳/, 'nobody yet today');
  assert.equal(count(`SELECT count(*) AS n FROM link_visits WHERE owner_id = ${host.id}`), 1, 'the lazy cleanup keeps only yesterday\'s and today\'s rows');
});

await scenario('reactions: the recipient reacts under the message or in the inbox; the sender sees it on their own message', async () => {
  const host = person(795000001, 'rx_host');
  join(host);
  await onboard(host);
  const code = /start=a_(\w+)/.exec((await say(host, '/link')).text)[1];
  advance(5);
  await say(U.reza, `/start a_${code}`);
  const text = 'یک پیام برای واکنش';
  ANON_SECRETS.add(text);
  const sent = await say(U.reza, text);
  const delivered = sentTo(sent.calls, host.id)[0];
  const mid = delivered.result.result.message_id;
  const kb = delivered.params.reply_markup.inline_keyboard;
  const ref = kb[0][0].callback_data.slice(3);
  assert.deepEqual(kb[2].map((b) => b.text), ['❤', '🔥', '🤣', '😱', '😢']);
  const r1 = await press(host, `ae:${ref}:0`, { messageId: mid });
  assert.match(r1.answer.text, /❤/);
  const rx = r1.calls.find((c) => c.method === 'setMessageReaction');
  assert.deepEqual([Number(rx.params.chat_id), rx.params.message_id, rx.params.reaction], [U.reza.id, sent.message.message_id, [{ type: 'emoji', emoji: '❤' }]]);
  assert.ok(rx.result.ok);
  noTrace(r1.calls, U.reza.id, host);
  assert.equal(r1.calls.find((c) => c.method === 'editMessageReplyMarkup').params.reply_markup.inline_keyboard[2][0].text, '❤✓');
  assert.equal(row('SELECT reaction FROM anon_msgs WHERE id = ?', ref).reaction, '❤');
  // in the inbox view: another one replaces it; the same again takes it back
  const v = await press(host, `iv:${ref}`, { messageId: mid });
  assert.ok(dataOf(v.kb).includes(`ae:${ref}:1:i`));
  assert.ok(buttons(v.kb).some((b) => b.text === '❤✓'));
  const r2 = await press(host, `ae:${ref}:1:i`, { messageId: mid });
  assert.deepEqual(r2.calls.find((c) => c.method === 'setMessageReaction').params.reaction, [{ type: 'emoji', emoji: '🔥' }]);
  assert.ok(buttons(r2.kb).some((b) => b.text === '🔥✓'), 'the inbox view, again');
  const r3 = await press(host, `ae:${ref}:1:i`, { messageId: mid });
  assert.deepEqual(r3.calls.find((c) => c.method === 'setMessageReaction').params.reaction, []);
  assert.equal(row('SELECT reaction FROM anon_msgs WHERE id = ?', ref).reaction, null);
  // the sender deleted their message: the first reaction is told in a line instead, once
  mock.state.goneMessages.add(`${U.reza.id}:${sent.message.message_id}`);
  const r4 = await press(host, `ae:${ref}:3`, { messageId: mid });
  assert.match(textsTo(r4.calls, U.reza.id), /😱 یک واکنش به پیامی که فرستادی/);
  noTrace(r4.calls, U.reza.id, host);
  const r5 = await press(host, `ae:${ref}:4`, { messageId: mid });
  assert.equal(sentTo(r5.calls, U.reza.id).length, 0, 'changing it doesn\'t notify again');
  assert.match((await press(U.ali, `ae:${ref}:0`)).answer.text, /دیگر در دسترس نیست/, 'only the recipient');
});

const faDigits = (s) => String(s).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

await scenario('time capsule: ">HH:MM" — the recipient can\'t open it before then (Tehran time); the sender can; history keeps it sealed', async () => {
  const s = person(796000001, 'cap_s');
  const r = person(796000002, 'cap_r');
  for (const u of [s, r]) {
    join(u);
    await onboard(u);
  }
  const now = nowSec();
  const h = (new Date((now + 210 * 60) * 1000).getUTCHours() + 2) % 24; // about two hours from now
  const at = `${String(h).padStart(2, '0')}:00`;
  const text = 'کپسول زمان برای بعد';
  SECRETS.add(text);
  const inl = await inline(s, `${text} @cap_r >${at}`);
  const res = mainResult(inl);
  assert.match(res.input_message_content.message_text, new RegExp(`⏰ باز می‌شود ساعت ${faDigits(at)} \\(به وقت تهران\\)`));
  assert.match(res.description, new RegExp(`⏰ ${faDigits(at)}`));
  const { inlineId } = await post(s, inl, res.id);
  const wid = widOf(res.id);
  const opensAt = row('SELECT opens_at FROM whispers WHERE id = ?', wid).opens_at;
  assert.ok(opensAt > now + 3600 && opensAt <= now + 2 * 3600, `${opensAt - now}`);
  const early = await press(r, `s:${wid}`, { inlineId });
  assert.match(early.answer.text, new RegExp(`ساعت ${faDigits(at)} باز می‌شود — .+ دیگر`));
  assert.equal(row('SELECT seen_at FROM whisper_rcpts WHERE whisper_id = ?', wid).seen_at, 0, 'not opened');
  assert.match((await say(r, `/start w_${wid}`)).text, /باز می‌شود/, 'nor through the deep link');
  assert.equal((await press(s, `s:${wid}`, { inlineId })).answer.text, text, 'the sender can');
  const hist = await press(r, 'h:r:0');
  assert.match(hist.text, /⏰ باز می‌شود ساعت/);
  assert.ok(!hist.text.includes(text));
  assert.ok(!(await press(r, `d:${wid}`)).text.includes(text), 'details too');
  advance(opensAt - nowSec() + 30);
  assert.equal((await press(r, `s:${wid}`, { inlineId })).answer.text, text);
  assert.ok((await press(r, 'h:r:0')).text.includes(text));
  assert.equal((await inline(s, 'سلام @cap_r >25:00')).results[0].id, 'h.bad_capsule');
  const plain = mainResult(await inline(s, 'بیشتر از >5 نفر @cap_r'));
  assert.ok(!plain.input_message_content.message_text.includes('⏰'), '">5" stays text');
  assert.match(mainResult(await inline(s, 'باشه @cap_r ⏰۲۱')).input_message_content.message_text, /⏰ باز می‌شود ساعت ۲۱:۰۰/, 'Persian digits, ⏰');
});

await scenario('media whisper: made in the bot, posted with the inline query; opens in the bot, protected, for the recipients only', async () => {
  const s = person(797000001, 'mw_s');
  const r = person(797000002, 'mw_r');
  const x = person(797000003, 'mw_x');
  for (const u of [s, r, x]) {
    join(u);
    await onboard(u);
  }
  assert.ok(dataOf((await press(s, 'ws')).kb).includes('wm'));
  await press(s, 'wm');
  assert.match((await say(s, 'just text')).text, /یک عکس، ویدیو، ویس یا فایل بفرست/);
  const voice = { voice: { file_id: 'AwACvoice1', file_unique_id: 'v1', duration: 3 } };
  assert.match((await say(s, undefined, voice)).text, /برای چه کسی است/);
  assert.match((await say(s, 'no one here')).text, /گیرنده را ننوشتی/);
  const body = 'گوش کن 🎧';
  SECRETS.add(body);
  const ready = await say(s, `!${body} @mw_r`);
  assert.match(ready.text, /آماده است: 🎤 ویس برای @mw_r\n🔥 یک‌بار مصرف/);
  const wid = ready.r.trace.find((e) => e.view === 'wmedia_ready').meta.id;
  assert.equal(buttons(ready.kb).find((b) => b.switch_inline_query !== undefined).switch_inline_query, `mw_${wid}`);
  const w = row('SELECT kind, file_id, body, once, inline_id FROM whispers WHERE id = ?', wid);
  assert.deepEqual([w.kind, w.file_id, w.body, w.once, w.inline_id], ['voice', 'AwACvoice1', body, 1, null]);
  // posting: one result for the sender; nobody else can post it
  const inl = await inline(s, `mw_${wid}`);
  assert.deepEqual(inl.results.map((x0) => x0.id), [`m.${wid}`]);
  const posted = inl.results[0].input_message_content.message_text;
  assert.match(posted, /یک نجوا برای @mw_r\n🎤 ویس — در ربات باز می‌شود\n🔥 یک‌بار مصرف/);
  assert.deepEqual(buttons(inl.results[0].reply_markup.inline_keyboard).map((b) => b.callback_data || b.url), [`s:${wid}`, `https://t.me/${BOT}?start=w_${wid}`]);
  assert.equal((await inline(x, `mw_${wid}`)).results[0].id, 'h.media_gone');
  const { inlineId } = await post(s, inl, `m.${wid}`);
  assert.equal(row('SELECT inline_id FROM whispers WHERE id = ?', wid).inline_id, inlineId);
  assert.equal((await inline(s, `mw_${wid}`)).results[0].id, 'h.media_posted', 'posted once');
  // a stranger is curious; the recipient's press opens the bot
  assert.match((await press(x, `s:${wid}`, { inlineId })).answer.text, /مال تو نیست/);
  assert.equal((await press(r, `s:${wid}`, { inlineId })).answer.url, `https://t.me/${BOT}?start=w_${wid}`);
  assert.match((await say(x, `/start w_${wid}`)).text, /مال تو نیست/);
  const open = await say(r, `/start w_${wid}`);
  const v = open.calls.find((c) => c.method === 'sendVoice');
  assert.ok(v && v.params.voice === 'AwACvoice1' && v.params.protect_content === true, 'sent protected');
  assert.ok(v.params.caption.includes(body));
  assert.match(textsTo(open.calls, s.id), /@mw_r نجوای شما را باز کرد/);
  assert.equal(row('SELECT state, file_id FROM whispers WHERE id = ?', wid).state, 1, 'one-time: burned');
  assert.equal(row('SELECT file_id FROM whispers WHERE id = ?', wid).file_id, null);
  assert.match((await say(r, `/start w_${wid}`)).text, /سوزانده شده/);
  // a photo with everything in the caption; the sender opens it from the details
  await press(s, 'wm');
  const photo = await say(s, undefined, { photo: [{ file_id: 'AgACmw', file_unique_id: 'mw1', width: 9, height: 9 }], caption: 'برای تو @mw_r 1h' });
  const wid2 = photo.r.trace.find((e) => e.view === 'wmedia_ready').meta.id;
  assert.match(photo.text, /🖼 عکس برای @mw_r\n⏳ مهلت باز کردن: ۱ ساعت/);
  const det = await press(s, `d:${wid2}`);
  assert.ok(dataOf(det.kb).includes(`wo:${wid2}`));
  assert.match(det.text, /🖼 عکس — برای تو/);
  const mine = await press(s, `wo:${wid2}`);
  assert.equal(mine.calls.find((c) => c.method === 'sendPhoto').params.protect_content, true);
  assert.match((await press(x, `wo:${wid2}`)).text, /مال تو نیست/);
  // Telegram refuses the file: not an opening — nothing marked, nobody told, a one-time one not burned
  await press(s, 'wm');
  const bad = await say(s, undefined, { document: { file_id: 'BADdoc', file_unique_id: 'bd1' }, caption: '! @mw_r' });
  const wid3 = bad.r.trace.find((e) => e.view === 'wmedia_ready').meta.id;
  const fail = await say(r, `/start w_${wid3}`);
  assert.match(fail.text, /تلگرام این فایل را نفرستاد/);
  assert.equal(sentTo(fail.calls, s.id).length, 0, 'the sender is not told');
  const after = row('SELECT w.state, r.seen_at, r.opens FROM whispers w JOIN whisper_rcpts r ON r.whisper_id = w.id WHERE w.id = ?', wid3);
  assert.deepEqual([after.state, after.seen_at, after.opens], [0, 0, 0]);
});

await scenario('daily question: opt-in; from 10:00 Tehran the first update starts it, in chunks that wake the bot; once a day', async () => {
  const subs = [];
  for (let i = 0; i < 7; i += 1) {
    const u = person(798000001 + i, `qd${i}`);
    join(u);
    await onboard(u);
    subs.push(u);
  }
  const q = await press(subs[0], 'qd');
  assert.ok(buttons(q.kb).some((b) => b.callback_data === 'qd:p' && /هر روز ساعت ۱۰ برایم بیاید: ❌/.test(b.text)));
  for (const u of subs) await press(u, 'qd:p');
  assert.equal(count('SELECT count(*) AS n FROM users WHERE qd_push = 1'), 7);
  const daily = (calls) => calls.filter((c) => c.method === 'sendMessage' && /سؤال امروز<\/b>/.test(c.params.text || ''));
  const nextLocal = (hh) => { // the next hh:00 in Tehran
    const off = 210 * 60;
    let at = Math.floor((nowSec() + off) / 86400) * 86400 + hh * 3600 - off;
    if (at <= nowSec()) at += 86400;
    return at;
  };
  await deliverWakes();
  advance(nextLocal(9) - nowSec() + 60);
  assert.equal(daily((await say(U.ali, '/help')).calls).length, 0, 'not before 10:00');
  advance(3600);
  const first = await say(U.ali, '/help');
  assert.equal(daily(first.calls).length, 5, 'a chunk on the side of an update');
  assert.ok(first.calls.some((c) => c.method === 'sendPoll'), 'and a wake for the rest');
  const rest = await deliverWakes();
  const got = [...daily(first.calls), ...daily(rest.calls)];
  assert.deepEqual(got.map((c) => Number(c.params.chat_id)).sort((a, b) => a - b), subs.map((u) => u.id), 'each once');
  const kb = got[0].params.reply_markup.inline_keyboard;
  assert.deepEqual(buttons(kb).map((b) => b.callback_data ?? `inline:${b.switch_inline_query}`), ['qd:d', 'inline:', 'qd:p']);
  advance(3 * 3600);
  assert.equal(daily((await say(U.ali, '/help')).calls).length, 0, 'once a day');
  const stop = await press(subs[0], 'qd:p', { messageId: got.find((c) => Number(c.params.chat_id) === subs[0].id).result.result.message_id });
  assert.match(stop.answer.text, /دیگر برایت فرستاده نمی‌شود/);
  assert.equal(userRow(subs[0]).qd_push, 0);
  mock.state.blocked.add(subs[1].id);
  advance(nextLocal(10) - nowSec() + 120);
  const day2 = await say(U.ali, '/help');
  const rest2 = await deliverWakes();
  const got2 = [...daily(day2.calls), ...daily(rest2.calls)];
  assert.equal(got2.filter((c) => c.result.ok).length, 5, 'the next day: those still subscribed');
  assert.equal(userRow(subs[1]).active, 0, 'blocked the bot: inactive, never retried');
  mock.state.blocked.delete(subs[1].id);
  rawDatabase().prepare('UPDATE users SET qd_push = 0').run(); // nobody gets them in the scenarios after this
});

// =====================================================================================
// Confession channel (lib/confess.js)
// =====================================================================================

const confessRoom = mock.state.chats.get('@confess_room').id;
const fwdChannel = (chat) => ({ forward_origin: { type: 'channel', chat: { id: chat.id, type: 'channel', title: chat.title }, message_id: 7, date: nowSec() } });
const confession = (id) => row('SELECT * FROM confessions WHERE id = ?', id);
let confId;
let confPostId;

await scenario('confession channel: the owner sets it from a forwarded post (the bot must be an admin); it appears in the menu', async () => {
  const s = await press(U.owner, 'a:cfs');
  assert.match(s.text, /کانال اعتراف<\/b>[\s\S]*کانال: تنظیم نشده/);
  assert.match((await press(U.ali, 'cf')).text, /فعلاً فعال نیست/);
  assert.ok(!dataOf((await say(U.ali, '/start')).kb).includes('cf'), 'not in the menu while closed');
  await press(U.owner, 'a:cfsc');
  assert.match((await say(U.owner, 'what')).text, /پیدا نکردم/);
  assert.match((await say(U.owner, 'fwd', fwdChannel(mock.state.chats.get('@not_admin_chan')))).text, /ادمین نیست/);
  const ok = await say(U.owner, 'fwd', fwdChannel(mock.state.chats.get('@confess_room')));
  assert.match(ok.text, /کانال اعتراف «Confessions» شد/);
  assert.equal(row("SELECT value FROM kv WHERE key = 'cf_on'").value, '1');
  const menuKb = dataOf((await say(U.ali, '/start')).kb);
  assert.ok(menuKb.includes('cf') && menuKb.includes('rc'), 'confessions and random chat in the menu');
});

await scenario('a confession: written, the author chooses comments and anonymous messages; reviewers see the choices and flags — never the author', async () => {
  const home = await press(U.mina, 'cf');
  assert.deepEqual(dataOf(home.kb), ['cw', 'm']);
  await press(U.mina, 'cw');
  const text = 'راستش هیچ‌وقت به کسی نگفتم که ترسیدم؛ بیا 09121234567';
  ANON_SECRETS.add(text);
  const opts = await say(U.mina, text);
  assert.match(opts.text, /پیش‌نمایش/);
  assert.match(opts.text, /شماره تلفن/, 'the author is warned');
  assert.deepEqual(dataOf(opts.kb), ['co:c', 'co:d', 'cs', 'cw', 'cf']);
  assert.match(buttons(opts.kb)[0].text, /نظر گذاشتن زیر اعتراف: ✅ مجاز/);
  assert.match(buttons(opts.kb)[1].text, /پیام ناشناس به من: ❌ غیرمجاز/);
  assert.match(buttons((await press(U.mina, 'co:d')).kb)[1].text, /✅ مجاز/);
  assert.match(buttons((await press(U.mina, 'co:c')).kb)[0].text, /❌ غیرمجاز/);
  await press(U.mina, 'co:c');
  const sent = await press(U.mina, 'cs');
  assert.match(sent.text, /اعتراف #۱ برای بررسی فرستاده شد/);
  confId = 1;
  assert.deepEqual([confession(1).status, confession(1).allow_comments, confession(1).allow_dm, confession(1).flags], ['pending', 1, 1, 'phone']);
  const review = sentTo(sent.calls, OWNER).find((c) => /برای بررسی/.test(c.params.text));
  assert.ok(review, 'the owner gets the review card');
  assert.ok(review.params.text.includes('هیچ‌وقت به کسی نگفتم'));
  assert.match(review.params.text, /نظر گذاشتن زیر اعتراف: ✅ مجاز/);
  assert.match(review.params.text, /پیام ناشناس به نویسنده: ✅ مجاز/);
  assert.match(review.params.text, /فیلترها: شماره تلفن/);
  assert.deepEqual(dataOf(review.params.reply_markup.inline_keyboard), ['a:cfa:1', 'a:cfr:1', 'a:cfb:1', 'a:cf']);
  assert.ok(sentTo(sent.calls, U.mina.id).some((c) => /برای بررسی/.test(c.params.text)), 'mina is an admin with cf, so she reviews too');
  noTrace(sent.calls, OWNER, U.mina);
  assert.match((await press(U.owner, 'a:cf')).text, /در انتظار بررسی:<\/b> ۱/);
});

await scenario('approve: posted to the channel with the author\'s buttons; the author is told; a second press changes nothing', async () => {
  const r = await press(U.owner, `a:cfa:${confId}`);
  assert.match(r.answer.text, /منتشر شد/);
  const post = r.calls.find((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === confessRoom);
  assert.ok(post, 'posted to the channel');
  assert.match(post.params.text, /^📝 <b>اعتراف #۱<\/b>/);
  confPostId = post.result.result.message_id;
  assert.deepEqual(buttons(post.params.reply_markup.inline_keyboard).map((b) => b.url), [
    `https://t.me/${BOT}?start=cm_1`, `https://t.me/${BOT}?start=cx_1`, `https://t.me/${BOT}?start=cf`]);
  noTrace(r.calls, confessRoom, U.mina);
  assert.match(textsTo(r.calls, U.mina.id), /اعتراف #۱ تو منتشر شد/);
  assert.equal(confession(confId).status, 'approved');
  assert.equal(confession(confId).channel_msg, confPostId);
  assert.match((await press(U.owner, `a:cfa:${confId}`)).answer.text, /قبلاً بررسی شده/);
  assert.match((await press(U.mina, `a:cfr:${confId}`)).answer.text, /قبلاً بررسی شده/);
});

let commentId;
await scenario('comments in the bot: refused with bad words or links (they are public); counted on the post; the author is told', async () => {
  const page = await say(U.ali, `/start cm_${confId}`);
  assert.match(page.text, /اعتراف #۱<\/b>[\s\S]*نظرها \(۰\)[\s\S]*اولین نفر باش/);
  await press(U.ali, `cc:${confId}`);
  assert.match((await say(U.ali, 'تو یه kos هستی')).text, /کلمه‌ی نامناسب/);
  assert.match((await say(U.ali, 'ببین t.me/spam')).text, /لینک/);
  const ok = await say(U.ali, 'خیلی شجاعانه بود 👏');
  assert.match(ok.text, /نظرت ثبت شد[\s\S]*نظرها \(۱\)[\s\S]*خیلی شجاعانه بود/);
  commentId = row('SELECT id FROM cf_comments WHERE confession_id = ?', confId).id;
  const edit = ok.calls.find((c) => c.method === 'editMessageReplyMarkup' && Number(c.params.chat_id) === confessRoom);
  assert.equal(edit.params.reply_markup.inline_keyboard[0][0].text, '💬 نظرها (۱)');
  assert.match(textsTo(ok.calls, U.mina.id), /یک نظر تازه زیر اعتراف #۱ تو/);
  noTrace(ok.calls, U.mina.id, U.ali);
  assert.match((await press(U.ali, `cc:${confId}`)).answer.text, /ثانیه‌ی دیگر/, 'a gap between comments');
  advance(25);
});

await scenario('a reported comment reaches the reviewers once; a reviewer removes it and the post\'s count goes down', async () => {
  const r1 = await press(U.nima, `cr:${commentId}`);
  assert.match(r1.answer.text, /گزارش شد/);
  const toOwner = sentTo(r1.calls, OWNER).find((c) => /گزارش یک نظر/.test(c.params.text));
  assert.ok(toOwner && toOwner.params.text.includes('خیلی شجاعانه بود'));
  assert.deepEqual(dataOf(toOwner.params.reply_markup.inline_keyboard), [`a:cfh:${commentId}`]);
  noTrace(r1.calls, OWNER, U.ali);
  assert.equal(sentTo((await press(U.reza, `cr:${commentId}`)).calls, OWNER).length, 0, 'once');
  const h = await press(U.owner, `a:cfh:${commentId}`);
  assert.match(h.answer.text, /حذف شد/);
  assert.equal(h.calls.find((c) => c.method === 'editMessageReplyMarkup').params.reply_markup.inline_keyboard[0][0].text, '💬 نظرها (۰)');
  assert.match((await say(U.ali, `/start cm_${confId}`)).text, /نظرها \(۰\)/);
});

await scenario('an anonymous message to the author from the post: into their inbox, no profile shown, no button that leads to it', async () => {
  advance(10);
  const card = await say(U.ivan, `/start cx_${confId}`);
  assert.match(card.text, /Анонимное сообщение автору признания #1/);
  assert.ok(!card.calls.some((c) => c.method === 'sendPhoto'), 'no profile card');
  noTrace(card.calls, U.ivan.id, U.mina);
  const msg = 'Ты очень смелая, спасибо';
  ANON_SECRETS.add(msg);
  const sent = await say(U.ivan, msg);
  const delivered = sentTo(sent.calls, U.mina.id)[0];
  assert.match(delivered.params.text, /پیام ناشناس جدید<\/b> · 💌 اعتراف\n❓ در جواب: «اعتراف #۱»/);
  noTrace(sent.calls, U.mina.id, U.ivan);
  assert.deepEqual(dataOf(sent.kb), [`cxw:${confId}`, 'm'], 'no aw:/rt: buttons with the author\'s link code');
  assert.equal(row("SELECT cat FROM anon_msgs WHERE to_id = ? ORDER BY created_at DESC LIMIT 1", U.mina.id).cat, 'c');
  assert.match((await say(U.mina, `/start cx_${confId}`)).text, /خودت است/);
  // the author answers: anonymous too — "the author of confession #1", never a name
  const ref = delivered.params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  assert.match((await press(U.mina, `ar:${ref}`)).text, /نمی‌فهمد نویسنده‌ی اعتراف تو هستی/);
  const answerText = 'ممنونم که نوشتی';
  ANON_SECRETS.add(answerText);
  const back = await say(U.mina, answerText);
  assert.match(back.text, /ناشناس فرستاده شد/);
  const toIvan = sentTo(back.calls, U.ivan.id)[0];
  assert.match(toIvan.params.text, /^↩️ <b>Ответ автора признания #1<\/b>/);
  noTrace(back.calls, U.ivan.id, U.mina);
  const backRef = toIvan.params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  const inInbox = await press(U.ivan, `iv:${backRef}`);
  assert.match(inInbox.text, /Ответ автора признания #1/);
  noTrace(inInbox.calls, U.ivan.id, U.mina);
  assert.equal(row('SELECT cf FROM anon_msgs WHERE id = ?', backRef).cf, confId);
  // a report reaches the owner and every admin who reviews reports (mina has rp)
  await press(U.ivan, `ap:${backRef}`);
  const rep = await press(U.ivan, `apy:${backRef}`);
  for (const id of [OWNER, U.mina.id]) assert.match(textsTo(rep.calls, id), /یک گزارش تازه برای بررسی/, String(id));
  noTrace(rep.calls, OWNER, U.ivan);
});

await scenario('reject, and reject-and-ban: the author is told or banned — nobody sees who it was', async () => {
  await press(U.ann, 'cf');
  await press(U.ann, 'cw');
  await say(U.ann, 'An English confession for the test');
  const s = await press(U.ann, 'cs');
  const id = Number(/#(\d+)/.exec(s.text)[1]);
  const r = await press(U.owner, `a:cfr:${id}`);
  assert.match(r.answer.text, /رد شد/);
  assert.match(textsTo(r.calls, U.ann.id), /wasn't posted/);
  assert.equal(confession(id).status, 'rejected');
  const bad = person(790000001, 'cf_bad');
  join(bad);
  await onboard(bad);
  await press(bad, 'cf');
  await press(bad, 'cw');
  await say(bad, 'یه اعتراف که بنش می‌کنیم');
  const s2 = await press(bad, 'cs');
  const id2 = Number(/#([۰-۹0-9]+)/.exec(s2.text)[1].replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  const b = await press(U.owner, `a:cfb:${id2}`);
  assert.match(b.answer.text, /بن شد/);
  noTrace(b.calls, OWNER, bad);
  assert.equal(userRow(bad).banned, 1);
  assert.equal(confession(id2).status, 'rejected');
  assert.match((await press(U.mina, `a:cfb:${id2}`)).answer.text, /دسترسی‌های تو نیست/, 'mina may review but not ban');
});

await scenario('confession limits: three a day per person; text only; closed when the owner turns it off', async () => {
  for (let i = 0; i < 2; i += 1) {
    await press(U.mina, 'cw');
    await say(U.mina, `اعتراف شماره ${i + 2}`);
    await press(U.mina, 'cs');
  }
  assert.match((await press(U.mina, 'cw')).answer.text, /حداکثر ۳ اعتراف/);
  await press(U.ali, 'cw');
  assert.match((await say(U.ali, undefined, { photo: [{ file_id: 'AgACcf', file_unique_id: 'cf1', width: 9, height: 9 }] })).text, /فقط متن/);
  await say(U.ali, '/cancel');
  await press(U.owner, 'a:cfst');
  assert.match((await press(U.ali, 'cw')).answer.text, /فعال نیست/);
  await press(U.owner, 'a:cfst');
  // "delete my data": the confessions stay where they are, but no longer lead back to their author
  const annsBefore = rows('SELECT id FROM confessions WHERE author_id = ?', U.ann.id).map((r) => r.id);
  assert.ok(annsBefore.length >= 1);
  await press(U.ann, 'dd');
  assert.match((await press(U.ann, 'ddy')).text, /fresh link/);
  assert.equal(count(`SELECT count(*) AS n FROM confessions WHERE author_id = ${U.ann.id}`), 0);
  for (const id of annsBefore) assert.equal(confession(id).author_id, 0);
});

// =====================================================================================
// Random anonymous chat (lib/rchat.js)
// =====================================================================================

const partnerOf = (u) => userRow(u).rc_partner;
const queued = (u) => !!row('SELECT 1 AS x FROM rc_queue WHERE user_id = ?', u.id);
const keyText = (k) => ({ next: '⏭ بعدی', end: '❌ پایان چت', report: '🚩 گزارش' }[k]);

await scenario('random chat: matched with someone of the same language; messages go across anonymous and protected', async () => {
  const home = await press(U.ali, 'rc');
  assert.deepEqual(dataOf(home.kb), ['rc:go', 'rc:m', 'm']);
  assert.match((await press(U.ali, 'rc:go')).text, /دنبال یک نفر می‌گردم/);
  assert.ok(queued(U.ali));
  assert.match((await press(U.ivan, 'rc:go')).text, /Ищу собеседника/, 'another language: not matched');
  const c = await press(U.nima, 'rc:go');
  assert.equal(partnerOf(U.nima), U.ali.id);
  assert.equal(partnerOf(U.ali), U.nima.id);
  assert.ok(!queued(U.ali) && !queued(U.nima));
  const toAli = sentTo(c.calls, U.ali.id).find((m) => /وصل شدی/.test(m.params.text));
  assert.deepEqual(toAli.params.reply_markup.keyboard.flat().map((b) => b.text), ['⏭ بعدی', '❌ پایان چت', '🚩 گزارش']);
  assert.ok(c.calls.some((m) => Number(m.params.chat_id) === U.nima.id && m.params.reply_markup && m.params.reply_markup.keyboard));
  advance(2);
  const hi = await say(U.nima, 'سلام، خوبی؟ <b>تست</b>');
  const relay = sentTo(hi.calls, U.ali.id)[0];
  assert.equal(relay.params.text, 'سلام، خوبی؟ &lt;b&gt;تست&lt;/b&gt;');
  assert.equal(relay.params.protect_content, true);
  noTrace(hi.calls, U.ali.id, U.nima);
  advance(2);
  const back = await say(U.ali, 'مرسی تو چطوری');
  assert.equal(sentTo(back.calls, U.nima.id)[0].params.text, 'مرسی تو چطوری');
  noTrace(back.calls, U.nima.id, U.ali);
  assert.match((await press(U.ali, 'rc:go')).answer.text, /الان در یک چت هستی/);
  assert.match((await say(U.ali, '/start')).text, /🎲 <b>چت تصادفی/, 'commands still work; the chat stays');
  assert.equal(partnerOf(U.ali), U.nima.id);
});

await scenario('random chat filters: links never; bad words and phone numbers by the receiver\'s settings; photos only if accepted', async () => {
  advance(2);
  assert.match((await say(U.nima, 'بیا اینجا t.me/xyz')).text, /لینک فرستاده نمی‌شود/);
  advance(2);
  assert.match((await say(U.nima, 'kir')).text, /کلمه‌ی نامناسب/);
  advance(2);
  assert.match((await say(U.nima, 'شماره‌ام ۰۹۱۲۳۴۵۶۷۸۹')).text, /شماره تلفن دریافت نمی‌کند/);
  advance(2);
  const photo = { photo: [{ file_id: 'AgACrc', file_unique_id: 'rc1', width: 9, height: 9 }] };
  assert.match((await say(U.nima, undefined, photo)).text, /عکس، ویدیو و فایل دریافت نمی‌کند/);
  await press(U.ali, 'rc:m');
  assert.equal(userRow(U.ali).rc_media, 1);
  advance(2);
  const ok = await say(U.nima, undefined, photo);
  const copy = ok.calls.find((m) => m.method === 'copyMessage' && Number(m.params.chat_id) === U.ali.id);
  assert.ok(copy && copy.params.protect_content === true, 'copied, protected');
  advance(2);
  assert.ok((await say(U.nima, undefined, { sticker: { file_id: 'CAACrc', file_unique_id: 'rs1' } })).calls.some((m) => m.method === 'copyMessage'), 'stickers always pass');
  assert.match((await say(U.nima, 'زود زود')).text, /کمی آرام‌تر/, 'a gap between messages');
});

await scenario('random chat controls: next, end, report (a strike; the two are never matched again)', async () => {
  advance(2);
  const next = await say(U.nima, keyText('next'));
  assert.ok(sentTo(next.calls, U.ali.id).some((m) => /طرف مقابل چت را تمام کرد/.test(m.params.text) && m.params.reply_markup.remove_keyboard));
  assert.equal(partnerOf(U.ali), 0);
  assert.ok(queued(U.nima), 'next: looking again');
  const again = await press(U.ali, 'rc:go');
  assert.equal(partnerOf(U.ali), U.nima.id, 'matched with the one waiting');
  assert.ok(again.calls.some((m) => Number(m.params.chat_id) === U.nima.id && /وصل شدی/.test(m.params.text)));
  const ask = await say(U.ali, keyText('report'));
  assert.match(ask.text, /گزارش کنم/);
  assert.equal(partnerOf(U.ali), U.nima.id, 'not until confirmed');
  const rep = await press(U.ali, 'rc:ry');
  assert.match(rep.answer.text, /گزارش شد/);
  assert.equal(partnerOf(U.ali) + partnerOf(U.nima), 0);
  assert.equal(count(`SELECT count(*) AS n FROM strikes WHERE sender_id = ${U.nima.id} AND by_id = ${U.ali.id}`), 1);
  assert.equal(count(`SELECT count(*) AS n FROM rc_blocks WHERE user_id = ${U.ali.id} AND blocked_id = ${U.nima.id}`), 1);
  await press(U.nima, 'rc:go');
  await press(U.ali, 'rc:go');
  assert.ok(queued(U.ali) && queued(U.nima) && partnerOf(U.ali) === 0, 'never matched again');
  await press(U.ali, 'rc:x');
  await press(U.nima, 'rc:x');
  await press(U.ivan, 'rc:x');
  assert.ok(!queued(U.ali) && !queued(U.nima) && !queued(U.ivan));
});

await scenario('random chat: a partner who blocked the bot ends the chat; restricted people can\'t search; a long-quiet chat gives way', async () => {
  const a = person(791000001, 'rc_a', 'en', 'Amy');
  const b = person(791000002, 'rc_b', 'en', 'Bob');
  for (const u of [a, b]) {
    join(u);
    await onboard(u, 'en');
  }
  await press(a, 'rc:go');
  await press(b, 'rc:go');
  assert.equal(partnerOf(a), b.id);
  mock.state.blocked.add(b.id);
  advance(2);
  const gone = await say(a, 'hello?');
  assert.match(gone.calls.map((m) => m.params.text || '').join('\n'), /isn't reachable/);
  assert.equal(partnerOf(a), 0);
  assert.equal(userRow(b).active, 0);
  mock.state.blocked.delete(b.id);
  rawDatabase().prepare('UPDATE users SET restricted_until = ? WHERE user_id = ?').run(nowSec() + 3600, a.id);
  assert.match((await press(a, 'rc:go')).answer.text, /Because of reports/);
  rawDatabase().prepare('UPDATE users SET restricted_until = 0 WHERE user_id = ?').run(a.id);
  await say(b, '/start'); // b is back
  await press(a, 'rc:go');
  await press(b, 'rc:go');
  assert.equal(partnerOf(a), b.id);
  advance(31 * 60);
  await press(a, 'rc:go');
  assert.equal(userRow(a).rc_partner, 0, 'the quiet chat ended');
  assert.ok(queued(a));
  await press(a, 'rc:x');
});

// =====================================================================================
// Channel question boxes (lib/qbox.js)
// =====================================================================================

const qChan = mock.state.chats.get('@qbox_chan');
const fwdQChan = () => ({ forward_origin: { type: 'channel', chat: { id: qChan.id, type: 'channel', title: qChan.title }, message_id: 3, date: nowSec() } });
let qbCode = null;

await scenario('question box: a channel admin connects their channel; questions arrive anonymously; the answer is posted to the channel', async () => {
  const host = person(799000001, 'qb_host');
  join(host);
  await onboard(host);
  assert.ok(dataOf((await press(host, 'an')).kb).includes('qb'));
  assert.deepEqual(dataOf((await press(host, 'qb')).kb), ['qb:n', 'an']);
  await press(host, 'qb:n');
  assert.match((await say(host, 'fwd', { forward_origin: { type: 'channel', chat: { id: mock.state.chats.get('@not_admin_chan').id, type: 'channel', title: 'x' }, message_id: 1, date: nowSec() } })).text, /ربات در «.*» ادمین نیست/);
  assert.match((await say(host, 'fwd', fwdQChan())).text, /تو در «Q Channel» ادمین نیستی/, 'only an admin of the channel');
  mock.setMember('qbox_chan', host.id, { status: 'administrator' });
  const made = await say(host, 'fwd', fwdQChan());
  assert.match(made.text, /صندوق سؤال «Q Channel» ساخته شد[\s\S]*start=q_(\w{10})/);
  qbCode = /start=q_(\w{10})/.exec(made.text)[1];
  const box = row('SELECT * FROM qboxes WHERE code = ?', qbCode);
  assert.deepEqual([box.owner_id, box.chat_id, box.open], [host.id, qChan.id, 1]);
  // another admin of the same channel can't make a second box, and isn't told whose it is
  mock.setMember('qbox_chan', U.mina.id, { status: 'administrator' });
  await press(U.mina, 'qb:n');
  const taken = await say(U.mina, 'fwd', fwdQChan());
  assert.match(taken.text, /از قبل صندوق سؤال دارد/);
  noTrace(taken.calls, U.mina.id, host);
  // a visitor asks
  advance(5);
  const ask = await say(U.ali, `/start q_${qbCode}`);
  assert.match(ask.text, /سؤال ناشناس از «Q Channel»/);
  const question = 'برنامه‌ی کانال برای ماه بعد چیه؟';
  ANON_SECRETS.add(question);
  const sent = await say(U.ali, question);
  assert.match(sent.text, /سؤالت ناشناس برای «Q Channel» فرستاده شد/);
  const notice = sentTo(sent.calls, host.id).find((c) => /سؤال ناشناس تازه/.test(c.params.text));
  assert.ok(notice, 'the owner is told');
  noTrace(sent.calls, host.id, U.ali);
  assert.match((await say(U.ali, `/start q_${qbCode}`)).text, /سؤال ناشناس از/);
  assert.match((await say(U.ali, 'یکی دیگه')).text, /کمی صبر کن/, 'a gap between questions');
  await say(U.ali, '/cancel');
  // filtered questions never reach the owner, and the asker sees the usual confirmation
  advance(30);
  await say(U.reza, `/start q_${qbCode}`);
  const spam = await say(U.reza, 'عضو شو t.me/spam_channel');
  assert.equal(spam.r.filtered, 'link');
  assert.match(spam.text, /فرستاده شد/);
  assert.equal(count(`SELECT count(*) AS n FROM qbox_questions WHERE box_id = ${box.id} AND status = 'new'`), 1);
  // the owner reads and answers: posted to the channel with an "ask your own" button
  const q1 = await press(host, `qb:l:${box.id}:0`);
  assert.match(q1.text, /سؤال ۱ از ۱/);
  assert.ok(q1.text.includes(question));
  noTrace(q1.calls, host.id, U.ali);
  const qid = q1.r.trace.find((x) => x.view === 'qbox_question').meta.id;
  await press(host, `qb:a:${qid}`);
  const answered = await say(host, 'ماه بعد یک مسابقه داریم 🎉');
  const post = answered.calls.find((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === qChan.id);
  assert.ok(post && post.params.text.includes(question) && post.params.text.includes('ماه بعد یک مسابقه داریم'));
  assert.deepEqual(buttons(post.params.reply_markup.inline_keyboard).map((b) => b.url), [`https://t.me/${BOT}?start=q_${qbCode}`]);
  noTrace(answered.calls, qChan.id, U.ali);
  const toAsker = sentTo(answered.calls, U.ali.id)[0];
  assert.match(toAsker.params.text, /به سؤالی که از «Q Channel» پرسیدی جواب داده شد/);
  assert.equal(toAsker.params.reply_markup.inline_keyboard[0][0].url, `https://t.me/qbox_chan/${post.result.result.message_id}`);
  assert.ok(buttons(answered.kb).some((b) => b.web_app && /k=qb&id=/.test(b.web_app.url)), 'make it an image card');
  const qrow = row('SELECT status, channel_msg FROM qbox_questions WHERE id = ?', qid);
  assert.deepEqual([qrow.status, qrow.channel_msg], ['answered', post.result.result.message_id]);
  assert.match((await press(host, `qb:a:${qid}`)).answer.text, /دیگر نیست/, 'answered once');
  // the card: only for the box's owner, posted to the channel
  const ctx = { initData: { user: { id: host.id } } };
  const card = await cardDataEndpoint({ k: 'qb', id: qid }, ctx);
  assert.deepEqual([card.kind, card.text, card.answer, card.name, card.link], ['qb', question, 'ماه بعد یک مسابقه داریم 🎉', 'Q Channel', `https://t.me/${BOT}?start=q_${qbCode}`]);
  await assert.rejects(() => cardDataEndpoint({ k: 'qb', id: qid }, { initData: { user: { id: U.ali.id } } }), /Not available/);
  const bytes = new Uint8Array(4000);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    b64 += B[(n >> 18) & 63] + B[(n >> 12) & 63] + (i + 1 < bytes.length ? B[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B[n & 63] : '=');
  }
  const r = await cardSendEndpoint({ k: 'qb', id: qid, image: `data:image/jpeg;base64,${b64}` }, ctx);
  assert.equal(r.to, 'channel');
  const photo = mock.state.media[mock.state.media.length - 1];
  assert.equal(photo.chat_id, qChan.id);
  await assert.rejects(() => cardSendEndpoint({ k: 'qb', id: qid, image: `data:image/jpeg;base64,${b64}` }, { initData: { user: { id: U.ali.id } } }), /Card not sent/);
});

await scenario('question box: block an asker without learning who; pause; a new link; the owner\'s own link; delete', async () => {
  const host = person(799000001, 'qb_host');
  const box = row('SELECT * FROM qboxes WHERE code = ?', qbCode);
  advance(30);
  await say(U.nima, `/start q_${qbCode}`);
  await say(U.nima, 'یک سؤال برای بلاک');
  const q = await press(host, `qb:l:${box.id}:0`);
  const qid = q.r.trace.find((x) => x.view === 'qbox_question').meta.id;
  const blk = await press(host, `qb:b:${qid}`);
  assert.match(blk.answer.text, /بلاک شد/);
  noTrace(blk.calls, host.id, U.nima);
  assert.match((await say(U.nima, `/start q_${qbCode}`)).text, /این کاربر پیام‌های تو را نمی‌پذیرد/, 'the blocked asker is refused');
  assert.match((await press(U.reza, `qb:v:${box.id}`)).answer.text, /مال تو نیست/, 'only the owner manages it');
  await press(host, `qb:t:${box.id}`);
  assert.match((await say(U.ivan, `/start q_${qbCode}`)).text, /Ящик вопросов «Q Channel» пока на паузе/, 'paused');
  await press(host, `qb:t:${box.id}`);
  const renewed = await press(host, `qb:r:${box.id}`);
  const newCode = /start=q_(\w{10})/.exec(renewed.text)[1];
  assert.notEqual(newCode, qbCode);
  assert.match((await say(U.ali, `/start q_${qbCode}`)).text, /معتبر نیست/, 'the old link stops');
  qbCode = newCode;
  assert.match((await say(host, `/start q_${qbCode}`)).text, /صندوق سؤال کانال خودت است/);
  await press(host, `qb:x:${box.id}`);
  assert.match((await press(host, `qb:xy:${box.id}`)).text, /پاک شد/);
  assert.equal(count(`SELECT count(*) AS n FROM qbox_questions WHERE box_id = ${box.id}`), 0);
  assert.equal(row('SELECT 1 AS x FROM qboxes WHERE id = ?', box.id), undefined);
  assert.match((await say(U.ali, `/start q_${qbCode}`)).text, /معتبر نیست/);
});

// =====================================================================================
// The smart filter (lib/ai.js) against a stand-in for Google Gemini
// =====================================================================================

const gemini = { requests: [], mode: 'ok' };
const geminiServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    gemini.requests.push({ url: req.url, key: req.headers['x-goog-api-key'], body, raw });
    if (gemini.mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } }));
      return;
    }
    const text = (((body.contents || [])[0] || {}).parts || [])[0]?.text || '';
    let v = { harmful: false, category: 'none', confidence: 3 };
    if (/بی‌ارزش|worthless/.test(text)) v = { harmful: true, category: 'harassment', confidence: 95 };
    if (/خودم را بکشم/.test(text)) v = { harmful: true, category: 'self_harm', confidence: 90 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }] }));
  });
});
await new Promise((r) => geminiServer.listen(0, '127.0.0.1', r));
rawDatabase().prepare("INSERT INTO kv (key, value) VALUES ('ai_base', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(`http://127.0.0.1:${geminiServer.address().port}/v1beta`);
const AI_KEY = 'AIzaSyTEST_key_1234567890abcdefghijk';
const { localDay } = await import('../tgcloud/lib/util.js');

await scenario('smart filter: the owner enters the key in the bot (the message is deleted, the key never shown again), tests it, turns it on', async () => {
  const s0 = await press(U.owner, 'a:ai');
  assert.match(s0.text, /فیلتر هوشمند[\s\S]*کلید: ثبت نشده/);
  assert.deepEqual(dataOf(s0.kb), ['a:aik', 'a']);
  assert.ok(!dataOf((await press(U.sara, 'fs')).kb).includes('fs:i'), 'no switch for users while it is off');
  await press(U.owner, 'a:aik');
  const bad = await say(U.owner, 'short');
  assert.ok(bad.calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === bad.message.message_id), 'deleted at once');
  assert.match(bad.text, /شبیه کلید API نیست/);
  const ok = await say(U.owner, AI_KEY);
  assert.ok(ok.calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === ok.message.message_id));
  assert.match(ok.text, /کلید ذخیره شد و کار می‌کند/);
  assert.match(ok.text, /AIza…hijk/);
  assert.equal(gemini.requests.length, 1);
  const first = gemini.requests[0];
  assert.equal(first.key, AI_KEY);
  assert.match(first.url, /^\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(first.body.generationConfig.responseMimeType, 'application/json');
  await press(U.owner, 'a:aio');
  assert.equal(row("SELECT value FROM kv WHERE key = 'ai_on'").value, '1');
  const test = await press(U.owner, 'a:ait');
  assert.match(test.text, /✅ سالم[\s\S]*🚫 آزاردهنده — آزار و تحقیر \(۹۵٪\)/);
  const leaked = JSON.stringify([mock.state.calls.map((c) => c.params), results]);
  assert.ok(!leaked.includes(AI_KEY), 'the key is in no message and no trace');
});

await scenario('smart filter: a hurtful message without swear words is filtered; the recipient can turn it off; self-harm is never hidden; only the text is sent', async () => {
  const aHost = person(800000001, 'ai_host');
  const aVis = person(800000002, 'ai_vis', 'fa', 'Visitor');
  for (const u of [aHost, aVis]) {
    join(u);
    await onboard(u);
  }
  const code = /start=a_(\w{10})/.exec((await say(aHost, '/link')).text)[1];
  const before = gemini.requests.length;
  await say(aVis, `/start a_${code}`);
  const hurt = await say(aVis, 'تو یه آدم بی‌ارزشی که هیچکس دوستت نداره');
  assert.equal(hurt.r.filtered, 'ai');
  assert.equal(sentTo(hurt.calls, aHost.id).length, 0, 'not delivered');
  assert.match(hurt.text, /پیامت ناشناس فرستاده شد/, 'the sender sees the usual confirmation');
  assert.equal(gemini.requests.length, before + 1);
  for (const r of gemini.requests) for (const s of [String(aVis.id), aVis.username, aVis.first_name, String(aHost.id), aHost.username]) assert.ok(!r.raw.includes(s), `"${s}" sent to Gemini`);
  const fs = await press(aHost, 'fs');
  assert.ok(buttons(fs.kb).some((b) => b.callback_data === 'fs:i' && /فیلتر هوشمند: روشن/.test(b.text)));
  await press(aHost, 'fs:i');
  advance(5);
  await say(aVis, `/start a_${code}`);
  const through = await say(aVis, 'باز هم می‌گویم تو بی‌ارزشی');
  assert.equal(sentTo(through.calls, aHost.id).length, 1, 'turned off: delivered');
  assert.equal(gemini.requests.length, before + 1, 'and not even sent for checking');
  await press(aHost, 'fs:i');
  advance(5);
  await say(aVis, `/start a_${code}`);
  const sad = await say(aVis, 'خیلی خسته‌ام، گاهی فکر می‌کنم خودم را بکشم');
  assert.equal(sad.r.filtered, undefined, 'self-harm: delivered');
  assert.equal(sentTo(sad.calls, aHost.id).length, 1);
  // a confession: the reviewers' card is marked; a hurtful comment is refused
  await press(aVis, 'cf');
  await press(aVis, 'cw');
  await say(aVis, 'رئیسم یه آدم بی‌ارزشه و همه ازش متنفرن');
  const cs = await press(aVis, 'cs');
  const card = sentTo(cs.calls, OWNER).find((c) => /برای بررسی/.test(c.params.text));
  assert.match(card.params.text, /فیلترها: 🤖 آزار و تحقیر/);
  noTrace(cs.calls, OWNER, aVis);
  await say(aVis, '/start cm_1');
  await press(aVis, 'cc:1');
  assert.match((await say(aVis, 'نویسنده بی‌ارزشه')).text, /🤖 محتوای آزاردهنده/);
  await say(aVis, '/cancel');
});

await scenario('smart filter: fails open — over Google\'s quota it pauses, with the daily cap it rests, a changed model is used, a removed key stops it', async () => {
  const aHost = person(800000001, 'ai_host');
  const aVis = person(800000002, 'ai_vis', 'fa', 'Visitor');
  const code = /start=a_(\w{10})/.exec((await say(aHost, '/link')).text)[1];
  const send = async (text) => {
    advance(5);
    await say(aVis, `/start a_${code}`);
    return say(aVis, text);
  };
  gemini.mode = '429';
  const n0 = gemini.requests.length;
  const r1 = await send('اولی بی‌ارزش');
  assert.equal(sentTo(r1.calls, aHost.id).length, 1, 'unchecked: delivered');
  assert.equal(gemini.requests.length, n0 + 1);
  assert.ok(Number(row("SELECT value FROM kv WHERE key = 'ai_cool'").value) > nowSec(), 'paused');
  assert.match(row("SELECT value FROM kv WHERE key = 'ai_err'").value, /429 Resource has been exhausted/);
  assert.match((await press(U.owner, 'a:ai')).text, /آخرین خطا[\s\S]*429/);
  gemini.mode = 'ok';
  await send('دومی بی‌ارزش');
  assert.equal(gemini.requests.length, n0 + 1, 'not asked while paused');
  advance(700);
  const r3 = await send('سومی بی‌ارزش');
  assert.equal(r3.r.filtered, 'ai', 'back after the pause');
  rawDatabase().prepare("UPDATE kv SET value = ? WHERE key = 'ai_day'").run(`${localDay()}:2000`);
  const r4 = await send('چهارمی بی‌ارزش');
  assert.equal(sentTo(r4.calls, aHost.id).length, 1, 'over the daily cap: unchecked');
  rawDatabase().prepare("UPDATE kv SET value = ? WHERE key = 'ai_day'").run(`${localDay()}:0`);
  await press(U.owner, 'a:aim');
  await press(U.owner, 'a:aims:1');
  await send('پنجمی بی‌ارزش');
  assert.match(gemini.requests[gemini.requests.length - 1].url, /gemini-3\.1-flash-lite:generateContent/);
  await press(U.owner, 'a:aimc');
  assert.match((await say(U.owner, 'Bad Model!')).text, /نام مدل فقط/);
  assert.match((await say(U.owner, 'gemini-x-test')).text, /gemini-x-test/);
  assert.match((await press(U.owner, 'a:aix')).text, /کلید حذف شد/);
  const n1 = gemini.requests.length;
  const r6 = await send('ششمی بی‌ارزش');
  assert.equal(sentTo(r6.calls, aHost.id).length, 1);
  assert.equal(gemini.requests.length, n1, 'no key: nothing sent');
  assert.match((await press(U.reza, 'a:ai')).answer.text, /فقط برای مالک/);
  geminiServer.close();
});

// =====================================================================================
// The inbox in the Mini App (endpoint inbox, lib/miniinbox.js)
// =====================================================================================

await scenario('Mini App inbox: list, read, react, reply through the same relay, archive, category, block, open in chat, report, delete — only your own', async () => {
  const host = person(801000001, 'mi_host');
  const vis = person(801000002, 'mi_vis', 'fa', 'Mi Visitor');
  for (const u of [host, vis]) {
    join(u);
    await onboard(u);
  }
  const code = /start=a_(\w{10})/.exec((await say(host, '/link')).text)[1];
  advance(5);
  await say(vis, `/start a_${code}`);
  const text = 'یک پیام برای صندوق مینی‌اپ';
  const sent = await say(vis, text);
  const ref = sentTo(sent.calls, host.id)[0].params.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  const box = await say(host, '/inbox');
  assert.ok(buttons(box.kb).some((b) => b.web_app && b.web_app.url === `https://app${BOT_ID}.tgcloud.ai/inbox.html?l=fa`), 'the button that opens it');
  const H = { initData: { user: { id: host.id } } };
  const V = { initData: { user: { id: vis.id } } };
  const list = await inboxEndpoint({ op: 'list', folder: 0 }, H);
  assert.deepEqual([list.labels.title, list.folder, list.cat], ['📥 صندوق پیام ناشناس', 0, '-']);
  const item = list.items.find((x) => x.id === ref);
  assert.ok(item && item.unread && item.preview === text && /💌|📝|❓|💬|😂|❤️/.test(item.from));
  const blob = JSON.stringify(list);
  for (const s of [String(vis.id), vis.username, vis.first_name]) assert.ok(!blob.includes(s), `"${s}" in the inbox page`);
  const unreadBefore = userRow(host).anon_unread;
  const got = await inboxEndpoint({ op: 'get', id: ref }, H);
  assert.deepEqual([got.body, got.unread, got.blocked], [text, false, false]);
  assert.equal(userRow(host).anon_unread, unreadBefore - 1, 'read');
  await assert.rejects(() => inboxEndpoint({ op: 'get', id: ref }, V), /دیگر در دسترس نیست/, 'not the sender');
  await assert.rejects(() => inboxEndpoint({ op: 'act', id: ref, act: 'delete' }, V), /دیگر در دسترس نیست/);
  assert.equal((await inboxEndpoint({ op: 'list', folder: 0, q: 'مینی‌اپ' }, H)).items.length, 1, 'search');
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'react', arg: 1 }, H)).reaction, '🔥');
  since();
  assert.equal((await inboxEndpoint({ op: 'reply', id: ref, text: 'جواب از مینی‌اپ' }, H)).ok, true);
  const back = sentTo(since(), vis.id)[0];
  assert.match(back.params.text, /جواب از مینی‌اپ/, 'delivered like a reply from the chat');
  assert.equal(row('SELECT count(*) AS n FROM anon_msgs WHERE to_id = ? AND from_id = ?', vis.id, host.id).n, 1);
  await assert.rejects(() => inboxEndpoint({ op: 'reply', id: ref, text: '   ' }, H), /جوابت را بنویس/);
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'archive' }, H)).folder, 1);
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'cat', arg: 'q' }, H)).cat, 'q');
  await assert.rejects(() => inboxEndpoint({ op: 'act', id: ref, act: 'cat', arg: 'zz' }, H), /نشد/);
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'block' }, H)).blocked, true);
  advance(5);
  assert.match((await say(vis, `/start a_${code}`)).text, /پیام‌های تو را نمی‌پذیرد/, 'blocked from the page');
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'block' }, H)).blocked, false);
  since();
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'open' }, H)).opened, true);
  assert.ok(sentTo(since(), host.id).some((c) => (c.params.text || '').includes(text)), 'the bot sends it into the chat');
  since();
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'report' }, H)).reported, true);
  assert.match(textsTo(since(), OWNER), /یک گزارش تازه برای بررسی/);
  // replying needs the channels, like in the chat
  mock.setMember(CHANNELS[0], host.id, { status: 'left' });
  rawDatabase().prepare('UPDATE users SET join_until = 0 WHERE user_id = ?').run(host.id);
  await assert.rejects(() => inboxEndpoint({ op: 'reply', id: ref, text: 'بدون عضویت' }, H), /عضو/);
  join(host);
  assert.equal((await inboxEndpoint({ op: 'act', id: ref, act: 'delete' }, H)).deleted, true);
  await assert.rejects(() => inboxEndpoint({ op: 'get', id: ref }, H), /دیگر در دسترس نیست/);
  await assert.rejects(() => inboxEndpoint({ op: 'list' }, { initData: { user: { id: 801000999 } } }), /Open the bot first/);
  await assert.rejects(() => inboxEndpoint({ op: 'drop_tables' }, H), /Unknown operation/);
  await assert.rejects(() => inboxEndpoint({ op: 'list' }, {}), /Open this from the bot/);
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
    && !/message is not modified|message to react not found|wrong file identifier/.test(c.result.description));
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
