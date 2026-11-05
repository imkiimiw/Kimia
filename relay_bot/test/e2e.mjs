// End-to-end test: the real handlers (tgcloud/handlers/*.js) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a strict mock Bot API
// that keeps every chat's messages (test/mock-telegram.mjs).
// Run: npm test
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';

const BOT_ID = 7000000002;
const OWNER = 5557901897;

// ---------- infrastructure ----------

const mock = createMockTelegram({ botId: BOT_ID });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema); // what "Start Migration" / `npx tgcloud migrate` does on the platform

// Telegram runs modules in a bare V8 isolate: ECMAScript built-ins, `console` and the `sdk` only.
// Remove Node's web and timer globals so any use of them in the bot fails here too.
for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'atob', 'btoa', 'crypto', 'AbortController', 'AbortSignal', 'Buffer', 'performance', 'navigator', 'Intl']) {
  delete globalThis[name];
}

const { default: onMessage } = await import('../tgcloud/handlers/message.js');
const { default: onCallback } = await import('../tgcloud/handlers/callback_query.js');

const errors = [];
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
console.warn = () => {}; // expected Bot API failures are logged as warnings

const clock = Date.UTC(2026, 9, 29, 6, 0);
Date.now = () => clock;
const nowSec = () => Math.floor(clock / 1000);

const person = (id, firstName, extra = {}) => ({ id, is_bot: false, first_name: firstName, language_code: 'fa', ...extra });
const U = {
  owner: person(OWNER, 'Owner', { username: 'owner_t' }),
  ali: person(710000001, 'علی', { last_name: 'رضایی', username: 'ali_t' }),
  sara: person(710000002, 'سارا'), // no username, and hides her account on forwards
  evil: person(710000003, '<b>Hack</b> & "co"'),
  quiet: person(710000004, 'Quiet'), // blocks the bot later
};
for (const u of Object.values(U)) mock.state.users.set(u.id, { ...u, hidden: u === U.sara });

let seq = 1;
const nextId = new Map(); // per-chat message ids, like Telegram's private chats
const newId = (chat) => {
  const n = (nextId.get(chat) || 0) + 1;
  nextId.set(chat, n);
  return n;
};

function content(kind, text) {
  if (kind === 'text') return { text };
  if (kind === 'photo') return { photo: [{ file_id: 'p', file_unique_id: 'p', width: 90, height: 90 }], ...(text ? { caption: text } : {}) };
  if (kind === 'quiz') return { poll: { id: '1', question: 'q?', options: [], type: 'quiz', is_anonymous: false } };
  if (kind === 'service') return { pinned_message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 0 } };
  return { [kind]: { file_id: kind, file_unique_id: kind } };
}

let concurrent = false; // inside together(): updates overlap, so calls can't be told apart per update

/** Runs a handler; its trace must list exactly the Bot API calls it made. */
async function run(handler, key, payload) {
  const start = mock.state.calls.length;
  const r = await handler(payload, { update: { update_id: seq++, [key]: payload } });
  assert.ok(r && Array.isArray(r.trace), `handler returned no trace: ${JSON.stringify(r)}`);
  assert.equal(r.error, undefined, `handler error: ${r.error}`);
  if (concurrent) return { r, calls: [] };
  const calls = mock.state.calls.slice(start);
  assert.deepEqual(r.trace.map((e) => e.m), calls.map((c) => c.method), 'trace differs from the calls made');
  return { r, calls };
}

/** Delivers several updates at once, like an album arriving (one update per photo). */
async function together(n, fn) {
  const start = mock.state.calls.length;
  concurrent = true;
  let results;
  try {
    results = await Promise.all(Array.from({ length: n }, fn));
  } finally {
    concurrent = false;
  }
  const calls = mock.state.calls.slice(start);
  const traced = results.flatMap((x) => x.r.trace.map((e) => e.m)).sort();
  assert.deepEqual(traced, calls.map((c) => c.method).sort(), 'traces differ from the calls made');
  return calls;
}

