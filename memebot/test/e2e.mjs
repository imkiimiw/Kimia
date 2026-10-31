// End-to-end scenarios: the real handlers (tgcloud/) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a strict mock Bot API
// (test/mock-telegram.mjs). Web and timer globals are removed first, like the platform's isolate.
// Run: npm test
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createMockTelegram, geminiAnswer } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase, stats } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { ENV } from '../tgcloud/lib/env.js';
import { DAILY_UPLOADS, INLINE_CACHE, INLINE_PERSONAL_CACHE } from '../tgcloud/lib/config.js';
import { insertMeme } from '../tgcloud/lib/store.js';
import { indexWords } from '../tgcloud/lib/normalize.js';

const OWNER = 5557901897;
const BACKUP = -1001111111111;
const ZWNJ = '‌';

// ---------- infrastructure ----------

const mock = createMockTelegram();
mock.addChannel(BACKUP, { title: 'Meme backup' });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema); // what `npx tgcloud migrate` does on the platform
// The Phase 1 scenarios run with moderation off (an owner setting); the Phase 2 ones turn it on.
rawDatabase().prepare("INSERT INTO kv (key, value, n) VALUES ('set:moderation', '', 0)").run();
ENV.ownerId = OWNER;
ENV.backupChannelId = BACKUP;
// Phases 1–3 were built with the channel as a private archive (every upload forwarded) and no meme
// of the day; the Phase 4 scenarios switch to the public feed mode the deployment uses.
ENV.backupMode = 'all';
ENV.motdChannelId = 0;

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

let clock = Date.UTC(2026, 9, 31, 6, 0); // 2026-10-31 09:30 Tehran
Date.now = () => clock;
const advance = (sec) => { clock += sec * 1000; };
const nowSec = () => Math.floor(clock / 1000);
let typing = 3; // seconds between a user's messages

const sql = (q, ...p) => rawDatabase().prepare(q).all(...p).map((r) => ({ ...r }));
const one = (q, ...p) => sql(q, ...p)[0];

let mark = 0;
let seq = 1;
const pressed = [];

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}
const sends = (calls, method = 'sendMessage') => calls.filter((c) => c.method === method);
const lastText = (calls) => {
  const s = calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  return s.length ? s[s.length - 1].params.text : '';
};
const buttons = (call) => (call.params.reply_markup ? call.params.reply_markup.inline_keyboard.flat() : []);
const failed = (calls) => calls.filter((c) => !c.ok);

function check(r) {
  assert.ok(r && Array.isArray(r.trace), `handler returned no trace: ${JSON.stringify(r)}`);
  assert.equal(r.error, undefined, `handler error: ${r && r.error}`);
  return r;
}

const person = (id, name, lang = 'fa') => ({ id, is_bot: false, first_name: name, username: `${name.toLowerCase()}_t`, language_code: lang });
const U = {
  ali: person(810000001, 'Ali'),
  sara: person(810000002, 'Sara'),
  reza: person(810000003, 'Reza'),
  ann: person(810000004, 'Ann', 'en'),
  joe: person(810000005, 'Joe', 'en'),
  newbie: person(810000006, 'Newbie'),
  nima: person(810000007, 'Nima'),
  owner: person(OWNER, 'Owner'),
  mina: person(810000008, 'Mina'),
  kian: person(810000009, 'Kian'),
  lia: person(810000010, 'Lia', 'en'),
  pari: person(810000011, 'Pari'),
};

/** A private message from u. `content` is text, or an object of message fields (media etc.). */
async function say(u, content, extra = {}) {
  advance(typing); // a person needs a moment per message (anti-spam counts messages per minute)
  since();
  mock.state.privateChats.add(u.id);
  const message = { message_id: 100000 + seq++, from: u, chat: { id: u.id, type: 'private', first_name: u.first_name }, date: nowSec(), ...extra };
  if (typeof content === 'string') message.text = content;
  else Object.assign(message, content);
  mock.userSent(message);
  const r = check(await onMessage(message));
  return { r, calls: since(), message };
}

const FILES = {
  photo: (uid) => ({ photo: [{ file_id: `S_${uid}`, file_unique_id: `s${uid}`, width: 90, height: 90 }, { file_id: `F_${uid}`, file_unique_id: uid, width: 1280, height: 720 }] }),
  animation: (uid) => ({ animation: { file_id: `F_${uid}`, file_unique_id: uid, width: 320, height: 240, duration: 3 }, document: { file_id: `F_${uid}`, file_unique_id: uid } }),
  video: (uid) => ({ video: { file_id: `F_${uid}`, file_unique_id: uid, width: 640, height: 360, duration: 9 } }),
  sticker: (uid) => ({ sticker: { file_id: `F_${uid}`, file_unique_id: uid, type: 'regular', width: 512, height: 512, is_animated: false, is_video: false } }),
  voice: (uid) => ({ voice: { file_id: `F_${uid}`, file_unique_id: uid, duration: 4 } }),
};
const media = (u, kind, uid, extra = {}) => say(u, FILES[kind](uid), extra);

/** Uploads a meme start to finish; returns its id. */
async function upload(u, kind, uid, keywords) {
  await media(u, kind, uid);
  const { calls } = await say(u, keywords);
  const row = one('SELECT id FROM memes WHERE file_unique_id = ?', uid);
  assert.ok(row, `meme ${uid} not saved: ${lastText(calls)}`);
  return row.id;
}

/** A button press. `markup` = the pressed message's keyboard, which Telegram sends along. */
async function press(u, data, messageId, markup = null, chat = null) {
  since();
  const id = `cb${seq++}`;
  pressed.push(id);
  const where = chat ? { message: { message_id: messageId, chat, date: nowSec(), ...(markup ? { reply_markup: markup } : {}) } }
    : messageId === null ? {} : { message: { message_id: messageId, chat: { id: u.id, type: 'private' }, date: nowSec(), ...(markup ? { reply_markup: markup } : {}) } };
  const cq = { id, from: u, chat_instance: 'ci', data, ...where };
  const r = check(await onCallback(cq));
  const calls = since();
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === id);
  assert.equal(answers.length, 1, `callback ${data} answered ${answers.length} times`);
  return { r, calls, answer: answers[0].params };
}

async function inline(u, query, offset = '') {
  since();
  const id = `iq${seq++}`;
  const q = { id, from: u, query, offset, chat_type: 'private' };
  const before = stats.queries;
  let atAnswer = null;
  mock.state.onInlineAnswer = () => { atAnswer = stats.queries; };
  const r = check(await onInline(q));
  mock.state.onInlineAnswer = null;
  const calls = since();
  assert.equal(calls.length, 1, `inline query made ${calls.length} Bot API calls`);
  assert.ok(calls[0].ok, `answerInlineQuery failed: ${calls[0].error}`);
  const p = mock.state.answeredInline.get(id);
  // queries = the database work done before the answer went out (stats bookkeeping comes after)
  return { p, ids: p.results.map((x) => x.id), queries: atAnswer - before, r };
}

async function chosen(u, resultId, query = '', inlineMessageId = undefined) {
  if (inlineMessageId) mock.state.inlineMessages.set(inlineMessageId, 'null');
  return check(await onChosen({ result_id: resultId, from: u, query, ...(inlineMessageId ? { inline_message_id: inlineMessageId } : {}) }));
}

/** A button under a meme sent through inline mode (no message, an inline_message_id). */
async function pressInline(u, data, inlineMessageId) {
  since();
  const id = `cb${seq++}`;
  pressed.push(id);
  check(await onCallback({ id, from: u, chat_instance: 'ci', data, inline_message_id: inlineMessageId }));
  const calls = since();
  return { calls, answer: calls.find((c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === id).params };
}

const faDigits = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const memeId = (uid) => one('SELECT id FROM memes WHERE file_unique_id = ?', uid).id;

// ---------- scenarios ----------

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('first /start asks for the language in every language; picking it shows the welcome', async () => {
  const { calls } = await say(U.ali, '/start');
  const pick = sends(calls)[0];
  assert.match(pick.params.text, /زبان ربات/);
  assert.match(pick.params.text, /Choose the bot language/);
  assert.deepEqual(buttons(pick).map((b) => b.callback_data), ['lang:fa', 'lang:en']);
  const r = await press(U.ali, 'lang:fa', pick.result.message_id);
  assert.match(r.calls.find((c) => c.method === 'editMessageText').params.text, /فارسی شد/);
  const welcome = sends(r.calls)[0];
  assert.match(welcome.params.text, /@meme_test_bot/);
  assert.match(welcome.params.text, /سلام Ali/);
  assert.deepEqual(buttons(welcome).map((b) => b.callback_data || 'inline'), ['m:up', 'm:my', 'm:fav', 'm:tags', 'm:top', 'm:me', 'inline', 'm:lang', 'm:help']);
  assert.equal(one('SELECT lang FROM users WHERE id = ?', U.ali.id).lang, 'fa');
});

scenario('an English user gets English after picking it', async () => {
  const { calls } = await say(U.ann, '/start');
  const r = await press(U.ann, 'lang:en', sends(calls)[0].result.message_id);
  assert.match(sends(r.calls)[0].params.text, /Hi Ann/);
});

scenario('/start upload (the inline "upload" button) remembers the upload help through the language picker', async () => {
  const { calls } = await say(U.newbie, '/start upload');
  const pick = sends(calls)[0];
  assert.deepEqual(buttons(pick).map((b) => b.callback_data), ['lang:fa:u', 'lang:en:u']);
  const r = await press(U.newbie, 'lang:fa:u', pick.result.message_id);
  assert.match(sends(r.calls)[0].params.text, /میمت رو بفرست/);
  const again = await say(U.newbie, '/start upload');
  assert.match(lastText(again.calls), /میمت رو بفرست/);
});

scenario('upload a photo: asks for keywords, saves file ids only, forwards to the backup channel, offers "try it"', async () => {
  const m = await media(U.ali, 'photo', 'U1');
  const ask = sends(m.calls)[0];
  assert.match(ask.params.text, /کلمه‌ی کلیدی/);
  assert.equal(ask.params.reply_parameters.message_id, m.message.message_id);
  assert.deepEqual(buttons(ask).map((b) => b.callback_data), [`up:p:${m.message.message_id}`, `up:x:${m.message.message_id}`]);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.ali.id).state, 'kw');

  const k = await say(U.ali, `  گربه${ZWNJ}ي عصباني ۲  `);
  const row = one('SELECT * FROM memes WHERE file_unique_id = ?', 'U1');
  assert.equal(row.file_id, 'F_U1', 'the largest photo size is kept');
  assert.equal(row.kind, 'photo');
  assert.equal(row.keywords, `گربه${ZWNJ}ی عصبانی ۲`);
  assert.equal(row.uploader_id, U.ali.id);
  assert.equal(row.status, 'approved');
  assert.deepEqual(sql('SELECT word FROM meme_words WHERE meme_id = ? ORDER BY word', row.id).map((w) => w.word).sort(), ['2', 'گربه', 'گربهی', 'عصبانی', 'ی'].sort());
  const fwd = k.calls.find((c) => c.method === 'forwardMessage');
  assert.deepEqual([fwd.params.chat_id, fwd.params.from_chat_id, fwd.params.message_id], [BACKUP, U.ali.id, m.message.message_id]);
  assert.equal(row.backup_chat_id, BACKUP);
  assert.equal(row.backup_msg_id, fwd.result.message_id);
  assert.ok(k.calls.some((c) => c.method === 'editMessageReplyMarkup' && c.params.message_id === ask.result.message_id), 'the cancel button is removed');
  const saved = sends(k.calls).pop();
  assert.match(saved.params.text, /ذخیره شد/);
  assert.match(saved.params.text, /۱ از ۲۰/);
  assert.equal(buttons(saved)[0].switch_inline_query_current_chat, `گربه${ZWNJ}ی`);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.ali.id).state, null);
  assert.deepEqual(failed(k.calls), []);
});

scenario('inline search finds it with every spelling (ZWNJ, Arabic letters, digits) and is fast', async () => {
  for (const q of ['گربه', `گربه${ZWNJ}ی`, 'گربهی', 'گربه ي', 'عصبانى', '2', '۲', 'عصب', '  گربه!!  عصبانی ']) {
    const { p, ids, queries } = await inline(U.sara, q);
    assert.deepEqual(ids, [`m${memeId('U1')}`], `query "${q}"`);
    assert.equal(p.results[0].type, 'photo');
    assert.equal(p.is_personal, true, 'own pending memes, ban and forced join make results personal');
    assert.equal(p.cache_time, INLINE_CACHE);
    assert.equal(p.next_offset, '');
    assert.equal(p.button, undefined);
    assert.ok(queries <= 3, `search used ${queries} queries (user, settings, search)`);
  }
  const none = await inline(U.sara, 'گربه سگ');
  assert.deepEqual(none.ids, []);
  assert.deepEqual(none.p.button, { text: '😕 پیدا نشد؛ تو آپلودش کن!', start_parameter: 'upload' });
  assert.ok(none.queries <= 3);
  const en = await inline(U.ann, 'zzz');
  assert.match(en.p.button.text, /Not found/);
});

scenario('every kind gives a valid cached result: GIF, video and voice (with titles), sticker', async () => {
  await upload(U.ali, 'animation', 'U2', 'رقص خنده دار');
  await upload(U.ali, 'video', 'U3', 'فوتبال گل');
  await upload(U.ali, 'sticker', 'U4', 'سلام 😂');
  await upload(U.ali, 'voice', 'U5', 'صدای خنده');
  const { p } = await inline(U.sara, 'خنده');
  assert.deepEqual(p.results.map((r) => r.type).sort(), ['gif', 'voice']);
  assert.equal(p.results.find((r) => r.type === 'voice').title, 'صدای خنده');
  assert.equal((await inline(U.sara, 'فوتبال')).p.results[0].title, 'فوتبال گل');
  assert.deepEqual((await inline(U.sara, '😂')).p.results, [{ type: 'sticker', id: `m${memeId('U4')}`, sticker_file_id: 'F_U4', reply_markup: { inline_keyboard: [[{ text: '👍', callback_data: `lk:${memeId('U4')}` }]] } }]);
});

