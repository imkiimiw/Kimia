// Phase 2 end to end: ingestion by send/forward, import card and bulk summary, duplicates,
// language, editing, removal, archive, the 🎵 Music screens. Real handlers, real SQL, fake Telegram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const SRC = -1009000000001; // a channel the owner forwards from
const ADMIN = 222;
const U = 111;
const ZWNJ = '‌';

let seq = 0;
/** An Audio object like Telegram sends. */
function audio({ title, performer, file_name, duration = 200, uid } = {}) {
  seq += 1;
  return {
    file_id: `FILE_${uid || seq}_${seq}`, file_unique_id: uid || `UQ${seq}`, duration,
    ...(title !== undefined ? { title } : {}), ...(performer !== undefined ? { performer } : {}),
    file_name: file_name ?? `${performer || 'x'} - ${title || 'y'}.mp3`, mime_type: 'audio/mpeg', file_size: 4_200_000,
    thumbnail: { file_id: `THUMB_${seq}`, file_unique_id: `TU${seq}`, width: 90, height: 90 },
  };
}
const fwd = (messageId, chatId = SRC) => ({ forward_origin: { type: 'channel', chat: { id: chatId, type: 'channel', title: 'Src' }, message_id: messageId, date: 0 } });
const tracks = (h) => h.q('SELECT * FROM tracks ORDER BY id');
const cards = (h, from = 0) => h.tg.callsOf('sendMessage', OWNER, from).filter((c) => /آهنگ جدید وارد شد/.test(c.params.text));

async function importOne(h, a, extra = {}, from = OWNER) {
  return h.send(from, null, { audio: a, ...extra });
}

test('forwarding 10 audios creates 10 tracks with correct metadata: one card, then ONE summary', async () => {
  const h = setup();
  await h.send(OWNER, '/start');
  const songs = [
    ['Blinding Lights', 'The Weeknd', 200], ['دلم تنگه', 'شادمهر عقیلی', 245], ['Shape of You', 'Ed Sheeran', 233],
    ['Song (Official Audio) @chan', 'Artist feat. Guest', 180], ['بی تو', 'ابی', 300], ['Levitating', 'Dua Lipa x DaBaby', 203],
    ['یه روز خوب', 'محسن یگانه', 260], ['Bad Habits', 'Ed Sheeran', 231], ['سلام', 'رضا صادقی', 190], ['Hello', 'Adele', 295],
  ];
  const mark = h.mark();
  for (let i = 0; i < songs.length; i++) {
    const [title, performer, duration] = songs[i];
    const r = await importOne(h, audio({ title, performer, duration }), fwd(500 + i));
    assert.equal(r.result, 'import');
  }
  const rows = tracks(h);
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.status === 'draft' && r.source_type === 'manual' && r.added_by === OWNER && /^[A-Za-z0-9]{9}$/.test(r.public_id)));
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.deepEqual(['The Weeknd', 200, 'audio/mpeg', 4_200_000, SRC, 500], [byTitle['Blinding Lights'].artist, byTitle['Blinding Lights'].duration, byTitle['Blinding Lights'].mime_type, byTitle['Blinding Lights'].file_size, byTitle['Blinding Lights'].origin_chat_id, byTitle['Blinding Lights'].origin_message_id]);
  assert.equal(byTitle['Blinding Lights'].language, 'en');
  assert.equal(byTitle['Blinding Lights'].language_confidence, 'low', 'Latin only → low');
  assert.equal(byTitle['دلم تنگه'].language, 'fa');
  assert.equal(byTitle['دلم تنگه'].language_confidence, 'medium');
  assert.deepEqual([byTitle.Song.artist, byTitle.Song.featured_artists], ['Artist', 'Guest'], 'noise and feat. handled');
  assert.deepEqual([byTitle.Levitating.artist, byTitle.Levitating.featured_artists], ['Dua Lipa', 'DaBaby']);
  assert.ok(byTitle['Blinding Lights'].cover_file_id.startsWith('THUMB_'), 'the audio thumbnail is kept');

  assert.equal(cards(h, mark).length, 1, 'only the first audio gets an import card');
  const summaries = h.tg.callsOf('sendMessage', OWNER, mark).filter((c) => /ورود گروهی/.test(c.params.text));
  assert.equal(summaries.length, 1, 'one summary message');
  const summaryId = summaries[0].result.message_id;
  assert.match(h.tg.message(OWNER, summaryId).text, /۱۰ فایل · ✅ ۱۰ جدید · ♻️ ۰ تکراری/);
  assert.equal(h.q("SELECT action FROM audit_log WHERE action = 'catalog.import'").length, 10);
});