/** `u` writes to the bot in its private chat. */
async function userSends(u, kind = 'text', text = '', extra = {}) {
  mock.state.started.add(u.id); // writing to the bot means it was started
  const id = newId(u.id);
  mock.store(u.id, id, { from: u, kind, text });
  const message = { message_id: id, from: u, chat: { id: u.id, type: 'private', first_name: u.first_name }, date: nowSec(), ...content(kind, text), ...extra };
  if (kind === 'text' && /^\/\w+/.test(text)) message.entities = [{ type: 'bot_command', offset: 0, length: /^\/\w+/.exec(text)[0].length }];
  const out = await run(onMessage, 'message', message);
  return { ...out, id };
}

/** The owner writes in the bot's chat, optionally as a reply to message `replyTo` there. */
async function ownerSends(kind = 'text', text = '', { replyTo = null, extra = {} } = {}) {
  mock.state.started.add(OWNER);
  const id = newId(OWNER);
  mock.store(OWNER, id, { from: U.owner, kind, text });
  const message = { message_id: id, from: U.owner, chat: { id: OWNER, type: 'private', first_name: 'Owner' }, date: nowSec(), ...content(kind, text), ...extra };
  if (kind === 'text' && /^\/\w+/.test(text)) message.entities = [{ type: 'bot_command', offset: 0, length: /^\/\w+/.exec(text)[0].length }];
  if (replyTo) message.reply_to_message = mock.messageObject(OWNER, replyTo);
  const out = await run(onMessage, 'message', message);
  return { ...out, id };
}

/**
 * Presses a button on message `msgId` in the owner's chat; it must be answered exactly once.
 * `message` overrides what the update carries (a second tap still shows the old buttons).
 */
async function press(data, msgId, from = U.owner, message = mock.messageObject(OWNER, msgId)) {
  const cq = { id: `cb${seq++}`, from, chat_instance: '1', data, message };
  const out = await run(onCallback, 'callback_query', cq);
  const answers = out.calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answers.length, 1, `answerCallbackQuery called ${answers.length} times for ${data}`);
  assert.ok(answers[0].result.ok, `answerCallbackQuery rejected: ${JSON.stringify(answers[0].result)}`);
  return { ...out, answer: answers[0].params };
}

const of = (calls, method, chat) => calls.filter((c) => c.method === method && (chat === undefined || Number(c.params.chat_id) === chat));
const textsTo = (calls, chat) => of(calls, 'sendMessage', chat).map((c) => c.params.text);
const okId = (c) => c.result.result.message_id;
const row = (q, ...p) => rawDatabase().prepare(q).get(...p);
const count = (q, ...p) => row(q, ...p).n;
const kbData = (markup) => markup.inline_keyboard.map((r) => r.map((b) => b.callback_data));

// ---------- scenario runner ----------

