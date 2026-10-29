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

/** Presses a button on message `msgId` in the owner's chat; it must be answered exactly once. */
async function press(data, msgId, from = U.owner) {
  const cq = { id: `cb${seq++}`, from, chat_instance: '1', data, message: mock.messageObject(OWNER, msgId) };
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

let ali1; // Ali's first message: { id, fwd, copy } (fwd/copy = ids in the owner's chat)

await scenario('owner /start: help, database ready', async () => {
  const o = await ownerSends('text', '/start');
  const [help] = textsTo(o.calls, OWNER);
  assert.match(help, /سلام مدیر/);
  assert.match(help, /یک بار <b>فوروارد<\/b> و یک بار <b>کپی<\/b>/);
  assert.match(help, /دیتابیس: ✅ آماده/);
  assert.equal(o.calls.length, 1);
});

await scenario('user /start: welcome, nothing goes to the owner', async () => {
  const s = await userSends(U.ali, 'text', '/start');
  assert.equal(s.calls.length, 1);
  assert.match(textsTo(s.calls, U.ali.id)[0], /به دست مدیر ربات می‌رسه/);
  assert.equal(of(s.calls, 'forwardMessage').length + of(s.calls, 'copyMessage').length, 0);
});

await scenario('user text: forwarded ONCE and copied ONCE to the owner, user gets ✅', async () => {
  const s = await userSends(U.ali, 'text', 'سلام، یه سوال داشتم');
  assert.deepEqual(s.calls.map((c) => c.method), ['forwardMessage', 'copyMessage', 'sendMessage']);
  const [fwd] = of(s.calls, 'forwardMessage', OWNER);
  const [copy] = of(s.calls, 'copyMessage', OWNER);
  assert.deepEqual([fwd.params.from_chat_id, fwd.params.message_id], [U.ali.id, s.id]);
  assert.deepEqual([copy.params.from_chat_id, copy.params.message_id], [U.ali.id, s.id]);
  assert.ok(fwd.result.ok && copy.result.ok);
  assert.deepEqual(copy.params.reply_markup.inline_keyboard, [
    [{ text: '👤 علی رضایی · @ali_t', callback_data: `u:${U.ali.id}:${s.id}` }],
    [{ text: '⛔️ مسدود کردن', callback_data: `b:${U.ali.id}:${s.id}` }],
  ]);
  assert.deepEqual(textsTo(s.calls, U.ali.id), ['✅ پیامت ارسال شد.']);
  ali1 = { id: s.id, fwd: okId(fwd), copy: okId(copy) };
  // what the owner now sees: the forward (with Ali as its origin) and the copy (same content, keyboard)
  assert.equal(mock.get(OWNER, ali1.fwd).forwardOrigin.sender_user.id, U.ali.id);
  assert.equal(mock.get(OWNER, ali1.copy).text, 'سلام، یه سوال داشتم');
  assert.equal(count('SELECT count(*) AS n FROM links WHERE user_id = ? AND user_msg_id = ?', U.ali.id, s.id), 2);
  assert.equal(row('SELECT messages FROM users WHERE user_id = ?', U.ali.id).messages, 1);
});

await scenario('owner replies to the FORWARD → copied to the user, as a reply to their message', async () => {
  const o = await ownerSends('text', 'سلام علی، بپرس', { replyTo: ali1.fwd });
  const [ans] = of(o.calls, 'copyMessage');
  assert.equal(Number(ans.params.chat_id), U.ali.id);
  assert.deepEqual([ans.params.from_chat_id, ans.params.message_id], [OWNER, o.id]);
  assert.deepEqual(ans.params.reply_parameters, { message_id: ali1.id, allow_sending_without_reply: true });
  assert.ok(ans.result.ok);
  const got = mock.get(U.ali.id, okId(ans));
  assert.equal(got.text, 'سلام علی، بپرس');
  assert.equal(got.replyTo, ali1.id, 'shows as a reply to Ali\'s message');
  assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>علی رضایی</b> ارسال شد.']);
  assert.equal(o.calls.length, 2);
});

await scenario('owner replies to the COPY with a voice → the user gets the voice', async () => {
  const o = await ownerSends('voice', '', { replyTo: ali1.copy });
  const [ans] = of(o.calls, 'copyMessage', U.ali.id);
  assert.ok(ans && ans.result.ok);
  assert.equal(mock.get(U.ali.id, okId(ans)).kind, 'voice');
  assert.equal(ans.params.reply_parameters.message_id, ali1.id);
  assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>علی رضایی</b> ارسال شد.']);
});

await scenario('stickers, photos with captions, documents… all relayed both ways', async () => {
  for (const kind of ['sticker', 'photo', 'document', 'video', 'video_note', 'animation', 'location', 'contact']) {
    const s = await userSends(U.ali, kind, kind === 'photo' ? 'عکس' : '');
    assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['forwardMessage:true', 'copyMessage:true', 'sendMessage:true'], kind);
    const copy = okId(of(s.calls, 'copyMessage')[0]);
    const o = await ownerSends(kind, '', { replyTo: copy });
    const [ans] = of(o.calls, 'copyMessage', U.ali.id);
    assert.ok(ans && ans.result.ok, kind);
    assert.equal(ans.params.reply_parameters.message_id, s.id);
  }
});

