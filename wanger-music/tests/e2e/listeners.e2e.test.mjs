// Listener features (owner's ideas, 2026-11-23): the buttons under a song, favourites, following an
// artist (their new songs are sent by the tick), requests (sent when the song arrives, Finglish
// requests included), random / browse by mood and genre, albums, missed searches for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const U = 111;
const V = 222;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
let seq = 0;

/** Imports an audio as the owner and (by default) activates it. */
async function song(h, title, performer, { album, activate = true } = {}) {
  seq += 1;
  advance(61);
  await h.send(OWNER, null, { audio: { file_id: `LF${seq}`, file_unique_id: `LU${seq}`, duration: 200 + seq, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: 1000 } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  if (album) {
    await h.press(OWNER, `trk:ed:${row.id}:album`, 1);
    await h.send(OWNER, album);
  }
  if (activate) await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}
/** The last song sent to a user (the sendAudio call). */
const lastSong = (h, id) => h.tg.callsOf('sendAudio', id).filter((c) => c.result).at(-1);
const data = (call) => buttons(call.params).map((b) => b.callback_data);

test('under a song: ❤️ / 🔔 / 👤 / 💿 / 📤; ❤️ toggles in place and fills «my favourites»', async () => {
  const h = setup();
  join(h, U);
  const tr = await song(h, 'بی تو', 'ابی', { album: 'آلبوم یک' });
  await h.send(U, `/start t_${tr.public_id}`);
  const m = lastSong(h, U);
  assert.deepEqual(data(m), [`l:fav:${tr.public_id}`, `l:fol:${tr.public_id}`, `l:art:${tr.public_id}:0`, `l:alb:${tr.public_id}`, undefined]);
  assert.equal(buttons(m.params).at(-1).switch_inline_query, 'بی تو ابی', '📤 opens inline search for the song in any chat');
  await h.press(U, `l:fav:${tr.public_id}`, m.result.message_id);
  assert.equal(h.tg.answers().at(-1).text, '❤️ به علاقه‌مندی‌هایت اضافه شد.');
  const edited = h.tg.callsOf('editMessageReplyMarkup', U).at(-1);
  assert.equal(edited.params.reply_markup.inline_keyboard[0][0].text, '💔 حذف از علاقه‌مندی‌ها');
  await h.press(U, 'l:favs:0', 1);
  assert.match(h.lastText(U), /علاقه‌مندی‌های من/);
  assert.deepEqual(h.lastButtons(U).map((b) => b.callback_data).filter((d) => d.startsWith('s:get:')), [`s:get:${tr.public_id}`]);
  await h.press(U, `l:fav:${tr.public_id}`, m.result.message_id);
  assert.equal(h.one('SELECT count(*) AS n FROM favorites').n, 0);
});

test('🔔 follow an artist: their next new song reaches the follower (once), a blocked follower is skipped', async () => {
  const h = setup();
  join(h, U);
  join(h, V);
  const first = await song(h, 'دلم تنگه', 'شادمهر عقیلی');
  for (const who of [U, V]) {
    await h.send(who, `/start t_${first.public_id}`);
    await h.press(who, `l:fol:${first.public_id}`, lastSong(h, who).result.message_id);
  }
  assert.match(h.tg.answers().at(-1).text, /هر آهنگ جدید «شادمهر عقیلی» را برایت می‌فرستم/);
  h.tg.blocked.add(V);
  const before = h.tg.callsOf('sendAudio', U).length;
  const next = await song(h, 'پرواز', 'شادمهر عقیلی');
  await h.opsTick(OWNER);
  const got = h.tg.callsOf('sendAudio', U).slice(before);
  assert.equal(got.length, 1);
  assert.equal(got[0].params.audio, next.audio_file_id);
  assert.equal(got[0].params.caption, '🔔 آهنگ جدید از شادمهر عقیلی');
  assert.equal(h.one('SELECT sent, done_at IS NOT NULL AS done FROM notice_jobs').sent, 1);
  // hidden and active again: no second notice; another artist: none
  await h.press(OWNER, `trk:hide:${next.id}`, 1);
  await h.press(OWNER, `trk:act:${next.id}`, 1);
  await song(h, 'Shape of You', 'Ed Sheeran');
  await h.opsTick(OWNER);
  assert.equal(h.tg.callsOf('sendAudio', U).slice(before).length, 1);
  // «🔔 my artists» lists and unfollows
  await h.press(U, 'l:fols:0', 1);
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === 'l:unf:0:0'));
  await h.tap(U, 'l:unf:0:0');
  assert.equal(h.one('SELECT count(*) AS n FROM artist_follows WHERE user_id = ?', U).n, 0);
});