const outcome = [];
async function scenario(name, fn) {
  try {
    await fn();
    outcome.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push({ name, ok: false, err });
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 8).join('\n   ')}`);
  }
}

// ---------- scenarios ----------

let ali1; // Ali's first message: { id, card, fwd, copy } (card/fwd/copy = ids in the owner's chat)
const cardKb = (uid, mid, { seen = false, blocked = false } = {}) => [
  [seen ? `sd:${uid}:${mid}` : `s:${uid}:${mid}`, `r:${uid}:${mid}`],
  [blocked ? `ub:${uid}:${mid}` : `b:${uid}:${mid}`],
];

await scenario('owner /start: help (card, buttons), database ready', async () => {
  const o = await ownerSends('text', '/start');
  const [help] = textsTo(o.calls, OWNER);
  for (const part of ['سلام مدیر', '📩 پیام جدید', '<b>فوروارد</b>', '<b>کپی</b>', '👁 <b>سین بزن</b>', '✉️ <b>پیام بده</b>', '⛔️ <b>بلاک</b>', 'دیتابیس: ✅ آماده']) {
    assert.ok(help.includes(part), `help lacks ${part}`);
  }
  assert.equal(o.calls.length, 1);
});

await scenario('user /start: welcome, nothing goes to the owner', async () => {
  const s = await userSends(U.ali, 'text', '/start');
  assert.equal(s.calls.length, 1);
  assert.match(textsTo(s.calls, U.ali.id)[0], /به دست مدیر ربات می‌رسه/);
});

await scenario('user text → owner gets "📩 پیام جدید" card, then the forward, then the copy; user gets ✅', async () => {
  const s = await userSends(U.ali, 'text', 'سلام، یه سوال داشتم');
  assert.deepEqual(s.calls.map((c) => `${c.method}→${c.params.chat_id}`), [
    `sendMessage→${OWNER}`, `forwardMessage→${OWNER}`, `copyMessage→${OWNER}`, `sendMessage→${U.ali.id}`,
  ]);
  assert.ok(s.calls.every((c) => c.result.ok));
  const [card, fwd, copy, sent] = s.calls;
  assert.equal(card.params.text, `📩 <b>پیام جدید</b>\n👤 <a href="tg://user?id=${U.ali.id}">علی رضایی</a> · @ali_t\n🆔 <code>${U.ali.id}</code>`);
  assert.deepEqual(kbData(card.params.reply_markup), cardKb(U.ali.id, s.id));
  assert.deepEqual(card.params.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text)), [['👁 سین بزن', '✉️ پیام بده'], ['⛔️ بلاک']]);
  assert.deepEqual([fwd.params.from_chat_id, fwd.params.message_id], [U.ali.id, s.id]);
  assert.deepEqual([copy.params.from_chat_id, copy.params.message_id], [U.ali.id, s.id]);
  assert.equal(copy.params.reply_markup, undefined, 'the copy is a plain copy');
  assert.equal(sent.params.text, '✅ پیامت ارسال شد.');
  ali1 = { id: s.id, card: okId(card), fwd: okId(fwd), copy: okId(copy) };
  assert.equal(mock.get(OWNER, ali1.fwd).forwardOrigin.sender_user.id, U.ali.id);
  assert.equal(mock.get(OWNER, ali1.copy).text, 'سلام، یه سوال داشتم');
  assert.equal(count('SELECT count(*) AS n FROM links WHERE user_id = ? AND user_msg_id = ?', U.ali.id, s.id), 3);
});

await scenario('👁 سین بزن: the user is told "👁 پیامت دیده شد" (as a reply to their message), once even on a double tap', async () => {
  const stale = mock.messageObject(OWNER, ali1.card); // what a second, quick tap still carries
  const p = await press(`s:${U.ali.id}:${ali1.id}`, ali1.card);
  const [seen] = of(p.calls, 'sendMessage', U.ali.id);
  assert.equal(seen.params.text, '👁 پیامت دیده شد.');
  assert.deepEqual(seen.params.reply_parameters, { message_id: ali1.id, allow_sending_without_reply: true });
  assert.equal(mock.get(U.ali.id, okId(seen)).replyTo, ali1.id);
  assert.match(p.answer.text, /اعلام شد/);
  const [edit] = of(p.calls, 'editMessageReplyMarkup', OWNER);
  assert.deepEqual(kbData(edit.params.reply_markup), cardKb(U.ali.id, ali1.id, { seen: true }));
  assert.equal(edit.params.reply_markup.inline_keyboard[0][0].text, '✅ سین زده شد');
  // the double tap: same old buttons, but the database says it was done
  const again = await press(`s:${U.ali.id}:${ali1.id}`, ali1.card, U.owner, stale);
  assert.equal(of(again.calls, 'sendMessage').length, 0, 'told only once');
  assert.match(again.answer.text, /قبلاً/);
  const done = await press(`sd:${U.ali.id}:${ali1.id}`, ali1.card);
  assert.deepEqual(done.calls.map((c) => c.method), ['answerCallbackQuery']);
  assert.match(done.answer.text, /قبلاً/);
});

await scenario('✉️ پیام بده: a prompt (force reply); whatever the owner sends as its reply goes to the user', async () => {
  const p = await press(`r:${U.ali.id}:${ali1.id}`, ali1.card);
  assert.match(p.answer.text, /بفرست/);
  const [prompt] = of(p.calls, 'sendMessage', OWNER);
  assert.match(prompt.params.text, /پیامت برای <b>علی رضایی<\/b> را بفرست/);
  assert.deepEqual(prompt.params.reply_markup, { force_reply: true, input_field_placeholder: 'پیام به علی رضایی' });
  assert.equal(prompt.params.reply_parameters.message_id, ali1.card);
  assert.equal(of(p.calls, 'sendMessage', U.ali.id).length, 0, 'nothing goes to the user yet');
  const promptId = okId(prompt);
  for (const kind of ['text', 'voice', 'photo']) {
    const o = await ownerSends(kind, kind === 'text' ? 'سلام علی، بگو' : '', { replyTo: promptId });
    const [ans] = of(o.calls, 'copyMessage', U.ali.id);
    assert.ok(ans && ans.result.ok, kind);
    assert.deepEqual([ans.params.from_chat_id, ans.params.message_id], [OWNER, o.id]);
    assert.equal(ans.params.reply_parameters.message_id, ali1.id);
    assert.equal(mock.get(U.ali.id, okId(ans)).kind, kind);
    assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>علی رضایی</b> ارسال شد.']);
  }
});

await scenario('Reply on the card, the forward or the copy also answers the user', async () => {
  for (const target of [ali1.card, ali1.fwd, ali1.copy]) {
    const o = await ownerSends('text', 'جواب', { replyTo: target });
    const [ans] = of(o.calls, 'copyMessage', U.ali.id);
    assert.ok(ans && ans.result.ok);
    assert.equal(ans.params.reply_parameters.message_id, ali1.id);
    assert.equal(mock.get(U.ali.id, okId(ans)).replyTo, ali1.id);
  }
});

await scenario('stickers, photos with captions, documents… all relayed (card + forward + copy) and answerable', async () => {
  for (const kind of ['sticker', 'photo', 'document', 'video', 'video_note', 'animation', 'voice', 'location', 'contact']) {
    const s = await userSends(U.ali, kind, kind === 'photo' ? 'عکس' : '');
    assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['sendMessage:true', 'forwardMessage:true', 'copyMessage:true', 'sendMessage:true'], kind);
    const copy = okId(of(s.calls, 'copyMessage')[0]);
    assert.equal(mock.get(OWNER, copy).kind, kind);
    const o = await ownerSends(kind, '', { replyTo: copy });
    const [ans] = of(o.calls, 'copyMessage', U.ali.id);
    assert.ok(ans && ans.result.ok, kind);
    assert.equal(ans.params.reply_parameters.message_id, s.id);
  }
});

await scenario('a user who hides forwards (privacy): the card still names them, a reply to the forward reaches them', async () => {
  const s = await userSends(U.sara, 'photo', 'این عکس');
  const [card] = of(s.calls, 'sendMessage', OWNER);
  assert.match(card.params.text, new RegExp(`<a href="tg://user\\?id=${U.sara.id}">سارا</a>\\n`));
  const fwd = okId(of(s.calls, 'forwardMessage')[0]);
  assert.equal(mock.get(OWNER, fwd).forwardOrigin.type, 'hidden_user');
  const o = await ownerSends('text', 'عکس قشنگیه', { replyTo: fwd });
  const [ans] = of(o.calls, 'copyMessage', U.sara.id);
  assert.ok(ans && ans.result.ok);
  assert.equal(ans.params.reply_parameters.message_id, s.id);
  assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>سارا</b> ارسال شد.']);
});

await scenario('user album (3 photos, arriving at once): ONE card, 3 forwards + 3 copies, ONE "✅ sent"', async () => {
  const calls = await together(3, () => userSends(U.ali, 'photo', '', { media_group_id: 'album-1' }));
  const cards = textsTo(calls, OWNER);
  assert.equal(cards.length, 1);
  assert.match(cards[0], /پیام جدید<\/b> \(آلبوم\)/);
  assert.equal(of(calls, 'forwardMessage', OWNER).filter((c) => c.result.ok).length, 3);
  assert.equal(of(calls, 'copyMessage', OWNER).filter((c) => c.result.ok).length, 3);
  assert.deepEqual(textsTo(calls, U.ali.id), ['✅ پیامت ارسال شد.']);
  const next = await together(2, () => userSends(U.ali, 'photo', '', { media_group_id: 'album-2' }));
  assert.equal(textsTo(next, OWNER).length, 1, 'a new album gets its own card');
  assert.deepEqual(textsTo(next, U.ali.id), ['✅ پیامت ارسال شد.']);
});

await scenario('owner album reply: every photo goes to the user, ONE "✅" to the owner', async () => {
  const calls = await together(3, () => ownerSends('photo', '', { replyTo: ali1.copy, extra: { media_group_id: 'owner-album-1' } }));
  assert.equal(of(calls, 'copyMessage', U.ali.id).filter((c) => c.result.ok).length, 3);
  assert.equal(textsTo(calls, OWNER).length, 1);
});

await scenario('owner message that is not a reply: a hint, nothing goes to any user', async () => {
  const o = await ownerSends('text', 'سلام به همه');
  assert.equal(o.calls.length, 1);
  assert.match(textsTo(o.calls, OWNER)[0], /Reply/);
});

await scenario('owner replies to something that is not about a user: nothing is sent to anyone', async () => {
  const help = okId((await ownerSends('text', '/help')).calls[0]);
  const a = await ownerSends('text', 'جواب', { replyTo: help });
  assert.deepEqual(a.calls.map((c) => c.method), ['sendMessage']);
  assert.match(textsTo(a.calls, OWNER)[0], /به هیچ کاربری وصل نیست/);
  // a message the owner forwarded in from elsewhere (its origin is Ali, but the owner sent it)
  const id = newId(OWNER);
  mock.store(OWNER, id, { from: U.owner, kind: 'text', text: 'fwd', forwardOrigin: { type: 'user', sender_user: U.ali, date: 0 } });
  const b = await ownerSends('text', 'جواب', { replyTo: id });
  assert.equal(of(b.calls, 'copyMessage').length, 0, 'must not message the forward\'s origin');
  const c = await ownerSends('text', 'جواب', { replyTo: a.id });
  assert.equal(of(c.calls, 'copyMessage').length, 0);
});

await scenario('a message that can\'t be copied (quiz): card + forward + a notice in place of the copy; a reply to the notice works', async () => {
  const s = await userSends(U.ali, 'quiz');
  assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['sendMessage:true', 'forwardMessage:true', 'copyMessage:false', 'sendMessage:true', 'sendMessage:true']);
  const fwd = okId(of(s.calls, 'forwardMessage')[0]);
  const notice = of(s.calls, 'sendMessage', OWNER)[1];
  assert.match(notice.params.text, /کپی این پیام ممکن نشد/);
  assert.equal(notice.params.reply_parameters.message_id, fwd);
  assert.deepEqual(textsTo(s.calls, U.ali.id), ['✅ پیامت ارسال شد.']);
  const o = await ownerSends('text', 'نظرسنجی رسید', { replyTo: okId(notice) });
  assert.equal(of(o.calls, 'copyMessage', U.ali.id)[0].params.reply_parameters.message_id, s.id);
});

await scenario('service messages (a pin) and group messages are ignored', async () => {
  const s = await userSends(U.ali, 'service');
  assert.equal(s.calls.length, 0);
  const group = { message_id: 5, from: U.ali, chat: { id: -100123, type: 'supergroup', title: 'g' }, date: nowSec(), text: 'hi' };
  const g = await run(onMessage, 'message', group);
  assert.equal(g.calls.length, 0);
});

await scenario('owner hasn\'t started the bot: nothing else is tried, the user is told it failed', async () => {
  mock.state.started.delete(OWNER);
  const s = await userSends(U.ali, 'text', 'کسی هست؟');
  mock.state.started.add(OWNER);
  assert.deepEqual(s.calls.map((c) => `${c.method}→${c.params.chat_id}:${c.result.ok}`), [`sendMessage→${OWNER}:false`, `sendMessage→${U.ali.id}:true`]);
  assert.match(textsTo(s.calls, U.ali.id)[0], /ارسال نشد/);
});

await scenario('user blocked the bot: replies and "seen" report it; the card stays unseen so it can be retried', async () => {
  const s = await userSends(U.quiet, 'text', 'bye');
  const card = okId(of(s.calls, 'sendMessage', OWNER)[0]);
  const copy = okId(of(s.calls, 'copyMessage')[0]);
  mock.state.blocked.add(U.quiet.id);
  const o = await ownerSends('text', 'کجا رفتی؟', { replyTo: copy });
  assert.equal(of(o.calls, 'copyMessage')[0].result.error_code, 403);
  assert.deepEqual(textsTo(o.calls, OWNER), ['❌ ارسال نشد: <b>Quiet</b> ربات را بلاک کرده یا حسابش دیگر در دسترس نیست.']);
  const p = await press(`s:${U.quiet.id}:${s.id}`, card);
  assert.equal(p.answer.show_alert, true);
  assert.match(p.answer.text, /اعلام نشد: این کاربر ربات را بلاک کرده/);
  assert.equal(of(p.calls, 'editMessageReplyMarkup').length, 0);
  assert.equal(row('SELECT seen FROM links WHERE owner_msg_id = ?', card).seen, 0);
  mock.state.blocked.delete(U.quiet.id);
  const retry = await press(`s:${U.quiet.id}:${s.id}`, card);
  assert.equal(of(retry.calls, 'sendMessage', U.quiet.id).length, 1, 'works once they unblock the bot');
});

await scenario('⛔️ بلاک: the card flips to "✅ آنبلاک", the user\'s messages stop reaching the owner; آنبلاک restores', async () => {
  const b = await press(`b:${U.ali.id}:${ali1.id}`, ali1.card);
  assert.match(b.answer.text, /بلاک شد/);
  const [edit] = of(b.calls, 'editMessageReplyMarkup', OWNER);
  assert.ok(edit.result.ok);
  assert.deepEqual(kbData(edit.params.reply_markup), cardKb(U.ali.id, ali1.id, { seen: true, blocked: true }), 'seen state kept');
  assert.equal(edit.params.reply_markup.inline_keyboard[1][0].text, '✅ آنبلاک');
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 1);

  const s = await userSends(U.ali, 'text', 'منو بلاک کردی؟');
  assert.deepEqual(s.calls.map((c) => `${c.method}→${c.params.chat_id}`), [`sendMessage→${U.ali.id}`]);
  assert.match(textsTo(s.calls, U.ali.id)[0], /امکان ارسال پیام برای شما وجود ندارد/);
  const album = await together(2, () => userSends(U.ali, 'photo', '', { media_group_id: 'album-blocked' }));
  assert.equal(textsTo(album, U.ali.id).length, 1, 'one notice per album');
  assert.equal(album.filter((c) => Number(c.params.chat_id) === OWNER).length, 0);

  const u = await press(`ub:${U.ali.id}:${ali1.id}`, ali1.card);
  assert.match(u.answer.text, /آنبلاک شد/);
  assert.deepEqual(kbData(of(u.calls, 'editMessageReplyMarkup')[0].params.reply_markup), cardKb(U.ali.id, ali1.id, { seen: true }));
  const again = await userSends(U.ali, 'text', 'برگشتم');
  assert.deepEqual(again.calls.map((c) => c.method), ['sendMessage', 'forwardMessage', 'copyMessage', 'sendMessage']);
});

await scenario('/block and /unblock as a reply (the command itself is not sent to the user)', async () => {
  const b = await ownerSends('text', '/block', { replyTo: ali1.fwd });
  assert.deepEqual(b.calls.map((c) => c.method), ['sendMessage']);
  assert.match(textsTo(b.calls, OWNER)[0], /<b>علی رضایی<\/b> بلاک شد/);
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 1);
  const s = await userSends(U.ali, 'text', 'سلام');
  assert.equal(of(s.calls, 'forwardMessage').length, 0);
  const u = await ownerSends('text', '/unblock', { replyTo: ali1.card });
  assert.match(textsTo(u.calls, OWNER)[0], /آنبلاک شد/);
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 0);
});

await scenario('buttons: anyone but the owner is refused; unknown data = old button', async () => {
  for (const data of [`b:${U.ali.id}:${ali1.id}`, `s:${U.ali.id}:${ali1.id}`, `r:${U.ali.id}:${ali1.id}`]) {
    const p = await press(data, ali1.card, U.sara);
    assert.match(p.answer.text, /فقط برای مدیر/);
    assert.equal(p.calls.length, 1);
  }
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 0);
  const old = await press('u:1:2', ali1.card);
  assert.match(old.answer.text, /قدیمی/);
});

await scenario('HTML in a user\'s name is escaped in every message the owner gets', async () => {
  const s = await userSends(U.evil, 'text', '<i>not html</i>');
  const [card] = of(s.calls, 'sendMessage', OWNER);
  assert.ok(card.result.ok);
  assert.ok(card.params.text.includes(`<a href="tg://user?id=${U.evil.id}">&lt;b&gt;Hack&lt;/b&gt; &amp; &quot;co&quot;</a>`));
  const copy = okId(of(s.calls, 'copyMessage')[0]);
  const o = await ownerSends('text', 'ok', { replyTo: copy });
  assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>&lt;b&gt;Hack&lt;/b&gt; &amp; &quot;co&quot;</b> ارسال شد.']);
  const p = await press(`r:${U.evil.id}:${s.id}`, okId(card));
  assert.ok(of(p.calls, 'sendMessage')[0].result.ok);
  const b = await ownerSends('text', '/block', { replyTo: copy });
  assert.ok(of(b.calls, 'sendMessage')[0].result.ok);
});

await scenario('database not migrated yet: messages still arrive, Reply on the card or forward still answers; block and /start say what to do', async () => {
  const db = rawDatabase();
  db.exec('ALTER TABLE users RENAME TO users_off; ALTER TABLE links RENAME TO links_off');
  try {
    const s = await userSends(U.ali, 'text', 'بدون دیتابیس');
    assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['sendMessage:true', 'forwardMessage:true', 'copyMessage:true', 'sendMessage:true']);
    assert.match(s.r.dbError, /no such table/);
    const card = okId(of(s.calls, 'sendMessage', OWNER)[0]);
    const fwd = okId(of(s.calls, 'forwardMessage')[0]);
    // Reply on the card: the user and their message come from its buttons
    const a = await ownerSends('text', 'جواب بدون دیتابیس', { replyTo: card });
    const [ans] = of(a.calls, 'copyMessage', U.ali.id);
    assert.ok(ans && ans.result.ok);
    assert.equal(ans.params.reply_parameters.message_id, s.id);
    assert.deepEqual(textsTo(a.calls, OWNER), [`✅ برای <b>کاربر ${U.ali.id}</b> ارسال شد.`]);
    // Reply on the forward of a user who doesn't hide forwards: from its origin
    const f = await ownerSends('text', 'جواب به فوروارد', { replyTo: fwd });
    assert.ok(of(f.calls, 'copyMessage', U.ali.id)[0].result.ok);
    // seen still works (no double-tap guard without the table)
    const seen = await press(`s:${U.ali.id}:${s.id}`, card);
    assert.equal(of(seen.calls, 'sendMessage', U.ali.id)[0].params.text, '👁 پیامت دیده شد.');
    // block needs the table: the owner is told what to do
    const b = await press(`b:${U.ali.id}:${s.id}`, card);
    assert.equal(b.answer.show_alert, true);
    assert.match(b.answer.text, /migrate/);
    const help = await ownerSends('text', '/start');
    assert.match(textsTo(help.calls, OWNER)[0], /دیتابیس: ❌ آماده نیست/);
  } finally {
    db.exec('ALTER TABLE users_off RENAME TO users; ALTER TABLE links_off RENAME TO links');
    errors.length = 0; // the "no such table" errors above were expected
  }
});

await scenario('every Bot API call was accepted, except the expected refusals', async () => {
  const refused = mock.state.calls.filter((c) => !c.result.ok).map((c) => `${c.method}: ${c.result.description}`);
  const expected = [
    /^copyMessage: Bad Request: the message can't be copied$/, // the quiz
    /^sendMessage: Forbidden: bot can't initiate conversation with a user$/, // owner hadn't started the bot
    /^(copyMessage|sendMessage): Forbidden: bot was blocked by the user$/, // Quiet
    /^editMessageReplyMarkup: Bad Request: message is not modified/, // the double tap on 👁 redraws an unchanged card
  ];
  assert.deepEqual(refused.filter((r) => !expected.some((re) => re.test(r))), []);
});

await scenario('no unexpected console.error during the whole run', async () => {
  assert.deepEqual(errors, []);
});

// ---------- summary ----------

await mock.close();
const failed = outcome.filter((o) => !o.ok);
console.log(`\n${outcome.length - failed.length}/${outcome.length} scenarios passed; ${mock.state.calls.length} Bot API calls`);
process.exit(failed.length ? 1 : 0);