scenario('duplicates are detected by file_unique_id, for the uploader and for others', async () => {
  const other = await media(U.sara, 'photo', 'U1');
  assert.match(lastText(other.calls), /قبلاً توی ربات هست/);
  assert.match(lastText(other.calls), /عصبانی/);
  const own = await media(U.ali, 'photo', 'U1');
  assert.match(lastText(own.calls), /قبلاً خودت آپلود کردی/);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.sara.id).state, null);
});

scenario('keywords: links and @usernames refused, empty and too long refused, the meme keeps waiting', async () => {
  await media(U.ali, 'photo', 'U6');
  for (const [text, re] of [['join @spam_channel now', /لینک و آیدی/], ['see https://x.example', /لینک و آیدی/], ['t.me/abc', /لینک و آیدی/], ['!!! ؟؟ ...', /کلمه‌ی کلیدی درستی/], ['خ'.repeat(201), /خیلی طولانیه/]]) {
    const r = await say(U.ali, text);
    assert.match(lastText(r.calls), re, text);
  }
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.ali.id).state, 'kw');
  await say(U.ali, 'خوب بد زشت');
  assert.ok(one('SELECT id FROM memes WHERE file_unique_id = ?', 'U6'));
});

scenario('pending upload: a new meme replaces it, stale cancel buttons do nothing, /cancel, expiry after 24 h', async () => {
  const a = await media(U.ali, 'photo', 'U7');
  const b = await media(U.ali, 'photo', 'U8');
  assert.match(lastText(b.calls), /کنار گذاشته شد/);
  const askB = sends(b.calls)[0];
  const stale = await press(U.ali, `up:x:${a.message.message_id}`, sends(a.calls)[0].result.message_id);
  assert.equal(stale.answer.text, 'چیزی برای لغو نیست.');
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.ali.id).state, 'kw');
  const c = await press(U.ali, `up:x:${b.message.message_id}`, askB.result.message_id);
  assert.equal(c.answer.text, '✖️ آپلود لغو شد.');
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.ali.id).state, null);
  assert.match(lastText(await say(U.ali, '/cancel').then((x) => x.calls)), /چیزی برای لغو نیست/);
  await media(U.ali, 'photo', 'U9');
  assert.match(lastText((await say(U.ali, '/cancel')).calls), /آپلود لغو شد/);
  await media(U.ali, 'photo', 'U9');
  advance(25 * 3600);
  assert.match(lastText((await say(U.ali, 'دیر')).calls), /وقت این آپلود تموم شده/);
  assert.equal(one('SELECT id FROM memes WHERE file_unique_id = ?', 'U9'), undefined);
});

scenario('albums are refused with one notice', async () => {
  const a = await media(U.sara, 'photo', 'A1', { media_group_id: 'G1' });
  const b = await media(U.sara, 'photo', 'A2', { media_group_id: 'G1' });
  assert.match(lastText(a.calls), /آلبوم قبول نمی‌شه/);
  assert.deepEqual(b.calls, []);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.sara.id).state, null);
});

scenario('unsupported content gets an explanation; groups, bots and service messages are ignored', async () => {
  const doc = await say(U.sara, { document: { file_id: 'D', file_unique_id: 'd' } });
  assert.match(lastText(doc.calls), /پشتیبانی|قبول نمی‌کنم/);
  const audio = await say(U.ann, { audio: { file_id: 'A', file_unique_id: 'a' } });
  assert.match(lastText(audio.calls), /can't take this kind/);
  since();
  check(await onMessage({ message_id: 1, from: U.sara, chat: { id: -100555, type: 'supergroup' }, date: nowSec(), text: '/start' }));
  check(await onMessage({ message_id: 2, from: { id: 999, is_bot: true, first_name: 'B' }, chat: { id: 999, type: 'private' }, date: nowSec(), text: '/start' }));
  assert.deepEqual(since(), []);
  assert.deepEqual((await say(U.sara, { pinned_message: { message_id: 1 } })).calls, []);
});

scenario('text with no pending meme gets a hint with a search button', async () => {
  const { calls } = await say(U.sara, 'گربه عصبانی');
  const hint = sends(calls)[0];
  assert.match(hint.params.text, /@meme_test_bot/);
  assert.equal(buttons(hint)[0].switch_inline_query_current_chat, 'گربه عصبانی');
});

scenario(`daily limit: ${DAILY_UPLOADS} uploads per Tehran day, refused at the next one, reset at 00:00 Tehran`, async () => {
  for (let i = 0; i < DAILY_UPLOADS; i += 1) {
    advance(4);
    await media(U.reza, 'photo', `R${i}`);
    advance(4);
    await say(U.reza, `ریز ${i} شماره`);
  }
  assert.equal(one('SELECT count(*) AS n FROM memes WHERE uploader_id = ?', U.reza.id).n, DAILY_UPLOADS);
  advance(4);
  const over = await media(U.reza, 'photo', 'R_over');
  assert.match(lastText(over.calls), /سقف روزانه/);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.reza.id).state, null);
  const day = Math.floor((nowSec() + 12600) / 86400);
  clock = ((day + 1) * 86400 - 12600) * 1000; // 00:00 Tehran next day
  await upload(U.reza, 'photo', 'R_over', 'ریز فردا');
  assert.equal(one('SELECT up_count FROM users WHERE id = ?', U.reza.id).up_count, 1);
});

scenario('anti-spam: more than 20 messages a minute mutes for 10 minutes (one warning); the owner is exempt', async () => {
  advance(120);
  typing = 0;
  for (let i = 0; i < 20; i += 1) await say(U.joe, `hello ${i}`);
  const warn = await say(U.joe, 'again');
  assert.match(lastText(warn.calls), /Slow down! I'll ignore your messages for 10 minutes/);
  assert.deepEqual((await say(U.joe, 'and again')).calls, []);
  const btn = await press(U.joe, 'm:help', 1);
  assert.deepEqual([btn.answer.text, btn.answer.show_alert], ['🐢 Please wait a little.', true]);
  advance(601);
  assert.match(lastText((await say(U.joe, 'hi')).calls), /To upload, send me a meme/);
  for (let i = 0; i < 30; i += 1) await say(U.owner, `owner ${i}`);
  typing = 3;
  assert.equal(one('SELECT mute_until FROM users WHERE id = ?', OWNER).mute_until, 0);
});

scenario('chosen_inline_result: counts a use once per hour per user; ranking follows usage', async () => {
  const gif = memeId('U2');
  const voice = memeId('U5');
  assert.deepEqual((await inline(U.sara, 'خنده')).ids, [`m${voice}`, `m${gif}`], 'ties: newest first');
  assert.equal((await chosen(U.sara, `m${gif}`)).counted, true);
  assert.equal((await chosen(U.sara, `m${gif}`)).counted, false);
  advance(3601);
  assert.equal((await chosen(U.sara, `m${gif}`)).counted, true);
  assert.equal((await chosen(U.nima, `m${gif}`)).counted, true);
  assert.equal(one('SELECT uses FROM memes WHERE id = ?', gif).uses, 3);
  assert.deepEqual((await inline(U.sara, 'خنده')).ids, [`m${gif}`, `m${voice}`]);
  assert.equal((await chosen(U.sara, 'bogus')).counted, false);
  assert.equal((await chosen(U.sara, 'm999999')).counted, false);
});

scenario('empty inline query: recently sent, then own uploads, then popular — no duplicates, personal, upload button', async () => {
  const gif = memeId('U2');
  const video = memeId('U3');
  advance(10);
  await chosen(U.ali, `m${video}`);
  const { p, ids, queries } = await inline(U.ali, '');
  assert.equal(p.is_personal, true);
  assert.equal(p.cache_time, INLINE_PERSONAL_CACHE);
  assert.deepEqual(p.button, { text: '📤 آپلود میم جدید', start_parameter: 'upload' });
  assert.equal(ids[0], `m${video}`, 'recently sent first');
  const own = sql('SELECT id FROM memes WHERE uploader_id = ? ORDER BY id DESC LIMIT 5', U.ali.id).map((r) => `m${r.id}`).filter((x) => x !== `m${video}`);
  assert.deepEqual(ids.slice(1, 1 + own.length), own, 'then own latest uploads');
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.ok(ids.includes(`m${gif}`));
  assert.ok(queries <= 5, `home page used ${queries} queries (user, settings, recent, own, popular)`);
  const stranger = await inline(U.nima, '');
  assert.equal(stranger.ids[0], `m${gif}`, 'nima sent the gif');
  assert.equal(new Set(stranger.ids).size, stranger.ids.length);
  assert.equal(stranger.ids.length, one("SELECT count(*) AS n FROM memes WHERE status = 'approved'").n, 'everything fits on one page');
});

scenario('pagination: 50 results per page with next_offset, in search and on the home page', async () => {
  const t = nowSec();
  for (let i = 0; i < 120; i += 1) {
    await insertMeme({ fileId: `F_P${i}`, fileUniqueId: `P${i}`, kind: i % 2 ? 'photo' : 'sticker', keywords: `پیج ${i}`, uploaderId: U.nima.id, words: indexWords(`پیج ${i}`), t });
  }
  const pages = [];
  let offset = '';
  do {
    const { p, ids } = await inline(U.sara, 'پیج', offset);
    pages.push(ids);
    offset = p.next_offset;
  } while (offset);
  assert.deepEqual(pages.map((x) => x.length), [50, 50, 20]);
  const all = pages.flat();
  assert.equal(new Set(all).size, 120);
  assert.deepEqual(all, sql("SELECT id FROM memes WHERE file_unique_id LIKE 'P%' ORDER BY uses DESC, id DESC").map((r) => `m${r.id}`));

  const total = one("SELECT count(*) AS n FROM memes WHERE status = 'approved'").n;
  const home = [];
  offset = '';
  let n = 0;
  do {
    const { p, ids } = await inline(U.ali, '', offset);
    assert.ok(ids.length <= 50);
    assert.ok(n === 0 || !p.button, 'the button is on the first page only');
    home.push(...ids);
    offset = p.next_offset;
    assert.ok(!offset || /^e\d+$/.test(offset));
    n += 1;
  } while (offset && n < 10);
  assert.equal(new Set(home).size, home.length, 'no meme twice across pages');
  assert.equal(home.length, total, 'every public meme reachable');
  assert.equal((await inline(U.sara, 'پیج', 'garbage')).ids.length, 50, 'a bad offset means the first page');
  assert.deepEqual((await inline(U.sara, 'پیج', '5000')).ids, []);
});

scenario('my memes: pages, card, delete with confirmation, list refreshed; nobody else can touch them', async () => {
  const n = one('SELECT count(*) AS n FROM memes WHERE uploader_id = ?', U.reza.id).n;
  const { calls } = await say(U.reza, '/my');
  const list = sends(calls)[0];
  assert.match(list.params.text, new RegExp(`\\(${faDigits(n)}\\)`));
  const listId = list.result.message_id;
  assert.equal(buttons(list).filter((b) => b.callback_data.startsWith('mv:')).length, 8);
  assert.deepEqual(buttons(list).filter((b) => b.callback_data.startsWith('my:')).map((b) => b.callback_data), ['my:1']);
  const p3 = await press(U.reza, 'my:2', listId);
  const edited = p3.calls.find((c) => c.method === 'editMessageText');
  assert.equal(buttons(edited).filter((b) => b.callback_data.startsWith('mv:')).length, n - 16);
  assert.match(edited.params.text, /صفحه‌ی ۳ از ۳/);

  const target = buttons(list)[0].callback_data.split(':')[1];
  const card = await press(U.reza, `mv:${target}:0`, listId);
  const photo = card.calls.find((c) => c.method === 'sendPhoto');
  assert.equal(photo.params.chat_id, U.reza.id);
  assert.match(photo.params.caption, /بار ارسال شده/);
  const cardId = photo.result.message_id;
  assert.deepEqual(buttons(photo).map((b) => b.callback_data || 'inline'), [`md:${target}:0:${listId}`, 'inline', `me:${target}:0:${listId}`, `fv:${target}`]);

  const ask = await press(U.reza, `md:${target}:0:${listId}`, cardId);
  assert.deepEqual(buttons(ask.calls.find((c) => c.method === 'editMessageReplyMarkup')).map((b) => b.callback_data), [`mx:${target}:0:${listId}`, `mn:${target}:0:${listId}`]);
  await press(U.reza, `mn:${target}:0:${listId}`, cardId);
  assert.ok(one('SELECT id FROM memes WHERE id = ?', target));

  for (const data of [`mx:${target}:0:0`, `mv:${target}:0`, `md:${target}:0:0`]) {
    const forged = await press(U.ali, data, 1);
    assert.deepEqual([forged.answer.text, forged.answer.show_alert], ['این میم دیگه وجود نداره.', true], data);
  }
  assert.ok(one('SELECT id FROM memes WHERE id = ?', target), 'still there after the forged presses');

  const del = await press(U.reza, `mx:${target}:0:${listId}`, cardId);
  assert.equal(del.answer.text, '🗑 حذف شد.');
  assert.ok(del.calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === cardId && c.ok));
  assert.match(del.calls.find((c) => c.method === 'editMessageText' && c.params.message_id === listId).params.text, /\(۲۰\)/);
  assert.equal(one('SELECT id FROM memes WHERE id = ?', target), undefined);
  assert.equal(one('SELECT count(*) AS n FROM meme_words WHERE meme_id = ?', target).n, 0);
  const again = await press(U.reza, `mx:${target}:0:${listId}`, cardId);
  assert.equal(again.answer.show_alert, true);

  const sticker = await press(U.ali, `mv:${memeId('U4')}:0`, 1);
  assert.equal(sticker.calls.find((c) => c.method === 'sendSticker').params.caption, undefined);
  const empty = await say(U.sara, '/my');
  assert.match(lastText(empty.calls), /هنوز میمی آپلود نکردی/);
});