await scenario('a user who hides forwards (privacy): the forward shows no account, a reply to it still reaches them', async () => {
  const s = await userSends(U.sara, 'photo', 'این عکس');
  const fwd = okId(of(s.calls, 'forwardMessage')[0]);
  assert.equal(mock.get(OWNER, fwd).forwardOrigin.type, 'hidden_user');
  const copy = of(s.calls, 'copyMessage')[0];
  assert.equal(copy.params.reply_markup.inline_keyboard[0][0].text, `👤 سارا · ${U.sara.id}`);
  const o = await ownerSends('text', 'عکس قشنگیه', { replyTo: fwd });
  const [ans] = of(o.calls, 'copyMessage', U.sara.id);
  assert.ok(ans && ans.result.ok);
  assert.equal(ans.params.reply_parameters.message_id, s.id);
  assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>سارا</b> ارسال شد.']);
});

await scenario('user album (3 photos, arriving at once): 3 forwards + 3 copies, but ONE "✅ sent"', async () => {
  const calls = await together(3, () => userSends(U.ali, 'photo', '', { media_group_id: 'album-1' }));
  assert.equal(of(calls, 'forwardMessage', OWNER).filter((c) => c.result.ok).length, 3);
  assert.equal(of(calls, 'copyMessage', OWNER).filter((c) => c.result.ok).length, 3);
  assert.deepEqual(textsTo(calls, U.ali.id), ['✅ پیامت ارسال شد.']);
  const next = await together(2, () => userSends(U.ali, 'photo', '', { media_group_id: 'album-2' }));
  assert.deepEqual(textsTo(next, U.ali.id), ['✅ پیامت ارسال شد.'], 'a new album gets its own notice');
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

await scenario('owner replies to something that is not a user\'s message: nothing is sent to anyone', async () => {
  // the help text the bot sent
  const help = okId((await ownerSends('text', '/help')).calls[0]);
  const a = await ownerSends('text', 'جواب', { replyTo: help });
  assert.deepEqual(a.calls.map((c) => c.method), ['sendMessage']);
  assert.match(textsTo(a.calls, OWNER)[0], /به هیچ کاربری وصل نیست/);
  // a message the owner forwarded in from elsewhere (its origin is Ali, but the owner sent it)
  const id = newId(OWNER);
  mock.store(OWNER, id, { from: U.owner, kind: 'text', text: 'fwd', forwardOrigin: { type: 'user', sender_user: U.ali, date: 0 } });
  const b = await ownerSends('text', 'جواب', { replyTo: id });
  assert.equal(of(b.calls, 'copyMessage').length, 0, 'must not message the forward\'s origin');
  // the owner's own message
  const c = await ownerSends('text', 'جواب', { replyTo: a.id });
  assert.equal(of(c.calls, 'copyMessage').length, 0);
});

await scenario('a message that can\'t be copied (quiz): forwarded, plus a notice with the user keyboard; a reply to the notice works', async () => {
  const s = await userSends(U.ali, 'quiz');
  assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['forwardMessage:true', 'copyMessage:false', 'sendMessage:true', 'sendMessage:true']);
  const fwd = okId(of(s.calls, 'forwardMessage')[0]);
  const [notice] = of(s.calls, 'sendMessage', OWNER);
  assert.match(notice.params.text, /کپی این پیام ممکن نشد/);
  assert.deepEqual(kbData(notice.params.reply_markup), [[`u:${U.ali.id}:${s.id}`], [`b:${U.ali.id}:${s.id}`]]);
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

await scenario('owner hasn\'t started the bot: the user is told it failed', async () => {
  mock.state.started.delete(OWNER);
  const s = await userSends(U.ali, 'text', 'کسی هست؟');
  mock.state.started.add(OWNER);
  assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['forwardMessage:false', 'copyMessage:false', 'sendMessage:true']);
  assert.match(textsTo(s.calls, U.ali.id)[0], /ارسال نشد/);
});

await scenario('user blocked the bot: the owner\'s reply reports it', async () => {
  const s = await userSends(U.quiet, 'text', 'bye');
  const copy = okId(of(s.calls, 'copyMessage')[0]);
  mock.state.blocked.add(U.quiet.id);
  const o = await ownerSends('text', 'کجا رفتی؟', { replyTo: copy });
  assert.equal(of(o.calls, 'copyMessage')[0].result.error_code, 403);
  assert.deepEqual(textsTo(o.calls, OWNER), ['❌ ارسال نشد: <b>Quiet</b> ربات را بلاک کرده یا حسابش دیگر در دسترس نیست.']);
});

await scenario('👤 button: alert with name, @username, id, message count, status', async () => {
  const p = await press(`u:${U.ali.id}:${ali1.id}`, ali1.copy);
  assert.equal(p.answer.show_alert, true);
  const t = p.answer.text;
  for (const part of ['علی رضایی', '@ali_t', String(U.ali.id), 'پیام‌ها: ', '2026-10-29', 'آزاد']) assert.ok(t.includes(part), `alert lacks ${part}: ${t}`);
  assert.ok(t.length <= 200);
});

await scenario('⛔️ button blocks: keyboard flips, the user\'s messages stop reaching the owner; ✅ unblocks', async () => {
  const b = await press(`b:${U.ali.id}:${ali1.id}`, ali1.copy);
  assert.match(b.answer.text, /مسدود شد/);
  const [edit] = of(b.calls, 'editMessageReplyMarkup', OWNER);
  assert.ok(edit.result.ok);
  assert.deepEqual(kbData(edit.params.reply_markup), [[`u:${U.ali.id}:${ali1.id}`], [`ub:${U.ali.id}:${ali1.id}`]]);
  assert.equal(edit.params.reply_markup.inline_keyboard[0][0].text, '👤 علی رضایی · @ali_t', 'name row kept');
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 1);

  const s = await userSends(U.ali, 'text', 'منو بلاک کردی؟');
  assert.deepEqual(s.calls.map((c) => c.method), ['sendMessage']);
  assert.match(textsTo(s.calls, U.ali.id)[0], /امکان ارسال پیام برای شما وجود ندارد/);
  const album = await together(2, () => userSends(U.ali, 'photo', '', { media_group_id: 'album-blocked' }));
  assert.equal(textsTo(album, U.ali.id).length, 1, 'one notice per album');
  assert.equal(of(album, 'forwardMessage').length, 0);
  const info = await press(`u:${U.ali.id}:${ali1.id}`, ali1.copy);
  assert.match(info.answer.text, /مسدود/);

  const u = await press(`ub:${U.ali.id}:${ali1.id}`, ali1.copy);
  assert.match(u.answer.text, /از مسدودی درآمد/);
  assert.deepEqual(kbData(of(u.calls, 'editMessageReplyMarkup')[0].params.reply_markup)[1], [`b:${U.ali.id}:${ali1.id}`]);
  const again = await userSends(U.ali, 'text', 'برگشتم');
  assert.deepEqual(again.calls.map((c) => c.method), ['forwardMessage', 'copyMessage', 'sendMessage']);
});

await scenario('/block and /unblock as a reply to the forward (the command itself is not sent to the user)', async () => {
  const b = await ownerSends('text', '/block', { replyTo: ali1.fwd });
  assert.deepEqual(b.calls.map((c) => c.method), ['sendMessage']);
  assert.match(textsTo(b.calls, OWNER)[0], /<b>علی رضایی<\/b> مسدود شد/);
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 1);
  const s = await userSends(U.ali, 'text', 'سلام');
  assert.equal(of(s.calls, 'forwardMessage').length, 0);
  const u = await ownerSends('text', '/unblock', { replyTo: ali1.fwd });
  assert.match(textsTo(u.calls, OWNER)[0], /از مسدودی درآمد/);
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 0);
});