test('a request from "nothing found" (Finglish), seen by the owner, delivered when the song is added', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, 'shadmehr bi to');
  assert.match(h.lastText(U), /برای «shadmehr bi to» چیزی پیدا نکردم/);
  await h.tap(U, 'l:rq');
  assert.match(h.lastText(U), /درخواستت ثبت شد: «shadmehr bi to»/);
  await h.send(U, 'shadmehr bi to');
  await h.tap(U, 'l:rq');
  assert.match(h.lastText(U), /قبلاً درخواست داده‌ای/);
  // the owner's list
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'mus:home');
  await h.tap(OWNER, 'lr:home');
  assert.match(h.lastText(OWNER), /1\. «shadmehr bi to» — ۱ نفر|۱\. «shadmehr bi to» — ۱ نفر/);
  // a song that doesn't fit changes nothing; the right one (Persian title) is delivered
  await song(h, 'پرواز', 'شادمهر عقیلی');
  const tr = await song(h, 'بی تو', 'شادمهر عقیلی');
  assert.equal(h.one("SELECT status FROM song_requests").status, 'matched');
  await h.opsTick(OWNER);
  const m = lastSong(h, U);
  assert.equal(m.params.audio, tr.audio_file_id);
  assert.equal(m.params.caption, '🎉 آهنگی که درخواست داده بودی رسید: «shadmehr bi to»');
  assert.equal(h.one('SELECT status FROM song_requests').status, 'done');
  await h.opsTick(OWNER);
  assert.equal(h.tg.callsOf('sendAudio', U).filter((c) => /درخواست داده بودی/.test(c.params.caption || '')).length, 1, 'once');
});

test('requests from the menu: at most 5 open, «📋 my requests» cancels; the owner drops one', async () => {
  const h = setup();
  join(h, U);
  for (let i = 0; i < 5; i++) {
    await h.press(U, 'l:req', 1);
    await h.send(U, `آهنگ شماره ${i}`);
  }
  await h.press(U, 'l:req', 1);
  await h.send(U, 'یکی دیگر');
  assert.match(h.lastText(U), /حداکثر ۵ درخواست باز|حداکثر 5 درخواست باز/);
  await h.press(U, 'l:reqs', 1);
  const cancel = h.lastButtons(U).find((b) => b.callback_data.startsWith('l:rqx:'));
  await h.tap(U, cancel.callback_data);
  assert.equal(h.one("SELECT count(*) AS n FROM song_requests WHERE status = 'open'").n, 4);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'mus:home');
  await h.tap(OWNER, 'lr:home');
  await h.tap(OWNER, 'lr:drop:0');
  assert.equal(h.one("SELECT count(*) AS n FROM song_requests WHERE status = 'open'").n, 3);
});

test('searches with no result: private and inline (4+ characters, keystroke prefixes folded), no user ids, owner can delete', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, 'xqzwv');
  for (const q of ['zor', 'zorb', 'zorba', 'zorbas']) await h.inline(U, q);
  assert.deepEqual(h.q('SELECT key, n FROM missed_searches ORDER BY key').map((r) => [r.key, r.n]), [['xqzwv', 1], ['zorb', 1], ['zorba', 1], ['zorbas', 1]]);
  assert.deepEqual(h.q('PRAGMA table_info(missed_searches)').map((c) => c.name), ['key', 'text', 'n', 'first_at', 'last_at'], 'nobody\'s id');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'mus:home');
  await h.tap(OWNER, 'lr:miss');
  const text = h.lastText(OWNER);
  assert.match(text, /«zorbas»/);
  assert.doesNotMatch(text, /«zorb»/, 'prefixes of a longer query are folded');
  assert.match(text, /«xqzwv»/);
  await h.tap(OWNER, 'lr:mdel:0');
  assert.equal(h.q('SELECT key FROM missed_searches').length, 3);
});

test('🎲 random, 🎭 moods (set on the track card) and genres, 💿 album sent five at a time, the welcome menu', async () => {
  const h = setup();
  join(h, U);
  const sad = await song(h, 'دلم گرفته', 'علی لهراسبی');
  await h.press(OWNER, `trk:setm:${sad.id}:sad`, 1);
  await h.press(OWNER, `trk:setg:${sad.id}:pop`, 1);
  for (let i = 1; i <= 7; i++) await song(h, `ترک ${i}`, 'گروه آلبوم', { album: 'آلبوم بزرگ' });
  await h.send(U, '/start');
  const welcome = h.lastButtons(U).map((b) => b.callback_data);
  for (const d of ['l:rnd', 'l:br', 'l:favs:0', 'l:fols:0', 'l:req', 'l:reqs']) assert.ok(welcome.includes(d), d);
  await h.tap(U, 'l:rnd');
  assert.equal(lastSong(h, U).params.caption, '🎲 آهنگ تصادفی امروز');
  await h.tap(U, 'l:br');
  await h.tap(U, 'l:m:sad:0');
  assert.deepEqual(h.lastButtons(U).filter((b) => b.callback_data.startsWith('s:get:')).map((b) => b.callback_data), [`s:get:${sad.public_id}`]);
  await h.press(U, 'l:g:pop:0', 1);
  assert.match(h.lastText(U), /پاپ/);
  // album: list, then «📥 send» five per press
  const albumSong = h.one("SELECT public_id FROM tracks WHERE album = 'آلبوم بزرگ' LIMIT 1").public_id;
  await h.press(U, `l:alb:${albumSong}`, 1);
  assert.match(h.lastText(U), /آلبوم بزرگ<\/b> — گروه آلبوم \(۷ آهنگ\)/);
  const before = h.tg.callsOf('sendAudio', U).length;
  await h.tap(U, `l:albs:${albumSong}:0`);
  assert.equal(h.tg.callsOf('sendAudio', U).length - before, 5);
  await h.tap(U, `l:albs:${albumSong}:5`);
  assert.equal(h.tg.callsOf('sendAudio', U).length - before, 7);
  // 👤 more from the artist, from a song: a new message (an audio message can't become text)
  await h.press(U, `l:art:${albumSong}:0`, lastSong(h, U).result.message_id);
  assert.match(h.lastText(U), /آهنگ‌های گروه آلبوم/);
});