scenario('backup: failures alert the owner once per 3 h and never block the upload; later retried by file_id', async () => {
  await say(U.owner, '/start');
  rawDatabase().exec('UPDATE memes SET backup_msg_id = 1 WHERE backup_msg_id IS NULL'); // the memes inserted directly above
  mock.state.channels.get(BACKUP).admin = false;
  const a = await upload(U.ali, 'photo', 'B1', 'پشتیبان یک');
  assert.equal(one('SELECT backup_msg_id FROM memes WHERE id = ?', a).backup_msg_id, null);
  const alerts = () => mock.state.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER && /پشتیبان‌گیری میم/.test(c.params.text));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].params.text, new RegExp(`#m${a}\\b`));
  await upload(U.ali, 'photo', 'B2', 'پشتیبان دو');
  assert.equal(alerts().length, 1, 'throttled');

  mock.state.channels.get(BACKUP).admin = true;
  advance(120);
  const c = await upload(U.ali, 'photo', 'B3', 'پشتیبان سه');
  assert.ok(one('SELECT backup_msg_id FROM memes WHERE id = ?', c).backup_msg_id > 0);
  const copies = mock.state.sent.filter((s) => s.chat_id === String(BACKUP));
  assert.deepEqual(copies.slice(-2).map((s) => s.caption), [`#m${a}`, `#m${memeId('B2')}`], 'older failures retried by file_id');
  assert.ok(one('SELECT backup_msg_id FROM memes WHERE id = ?', a).backup_msg_id > 0);

  const m = await media(U.ali, 'voice', 'B4');
  mock.userDeleted(U.ali.id, m.message.message_id);
  const k = await say(U.ali, 'ویس پاک شده');
  const copy = k.calls.find((x) => x.method === 'sendVoice' && x.params.chat_id === BACKUP);
  assert.equal(copy.params.caption, `#m${memeId('B4')}`);
  assert.ok(one('SELECT backup_msg_id FROM memes WHERE file_unique_id = ?', 'B4').backup_msg_id > 0);

  mock.state.channels.get(BACKUP).admin = false;
  advance(4 * 3600);
  const bad = await upload(U.ali, 'photo', 'B5', 'فایل خراب');
  mock.state.channels.get(BACKUP).admin = true;
  mock.state.badFiles.add('F_B5');
  advance(120);
  await upload(U.ali, 'photo', 'B6', 'پشتیبان شش');
  assert.equal(one('SELECT backup_msg_id FROM memes WHERE id = ?', bad).backup_msg_id, 0, 'gave up on a file Telegram refuses');
  mock.state.badFiles.delete('F_B5');

  ENV.backupChannelId = 0;
  const off = await media(U.ali, 'photo', 'B7');
  const offK = await say(U.ali, 'بدون پشتیبان');
  assert.ok(one('SELECT id FROM memes WHERE file_unique_id = ?', 'B7'));
  assert.equal(offK.calls.filter((x) => x.method === 'forwardMessage').length, 0);
  assert.ok(off);
  ENV.backupChannelId = BACKUP;
});

scenario('owner /setup: commands and descriptions in both languages, inline mode and backup channel checked', async () => {
  const { calls } = await say(U.owner, '/setup');
  const fa = mock.state.botTexts.get('');
  const en = mock.state.botTexts.get('en');
  assert.deepEqual(fa.commands.map((c) => c.command), ['start', 'my', 'fav', 'tags', 'top', 'profile', 'lang', 'help', 'cancel']);
  assert.equal(fa.commands[1].description, 'میم‌های من');
  assert.equal(en.commands[1].description, 'My memes');
  assert.deepEqual(mock.state.botTexts.get(`chat:${OWNER}/`).commands.map((c) => c.command), ['start', 'my', 'fav', 'tags', 'top', 'profile', 'lang', 'help', 'cancel', 'admin'], 'the owner\'s own menu has /admin');
  assert.ok(fa.description && en.short);
  const report = lastText(calls);
  assert.match(report, /حالت اینلاین روشنه/);
  assert.match(report, /کانال پشتیبان: Meme backup/);
  assert.match(report, /setinlinefeedback/);
  mock.state.inline = false;
  mock.state.channels.get(BACKUP).admin = false;
  const bad = lastText((await say(U.owner, '/setup')).calls);
  assert.match(bad, /حالت اینلاین خاموشه/);
  assert.match(bad, /ادمین این کانال/);
  mock.state.inline = true;
  mock.state.channels.get(BACKUP).admin = true;
  const before = mock.state.calls.filter((c) => c.method === 'setMyCommands').length;
  await say(U.sara, '/setup');
  assert.equal(mock.state.calls.filter((c) => c.method === 'setMyCommands').length, before, 'not for others');
});

scenario('menu buttons and /lang, /help', async () => {
  const { calls } = await say(U.ali, '/lang');
  const r = await press(U.ali, 'lang:en', sends(calls)[0].result.message_id);
  const welcome = sends(r.calls)[0];
  assert.match(welcome.params.text, /Hi Ali/);
  const help = await press(U.ali, 'm:help', welcome.result.message_id);
  assert.match(help.calls.find((c) => c.method === 'editMessageText').params.text, /Up to 20 memes a day/);
  assert.match(lastText((await press(U.ali, 'm:up', welcome.result.message_id)).calls), /Send your meme/);
  assert.match(lastText((await press(U.ali, 'm:my', welcome.result.message_id)).calls), /My memes/);
  assert.match(lastText((await press(U.ali, 'm:lang', welcome.result.message_id)).calls), /Choose the bot language/);
  assert.match(lastText((await say(U.ali, '/help')).calls), /in any chat, type/);
  await press(U.ali, 'lang:fa', 1);
  await press(U.ali, 'nonsense:1', 1);
});

// ---------- Phase 2: moderation, admin panel, reports, bans, forced join, broadcast ----------