test('forwarding one again is rejected (same file, or the same post); nothing is added', async () => {
  const h = setup();
  const a = audio({ title: 'Hello', performer: 'Adele' });
  await importOne(h, a, fwd(1));
  advance(61);
  const mark = h.mark();
  await importOne(h, { ...a, file_id: 'OTHER_FILE_ID_SAME_UNIQUE' }, fwd(2));
  assert.match(h.lastText(OWNER), /قبلاً توی آرشیو هست: «Hello — Adele»/);
  assert.equal(cards(h, mark).length, 0);
  advance(61);
  await importOne(h, audio({ title: 'Other', performer: 'X' }), fwd(1));
  assert.match(h.lastText(OWNER), /قبلاً توی آرشیو هست/, 'same origin post → duplicate');
  assert.equal(tracks(h).length, 1);

  // inside a run of forwards the duplicate is counted in the summary instead
  advance(61);
  await importOne(h, audio({ title: 'New', performer: 'Y' }), fwd(10));
  await importOne(h, a, fwd(11));
  assert.match(h.lastText(OWNER), /۲ فایل · ✅ ۱ جدید · ♻️ ۱ تکراری/);
});

test('a remix of an existing song is flagged, not blocked; a real soft duplicate needs a decision', async () => {
  const h = setup();
  await importOne(h, audio({ title: 'Song', performer: 'Artist', duration: 200 }));
  advance(61);
  await importOne(h, audio({ title: 'Song (Remix)', performer: 'Artist', duration: 215 }));
  let rows = tracks(h);
  assert.equal(rows.length, 2, 'not blocked');
  assert.deepEqual([rows[1].title, rows[1].version, rows[1].duplicate_of], ['Song', 'Remix', null]);
  assert.match(h.lastText(OWNER), /🔗 نسخه‌ی دیگه‌ای از همین آهنگ هست: «Song — Artist»/, 'flagged on the card');

  advance(61);
  await importOne(h, audio({ title: 'song', performer: 'ARTIST', duration: 202 }), {}, OWNER);
  rows = tracks(h);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].duplicate_of, rows[0].id, 'same song, other file, ±3 s → soft duplicate');
  assert.match(h.lastText(OWNER), /احتمالاً تکراریِ «Song — Artist»/);
  const ids = buttons(h.tg.lastTo(OWNER)).map((b) => b.callback_data);
  assert.ok(ids.includes(`trk:keep:${rows[2].id}`) && ids.includes(`trk:repl:${rows[2].id}`));
  assert.equal(h.q("SELECT id FROM tracks WHERE status = 'draft' AND duplicate_of IS NOT NULL").length, 1, 'listed under needs review');

  await h.tap(OWNER, `trk:repl:${rows[2].id}`);
  await h.tap(OWNER, `trk:replok:${rows[2].id}`);
  rows = tracks(h);
  assert.equal(rows[0].status, 'removed', 'replace: the older one is removed');
  assert.equal(rows[2].duplicate_of, null);

  advance(61);
  await importOne(h, audio({ title: 'Song', performer: 'Artist', duration: 199 }));
  const last = tracks(h).at(-1);
  assert.equal(last.duplicate_of, rows[2].id);
  const mark = h.mark();
  await h.tap(OWNER, `trk:act:${last.id}`);
  assert.match(h.tg.answers(mark).at(-1).text, /اول درباره‌ی تکراری تصمیم بگیر/, 'no activation before a decision');
  assert.equal(h.one('SELECT status FROM tracks WHERE id = ?', last.id).status, 'draft');
  await h.tap(OWNER, `trk:keep:${last.id}`);
  assert.equal(h.one('SELECT duplicate_of FROM tracks WHERE id = ?', last.id).duplicate_of, null, 'keep both');
  await h.tap(OWNER, `trk:act:${last.id}`);
  assert.equal(h.one('SELECT status FROM tracks WHERE id = ?', last.id).status, 'active', 'activatable after the decision');
});