await scenario('buttons: anyone but the owner is refused; unknown data = old button', async () => {
  const p = await press(`b:${U.ali.id}:${ali1.id}`, ali1.copy, U.sara);
  assert.match(p.answer.text, /فقط برای مدیر/);
  assert.equal(p.calls.length, 1);
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.ali.id).blocked, 0);
  const old = await press('x:1', ali1.copy);
  assert.match(old.answer.text, /قدیمی/);
});

await scenario('HTML in a user\'s name is escaped in every message the owner gets', async () => {
  const s = await userSends(U.evil, 'text', '<i>not html</i>');
  const copy = of(s.calls, 'copyMessage')[0];
  assert.ok(copy.result.ok);
  assert.equal(copy.params.reply_markup.inline_keyboard[0][0].text, `👤 <b>Hack</b> & "co" · ${U.evil.id}`, 'button text is plain text');
  const o = await ownerSends('text', 'ok', { replyTo: okId(copy) });
  assert.deepEqual(textsTo(o.calls, OWNER), ['✅ برای <b>&lt;b&gt;Hack&lt;/b&gt; &amp; &quot;co&quot;</b> ارسال شد.']);
  assert.ok(of(o.calls, 'sendMessage')[0].result.ok);
  const b = await ownerSends('text', '/block', { replyTo: okId(copy) });
  assert.ok(of(b.calls, 'sendMessage')[0].result.ok);
});