const kvN = (key) => (one('SELECT n FROM kv WHERE key = ?', key) || {}).n;
const toUser = (calls, uid) => calls.filter((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === uid);
const allTo = (uid, re) => mock.state.calls.filter((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === uid && re.test(c.params.text));
const status = (id) => one('SELECT status FROM memes WHERE id = ?', id).status;

async function panel(u) {
  const { calls } = await say(u, '/admin');
  const p = sends(calls)[0];
  assert.match(p.params.text, /پنل مدیریت|Admin panel|پنل ناظر|Moderator panel/);
  return p;
}

scenario('phase 2 — settings: the owner turns moderation on and changes the thresholds from the panel', async () => {
  const p = await panel(U.owner);
  assert.deepEqual(buttons(p).map((b) => b.callback_data), ['a:q', 'a:r', 'a:u', 'a:bl:0', 'a:ss', 'a:ch', 'a:bc', 'a:st', 'a:ad']);
  const id = p.result.message_id;
  const st = await press(U.owner, 'a:st', id);
  assert.match(st.calls.find((c) => c.method === 'editMessageText').params.text, /میم‌های جدید: خاموش/);
  await press(U.owner, 'a:st:moderation:t', id);
  assert.equal(kvN('set:moderation'), 1);
  for (let i = 0; i < 3; i += 1) await press(U.owner, 'a:st:trust:-', id);
  assert.equal(kvN('set:trust'), 2);
  await press(U.owner, 'a:st:hide:+', id);
  await press(U.owner, 'a:st:hide:-', id);
  assert.equal(kvN('set:hide'), 3);
  const view = (await press(U.owner, 'a:st', id)).calls.find((c) => c.method === 'editMessageText');
  assert.match(view.params.text, /انتشار خودکار بعد از: ۲ میم/);
  assert.match((await press(U.owner, 'a:p', id)).calls.find((c) => c.method === 'editMessageText').params.text, /پنل مدیریت/);
});

scenario('phase 2 — a new meme waits for approval: only its uploader finds it; admins are told (at most every 30 min)', async () => {
  advance(3600);
  await media(U.mina, 'photo', 'M1');
  const k = await say(U.mina, 'تایید نشده یک');
  const m1 = memeId('M1');
  assert.equal(status(m1), 'pending');
  assert.match(toUser(k.calls, U.mina.id).pop().params.text, /منتظر تأیید ادمینه/);
  const note = toUser(k.calls, OWNER)[0];
  assert.match(note.params.text, /۱ میم منتظر تأییده/);
  assert.deepEqual(buttons(note).map((b) => b.callback_data), ['a:q']);
  assert.deepEqual((await inline(U.sara, 'تایید')).ids, []);
  assert.deepEqual((await inline(U.mina, 'تایید')).ids, [`m${m1}`]);
  assert.ok((await inline(U.mina, '')).ids.includes(`m${m1}`), 'on the uploader\'s home page too');
  await media(U.mina, 'photo', 'M2');
  const k2 = await say(U.mina, 'تایید نشده دو');
  assert.deepEqual(toUser(k2.calls, OWNER), [], 'throttled');
  assert.match(buttons(sends((await say(U.mina, '/my')).calls)[0])[0].text, /^⏳/);
});

scenario('phase 2 — approval queue: approve / reject, the uploader is told, the buttons become a label, the next card follows', async () => {
  const m1 = memeId('M1');
  const m2 = memeId('M2');
  const q = await press(U.owner, 'a:q', 1);
  const card = q.calls.find((c) => c.method === 'sendPhoto');
  assert.match(card.params.caption, new RegExp(`#m${m1}`));
  assert.match(card.params.caption, /Mina/);
  assert.deepEqual(buttons(card).map((b) => b.callback_data), [`a:ok:${m1}`, `a:no:${m1}`, `a:nb:${m1}`, `a:qs:${m1}`]);
  const ok = await press(U.owner, `a:ok:${m1}`, card.result.message_id);
  assert.equal(status(m1), 'approved');
  assert.equal(one('SELECT reviewed_by FROM memes WHERE id = ?', m1).reviewed_by, OWNER);
  assert.match(toUser(ok.calls, U.mina.id)[0].params.text, /میمت تأیید شد/);
  assert.match(buttons(ok.calls.find((c) => c.method === 'editMessageReplyMarkup'))[0].text, /تأیید شد — Owner/);
  const card2 = ok.calls.find((c) => c.method === 'sendPhoto');
  assert.match(card2.params.caption, new RegExp(`#m${m2}`));
  const twice = await press(U.owner, `a:ok:${m1}`, card.result.message_id);
  assert.deepEqual([twice.answer.text, twice.answer.show_alert], ['این مورد قبلاً بررسی شده.', true]);
  const no = await press(U.owner, `a:no:${m2}`, card2.result.message_id);
  assert.equal(status(m2), 'rejected');
  assert.match(toUser(no.calls, U.mina.id)[0].params.text, /تأیید نشد/);
  assert.match(lastText(no.calls), /به آخر صف رسیدی/);
  assert.deepEqual((await inline(U.sara, 'تایید')).ids, [`m${m1}`]);
  assert.match(lastText((await media(U.mina, 'photo', 'M2')).calls), /❌ رد شده/);
  assert.match(lastText((await media(U.sara, 'photo', 'M2')).calls), /رد شده و دوباره قبول نمی/);
  assert.match(lastText((await press(U.owner, 'a:q', 1)).calls), /صف تأیید خالیه/);
});

scenario('phase 2 — trust: after N approved memes (N = 2 here) uploads go public at once; admins never wait', async () => {
  await upload(U.mina, 'sticker', 'M3', 'استیکر مینا');
  const m3 = memeId('M3');
  assert.equal(status(m3), 'pending');
  const q = await press(U.owner, 'a:q', 1);
  assert.ok(q.calls.some((c) => c.method === 'sendSticker' && !c.params.reply_markup), 'a sticker card: the sticker, then a text with the buttons');
  const text = sends(q.calls).pop();
  assert.match(text.params.text, new RegExp(`#m${m3}`));
  const ok = await press(U.owner, `a:ok:${m3}`, text.result.message_id);
  assert.match(toUser(ok.calls, U.mina.id)[0].params.text, /بدون نیاز به تأیید منتشر/);
  assert.equal(one('SELECT approved_n FROM users WHERE id = ?', U.mina.id).approved_n, 2);
  await media(U.mina, 'photo', 'M4');
  const k = await say(U.mina, 'مینا آزاد');
  assert.equal(status(memeId('M4')), 'approved');
  assert.match(lastText(k.calls), /میم ذخیره شد!/);
  await upload(U.owner, 'photo', 'O1', 'مالک');
  assert.equal(status(memeId('O1')), 'approved');
});

scenario('phase 2 — ordinary users can\'t open the panel or press any of its buttons', async () => {
  assert.doesNotMatch(lastText((await say(U.sara, '/admin')).calls), /پنل مدیریت/);
  for (const data of ['a:p', 'a:q', `a:ok:${memeId('M1')}`, 'a:st:moderation:t', 'a:bc', `a:ub:${U.ali.id}`, 'a:x']) {
    const r = await press(U.sara, data, 1);
    assert.deepEqual([r.answer.text, r.answer.show_alert], ['⛔️ دسترسی نداری.', true], data);
  }
  assert.equal(kvN('set:moderation'), 1);
  assert.equal(one('SELECT banned FROM users WHERE id = ?', U.ali.id).banned, 0);
});

scenario('phase 2 — admins: the owner adds one; they get the queue, reports and bans but not owner sections; removal revokes', async () => {
  const p = await panel(U.owner);
  await press(U.owner, 'a:ad', p.result.message_id);
  await press(U.owner, 'a:ada', p.result.message_id);
  assert.match(sends((await say(U.owner, '@NIMA_T')).calls)[0].params.text, /پیدا نشد/, 'nima never wrote to the bot');
  await say(U.nima, '/start');
  await press(U.owner, 'a:ada', p.result.message_id);
  const add = await say(U.owner, '@NIMA_T');
  assert.match(sends(add.calls)[0].params.text, /Nima.*ادمین اضافه شد/);
  assert.match(toUser(add.calls, U.nima.id)[0].params.text, /ادمین ربات شدید/, 'the new admin is told');
  assert.ok(one('SELECT user_id FROM admins WHERE user_id = ?', U.nima.id));
  const np = await panel(U.nima);
  assert.deepEqual(buttons(np).map((b) => b.callback_data), ['a:q', 'a:r', 'a:u', 'a:bl:0', 'a:ss']);
  for (const data of ['a:st', 'a:bc', 'a:ch', 'a:ad', `a:adr:${U.nima.id}`]) assert.equal((await press(U.nima, data, np.result.message_id)).answer.text, '⛔️ دسترسی نداری.', data);
  advance(1900);
  await media(U.kian, 'photo', 'K1');
  const k = await say(U.kian, 'کیان');
  assert.equal(toUser(k.calls, OWNER).length + toUser(k.calls, U.nima.id).length, 2, 'both admins told');
  const q = await press(U.nima, 'a:q', 1);
  const card = q.calls.find((c) => c.method === 'sendPhoto');
  await press(U.nima, `a:ok:${memeId('K1')}`, card.result.message_id);
  assert.equal(one('SELECT reviewed_by FROM memes WHERE file_unique_id = ?', 'K1').reviewed_by, U.nima.id);
  await press(U.owner, `a:adr:${U.nima.id}`, p.result.message_id);
  assert.equal(one('SELECT user_id FROM admins WHERE user_id = ?', U.nima.id), undefined);
  assert.doesNotMatch(lastText((await say(U.nima, '/admin')).calls), /پنل مدیریت/);
});

scenario('phase 2 — reports: send someone\'s public meme to the bot and pick a reason; 3 reports hide it; admins keep or remove', async () => {
  const id = memeId('U1');
  const r = await media(U.sara, 'photo', 'U1');
  const msg = sends(r.calls)[0];
  assert.deepEqual(buttons(msg).map((b) => b.callback_data), [`fv:${id}`, `lk:${id}`, `rp:${id}`]);
  const pick = await press(U.sara, `rp:${id}`, msg.result.message_id);
  assert.deepEqual(buttons(pick.calls.find((c) => c.method === 'editMessageReplyMarkup')).map((b) => b.callback_data), [`rp:${id}:nsfw`, `rp:${id}:hate`, `rp:${id}:spam`, `rp:${id}:other`, `rp:${id}:x`]);
  await press(U.sara, `rp:${id}:x`, msg.result.message_id);
  const done = await press(U.sara, `rp:${id}:nsfw`, msg.result.message_id);
  assert.equal(done.answer.text, '✅ گزارشت ثبت شد. ممنون!');
  assert.equal(one('SELECT reports FROM memes WHERE id = ?', id).reports, 1);
  assert.match(toUser(done.calls, OWNER)[0].params.text, /گزارش‌شده منتظر بررسیه/);
  assert.equal((await press(U.sara, `rp:${id}:spam`, msg.result.message_id)).answer.text, 'قبلاً این میم رو گزارش کردی.');
  const own = await media(U.ali, 'photo', 'U1');
  assert.deepEqual(buttons(sends(own.calls)[0]).map((b) => b.callback_data), [`fv:${id}`], 'no report button on your own meme');
  assert.equal((await press(U.ali, `rp:${id}`, 1)).answer.text, 'میم خودت رو نمی‌تونی گزارش کنی.');
  assert.equal((await press(U.ali, `rp:${id}:spam`, 1)).answer.text, 'این میم دیگه قابل گزارش نیست.');
  await press(U.joe, `rp:${id}:hate`, 1);
  assert.equal(status(id), 'approved');
  await press(U.ann, `rp:${id}:spam`, 1);
  assert.equal(status(id), 'hidden', 'hidden after 3 reports');
  assert.deepEqual((await inline(U.nima, 'عصبانی')).ids, []);
  assert.match(lastText((await media(U.reza, 'photo', 'U1')).calls), /پنهانه/);

  const card = (await press(U.owner, 'a:r', 1)).calls.find((c) => c.method === 'sendPhoto');
  assert.match(card.params.caption, /۳ گزارش/);
  assert.match(card.params.caption, /نامناسب ۱/);
  assert.deepEqual(buttons(card).map((b) => b.callback_data), [`a:rk:${id}`, `a:rd:${id}`, `a:rb:${id}`, `a:rs:${id}`]);
  await press(U.owner, `a:rk:${id}`, card.result.message_id);
  assert.equal(status(id), 'approved');
  assert.equal(one('SELECT count(*) AS n FROM reports WHERE meme_id = ?', id).n, 0);
  assert.deepEqual((await inline(U.nima, 'عصبانی')).ids, [`m${id}`]);

  const video = memeId('U3');
  await press(U.sara, `rp:${video}:spam`, 1);
  const vcard = (await press(U.owner, 'a:r', 1)).calls.find((c) => c.method === 'sendVideo');
  const rd = await press(U.owner, `a:rd:${video}`, vcard.result.message_id);
  assert.equal(status(video), 'rejected');
  assert.match(toUser(rd.calls, U.ali.id)[0].params.text, /به‌خاطر گزارش‌ها حذف شد/);
  rawDatabase().prepare('UPDATE users SET rep_day = ?, rep_n = 10 WHERE id = ?').run(Math.floor((nowSec() + 12600) / 86400), U.ann.id);
  assert.equal((await press(U.ann, `rp:${memeId('U4')}:spam`, 1)).answer.text, 'You reached today\'s report limit.');
});

scenario('phase 2 — bans: find by @username; banning rejects waiting memes; banned users get one notice a day and nothing inline; unban', async () => {
  await upload(U.pari, 'photo', 'PA1', 'پری');
  const pa = memeId('PA1');
  const p = await panel(U.owner);
  await press(U.owner, 'a:u', p.result.message_id);
  const card = sends((await say(U.owner, '@Pari_T')).calls)[0];
  assert.match(card.params.text, /<code>810000011<\/code>/);
  assert.match(card.params.text, /منتظر تأیید ۱/);
  const ban = await press(U.owner, `a:ub:${U.pari.id}`, card.result.message_id);
  assert.equal(ban.answer.text, '🚫 مسدود شد. ۱ میم منتظرش رد شد.');
  assert.equal(status(pa), 'rejected');
  assert.match(lastText((await say(U.pari, '/start')).calls), /مسدود شده/);
  assert.deepEqual((await say(U.pari, 'سلام')).calls, [], 'then silence');
  const inl = await inline(U.pari, 'گربه');
  assert.deepEqual([inl.ids, inl.p.button], [[], undefined]);
  assert.equal((await press(U.pari, 'm:help', 1)).answer.text, '⛔️ دسترسی شما مسدود شده.');
  advance(86401);
  assert.match(lastText((await say(U.pari, 'سلام')).calls), /مسدود شده/, 'a notice again the next day');
  const list = await press(U.owner, 'a:bl:0', p.result.message_id);
  assert.deepEqual(buttons(list.calls.find((c) => c.method === 'editMessageText')).map((b) => b.callback_data), [`a:uc:${U.pari.id}`, 'a:p']);
  await press(U.owner, `a:uu:${U.pari.id}`, p.result.message_id);
  assert.match(lastText((await say(U.pari, '/start')).calls), /سلام Pari|زبان/);

  assert.equal((await press(U.owner, `a:ub:${OWNER}`, 1)).answer.text, 'مالک و ادمین‌ها رو نمی‌شه مسدود کرد (اول از ادمینی حذفش کن).');
  await press(U.owner, 'a:u', p.result.message_id);
  assert.match(lastText((await say(U.owner, 'nobody_here')).calls), /پیدا نشد/);

  const rezaPublic = one("SELECT count(*) AS n FROM memes WHERE uploader_id = ? AND status = 'approved'", U.reza.id).n;
  const ask = await press(U.owner, `a:uh:${U.reza.id}`, p.result.message_id);
  assert.deepEqual(buttons(ask.calls.find((c) => c.method === 'editMessageText')).map((b) => b.callback_data), [`a:uhy:${U.reza.id}`, `a:uc:${U.reza.id}`]);
  const hid = await press(U.owner, `a:uhy:${U.reza.id}`, p.result.message_id);
  assert.equal(hid.answer.text, `🙈 ${faDigits(rezaPublic)} میم رد شد.`);
  assert.equal(one("SELECT count(*) AS n FROM memes WHERE uploader_id = ? AND status = 'approved'", U.reza.id).n, 0);

  await upload(U.lia, 'photo', 'L1', 'spam spam');
  const qc = (await press(U.owner, 'a:q', 1)).calls.find((c) => c.method === 'sendPhoto');
  const l1 = memeId('L1');
  const nb = await press(U.owner, `a:nb:${l1}`, qc.result.message_id);
  assert.deepEqual(buttons(nb.calls.find((c) => c.method === 'editMessageReplyMarkup')).map((b) => b.callback_data), [`a:nby:${l1}`, `a:qk:${l1}`]);
  await press(U.owner, `a:qk:${l1}`, qc.result.message_id);
  assert.equal(status(l1), 'pending');
  await press(U.owner, `a:nb:${l1}`, qc.result.message_id);
  await press(U.owner, `a:nby:${l1}`, qc.result.message_id);
  assert.deepEqual([status(l1), one('SELECT banned FROM users WHERE id = ?', U.lia.id).banned], ['rejected', 1]);
});

scenario('phase 2 — forced join: channels added by @username or a forwarded post; members pass, others get a lock (PM) or a join button (inline); cached; a broken channel is skipped', async () => {
  const PUB = -1003000000001;
  const PRIV = -1003000000002;
  mock.addChannel(PUB, { title: 'Meme channel', username: 'memechan' });
  mock.addChannel(PRIV, { title: 'Private memes' });
  mock.addChannel(-1003000000003, { title: 'Not admin', username: 'notadminchan', admin: false });
  const p = await panel(U.owner);
  const pid = p.result.message_id;
  assert.match((await press(U.owner, 'a:ch', pid)).calls.find((c) => c.method === 'editMessageText').params.text, /هیچ کانالی/);
  await press(U.owner, 'a:cha', pid);
  assert.match(lastText((await say(U.owner, 'https://t.me/memechan')).calls), /Meme channel/);
  await press(U.owner, 'a:cha', pid);
  const fwd = await say(U.owner, { text: 'a post', forward_origin: { type: 'channel', chat: { id: PRIV, type: 'channel', title: 'Private memes' }, message_id: 5, date: 0 } });
  assert.ok(sends(fwd.calls).some((c) => /Private memes/.test(c.params.text)));
  assert.deepEqual(sql('SELECT chat_id, link FROM channels ORDER BY added_at, chat_id').map((c) => c.link), ['https://t.me/memechan', 'https://t.me/+inv1003000000002']);
  await press(U.owner, 'a:cha', pid);
  assert.ok(sends((await say(U.owner, '@notadminchan')).calls).some((c) => /ادمین این کانال نیست/.test(c.params.text)));
  await press(U.owner, 'a:cha', pid);
  assert.ok(sends((await say(U.owner, 'not a channel!')).calls).some((c) => /کانال پیدا نشد/.test(c.params.text)));
  assert.ok(kvN('join:ver') >= 2);

  const lock = sends((await say(U.sara, 'سلام')).calls)[0];
  assert.match(lock.params.text, /عضو این کانال/);
  assert.deepEqual(buttons(lock).map((b) => b.url || b.callback_data), ['https://t.me/memechan', 'https://t.me/+inv1003000000002', 'j:chk']);
  const in1 = await inline(U.sara, 'گربه');
  assert.deepEqual([in1.ids, in1.p.button.start_parameter], [[], 'join']);
  const before = mock.state.calls.length;
  await inline(U.sara, 'گربه ع');
  assert.equal(mock.state.calls.slice(before).filter((c) => c.method === 'getChatMember').length, 0, 'negative result cached');
  const still = await press(U.sara, 'j:chk', lock.result.message_id);
  assert.deepEqual([still.answer.text, still.answer.show_alert], ['❌ هنوز عضو همه‌ی کانال‌ها نیستی.', true]);
  mock.setMember(PUB, U.sara.id);
  mock.setMember(PRIV, U.sara.id, 'restricted');
  const ok = await press(U.sara, 'j:chk', lock.result.message_id);
  assert.match(ok.calls.find((c) => c.method === 'editMessageText').params.text, /حالا می‌تونی/);
  const before2 = mock.state.calls.length;
  assert.ok((await inline(U.sara, 'گربه')).ids.length > 0);
  assert.equal(mock.state.calls.slice(before2).filter((c) => c.method === 'getChatMember').length, 0, 'positive result cached');
  const stranger = await inline({ id: 899000001, is_bot: false, first_name: 'X', language_code: 'en' }, 'cat');
  assert.equal(stranger.p.button.start_parameter, 'join', 'never opened the bot → join first');
  assert.ok((await inline(U.owner, 'گربه')).ids.length > 0, 'admins are exempt');
  mock.setMember(PUB, U.ann.id, 'left');
  assert.match(lastText((await say(U.ann, 'hi')).calls), /join these channels/);
  const cb = await press(U.ann, 'm:my', 1);
  assert.deepEqual([cb.answer.text, cb.answer.show_alert], ['📢 Join the channels first.', true]);

  mock.state.channels.get(PUB).admin = false;
  advance(700);
  const broken = await say(U.sara, 'سلام دوباره');
  assert.match(lastText(broken.calls), /برای آپلود، میم رو بفرست/, 'the broken channel is skipped');
  assert.equal(allTo(OWNER, /عضویت این کانال\u200Cها قابل بررسی نیست/).length, 1);
  mock.state.channels.get(PUB).admin = true;

  await press(U.owner, 'a:st:join:t', pid);
  assert.match(lastText((await say(U.ann, 'hi')).calls), /To upload, send me a meme/, 'switched off');
  await press(U.owner, 'a:st:join:t', pid);
  await press(U.owner, `a:chr:${PRIV}`, pid);
  await press(U.owner, `a:chr:${PUB}`, pid);
  assert.equal(one('SELECT count(*) AS n FROM channels').n, 0);
  assert.match(lastText((await say(U.ann, 'hi')).calls), /To upload, send me a meme/, 'no channels → no lock');
});

scenario('phase 2 — broadcast: draft, confirm, batches of 25, a 429 waits and resumes, blocked users marked, finished on the side of other updates, nobody twice', async () => {
  const extra = Array.from({ length: 60 }, (_, i) => 830000001 + i);
  for (const id of extra) {
    rawDatabase().prepare('INSERT INTO users (id, first_name, created_at, seen_at) VALUES (?, ?, ?, ?)').run(id, 'U', nowSec(), nowSec());
    mock.state.privateChats.add(id);
  }
  mock.state.blocked.add(extra[3]);
  mock.state.blocked.add(extra[40]);
  rawDatabase().prepare('UPDATE users SET banned = 1 WHERE id = ?').run(extra[10]);
  const total = one('SELECT count(*) AS n FROM users WHERE banned = 0 AND blocked = 0').n;

  const p = await panel(U.owner);
  await press(U.owner, 'a:bc', p.result.message_id);
  const draft = await say(U.owner, FILES.photo('BC1'));
  assert.equal(one('SELECT id FROM memes WHERE file_unique_id = ?', 'BC1'), undefined, 'the broadcast message is not an upload');
  const confirm = sends(draft.calls)[0];
  assert.match(confirm.params.text, new RegExp(`برای ${faDigits(total)} کاربر`));
  const bid = Number(buttons(confirm)[0].callback_data.split(':')[2]);
  const copies = () => mock.state.copies.length;

  const first = await press(U.owner, `a:bcy:${bid}`, confirm.result.message_id);
  assert.equal(first.calls.filter((c) => c.method === 'copyMessage').length, 25);
  assert.match(first.calls.find((c) => c.method === 'editMessageText').params.text, /در حال ارسال/);
  mock.rateLimitCopyAt(10);
  const limited = await press(U.owner, `a:bcx:${bid}`, confirm.result.message_id);
  assert.equal(limited.calls.filter((c) => c.method === 'copyMessage' && c.ok).length, 9);
  assert.match(limited.calls.find((c) => c.method === 'editMessageText').params.text, /محدودیت سرعت/);
  const n1 = copies();
  await press(U.owner, `a:bcx:${bid}`, confirm.result.message_id);
  assert.equal(copies(), n1, 'waits for retry_after');
  advance(8);
  await press(U.owner, `a:bcx:${bid}`, confirm.result.message_id);
  assert.ok(copies() > n1);
  for (let i = 0; i < 40 && one('SELECT status FROM broadcasts WHERE id = ?', bid).status === 'running'; i += 1) await say(U.sara, `side ${i}`);
  const b = one('SELECT * FROM broadcasts WHERE id = ?', bid);
  assert.equal(b.status, 'done');
  assert.equal(b.sent + b.failed, total);
  const per = new Map();
  for (const c of mock.state.copies.filter((x) => x.message_id === draft.message.message_id)) per.set(c.to, (per.get(c.to) || 0) + 1);
  assert.ok([...per.values()].every((n) => n === 1), 'nobody twice');
  assert.equal(per.has(extra[10]), false, 'banned users skipped');
  assert.equal(per.size, b.sent);
  assert.deepEqual([extra[3], extra[40]].map((id) => one('SELECT blocked FROM users WHERE id = ?', id).blocked), [1, 1]);
  assert.equal(allTo(OWNER, /پیام همگانی #\d+ تموم شد/).length, 1);

  await press(U.owner, 'a:bc', p.result.message_id);
  const d2 = sends((await say(U.owner, 'second')).calls)[0];
  const id2 = Number(buttons(d2)[0].callback_data.split(':')[2]);
  await press(U.owner, 'a:bc', p.result.message_id);
  const d3 = sends((await say(U.owner, 'third')).calls)[0];
  const id3 = Number(buttons(d3)[0].callback_data.split(':')[2]);
  await press(U.owner, `a:bcy:${id2}`, d2.result.message_id);
  assert.equal((await press(U.owner, `a:bcy:${id3}`, d3.result.message_id)).answer.text, 'یه پیام همگانی دیگه در حال ارساله.');
  await press(U.owner, `a:bcs:${id2}`, d2.result.message_id);
  assert.equal(one('SELECT status FROM broadcasts WHERE id = ?', id2).status, 'cancelled');
  await press(U.owner, `a:bcn:${id3}`, d3.result.message_id);
  assert.equal(one('SELECT status FROM broadcasts WHERE id = ?', id3).status, 'cancelled');
  await press(U.owner, 'a:bc', p.result.message_id);
  assert.match(lastText((await say(U.owner, '/cancel')).calls), /لغو شد/);
  assert.equal(one('SELECT state FROM users WHERE id = ?', OWNER).state, null);
});

// ---------- Phase 3: favourites, private collection, editing keywords, hashtags, type filter ----------

const markupOf = (call) => call.params.reply_markup;
const favCount = (uid) => one('SELECT count(*) AS n FROM favorites WHERE user_id = ?', uid).n;

scenario('phase 3 — favourites: star a meme by sending it, the button flips in place, @bot fav, /fav list and card, unstar', async () => {
  const gif = memeId('U2');
  const voice = memeId('U5');
  const d = await media(U.sara, 'animation', 'U2');
  const msg = sends(d.calls)[0];
  assert.deepEqual(buttons(msg).map((b) => b.callback_data), [`fv:${gif}`, `lk:${gif}`, `rp:${gif}`]);
  const star = await press(U.sara, `fv:${gif}`, msg.result.message_id, markupOf(msg));
  assert.equal(star.answer.text, '⭐ به علاقه‌مندی‌ها اضافه شد.');
  const flipped = buttons(star.calls.find((c) => c.method === 'editMessageReplyMarkup'));
  assert.deepEqual(flipped.map((b) => [b.text, b.callback_data]), [['★ حذف از علاقه‌مندی‌ها', `fv:${gif}`], ['👍', `lk:${gif}`], ['🚩 گزارش این میم', `rp:${gif}`]]);
  advance(5);
  const v = sends((await media(U.sara, 'voice', 'U5')).calls)[0];
  await press(U.sara, `fv:${voice}`, v.result.message_id, markupOf(v));
  assert.equal(favCount(U.sara.id), 2);

  const fav = await inline(U.sara, 'fav');
  assert.deepEqual(fav.ids, [`m${voice}`, `m${gif}`], 'newest starred first');
  assert.equal(fav.p.is_personal, true);
  assert.deepEqual((await inline(U.sara, '⭐️ گیف')).ids, [`m${gif}`], 'favourites of one type');
  assert.deepEqual((await inline(U.sara, `علاقه‌مندی رقص`)).ids, [`m${gif}`], 'favourites matching words');
  const none = await inline(U.nima, 'fav');
  assert.deepEqual([none.ids, none.p.button.start_parameter], [[], 'fav']);
  const pick = sends((await say(U.nima, '/start fav')).calls)[0];
  assert.deepEqual(buttons(pick).map((b) => b.callback_data), ['lang:fa:f', 'lang:en:f'], 'no language yet: the picker remembers where to go');
  assert.match(lastText((await press(U.nima, 'lang:fa:f', pick.result.message_id)).calls), /هنوز علاقه‌مندی نداری/);
  assert.match(lastText((await say(U.nima, '/start fav')).calls), /هنوز علاقه‌مندی نداری/);

  const list = sends((await say(U.sara, '/fav')).calls)[0];
  assert.match(list.params.text, /علاقه‌مندی‌ها<\/b> \(۲\)/);
  assert.deepEqual(buttons(list).map((b) => b.callback_data), [`fo:${voice}:0`, `fo:${gif}:0`]);
  const card = (await press(U.sara, `fo:${gif}:0`, list.result.message_id)).calls.find((c) => c.method === 'sendAnimation');
  assert.deepEqual(buttons(card).map((b) => b.callback_data || 'inline'), [`fv:${gif}`, 'inline']);
  const off = await press(U.sara, `fv:${gif}`, card.result.message_id, markupOf(card));
  assert.equal(off.answer.text, 'از علاقه‌مندی‌ها حذف شد.');
  assert.deepEqual((await inline(U.sara, 'fav')).ids, [`m${voice}`]);

  assert.deepEqual([(await press(U.sara, `fv:${memeId('U3')}`, 1)).answer.text], ['این میم دیگه در دسترس نیست.'], 'a removed meme can\'t be starred');
  const t0 = nowSec();
  const ins = rawDatabase().prepare('INSERT INTO favorites (user_id, meme_id, created_at) VALUES (?, ?, ?)');
  for (let i = 0; i < 500; i += 1) ins.run(U.joe.id, 100000 + i, t0);
  assert.equal((await press(U.joe, `fv:${gif}`, 1)).answer.text, 'You can have at most 500 favourites.');

  const m4 = memeId('M4');
  await press(U.sara, `fv:${m4}`, 1);
  assert.equal(one('SELECT count(*) AS n FROM favorites WHERE meme_id = ?', m4).n, 1);
  await press(U.mina, `mx:${m4}:0:0`, 1);
  assert.equal(one('SELECT count(*) AS n FROM favorites WHERE meme_id = ?', m4).n, 0, 'deleting a meme removes it from favourites');
});

scenario('phase 3 — private collection: switch on the keywords question; only the owner sees it, no approval; a public copy is still possible; publish later', async () => {
  const pendingBefore = one("SELECT count(*) AS n FROM memes WHERE status = 'pending'").n;
  const m = await media(U.sara, 'photo', 'PV1');
  const ask = sends(m.calls)[0];
  const on = await press(U.sara, `up:p:${m.message.message_id}`, ask.result.message_id);
  assert.match(buttons(on.calls.find((c) => c.method === 'editMessageReplyMarkup'))[0].text, /روشن ✅/);
  assert.match(on.answer.text, /خصوصی ذخیره/);
  await press(U.sara, `up:p:${m.message.message_id}`, ask.result.message_id);
  await press(U.sara, `up:p:${m.message.message_id}`, ask.result.message_id);
  assert.equal((await press(U.sara, 'up:p:999', ask.result.message_id)).answer.show_alert, true, 'a stale switch does nothing');
  const k = await say(U.sara, 'خصوصی من');
  const row = one('SELECT * FROM memes WHERE file_unique_id = ?', `p${U.sara.id}:PV1`);
  assert.equal(row.status, 'private');
  assert.match(toUser(k.calls, U.sara.id).pop().params.text, /مجموعه‌ی خصوصی/);
  assert.deepEqual(toUser(k.calls, OWNER), [], 'no admin is told');
  assert.ok(k.calls.some((c) => c.method === 'forwardMessage'), 'backed up like every upload');
  assert.equal(one("SELECT count(*) AS n FROM memes WHERE status = 'pending'").n, pendingBefore, 'not in the queue');
  assert.deepEqual((await inline(U.sara, 'خصوصی')).ids, [`m${row.id}`]);
  assert.deepEqual((await inline(U.ali, 'خصوصی')).ids, []);
  assert.ok((await inline(U.sara, '')).ids.includes(`m${row.id}`));
  assert.match(buttons(sends((await say(U.sara, '/my')).calls)[0])[0].text, /^🔒/);
  const again = sends((await media(U.sara, 'photo', 'PV1')).calls)[0];
  assert.match(again.params.text, /مجموعه‌ی خصوصی خودته/);
  assert.deepEqual(buttons(again).map((b) => b.callback_data), [`mp:${row.id}:0:0`]);

  await upload(U.ali, 'photo', 'PV1', 'عمومی علی');
  const pub = one('SELECT * FROM memes WHERE file_unique_id = ?', 'PV1');
  assert.equal(pub.status, 'pending', 'someone else can still upload the same file publicly');

  await media(U.sara, 'photo', 'PV2');
  const ask2 = sends(mock.state.calls.slice(-3)).pop();
  await press(U.sara, `up:p:${ask2.params.reply_markup.inline_keyboard[1][0].callback_data.split(':')[2]}`, ask2.result.message_id);
  await say(U.sara, 'دومی خصوصی');
  const pv2 = one('SELECT id, status FROM memes WHERE file_unique_id = ?', `p${U.sara.id}:PV2`);
  assert.equal(pv2.status, 'private');
  const pubBtn = await press(U.sara, `mp:${pv2.id}:0:0`, 1);
  assert.equal(pubBtn.answer.text, '🌍 میم برای انتشار عمومی منتظر تأیید ادمینه.');
  assert.deepEqual(Object.values(one('SELECT status, file_unique_id FROM memes WHERE id = ?', pv2.id)), ['pending', 'PV2']);

  const qc = (await press(U.owner, 'a:q', 1)).calls.find((c) => c.method === 'sendPhoto');
  assert.match(qc.params.caption, new RegExp(`#m${pub.id}`));
  await press(U.owner, `a:ok:${pub.id}`, qc.result.message_id);
  const exists = await press(U.sara, `mp:${row.id}:0:0`, 1);
  assert.equal(exists.answer.text, 'این میم قبلاً به‌صورت عمومی توی رباته؛ به علاقه‌مندی‌هات اضافه شد.');
  assert.ok(one('SELECT meme_id FROM favorites WHERE user_id = ? AND meme_id = ?', U.sara.id, pub.id));
  assert.equal(one('SELECT status FROM memes WHERE id = ?', row.id).status, 'private', 'the private copy stays');
});

scenario('phase 3 — edit keywords from the /my card: public memes of untrusted users go back to the queue; trusted, pending and private edit freely', async () => {
  const pv2 = one('SELECT id FROM memes WHERE file_unique_id = ?', 'PV2').id;
  const ask = await press(U.sara, `me:${pv2}:0:0`, 1);
  const prompt = sends(ask.calls)[0];
  assert.match(prompt.params.text, /کلمه‌های کلیدی جدید/);
  assert.match(prompt.params.text, /دومی خصوصی/);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.sara.id).state, 'edkw');
  assert.match(lastText((await say(U.sara, 'see t.me/x')).calls), /لینک و آیدی/);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.sara.id).state, 'edkw', 'still waiting after a refused text');
  const done = await say(U.sara, 'جدید #تست');
  assert.match(lastText(done.calls), /به‌روز شد/);
  assert.equal(one('SELECT keywords FROM memes WHERE id = ?', pv2).keywords, 'جدید #تست');
  assert.ok(one('SELECT word FROM meme_words WHERE meme_id = ? AND word = ?', pv2, '#تست'));
  assert.equal(one('SELECT count(*) AS n FROM meme_words WHERE meme_id = ? AND word = ?', pv2, 'دومی').n, 0, 'old words gone');
  assert.equal(one('SELECT status FROM memes WHERE id = ?', pv2).status, 'pending');

  const sticker = memeId('U4');
  assert.ok(one('SELECT approved_n FROM users WHERE id = ?', U.ali.id).approved_n < 2, 'ali is not trusted (trust = 2)');
  await press(U.ali, `me:${sticker}:0:0`, 1);
  const back = await say(U.ali, 'سلام دوباره 😂');
  assert.match(lastText(back.calls), /دوباره منتظر تأیید/);
  assert.equal(one('SELECT status FROM memes WHERE id = ?', sticker).status, 'pending', 'untrusted: back to the queue');

  const m1 = memeId('M1');
  await press(U.mina, `me:${m1}:0:0`, 1);
  await say(U.mina, 'مینا ویرایش');
  assert.deepEqual(Object.values(one('SELECT status, keywords FROM memes WHERE id = ?', m1)), ['approved', 'مینا ویرایش'], 'trusted: stays public');

  await press(U.mina, `me:${m1}:0:0`, 1);
  assert.match(lastText((await say(U.mina, '/cancel')).calls), /ویرایش لغو شد/);
  await press(U.mina, `me:${m1}:0:0`, 1);
  const cx = await press(U.mina, 'ek:x', 1);
  assert.equal(one('SELECT state FROM users WHERE id = ?', U.mina.id).state, null);
  assert.ok(cx);
  assert.equal((await press(U.sara, `me:${m1}:0:0`, 1)).answer.text, 'این میم دیگه وجود نداره.', 'not yours');
  assert.equal((await press(U.mina, `me:${memeId('M2')}:0:0`, 1)).answer.text, 'این میم الان قابل ویرایش نیست.', 'rejected');
});