test('editing title, artist, album, language, genre and cover; activation rules', async () => {
  const h = setup();
  await importOne(h, audio({ title: undefined, performer: undefined, file_name: 'JustNoise.mp3' }));
  const id = tracks(h)[0].id;
  assert.equal(tracks(h)[0].artist, null);
  assert.match(h.lastText(OWNER), /⚠️ خواننده نداره/);
  let mark = h.mark();
  await h.tap(OWNER, `trk:act:${id}`);
  assert.match(h.tg.answers(mark).at(-1).text, /عنوان و خواننده لازمه/);
  assert.equal(tracks(h)[0].status, 'draft');

  await h.tap(OWNER, `trk:ed:${id}:title`);
  await h.send(OWNER, 'Bohemian Rhapsody (Live)');
  await h.tap(OWNER, `trk:ed:${id}:artist`);
  await h.send(OWNER, 'Queen feat. Someone');
  await h.tap(OWNER, `trk:ed:${id}:album`);
  await h.send(OWNER, 'Live Aid');
  let tr = tracks(h)[0];
  assert.deepEqual([tr.title, tr.version, tr.artist, tr.featured_artists, tr.album], ['Bohemian Rhapsody', 'Live', 'Queen', 'Someone', 'Live Aid']);
  assert.equal(tr.dup_key, 'queen|bohemian rhapsody|live');
  await h.tap(OWNER, `trk:ed:${id}:title`);
  await h.send(OWNER, 'x'.repeat(201));
  assert.match(h.lastText(OWNER), /بین ۱ تا ۲۰۰ کاراکتر/);
  await h.send(OWNER, '/cancel');

  await h.tap(OWNER, `trk:lang:${id}`);
  await h.tap(OWNER, `trk:setl:${id}:en`);
  await h.tap(OWNER, `trk:genre:${id}`);
  await h.tap(OWNER, `trk:setg:${id}:rock`);
  await h.tap(OWNER, `trk:cover:${id}`);
  await h.send(OWNER, 'not a photo');
  assert.match(h.lastText(OWNER), /باید یه عکس بفرستی/);
  await h.send(OWNER, null, { photo: [{ file_id: 'P_small', width: 90, height: 90 }, { file_id: 'P_big', width: 1280, height: 1280 }] });
  tr = tracks(h)[0];
  assert.deepEqual([tr.language, tr.language_confidence, tr.language_source, tr.genre, tr.cover_file_id], ['en', 'high', 'manual', 'rock', 'P_big']);

  mark = h.mark();
  await h.tap(OWNER, `trk:act:${id}`);
  tr = tracks(h)[0];
  assert.equal(tr.status, 'active');
  assert.ok(tr.activated_at > 0);
  assert.match(h.tg.answers(mark).at(-1).text, /فعال شد/);
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'catalog.version'").value, '2', 'activation bumps catalog.version');
  const actions = h.q('SELECT action FROM audit_log ORDER BY id').map((r) => r.action);
  for (const a of ['catalog.import', 'catalog.edit_title', 'catalog.edit_artist', 'catalog.edit_album', 'catalog.language', 'catalog.genre', 'catalog.cover', 'catalog.activate']) assert.ok(actions.includes(a), a);
});

