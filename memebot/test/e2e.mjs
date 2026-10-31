// End-to-end scenarios: the real handlers (tgcloud/) run against a local emulation of the
// platform's `sdk` (test/sdk/: SQLite via node:sqlite + a Bot API client) and a strict mock Bot API
// (test/mock-telegram.mjs). Web and timer globals are removed first, like the platform's isolate.
// Run: npm test
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
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

async function press(u, data, messageId) {
  since();
  const id = `cb${seq++}`;
  pressed.push(id);
  const cq = { id, from: u, chat_instance: 'ci', data, message: { message_id: messageId, chat: { id: u.id, type: 'private' }, date: nowSec() } };
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
  const r = check(await onInline(q));
  const calls = since();
  assert.equal(calls.length, 1, `inline query made ${calls.length} Bot API calls`);
  assert.ok(calls[0].ok, `answerInlineQuery failed: ${calls[0].error}`);
  const p = mock.state.answeredInline.get(id);
  return { p, ids: p.results.map((x) => x.id), queries: stats.queries - before, r };
}

async function chosen(u, resultId, query = '') {
  return check(await onChosen({ result_id: resultId, from: u, query }));
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
  assert.deepEqual(buttons(welcome).map((b) => b.callback_data || 'inline'), ['m:up', 'm:my', 'inline', 'm:lang', 'm:help']);
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
  assert.deepEqual(buttons(ask).map((b) => b.callback_data), [`up:x:${m.message.message_id}`]);
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
  assert.deepEqual((await inline(U.sara, '😂')).p.results, [{ type: 'sticker', id: `m${memeId('U4')}`, sticker_file_id: 'F_U4' }]);
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
  assert.deepEqual(buttons(photo).map((b) => b.callback_data || 'inline'), [`md:${target}:0:${listId}`, 'inline']);

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
  assert.deepEqual(fa.commands.map((c) => c.command), ['start', 'my', 'lang', 'help', 'cancel']);
  assert.equal(fa.commands[1].description, 'میم‌های من');
  assert.equal(en.commands[1].description, 'My memes');
  assert.deepEqual(mock.state.botTexts.get(`chat:${OWNER}/`).commands.map((c) => c.command), ['start', 'my', 'lang', 'help', 'cancel', 'admin'], 'the owner\'s own menu has /admin');
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
  assert.match(p.params.text, /پنل مدیریت|Admin panel/);
  return p;
}

scenario('phase 2 — settings: the owner turns moderation on and changes the thresholds from the panel', async () => {
  const p = await panel(U.owner);
  assert.deepEqual(buttons(p).map((b) => b.callback_data), ['a:q', 'a:r', 'a:u', 'a:bl:0', 'a:ch', 'a:bc', 'a:st', 'a:ad']);
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
  assert.match(sends(add.calls)[0].params.text, /Nima.*ادمین شد/);
  assert.ok(one('SELECT user_id FROM admins WHERE user_id = ?', U.nima.id));
  const np = await panel(U.nima);
  assert.deepEqual(buttons(np).map((b) => b.callback_data), ['a:q', 'a:r', 'a:u', 'a:bl:0']);
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
  assert.deepEqual(buttons(msg).map((b) => b.callback_data), [`rp:${id}`]);
  const pick = await press(U.sara, `rp:${id}`, msg.result.message_id);
  assert.deepEqual(buttons(pick.calls.find((c) => c.method === 'editMessageReplyMarkup')).map((b) => b.callback_data), [`rp:${id}:nsfw`, `rp:${id}:hate`, `rp:${id}:spam`, `rp:${id}:other`, `rp:${id}:x`]);
  await press(U.sara, `rp:${id}:x`, msg.result.message_id);
  const done = await press(U.sara, `rp:${id}:nsfw`, msg.result.message_id);
  assert.equal(done.answer.text, '✅ گزارشت ثبت شد. ممنون!');
  assert.equal(one('SELECT reports FROM memes WHERE id = ?', id).reports, 1);
  assert.match(toUser(done.calls, OWNER)[0].params.text, /گزارش‌شده منتظر بررسیه/);
  assert.equal((await press(U.sara, `rp:${id}:spam`, msg.result.message_id)).answer.text, 'قبلاً این میم رو گزارش کردی.');
  const own = await media(U.ali, 'photo', 'U1');
  assert.deepEqual(buttons(sends(own.calls)[0]), [], 'no report button on your own meme');
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