scenario('phase 3 — hashtags and type filter: #tag finds tags only, words find tagged memes, /tags lists public tags, type words in both languages', async () => {
  await upload(U.mina, 'photo', 'H1', 'گل زیبا #فوتبال #جام_جهانی');
  await upload(U.mina, 'animation', 'H2', 'گل دیدنی #فوتبال');
  const h1 = memeId('H1');
  const h2 = memeId('H2');
  assert.deepEqual([h1, h2].map((id) => one('SELECT status FROM memes WHERE id = ?', id).status), ['approved', 'approved']);
  assert.deepEqual((await inline(U.nima, '#فوتبال')).ids, [`m${h2}`, `m${h1}`]);
  assert.deepEqual((await inline(U.nima, '#جام')).ids, [`m${h1}`]);
  assert.deepEqual((await inline(U.nima, '#جام_جهانی')).ids, [`m${h1}`]);
  assert.ok((await inline(U.nima, 'فوتبال')).ids.includes(`m${h1}`), 'the tag\'s word is searchable too');
  assert.deepEqual((await inline(U.nima, 'gif #فوتبال')).ids, [`m${h2}`]);
  assert.deepEqual((await inline(U.nima, 'عکس #فوتبال')).ids, [`m${h1}`]);
  const gifs = await inline(U.nima, 'گیف');
  assert.ok(gifs.ids.length > 0 && gifs.p.results.every((r) => r.type === 'gif'), 'only GIFs');
  assert.ok(gifs.queries <= 3, `type filter used ${gifs.queries} queries`);
  assert.ok((await inline(U.nima, 'sticker')).p.results.every((r) => r.type === 'sticker'));
  assert.ok((await inline(U.ann, 'voice')).p.results.every((r) => r.type === 'voice'));

  const tagsMsg = sends((await say(U.nima, '/tags')).calls)[0];
  const tagButtons = buttons(tagsMsg).map((b) => [b.text, b.switch_inline_query_current_chat]);
  assert.deepEqual(tagButtons.slice(0, 2), [['#فوتبال · ۲', '#فوتبال'], ['#جام_جهانی · ۱', '#جام_جهانی']]);
  assert.ok(!tagButtons.some(([, q]) => q === '#تست'), 'tags of non-public memes are not listed');
  assert.match(lastText((await press(U.nima, 'm:tags', 1)).calls), /هشتگ‌های پرکاربرد/);
});