test('removal: hide/remove leave the active catalog; removed files stay blocked; restore; owner-only purge', async () => {
  const h = setup();
  const a = audio({ title: 'Song', performer: 'Artist' });
  await importOne(h, a);
  const id = tracks(h)[0].id;
  await h.tap(OWNER, `trk:act:${id}`);
  await h.tap(OWNER, `trk:hide:${id}`);
  assert.equal(tracks(h)[0].status, 'hidden');
  await h.tap(OWNER, `trk:rm:${id}`);
  assert.match(h.lastText(OWNER), /حذف بشه؟/);
  assert.equal(tracks(h)[0].status, 'hidden', 'not before confirming');
  await h.tap(OWNER, `trk:rmok:${id}`);
  assert.equal(tracks(h)[0].status, 'removed');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'catalog.version'").value, '3', 'activate + hide bumped it; removing a hidden track does not');

  advance(61);
  await importOne(h, a);
  assert.match(h.lastText(OWNER), /قبلاً توی آرشیو هست.*حذف‌شده/s, 'a removed track still blocks its file');
  assert.equal(tracks(h).length, 1);

  // an admin can remove and restore but not purge
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, String(ADMIN));
  for (const c of SEED) h.tg.setMember(c, ADMIN, 'member');
  await h.press(ADMIN, `trk:v:${id}`, 1);
  assert.equal(buttons(h.tg.lastTo(ADMIN)).some((b) => b.callback_data === `trk:purge:${id}`), false, 'no purge button for admins');
  let mark = h.mark();
  await h.press(ADMIN, `trk:purgeok:${id}`, 1);
  assert.equal(h.tg.answers(mark)[0].text, '⛔️ به این بخش دسترسی نداری.');
  await h.press(ADMIN, `trk:rest:${id}`, 1);
  assert.equal(tracks(h)[0].status, 'draft');
  await h.press(ADMIN, `trk:rmok:${id}`, 1);

  await h.tap(OWNER, `trk:v:${id}`).catch(() => h.press(OWNER, `trk:v:${id}`, 1));
  await h.press(OWNER, `trk:purge:${id}`, 1);
  mark = h.mark();
  await h.press(OWNER, `trk:purgeok:${id}`, 1);
  assert.match(h.tg.answers(mark)[0].text, /برای همیشه پاک شد/);
  assert.equal(tracks(h).length, 0);
  advance(61);
  await importOne(h, a);
  assert.equal(tracks(h).length, 1, 'after a purge the file can be imported again');
});

test('very long tag text is capped at 200 characters', async () => {
  const h = setup();
  await importOne(h, audio({ title: 'T'.repeat(300), performer: 'P'.repeat(300) }));
  const tr = tracks(h)[0];
  assert.equal([...tr.title].length, 200);
  assert.equal([...tr.artist].length, 200);
});

test('a document or voice instead of audio is refused with an explanation; users can’t import', async () => {
  const h = setup();
  await h.send(OWNER, null, { document: { file_id: 'D', file_unique_id: 'DU', mime_type: 'audio/mpeg', file_name: 'song.mp3' } });
  assert.match(h.lastText(OWNER), /به‌صورت «فایل» \(Document\) اومده/);
  await h.send(OWNER, null, { voice: { file_id: 'V', file_unique_id: 'VU', duration: 3 } });
  assert.match(h.lastText(OWNER), /پیام صوتیه/);
  for (const c of SEED) h.tg.setMember(c, U, 'member');
  const r = await h.send(U, null, { audio: audio({ title: 'X', performer: 'Y' }) });
  assert.notEqual(r.result, 'import');
  assert.equal(tracks(h).length, 0);
});

test('bulk summary can be turned off: every audio then gets its own card', async () => {
  const h = setup();
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:import.bulk_summary');
  const mark = h.mark();
  for (let i = 0; i < 3; i++) await importOne(h, audio({ title: `S${i}`, performer: 'A' }));
  assert.equal(cards(h, mark).length, 3);
});

test('archive channel: activation copies the track; failures alert the owner; the tick works the backlog', async () => {
  const h = setup();
  const ARCH = -1008000000001;
  h.tg.addChannel({ id: ARCH, username: 'WangerArchive', title: 'Archive' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:archive.chat_id');
  await h.send(OWNER, '@WangerArchive');
  await importOne(h, audio({ title: 'One', performer: 'A' }));
  const id = tracks(h)[0].id;
  await h.tap(OWNER, `trk:act:${id}`);
  const post = h.tg.callsOf('sendAudio', ARCH).at(-1);
  assert.equal(post.params.audio, tracks(h)[0].audio_file_id);
  assert.match(post.params.caption, new RegExp(`^#t${tracks(h)[0].public_id}\\n🎵 One\\n👤 A`));
  assert.deepEqual([tracks(h)[0].archive_chat_id, tracks(h)[0].archive_message_id], [ARCH, post.result.message_id]);

  h.tg.setBotStatus(ARCH, 'left');
  advance(61);
  await importOne(h, audio({ title: 'Two', performer: 'A' }));
  const id2 = tracks(h)[1].id;
  await h.tap(OWNER, `trk:act:${id2}`);
  assert.equal(tracks(h)[1].status, 'active', 'an archive failure never blocks activation');
  assert.equal(tracks(h)[1].archive_message_id, null);
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /کانال آرشیو/.test(c.params.text)), 'owner alerted');

  h.tg.setBotStatus(ARCH, 'administrator');
  advance(61);
  await h.opsTick(OWNER);
  assert.ok(tracks(h)[1].archive_message_id > 0, 'the tick archived the backlog');
});

