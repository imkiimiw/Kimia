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
    assert.equal(p.is_personal, false);
    assert.equal(p.cache_time, INLINE_CACHE);
    assert.equal(p.next_offset, '');
    assert.equal(p.button, undefined);
    assert.ok(queries <= 1, `search used ${queries} queries`);
  }
  const none = await inline(U.sara, 'گربه سگ');
  assert.deepEqual(none.ids, []);
  assert.deepEqual(none.p.button, { text: '😕 پیدا نشد؛ تو آپلودش کن!', start_parameter: 'upload' });
  assert.ok(none.queries <= 2);
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
  assert.ok(queries <= 4, `home page used ${queries} queries`);
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
