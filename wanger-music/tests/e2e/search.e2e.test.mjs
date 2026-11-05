// Phase 3 end to end: the §9 must-pass list and the §12 inline cases, through the real handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';
import { stats } from '../sdk/db.mjs';

const U = 111;
const ZWNJ = '‌';
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
let seq = 0;

/** Imports an audio as the owner and activates it; returns the track row. */
async function addActive(h, title, performer, { duration = 200, album } = {}) {
  seq += 1;
  advance(61); // one card per import (no bulk summary)
  await h.send(OWNER, null, { audio: { file_id: `F${seq}`, file_unique_id: `U${seq}`, duration: duration + seq, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: 1000 } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  if (album) {
    await h.press(OWNER, `trk:ed:${row.id}:album`, 1);
    await h.send(OWNER, album);
  }
  await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}
const ids = (answer) => answer.results.map((r) => r.id);

test('§9 must-pass: ي/ی, ك/ک, «می‌خوام» forms, ۲ = 2, “week”, «شادمهر», an alias, removed tracks', async () => {
  const h = setup();
  join(h, U);
  const ali = await addActive(h, 'دلم گرفته', 'علي لهراسبي');
  const kaf = await addActive(h, 'کوچه', 'بابك جهانبخش');
  const mikham = await addActive(h, `من می${ZWNJ}خوام برم`, 'محسن یگانه');
  const part2 = await addActive(h, 'قسمت ۲', 'گروه');
  const weeknd = await addActive(h, 'Blinding Lights', 'The Weeknd');
  const shad = await addActive(h, 'دلم تنگه', 'شادمهر عقیلی');

  assert.deepEqual(ids((await h.inline(U, 'علی')).answer), [ali.public_id], 'ي/ی');
  assert.deepEqual(ids((await h.inline(U, 'لهراسبی')).answer), [ali.public_id]);
  assert.deepEqual(ids((await h.inline(U, 'بابک')).answer), [kaf.public_id], 'ك/ک');
  assert.deepEqual(ids((await h.inline(U, 'كوچه')).answer), [kaf.public_id]);
  for (const q of [`می${ZWNJ}خوام`, 'میخوام', 'می خوام']) assert.deepEqual(ids((await h.inline(U, q)).answer), [mikham.public_id], q);
  assert.deepEqual(ids((await h.inline(U, 'قسمت 2')).answer), [part2.public_id], '۲ = 2');
  assert.deepEqual(ids((await h.inline(U, 'week')).answer), [weeknd.public_id], 'week finds The Weeknd');
  assert.deepEqual(ids((await h.inline(U, 'شادمهر')).answer), [shad.public_id], '«شادمهر» finds «شادمهر عقیلی»');
  assert.deepEqual(ids((await h.inline(U, 'shadmehr')).answer), [], 'no alias yet');

  await h.press(OWNER, `art:byt:${shad.id}`, 1);
  const artistId = h.one('SELECT id FROM artists WHERE normalized_name = ?', 'شادمهر عقیلی').id;
  await h.press(OWNER, `art:addal:${artistId}`, 1);
  await h.send(OWNER, 'Shadmehr');
  assert.match(h.tg.callsOf('sendMessage', OWNER).at(-2).params.text, /«shadmehr» اضافه شد/);
  assert.deepEqual(ids((await h.inline(U, 'shadmehr')).answer), [shad.public_id], 'the alias finds the Persian-script artist');
  assert.deepEqual(ids((await h.inline(U, 'shad')).answer), [shad.public_id], 'aliases match by prefix too');

  await h.press(OWNER, `trk:rmok:${shad.id}`, 1);
  assert.deepEqual(ids((await h.inline(U, 'shadmehr')).answer), [], 'removed tracks never appear');
  assert.deepEqual(ids((await h.inline(U, 'شادمهر')).answer), []);
  assert.equal(h.one('SELECT count(*) AS n FROM track_terms WHERE track_id = ?', shad.id).n, 0, 'its terms are gone');
  await h.press(OWNER, `trk:hide:${weeknd.id}`, 1);
  assert.deepEqual(ids((await h.inline(U, 'week')).answer), [], 'hidden tracks never appear');
});

test('inline: empty query (popular, then newest), normal query, no results, every token must match', async () => {
  const h = setup();
  join(h, U);
  const a = await addActive(h, 'Hello', 'Adele');
  const b = await addActive(h, 'Hello', 'Lionel Richie');
  const c = await addActive(h, 'Someone Like You', 'Adele');
  await h.chosen(U, c.public_id);
  await h.chosen(U, c.public_id);
  let r = await h.inline(U, '');
  assert.deepEqual(ids(r.answer), [c.public_id, b.public_id, a.public_id], 'most played first, then newest');
  assert.equal(r.answer.button, undefined);
  r = await h.inline(U, 'hello adele');
  assert.deepEqual(ids(r.answer), [a.public_id], 'every token must match');
  r = await h.inline(U, 'adele');
  assert.deepEqual(ids(r.answer), [c.public_id, a.public_id], 'exact artist match; more plays first');
  r = await h.inline(U, 'hel');
  assert.deepEqual(ids(r.answer).sort(), [a.public_id, b.public_id].sort(), 'the last token is a prefix');
  r = await h.inline(U, 'zzzz');
  assert.deepEqual(r.answer.results, []);
  assert.deepEqual(r.answer.button, { text: '🔎 جستجو در ربات', start_parameter: 'search' });
  assert.deepEqual([r.answer.is_personal, r.answer.cache_time], [true, 60], 'always personal; cache_time from settings');
  const sample = (await h.inline(U, 'adele')).answer.results[0];
  assert.deepEqual(Object.keys(sample).sort(), ['audio_file_id', 'id', 'type']);
  assert.equal(sample.type, 'audio', 'InlineQueryResultCachedAudio');
});

test('inline pagination: 20 per page via next_offset; offsets past the end are empty', async () => {
  const h = setup();
  join(h, U);
  for (let i = 0; i < 25; i++) await addActive(h, `Love Song ${i}`, `Singer ${i}`);
  let r = await h.inline(U, 'love');
  assert.equal(r.answer.results.length, 20);
  assert.equal(r.answer.next_offset, '20');
  r = await h.inline(U, 'love', '20');
  assert.equal(r.answer.results.length, 5);
  assert.equal(r.answer.next_offset, '');
  assert.equal(new Set([...(await h.inline(U, 'love')).answer.results, ...r.answer.results].map((x) => x.id)).size, 25, 'no overlap');
  r = await h.inline(U, 'love', '9999');
  assert.deepEqual(r.answer.results, []);
  r = await h.inline(U, 'love', 'garbage');
  assert.equal(r.answer.results.length, 20, 'an invalid offset starts at 0');
});

test('inline gate: a non-member gets no results, a personal answer, cache_time 0 and the join button', async () => {
  const h = setup();
  const admin = await addActive(h, 'Hello', 'Adele');
  const r = await h.inline(U, 'hello');
  assert.deepEqual(r.answer, { inline_query_id: r.answer.inline_query_id, results: [], is_personal: true, cache_time: 0, button: { text: '🔒 اول عضو کانال‌ها شو', start_parameter: 'join' } });
  assert.equal(r.result.result, 'gated');
  const u = h.one('SELECT is_blocked, force_join_ok_until FROM users WHERE telegram_id = ?', U);
  assert.deepEqual({ ...u }, { is_blocked: 1, force_join_ok_until: 0 }, 'an inline-only user can’t be messaged yet; no pass cached');
  join(h, U);
  assert.deepEqual(ids((await h.inline(U, 'hello')).answer), [admin.public_id]);
  await h.send(U, '/start join');
  assert.equal(h.one('SELECT is_blocked FROM users WHERE telegram_id = ?', U).is_blocked, 0, 'starting the bot clears it');
});

test('inline: a long query is cut (64 chars, 5 tokens); banned users get nothing; an expired query is not an error', async () => {
  const h = setup();
  join(h, U);
  const t = await addActive(h, 'Hello', 'Adele');
  let r = await h.inline(U, `hello ${'x'.repeat(200)}`);
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.answer.results, [], 'the cut query still has to match');
  r = await h.inline(U, 'hello a b c d e f g');
  assert.equal(r.result.ok, true);
  h.tg.failNext('answerInlineQuery', 400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
  r = await h.inline(U, 'hello');
  assert.equal(r.result.ok, true);
  assert.equal(h.one('SELECT count(*) AS n FROM error_log').n, 0);
  await h.press(OWNER, `usr:banok:${U}`, 1);
  r = await h.inline(U, 'hello');
  assert.deepEqual([r.answer.results, r.answer.cache_time, r.answer.button], [[], 0, undefined]);
  assert.equal(h.one('SELECT play_count FROM tracks WHERE id = ?', t.id).play_count, 0);
});

test('inline path cost: few indexed queries, exactly one Bot API call, no tick', async () => {
  const h = setup();
  join(h, U);
  for (let i = 0; i < 5; i++) await addActive(h, `Song ${i}`, 'Artist');
  await h.inline(U, 'song'); // first call stores the force-join pass
  const before = stats.queries;
  const r = await h.inline(U, 'song');
  const queries = stats.queries - before;
  assert.ok(queries <= 4, `${queries} DB queries`);
  assert.deepEqual(r.calls.map((c) => c.method), ['answerInlineQuery']);
  assert.equal(r.result.tick, null, 'never a tick on inline_query');
});

test('chosen_inline_result counts a play once per update', async () => {
  const h = setup();
  const t = await addActive(h, 'Hello', 'Adele');
  await h.chosen(U, t.public_id, 9001);
  await h.chosen(U, t.public_id, 9001);
  await h.chosen(U, t.public_id, 9002);
  await h.chosen(U, 'NoSuchId1');
  assert.equal(h.one('SELECT play_count FROM tracks WHERE id = ?', t.id).play_count, 2);
});

test('private chat: plain text and /search list results; a button sends the audio; pagination; deep links', async () => {
  const h = setup();
  join(h, U);
  const tracks = [];
  for (let i = 0; i < 12; i++) tracks.push(await addActive(h, `Rain ${i}`, 'Weather'));
  await h.send(U, 'rain');
  let msg = h.tg.lastTo(U);
  assert.match(msg.text, /^🔎 «rain»/);
  let bs = buttons(msg);
  assert.equal(bs.filter((b) => b.callback_data && b.callback_data.startsWith('s:get:')).length, 10);
  assert.ok(bs.some((b) => b.switch_inline_query_current_chat === 'rain'), 'the inline-search button');
  const pick = bs.find((b) => b.callback_data && b.callback_data.startsWith('s:get:')).callback_data;
  await h.tap(U, pick);
  const sent = h.tg.callsOf('sendAudio', U).at(-1);
  const pid = pick.split(':')[2];
  assert.equal(sent.params.audio, h.one('SELECT audio_file_id FROM tracks WHERE public_id = ?', pid).audio_file_id);
  assert.equal(h.one('SELECT play_count FROM tracks WHERE public_id = ?', pid).play_count, 1);
  await h.tap(U, 's:pg:1');
  msg = h.tg.lastTo(U);
  assert.equal(buttons(msg).filter((b) => b.callback_data && b.callback_data.startsWith('s:get:')).length, 2, 'page 2');
  await h.send(U, '/search');
  assert.match(h.lastText(U), /اسم آهنگ یا خواننده رو بفرست/);
  await h.send(U, '/search weather rain 3');
  assert.equal(buttons(h.tg.lastTo(U)).filter((b) => b.callback_data && b.callback_data.startsWith('s:get:')).length, 1);
  await h.send(U, 'nothinglikethis');
  assert.match(h.lastText(U), /چیزی پیدا نکردم/);

  await h.send(U, `/start t_${tracks[3].public_id}`);
  assert.equal(h.tg.callsOf('sendAudio', U).at(-1).params.audio, tracks[3].audio_file_id, 'deep link sends the track');
  await h.press(OWNER, `trk:rmok:${tracks[3].id}`, 1);
  await h.send(U, `/start t_${tracks[3].public_id}`);
  assert.match(h.lastText(U), /دیگه در دسترس نیست/);
  await h.send(U, '/start search');
  assert.match(h.lastText(U), /اسم آهنگ یا خواننده رو بفرست/);
  const mark = h.mark();
  await h.press(U, 's:get:NoSuchId1', 1);
  assert.match(h.tg.callsOf('sendMessage', U, mark).at(-1).params.text, /دیگه در دسترس نیست/);
});

test('a deep link from a non-member continues after joining', async () => {
  const h = setup();
  const t = await addActive(h, 'Hello', 'Adele');
  await h.send(U, `/start t_${t.public_id}`);
  assert.match(h.lastText(U), /اول عضو این کانال/);
  join(h, U);
  await h.tap(U, 'fj:check');
  assert.equal(h.tg.callsOf('sendAudio', U).at(-1).params.audio, t.audio_file_id);
});

test('index lifecycle: editing an active title re-indexes it; purge drops terms; the rebuild cursor indexes old tracks', async () => {
  const h = setup();
  join(h, U);
  const t = await addActive(h, 'Old Name', 'Band');
  await h.press(OWNER, `trk:ed:${t.id}:title`, 1);
  await h.send(OWNER, 'New Name');
  assert.deepEqual(ids((await h.inline(U, 'old')).answer), []);
  assert.deepEqual(ids((await h.inline(U, 'new name')).answer), [t.public_id]);

  // a track that was active before Phase 3 had no terms: bootstrap v2 schedules a rebuild
  h.db().prepare('DELETE FROM track_terms').run();
  h.db().prepare("UPDATE settings SET value = '0' WHERE key = 'search.reindex_cursor'").run();
  assert.deepEqual(ids((await h.inline(U, 'new')).answer), []);
  await h.opsTick(OWNER);
  assert.deepEqual(ids((await h.inline(U, 'new')).answer), [t.public_id], 'rebuilt by the tick');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'search.reindex_cursor'").value, '-1');

  await h.press(OWNER, `trk:rmok:${t.id}`, 1);
  await h.press(OWNER, `trk:purgeok:${t.id}`, 1);
  assert.equal(h.one('SELECT count(*) AS n FROM track_terms').n, 0);
});

test('inline caption template: validated by a preview, applied to results; bad HTML and unknown variables refused', async () => {
  const h = setup();
  join(h, U);
  const t = await addActive(h, 'Hello', 'Adele');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:inline.caption');
  await h.send(OWNER, '{title} {nope}');
  assert.match(h.lastText(OWNER), /شناخته نشدن: \{nope\}/);
  await h.send(OWNER, '<b>{title}');
  assert.match(h.lastText(OWNER), /تلگرام این متن رو قبول نکرد/);
  await h.send(OWNER, '🎧 <b>{title}</b> — {artist}\n💿 {album}\n<a href="{bot_link}">Wanger Music</a>');
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /پیش‌نمایش/.test(c.params.text)), 'preview sent to the owner');
  const r = (await h.inline(U, 'hello')).answer.results[0];
  assert.equal(r.caption, `🎧 <b>Hello</b> — Adele\n<a href="https://t.me/Wange_Musicbot?start=t_${t.public_id}">Wanger Music</a>`);
  assert.equal(r.parse_mode, 'HTML');
});