test('🎵 Music screens: counts, filters, search (Persian forms), System Status shows tracks', async () => {
  const h = setup();
  await importOne(h, audio({ title: 'دلم تنگه', performer: 'شادمهر عقيلي' }));
  advance(61);
  await importOne(h, audio({ title: 'Blinding Lights', performer: 'The Weeknd' }));
  advance(61);
  await importOne(h, audio({ title: undefined, performer: undefined, file_name: 'x.mp3' }));
  const [fa, en] = tracks(h);
  await h.tap(OWNER, `trk:act:${fa.id}`);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'mus:home');
  assert.match(h.lastText(OWNER), /کل: ۳\n✅ فعال: ۱ · 📝 پیش‌نویس: ۲ \(⚠️ نیاز به بررسی: ۲\)/);
  await h.tap(OWNER, 'mus:ls:review:0');
  assert.equal(h.lastButtons(OWNER).filter((b) => b.callback_data.startsWith('trk:v:')).length, 2);
  await h.tap(OWNER, 'mus:ls:fa:0');
  assert.deepEqual(h.lastButtons(OWNER).filter((b) => b.callback_data.startsWith('trk:v:')).map((b) => b.callback_data), [`trk:v:${fa.id}`]);

  await h.tap(OWNER, 'mus:home');
  await h.tap(OWNER, 'mus:find');
  await h.send(OWNER, 'شادمهر');
  assert.deepEqual(h.lastButtons(OWNER).filter((b) => b.callback_data.startsWith('trk:v:')).map((b) => b.callback_data), [`trk:v:${fa.id}`], 'ي/ی: «شادمهر» finds «شادمهر عقيلي»');
  await h.tap(OWNER, 'mus:find');
  await h.send(OWNER, 'week');
  assert.match(h.lastText(OWNER), /چیزی پیدا نشد/, 'prefix search only (inline search with word matching is Phase 3)');
  await h.send(OWNER, `t_${en.public_id}`);
  assert.deepEqual(h.lastButtons(OWNER).filter((b) => b.callback_data.startsWith('trk:v:')).map((b) => b.callback_data), [`trk:v:${en.id}`], 'by public id');

  await h.press(OWNER, `trk:play:${en.id}`, 1);
  assert.equal(h.tg.callsOf('sendAudio', OWNER).at(-1).params.audio, en.audio_file_id);
  await h.tap(OWNER, 'adm:home');
  await h.tap(OWNER, 'sys:home');
  assert.match(h.lastText(OWNER), /آهنگ‌ها: ۳ \(✅ ۱\)/);
});

test('every new music route rejects a normal user; flows re-check permissions', async () => {
  const h = setup();
  for (const c of SEED) h.tg.setMember(c, U, 'member');
  await importOne(h, audio({ title: 'S', performer: 'A' }));
  const id = tracks(h)[0].id;
  for (const data of [`trk:v:${id}`, `trk:act:${id}`, `trk:rmok:${id}`, `trk:purgeok:${id}`, `trk:ed:${id}:title`, 'mus:home', 'mus:ls:draft:0', 'imp:ref']) {
    const mark = h.mark();
    await h.press(U, data, 1);
    assert.deepEqual(h.tg.calls.slice(mark).map((c) => c.method), ['answerCallbackQuery'], data);
  }
  assert.equal(tracks(h)[0].status, 'draft');
});