// ---------- Phase 4: the channel as a public feed, likes and ranking, profiles, leaderboard, meme of the day ----------

const toChannel = (calls, method) => calls.filter((c) => c.method === method && Number(c.params.chat_id) === BACKUP);
const backupOf = (id) => one('SELECT backup_msg_id FROM memes WHERE id = ?', id).backup_msg_id;

scenario('phase 4 — the channel is a public feed: only approved memes, as clean copies with 👍; removed memes leave it; edits update the caption', async () => {
  ENV.backupMode = 'public';
  await media(U.mina, 'photo', 'C1');
  const k = await say(U.mina, 'کانال یک');
  const c1 = memeId('C1');
  const post = toChannel(k.calls, 'sendPhoto')[0];
  assert.ok(post, 'a trusted upload is posted at once');
  assert.match(post.params.caption, /کانال یک/);
  assert.match(post.params.caption, /@meme_test_bot/);
  assert.doesNotMatch(post.params.caption, /Mina/, 'never the uploader\'s name');
  assert.deepEqual(buttons(post).map((b) => b.callback_data), [`lk:${c1}`]);
  assert.equal(k.calls.filter((c) => c.method === 'forwardMessage').length, 0, 'never forwarded');
  assert.equal(backupOf(c1), post.result.message_id);

  await upload(U.sara, 'photo', 'C2', 'کانال دو');
  const c2 = memeId('C2');
  assert.equal(backupOf(c2), null, 'waiting for approval: not posted');
  const ok = await press(U.owner, `a:ok:${c2}`, 1);
  const post2 = toChannel(ok.calls, 'sendPhoto')[0];
  assert.ok(post2, 'posted when approved');

  const m = await media(U.sara, 'photo', 'C3');
  await press(U.sara, `up:p:${m.message.message_id}`, sends(m.calls)[0].result.message_id);
  const priv = await say(U.sara, 'کانال سه خصوصی');
  assert.deepEqual(toChannel(priv.calls, 'sendPhoto'), [], 'private: never posted');

  await press(U.mina, `me:${c1}:0:0`, 1);
  const cap = (await say(U.mina, 'کانال یک ویرایش')).calls.find((c) => c.method === 'editMessageCaption');
  assert.deepEqual([cap.params.chat_id, cap.params.message_id], [BACKUP, post.result.message_id]);
  assert.match(cap.params.caption, /ویرایش/);

  await press(U.sara, `me:${c2}:0:0`, 1);
  const back = await say(U.sara, 'کانال دو ویرایش');
  assert.ok(toChannel(back.calls, 'deleteMessage').some((c) => c.params.message_id === post2.result.message_id), 'back in the queue: the post is deleted');
  assert.equal(backupOf(c2), null);

  const del = await press(U.mina, `mx:${c1}:0:0`, 1);
  assert.ok(toChannel(del.calls, 'deleteMessage').some((c) => c.params.message_id === post.result.message_id), 'deleted by the uploader: the post is deleted');

  advance(4 * 3600);
  mock.state.channels.get(BACKUP).admin = false;
  await upload(U.mina, 'photo', 'C4', 'کانال چهار');
  const c4 = memeId('C4');
  assert.equal(backupOf(c4), null);
  assert.ok(allTo(OWNER, new RegExp(`#m${c4}\\b`)).length === 1, 'the owner is alerted');
  mock.state.channels.get(BACKUP).admin = true;
  advance(120);
  await upload(U.mina, 'photo', 'C5', 'کانال پنج');
  assert.ok(backupOf(c4) > 0, 'retried with the next post');
  assert.equal(backupOf(c2), null, 'a waiting meme is not retried');
  await press(U.owner, `a:ok:${c2}`, 1);
  assert.ok(backupOf(c2) > 0, 'posted again when approved again');
});

scenario('phase 4 — likes: 👍 under memes sent inline, on channel posts and in private; one per user, not your own; likes outweigh uses in ranking', async () => {
  const c5 = memeId('C5');
  const r = await inline(U.sara, 'کانال پنج');
  assert.deepEqual(r.p.results[0].reply_markup, { inline_keyboard: [[{ text: '👍', callback_data: `lk:${c5}` }]] });
  await chosen(U.sara, `m${c5}`, 'کانال پنج', 'IM1');
  const like = await pressInline(U.joe, `lk:${c5}`, 'IM1');
  assert.equal(like.answer.text, '👍 Liked.');
  const e1 = like.calls.find((c) => c.method === 'editMessageReplyMarkup');
  assert.deepEqual([e1.params.inline_message_id, buttons(e1)[0].text], ['IM1', '👍 1']);
  assert.deepEqual(Object.values(one('SELECT uses, likes, score FROM memes WHERE id = ?', c5)), [1, 1, 4]);
  const un = await pressInline(U.joe, `lk:${c5}`, 'IM1');
  assert.deepEqual([un.answer.text, buttons(un.calls.find((c) => c.method === 'editMessageReplyMarkup'))[0].text], ['Like removed.', '👍']);
  assert.deepEqual(Object.values(one('SELECT likes, score FROM memes WHERE id = ?', c5)), [0, 1]);
  assert.equal((await pressInline(U.mina, `lk:${c5}`, 'IM1')).answer.show_alert, true, 'not your own meme');

  const postId = backupOf(c5);
  const channel = { id: BACKUP, type: 'channel', title: 'Meme backup' };
  const cl = await press(U.ann, `lk:${c5}`, postId, { inline_keyboard: [[{ text: '👍', callback_data: `lk:${c5}` }]] }, channel);
  const e2 = cl.calls.find((c) => c.method === 'editMessageReplyMarkup');
  assert.deepEqual([e2.params.chat_id, e2.params.message_id, buttons(e2)[0].text], [BACKUP, postId, '👍 1']);
  assert.equal(cl.calls.filter((c) => c.method === 'sendMessage').length, 0, 'nothing is ever sent to the channel');
  const forged = await press(U.ann, 'a:p', postId, null, channel);
  assert.deepEqual(forged.calls.map((c) => c.method), ['answerCallbackQuery'], 'only 👍 works outside the private chat');

  const d = sends((await media(U.reza, 'photo', 'C5')).calls)[0];
  assert.ok(buttons(d).some((b) => b.callback_data === `lk:${c5}`));
  await press(U.reza, `lk:${c5}`, d.result.message_id, markupOf(d));
  assert.equal(one('SELECT likes FROM memes WHERE id = ?', c5).likes, 2);

  await upload(U.mina, 'photo', 'RK1', 'رتبه یک');
  await upload(U.mina, 'photo', 'RK2', 'رتبه دو');
  const r1 = memeId('RK1');
  const r2 = memeId('RK2');
  await chosen(U.sara, `m${r1}`);
  await chosen(U.nima, `m${r1}`);
  await press(U.ann, `lk:${r2}`, 1);
  assert.deepEqual((await inline(U.sara, 'رتبه')).ids, [`m${r2}`, `m${r1}`], '1 like (3) beats 2 uses (2)');
  await press(U.owner, 'a:st:likebtn:t', 1);
  assert.equal((await inline(U.sara, 'رتبه')).p.results[0].reply_markup, undefined, 'the button can be switched off');
  await press(U.owner, 'a:st:likebtn:t', 1);
});