await scenario('database not migrated yet: relaying and replying to the copy still work; block and /start say so', async () => {
  const db = rawDatabase();
  db.exec('ALTER TABLE users RENAME TO users_off; ALTER TABLE links RENAME TO links_off');
  try {
    const s = await userSends(U.ali, 'text', 'بدون دیتابیس');
    assert.deepEqual(s.calls.map((c) => `${c.method}:${c.result.ok}`), ['forwardMessage:true', 'copyMessage:true', 'sendMessage:true']);
    assert.match(s.r.dbError, /no such table/);
    const fwd = okId(of(s.calls, 'forwardMessage')[0]);
    const copy = okId(of(s.calls, 'copyMessage')[0]);
    // reply to the copy: the user comes from its keyboard, including their message id
    const a = await ownerSends('text', 'جواب بدون دیتابیس', { replyTo: copy });
    const [ans] = of(a.calls, 'copyMessage', U.ali.id);
    assert.ok(ans && ans.result.ok);
    assert.equal(ans.params.reply_parameters.message_id, s.id);
    assert.deepEqual(textsTo(a.calls, OWNER), [`✅ برای <b>کاربر ${U.ali.id}</b> ارسال شد.`]);
    // reply to the forward of a user who doesn't hide forwards: from its origin
    const f = await ownerSends('text', 'جواب به فوروارد', { replyTo: fwd });
    assert.ok(of(f.calls, 'copyMessage', U.ali.id)[0].result.ok);
    // block can't work without the table: the owner is told what to do
    const b = await press(`b:${U.ali.id}:${s.id}`, copy);
    assert.equal(b.answer.show_alert, true);
    assert.match(b.answer.text, /Start Migration/);
    const i = await press(`u:${U.ali.id}:${s.id}`, copy);
    assert.match(i.answer.text, /Start Migration/);
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
    /^(forwardMessage|copyMessage): Forbidden: bot can't initiate conversation with a user$/, // owner hadn't started the bot
    /^copyMessage: Forbidden: bot was blocked by the user$/, // Quiet
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