scenario('phase 4 — profile and weekly leaderboard: points this week, rank, hide my name, others\' profiles, top meme cards, last week', async () => {
  const day = Math.floor((nowSec() + 12600) / 86400);
  const week = Math.floor((day + 5) / 7);
  clock = (((week + 1) * 7 - 5) * 86400 - 12600 + 3600) * 1000; // next Saturday, 01:00 Tehran
  const r1 = memeId('RK1');
  const r2 = memeId('RK2');
  for (const u of [U.sara, U.nima, U.reza]) await chosen(u, `m${r1}`);
  await press(U.sara, `lk:${r2}`, 1);
  await press(U.nima, `lk:${r2}`, 1);

  const top = sends((await say(U.ann, '/top')).calls)[0];
  const text = top.params.text;
  assert.match(text, /This week's leaderboard/);
  assert.ok(text.indexOf('رتبه دو') < text.indexOf('رتبه یک'), 'R2 (6 points) above R1 (3 points)');
  assert.match(text, /6 points/);
  assert.match(text, /Mina.*9 points/);
  assert.deepEqual(buttons(top).map((b) => b.callback_data), [`lm:${r2}`, `lm:${r1}`, `pf:${U.mina.id}`, 'lb:l']);

  const prof = sends((await say(U.mina, '/profile')).calls)[0];
  assert.match(prof.params.text, /۹ امتیاز/);
  assert.match(prof.params.text, /۱$|رتبه.{0,3}۱/m);
  await press(U.mina, 'pv:t', prof.result.message_id);
  assert.equal(one('SELECT lb_hidden FROM users WHERE id = ?', U.mina.id).lb_hidden, 1);
  const hidden = sends((await say(U.ann, '/top')).calls)[0];
  assert.match(hidden.params.text, /anonymous — 9 points/);
  assert.ok(!buttons(hidden).some((b) => b.callback_data === `pf:${U.mina.id}`));
  assert.equal((await press(U.ann, `pf:${U.mina.id}`, 1)).answer.text, 'This user hides their name.');
  await press(U.mina, 'pv:t', prof.result.message_id);
  assert.match(sends((await press(U.ann, `pf:${U.mina.id}`, 1)).calls)[0].params.text, /Mina[\s\S]*Public memes/);

  const card = (await press(U.ann, `lm:${r2}`, 1)).calls.find((c) => c.method === 'sendPhoto');
  assert.deepEqual(buttons(card).map((b) => b.callback_data || 'inline'), [`fv:${r2}`, `lk:${r2}`, 'inline']);

  advance(7 * 86400);
  const lw = await press(U.ann, 'lb:l', top.result.message_id);
  const lwText = lw.calls.find((c) => c.method === 'editMessageText').params.text;
  assert.match(lwText, /Last week's leaderboard/);
  assert.ok(lwText.indexOf('رتبه دو') < lwText.indexOf('رتبه یک'));
  const tw = await press(U.ann, 'lb:w', top.result.message_id);
  assert.match(tw.calls.find((c) => c.method === 'editMessageText').params.text, /no points yet/);
});

scenario('phase 4 — meme of the day: posted once after 12:00 Tehran on the side of other updates; yesterday\'s best; no repeats; switchable; failures alert', async () => {
  ENV.motdChannelId = BACKUP;
  const at = (d, hour) => { clock = ((d * 86400) - 12600 + hour * 3600) * 1000; };
  const motdPosts = (calls) => toChannel(calls, 'sendPhoto').filter((c) => /میم روز/.test(c.params.caption || ''));
  const D = Math.floor((nowSec() + 12600) / 86400) + 1;
  at(D, 9);
  const c5 = memeId('C5');
  const r1 = memeId('RK1');
  await chosen(U.joe, `m${r1}`);
  await chosen(U.ann, `m${r1}`);
  await chosen(U.reza, `m${c5}`);
  at(D, 11);
  assert.deepEqual(motdPosts((await say(U.sara, 'سلام')).calls), [], 'not before 12:00');

  at(D + 1, 12.5);
  const p1 = motdPosts((await say(U.sara, 'سلام')).calls);
  assert.equal(p1.length, 1);
  assert.match(p1[0].params.caption, /رتبه یک/, 'yesterday\'s best');
  assert.deepEqual(buttons(p1[0]).map((b) => b.callback_data || b.url), [`lk:${r1}`, 'https://t.me/meme_test_bot']);
  assert.equal(one('SELECT meme_id FROM motd WHERE day = ?', D + 1).meme_id, r1);
  assert.deepEqual(motdPosts((await say(U.sara, 'دوباره')).calls), [], 'once a day');

  at(D + 2, 13);
  const p2 = motdPosts((await say(U.sara, 'سلام')).calls);
  assert.equal(p2.length, 1);
  assert.notEqual(one('SELECT meme_id FROM motd WHERE day = ?', D + 2).meme_id, r1, 'never twice within 30 days');

  await press(U.owner, 'a:st:motd:t', 1);
  at(D + 3, 13);
  assert.deepEqual(motdPosts((await say(U.sara, 'سلام')).calls), [], 'switched off');
  await press(U.owner, 'a:st:motd:t', 1);

  at(D + 4, 13);
  mock.state.channels.get(BACKUP).admin = false;
  await say(U.sara, 'سلام');
  assert.equal(allTo(OWNER, /میم روز به کانال ناموفق/).length, 1, 'the owner is alerted');
  mock.state.channels.get(BACKUP).admin = true;
  assert.deepEqual(motdPosts((await say(U.sara, 'دوباره')).calls), [], 'retries wait 30 minutes');
  advance(1900);
  const sent = await chosen(U.nima, `m${c5}`);
  assert.ok(sent.trace.some((x) => x.m === 'sendPhoto' && x.view === 'motd'), 'a sent meme can post it too');
  ENV.motdChannelId = 0;
});

// ---------- Phase 5: staff roles (moderators), stats ----------

scenario('phase 5 — staff: the owner adds a moderator by forwarding their message; moderators approve or reject only; switch role; remove', async () => {
  const p = await panel(U.owner);
  const staff = (await press(U.owner, 'a:ad', p.result.message_id)).calls.find((c) => c.method === 'editMessageText');
  assert.ok(buttons(staff).some((b) => b.callback_data === 'a:adm') && buttons(staff).some((b) => b.callback_data === 'a:ada'));
  await press(U.owner, 'a:adm', p.result.message_id);
  const hidden = await say(U.owner, { text: 'hi', forward_origin: { type: 'hidden_user', sender_user_name: 'X', date: 0 } });
  assert.match(sends(hidden.calls)[0].params.text, /مخفی کرده/, 'a hidden forward can\'t be used');
  await press(U.owner, 'a:adm', p.result.message_id);
  const add = await say(U.owner, { text: 'hi', forward_origin: { type: 'user', sender_user: U.kian, date: 0 } });
  assert.match(sends(add.calls)[0].params.text, /Kian.*ناظر اضافه شد/);
  assert.equal(one('SELECT role FROM admins WHERE user_id = ?', U.kian.id).role, 'mod');
  assert.match(toUser(add.calls, U.kian.id)[0].params.text, /ناظر ربات شدید/, 'the moderator is told');
  assert.deepEqual(mock.state.botTexts.get(`chat:${U.kian.id}/`).commands.map((c) => c.command).slice(-1), ['admin'], '/admin in their menu');

  const mp = await panel(U.kian);
  assert.match(mp.params.text, /پنل ناظر/);
  assert.deepEqual(buttons(mp).map((b) => b.callback_data), ['a:q']);
  await upload(U.pari, 'photo', 'MD1', 'برای ناظر');
  const md1 = memeId('MD1');
  assert.equal(one('SELECT status FROM memes WHERE id = ?', md1).status, 'pending');
  const q = await press(U.kian, 'a:q', mp.result.message_id);
  const card = q.calls.find((c) => (c.method === 'sendPhoto' || c.method === 'sendMessage' || c.method === 'sendSticker') && buttons(c).length && buttons(c)[0].callback_data.startsWith('a:ok:'));
  assert.ok(!buttons(card).some((b) => b.callback_data.startsWith('a:nb:')), 'no reject + ban for a moderator');
  const ok = await press(U.kian, `a:ok:${md1}`, card.result.message_id);
  assert.deepEqual(Object.values(one('SELECT status, reviewed_by FROM memes WHERE id = ?', md1)), ['approved', U.kian.id]);
  assert.ok(ok);
  for (const data of [`a:nb:${md1}`, `a:nby:${md1}`, 'a:r', 'a:u', 'a:ss', 'a:sq:7', 'a:st', 'a:bl:0', 'a:ad', `a:ub:${U.sara.id}`]) {
    assert.equal((await press(U.kian, data, mp.result.message_id)).answer.text, '⛔️ دسترسی نداری.', data);
  }
  assert.equal((await press(U.owner, `a:ub:${U.kian.id}`, 1)).answer.text, 'مالک و ادمین‌ها رو نمی‌شه مسدود کرد (اول از ادمینی حذفش کن).');

  advance(1900);
  await press(U.ann, `rp:${memeId('C5')}:spam`, 1);
  assert.equal(allTo(U.kian.id, /گزارش‌شده منتظر بررسی/).length, 0, 'moderators aren\'t told about reports');

  const sw = await press(U.owner, `a:adt:${U.kian.id}`, p.result.message_id);
  assert.match(sw.answer.text, /ادمین/);
  assert.equal(one('SELECT role FROM admins WHERE user_id = ?', U.kian.id).role, 'admin');
  assert.match(toUser(sw.calls, U.kian.id)[0].params.text, /ادمین ربات شدید/);
  assert.ok(buttons(await panel(U.kian)).some((b) => b.callback_data === 'a:ss'), 'admins get stats');
  const rm = await press(U.owner, `a:adr:${U.kian.id}`, p.result.message_id);
  assert.equal(one('SELECT user_id FROM admins WHERE user_id = ?', U.kian.id), undefined);
  assert.ok(rm.calls.some((c) => c.method === 'deleteMyCommands' && c.params.scope.chat_id === U.kian.id), 'their menu is reset');
  assert.match(toUser(rm.calls, U.kian.id)[0].params.text, /دیگه جزو تیم/);
  assert.doesNotMatch(lastText((await say(U.kian, '/admin')).calls), /پنل/);
});

scenario('phase 5 — stats: a search counts once per typed query (not per keystroke); no-result searches are listed; overview; pruning', async () => {
  const sumOf = (name) => (one('SELECT sum(n) AS n FROM stat_day WHERE name = ?', name).n || 0);
  const qRow = (q) => one('SELECT sum(n) AS n, sum(miss) AS miss FROM search_q WHERE q = ?', q) || {};
  const s0 = sumOf('search');
  const m0 = sumOf('search_miss');
  for (const q of ['ک', 'کا', 'کان', 'کانا', 'کانال']) await inline(U.sara, q);
  assert.equal(sumOf('search'), s0, 'still typing: nothing counted yet');
  await inline(U.sara, 'سگ گربه پرنده');
  assert.equal(sumOf('search'), s0 + 1, 'moving on to another query counts the finished one, once');
  assert.deepEqual([qRow('کانال').n, qRow('کا').n], [1, null], 'only the final query, not its prefixes');
  advance(40);
  await inline(U.sara, 'ناموجودترین');
  assert.equal(sumOf('search_miss'), m0 + 1, '"سگ گربه پرنده" found nothing');
  await inline(U.sara, 'ناموجودتر');
  advance(5);
  await inline(U.sara, 'ناموجودترین');
  await inline(U.sara, '');
  const sent = await chosen(U.sara, `m${memeId('C5')}`, '');
  assert.ok(sent);
  assert.equal(qRow('ناموجودترین').miss, 1, 'deleting back is the same search; clearing it ends the search');
  const k0 = qRow('کانال پنج').n || 0;
  await inline(U.sara, 'کانال پنج');
  await chosen(U.sara, `m${memeId('C5')}`, 'کانال پنج');
  assert.equal(qRow('کانال پنج').n, k0 + 1, 'sending a result counts the search at once, once');
  assert.equal(one('SELECT count(*) AS n FROM search_pending WHERE user_id = ?', U.sara.id).n, 0);
  const fav0 = sumOf('search');
  await inline(U.sara, 'fav کانال');
  await inline(U.sara, 'سگ');
  assert.equal(sumOf('search'), fav0, 'favourite searches are not counted');
  const before = sumOf('upload');
  await upload(U.mina, 'photo', 'ST1', 'آمار یک');
  assert.equal(sumOf('upload'), before + 1);

  const p = await panel(U.owner);
  const ov = (await press(U.owner, 'a:ss', p.result.message_id)).calls.find((c) => c.method === 'editMessageText');
  assert.match(ov.params.text, /کاربران:<\/b> [۰-۹]+/);
  assert.match(ov.params.text, /جستجو:<\/b> امروز [۰-۹]+/);
  assert.deepEqual(buttons(ov).map((b) => b.callback_data), ['a:sq:7', 'a:sm:7', 'a:ss', 'a:p']);
  const top = (await press(U.owner, 'a:sq:7', p.result.message_id)).calls.find((c) => c.method === 'editMessageText');
  assert.match(top.params.text, /پرجستجوترین/);
  assert.match(top.params.text, /کانال/);
  const miss = (await press(U.owner, 'a:sm:30', p.result.message_id)).calls.find((c) => c.method === 'editMessageText');
  assert.match(miss.params.text, /ناموجودترین/);
  assert.ok(buttons(miss).some((b) => b.switch_inline_query_current_chat === 'ناموجودترین'), 'try it');
  assert.ok(buttons(miss).some((b) => b.callback_data === 'a:sm:7') && buttons(miss).some((b) => b.text.startsWith('• ')));

  const today = Math.floor((nowSec() + 12600) / 86400);
  rawDatabase().prepare('INSERT INTO search_q (day, q, n, miss) VALUES (?, ?, 1, 1)').run(today - 61, 'خیلی قدیمی');
  advance(86401);
  await say(U.sara, 'سلام');
  assert.equal(qRow('خیلی قدیمی').n, null, 'pruned after 60 days');
});

// ---------- phase 6 ----------

const KEY = 'AQ.test-key_0123456789abcdef';
const ava = person(810000012, 'Ava');
const geminiPosts = () => mock.state.gemini.calls.filter((c) => c.method === 'POST');
const secret = () => (one("SELECT value FROM kv WHERE key = 'secret:gemini'") || {}).value;

scenario('phase 6 — /aikey: owner only; the message holding the key is deleted; the key is checked and kept in the database only', async () => {
  mock.state.gemini.keys.add(KEY);
  advance(3600);
  await upload(ava, 'photo', 'AI0', 'بدون هوش');
  assert.equal(mock.state.gemini.calls.length, 0, 'no key: no AI');
  assert.deepEqual(mock.state.downloads, []);
  await say(ava, `/aikey ${KEY}`);
  assert.equal(secret(), undefined, 'not the owner');
  assert.match(lastText((await say(U.owner, '/aikey')).calls), /کلید Gemini:<\/b> تنظیم نشده/);
  const bad = await say(U.owner, '/aikey AQ.wrong-key_0123456789abcdef');
  assert.ok(bad.calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === bad.message.message_id && c.ok), 'deleted');
  assert.match(lastText(bad.calls), /قبول نکرد/);
  assert.equal(secret(), undefined);
  assert.match(lastText((await say(U.owner, '/aikey short')).calls), /شبیه کلید API نیست/);
  const good = await say(U.owner, `/aikey ${KEY}`);
  assert.ok(good.calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === good.message.message_id && c.ok), 'deleted');
  assert.match(lastText(good.calls), /ذخیره شد و کار می/);
  assert.equal(secret(), KEY);
  assert.equal(mock.state.gemini.calls.at(-1).method, 'GET', 'checked with a free metadata request');
  assert.match(lastText((await say(U.owner, '/aikey')).calls), /تنظیم شده/);
});

scenario('phase 6 — suggestions on the keywords question, saved with one button; the text in the image is searchable; own keywords still work; image choice per type', async () => {
  advance(60);
  const m = await media(ava, 'photo', 'AI1');
  assert.deepEqual(mock.state.downloads.slice(-1), ['S_AI1'], 'the largest photo size that fits 800 px');
  const post = geminiPosts().at(-1);
  assert.equal(post.key, KEY);
  assert.match(post.path, /^models\/gemini-[\w.-]+:generateContent$/);
  const img = post.body.contents[0].parts[0].inline_data;
  assert.equal(img.mime_type, 'image/jpeg');
  assert.equal(Buffer.from(img.data, 'base64').toString('utf8'), 'IMG:S_AI1', 'the image itself, base64');
  const ask = sends(m.calls)[0];
  const ed = m.calls.find((c) => c.method === 'editMessageText');
  assert.equal(ed.params.message_id, ask.result.message_id, 'the question itself is edited');
  assert.match(ed.params.text, /پیشنهاد هوش مصنوعی:<\/b> .*گربه، خنده دار/);
  const mid = m.message.message_id;
  const codes = [`up:s:${mid}`, `up:p:${mid}`, `up:x:${mid}`];
  assert.deepEqual(buttons(ed).map((b) => b.callback_data), codes);
  const tg = await press(ava, `up:p:${mid}`, ask.result.message_id);
  assert.deepEqual(buttons(tg.calls.find((c) => c.method === 'editMessageReplyMarkup')).map((b) => b.callback_data), codes, 'the private switch keeps the button');
  await press(ava, `up:p:${mid}`, ask.result.message_id);
  const use = await press(ava, `up:s:${mid}`, ask.result.message_id);
  const row = one('SELECT id, keywords, ocr, ai_flag, status FROM memes WHERE file_unique_id = ?', 'AI1');
  assert.deepEqual([row.keywords, row.ocr, row.ai_flag, row.status], ['گربه، خنده دار', 'وقتی سلام می کنی', 0, 'pending']);
  assert.match(lastText(use.calls), /منتظر تأیید/);
  assert.ok((await inline(ava, 'سلام')).ids.includes(`m${row.id}`), 'found by the text inside the image');
  assert.ok((await inline(ava, 'خنده دار')).ids.includes(`m${row.id}`), 'and by the suggested keywords');
  assert.equal((await press(ava, `up:s:${mid}`, ask.result.message_id)).answer.show_alert, true, 'only once');

  advance(60);
  await media(ava, 'photo', 'AI2');
  await say(ava, 'دست ساز');
  const r2 = one('SELECT keywords, ocr FROM memes WHERE file_unique_id = ?', 'AI2');
  assert.deepEqual([r2.keywords, r2.ocr], ['دست ساز', 'وقتی سلام می کنی'], 'typed keywords, the OCR text still kept');

  mock.state.gemini.reply = () => geminiAnswer({ keywords: [], text: '' });
  const st = await media(ava, 'sticker', 'AI3');
  assert.deepEqual([mock.state.downloads.at(-1), geminiPosts().at(-1).body.contents[0].parts[0].inline_data.mime_type], ['F_AI3', 'image/webp'], 'a static sticker as it is');
  assert.equal(st.calls.filter((c) => c.method === 'editMessageText').length, 0, 'nothing to suggest: the question stays');
  const thumb = { file_id: 'T_AI6', file_unique_id: 'tAI6', width: 320, height: 180 };
  await say(ava, { video: { file_id: 'F_AI6', file_unique_id: 'AI6', width: 640, height: 360, duration: 9, thumbnail: thumb } });
  assert.deepEqual([mock.state.downloads.at(-1), geminiPosts().at(-1).body.contents[0].parts[0].inline_data.mime_type], ['T_AI6', 'image/jpeg'], 'a video: its thumbnail');
  const n = geminiPosts().length;
  await media(ava, 'voice', 'AI4');
  await media(ava, 'video', 'AI5');
  assert.equal(geminiPosts().length, n, 'voice, or a video without a thumbnail: no AI');
  await say(ava, '/cancel');
  mock.state.gemini.reply = null;
});

scenario('phase 6 — a flagged meme always waits for approval, even from a trusted user; the queue card says why; staff uploads are not held', async () => {
  mock.state.gemini.reply = () => geminiAnswer({ keywords: ['خشن'], text: '', nsfw: true, reason: 'graphic violence' });
  assert.ok(one('SELECT approved_n FROM users WHERE id = ?', U.mina.id).approved_n >= 2, 'Mina is trusted');
  advance(3600);
  const k = await upload(U.mina, 'photo', 'AF1', 'پرچم خورده');
  const f1 = memeId('AF1');
  assert.ok(k > 0);
  assert.equal(status(f1), 'pending');
  const f = one('SELECT ai_flag, ai_reason FROM memes WHERE id = ?', f1);
  assert.deepEqual([f.ai_flag, f.ai_reason], [1, 'graphic violence']);
  assert.equal(backupOf(f1), null, 'not posted to the channel');
  const card = (await press(U.owner, `a:qs:${f1 - 1}`, 1)).calls.find((c) => c.method === 'sendPhoto');
  assert.match(card.params.caption, new RegExp(`#m${f1}\\b`));
  assert.match(card.params.caption, /هوش مصنوعی:<\/b> شاید نامناسب باشه \(graphic violence\)/);
  await press(U.owner, `a:ok:${f1}`, card.result.message_id);
  assert.equal(status(f1), 'approved', 'an admin can still approve it');
  await upload(U.owner, 'photo', 'AF2', 'مالک پرچم');
  assert.equal(status(memeId('AF2')), 'approved', 'staff uploads are never held');
  mock.state.gemini.reply = null;
  const ocrCard = await upload(ava, 'photo', 'AF3', 'کارت متن');
  const card2 = (await press(U.owner, `a:qs:${ocrCard - 1}`, 1)).calls.find((c) => c.method === 'sendPhoto');
  assert.match(card2.params.caption, /متن داخل تصویر: .*وقتی سلام می کنی/);
  assert.doesNotMatch(card2.params.caption, /شاید نامناسب/);
});

scenario('phase 6 — the user is faster than the AI: the late result goes on the saved meme; a late flag takes a public meme off the channel; a newer upload is never touched', async () => {
  advance(3600);
  mock.state.gemini.onCall = async () => { mock.state.gemini.onCall = null; await say(U.mina, 'سریع تر از هوش'); };
  const m = await media(U.mina, 'photo', 'AR1');
  const r1 = memeId('AR1');
  const row = one('SELECT status, ocr FROM memes WHERE id = ?', r1);
  assert.deepEqual([row.status, row.ocr], ['approved', 'وقتی سلام می کنی'], 'saved first, the OCR text added afterwards');
  assert.equal(m.calls.filter((c) => c.method === 'editMessageText').length, 0, 'no suggestions on a question already answered');
  assert.ok((await inline(U.sara, 'سلام')).ids.includes(`m${r1}`), 'late OCR words are indexed too');

  mock.state.gemini.reply = () => geminiAnswer({ nsfw: true, reason: 'nudity' });
  mock.state.gemini.onCall = async () => { mock.state.gemini.onCall = null; await say(U.mina, 'دیر پرچم خورده'); };
  const from = mock.state.calls.length;
  await media(U.mina, 'photo', 'AR2');
  const r2 = memeId('AR2');
  const calls = mock.state.calls.slice(from);
  const posted = toChannel(calls, 'sendPhoto')[0];
  assert.ok(posted, 'trusted: posted at once');
  assert.deepEqual([status(r2), one('SELECT ai_flag FROM memes WHERE id = ?', r2).ai_flag], ['pending', 1]);
  assert.ok(toChannel(calls, 'deleteMessage').some((c) => c.params.message_id === posted.result.message_id && c.ok), 'taken off the channel');
  assert.equal(backupOf(r2), null);
  assert.deepEqual((await inline(U.sara, 'دیر پرچم')).ids, [], 'not public any more');
  mock.state.gemini.reply = null;

  advance(60);
  mock.state.gemini.onCall = async () => { mock.state.gemini.onCall = null; await media(U.mina, 'photo', 'AR4'); };
  await media(U.mina, 'photo', 'AR3');
  const st = one('SELECT state, state_data FROM users WHERE id = ?', U.mina.id);
  const data = JSON.parse(st.state_data);
  assert.deepEqual([st.state, data.fileUniqueId, data.ai.k], ['kw', 'AR4', ['گربه', 'خنده دار']], 'the newer upload keeps its own result');
  assert.equal(one('SELECT count(*) AS n FROM memes WHERE file_unique_id = ?', 'AR3').n, 0);
  await say(U.mina, '/cancel');
});

scenario('phase 6 — quota: a 429 pauses AI for an hour, uploads go on without it; the settings switch and status; stats; /aikey off', async () => {
  advance(3600);
  mock.state.gemini.reply = () => ({ status: 429, json: { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } } });
  const n0 = geminiPosts().length;
  await upload(ava, 'photo', 'AQ1', 'سهمیه یک');
  assert.equal(geminiPosts().length, n0 + 1);
  assert.equal(one('SELECT ocr FROM memes WHERE file_unique_id = ?', 'AQ1').ocr, null, 'saved without AI');
  mock.state.gemini.reply = null;
  await upload(ava, 'photo', 'AQ2', 'سهمیه دو');
  assert.equal(geminiPosts().length, n0 + 1, 'paused');
  const p = await panel(U.owner);
  const id = p.result.message_id;
  const view = async () => (await press(U.owner, 'a:st', id)).calls.find((c) => c.method === 'editMessageText');
  assert.match((await view()).params.text, /هوش مصنوعی \(Gemini\): روشن · سهمیه/);
  advance(3601);
  const v2 = await view();
  assert.match(v2.params.text, /هوش مصنوعی \(Gemini\): روشن · امروز [۰-۹]+ از ۵۰۰/);
  assert.ok(buttons(v2).some((b) => b.callback_data === 'a:st:ai:t'));
  await upload(ava, 'photo', 'AQ3', 'سهمیه سه');
  assert.equal(geminiPosts().length, n0 + 2, 'back after an hour');
  await press(U.owner, 'a:st:ai:t', id);
  assert.equal(kvN('set:ai'), 0);
  advance(60);
  await upload(ava, 'photo', 'AQ4', 'سهمیه چهار');
  assert.equal(geminiPosts().length, n0 + 2, 'switched off');
  await press(U.owner, 'a:st:ai:t', id);
  const ov = (await press(U.owner, 'a:ss', id)).calls.find((c) => c.method === 'editMessageText');
  assert.match(ov.params.text, /هوش مصنوعی: امروز [۱-۹][۰-۹]* · ۳۰ روز/);
  assert.match(lastText((await say(U.owner, '/aikey off')).calls), /کلید Gemini پاک شد/);
  assert.equal(secret() || null, null);
  advance(60);
  await upload(ava, 'photo', 'AQ5', 'سهمیه پنج');
  assert.equal(geminiPosts().length, n0 + 2, 'no key: no AI');
  assert.ok(!JSON.stringify(mock.state.calls).includes(KEY), 'the key is in nothing the bot sent');
  assert.match(lastText((await say(ava, '/help')).calls), /Gemini گوگل/);
});

// ---------- run ----------

let failedCount = 0;
for (const s of scenarios) {
  try {
    await s.fn();
    console.log(`✔ ${s.name}`);
  } catch (e) {
    failedCount += 1;
    console.log(`✘ ${s.name}\n  ${(e && e.stack) || e}`);
  }
}
const unanswered = pressed.filter((id) => !mock.state.answeredCallbacks.has(id));
if (unanswered.length) {
  failedCount += 1;
  console.log(`✘ callbacks never answered: ${unanswered.join(', ')}`);
}
if (errors.length) {
  failedCount += 1;
  console.log(`✘ console.error was called:\n${errors.join('\n')}`);
}
await mock.close();
console.log(failedCount ? `\n${failedCount} failed of ${scenarios.length}` : `\n✔ all ${scenarios.length} scenarios passed`);
process.exit(failedCount ? 1 : 0);
