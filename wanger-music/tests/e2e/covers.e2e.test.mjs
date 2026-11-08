// The cover photo of cover_then_audio posts (the owner: "the covers in the channel are blurry").
// Production, 2026-11-08: the covers the bot had were Telegram's audio thumbnails (2–6 KB), while
// the files carried 622–3000 px pictures. The worker now uploads the picture inside the audio file
// once and keeps that photo; files without a bigger picture keep the thumbnail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER } from '../helpers/harness.mjs';
import { jpeg, png, mp3WithCover } from '../helpers/audio-files.mjs';

const FLOW = -1004391543350;
let seq = 0;

async function coverChannel(h) {
  h.tg.addChannel({ id: FLOW, username: 'WangerFlow', title: 'WangerFlow' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${FLOW}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', FLOW).id;
  for (const a of ['appr', 'fmt', 'tog', 'auto']) await h.pressLast(OWNER, `dst:${a}:${id}`);
  return id;
}

/** A Persian track with Telegram's small thumbnail; `file` = the audio file's bytes (if any). */
async function track(h, file, { activate = true } = {}) {
  seq += 1;
  advance(61);
  if (file) h.tg.files.set(`CF${seq}`, file);
  await h.send(OWNER, null, { audio: { file_id: `CF${seq}`, file_unique_id: `CU${seq}`, duration: 200 + seq, title: `آهنگ ${seq}`, performer: 'شادمهر', file_name: 'x.mp3', thumbnail: { file_id: `THUMB_C${seq}`, file_unique_id: `TC${seq}`, width: 90, height: 90 } } });
  const tr = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  if (activate) await h.press(OWNER, `trk:act:${tr.id}`, 1);
  return tr;
}
const row = (h, id) => ({ ...h.one('SELECT cover_file_id, cover_source FROM tracks WHERE id = ?', id) });
const photos = (h, chat) => h.tg.callsOf('sendPhoto', chat).filter((c) => c.result);
const streams = (h) => h.tg.callsOf('getFileStream').length;
const send = async (h) => { await h.send(OWNER, '/admin'); await h.tap(OWNER, 'pub:sendq'); };

test('the full picture inside the audio file goes to the channel (not the 90 px thumbnail), uploaded once and kept', async () => {
  const h = setup({ autoSend: false });
  const id = await coverChannel(h);
  const cover = jpeg(1000, 1000, 6000);
  const tr = await track(h, mp3WithCover([{ bytes: cover }]));
  await send(h);
  const [photo] = photos(h, FLOW);
  assert.ok(photo, 'a cover was posted');
  assert.deepEqual(photo.params.photo.bytes, cover, 'the picture from the file, byte for byte');
  assert.equal(photo.params.photo.type, 'image/jpeg');
  assert.equal(h.tg.callsOf('sendAudio', FLOW).length, 1, 'then the audio');
  assert.deepEqual(row(h, tr.id), { cover_file_id: `PHb${photo.result.message_id}`, cover_source: 'file' });
  assert.equal(h.one('SELECT status FROM publications').status, 'published');

  // the kept photo is reused by id: the preview to the owner downloads nothing
  const before = streams(h);
  await h.press(OWNER, `dst:prev:${id}`, 1);
  assert.equal(h.tg.callsOf('sendPhoto', OWNER).at(-1).params.photo, `PHb${photo.result.message_id}`);
  assert.equal(streams(h), before);
});

test('the preview uploads the full picture first; the channel post then uses it by id (PNG covers too)', async () => {
  const h = setup({ autoSend: false });
  const id = await coverChannel(h);
  const cover = png(3000, 3000, 9000);
  const tr = await track(h, mp3WithCover([{ bytes: cover }], { version: 4 }));
  await h.press(OWNER, `dst:prev:${id}`, 1);
  const prev = h.tg.callsOf('sendPhoto', OWNER).at(-1);
  assert.deepEqual(prev.params.photo.bytes, cover);
  assert.equal(prev.params.photo.type, 'image/png');
  assert.equal(row(h, tr.id).cover_source, 'file');
  assert.deepEqual(photos(h, FLOW), [], 'the preview never goes to the channel');
  await send(h);
  assert.equal(photos(h, FLOW)[0].params.photo, row(h, tr.id).cover_file_id);
  assert.equal(streams(h), 1, 'the file was read once');
});

test('a file without a bigger picture keeps the thumbnail (uploaded as a photo) and is not read again', async () => {
  const h = setup({ autoSend: false });
  const id = await coverChannel(h);
  const tr = await track(h, mp3WithCover([{ bytes: jpeg(300, 300) }]));
  await send(h);
  const [photo] = photos(h, FLOW);
  assert.ok(photo.params.photo.bytes instanceof Uint8Array, 'the thumbnail\'s bytes');
  assert.deepEqual(row(h, tr.id), { cover_file_id: `PHb${photo.result.message_id}`, cover_source: 'thumb' });
  const before = streams(h);
  await h.press(OWNER, `dst:prev:${id}`, 1);
  assert.equal(streams(h), before);
});

test('a cover a person set is never replaced; a file Telegram won\'t hand out falls back to the thumbnail; a passing error retries next time', async () => {
  const h = setup({ autoSend: false });
  await coverChannel(h);
  const a = await track(h, mp3WithCover([{ bytes: jpeg(1000, 1000) }]), { activate: false });
  await h.press(OWNER, `trk:cover:${a.id}`, 1);
  await h.send(OWNER, null, { photo: [{ file_id: 'MANUAL', width: 1280, height: 1280 }] });
  await h.press(OWNER, `trk:act:${a.id}`, 1);
  await send(h);
  assert.equal(photos(h, FLOW)[0].params.photo, 'MANUAL');
  assert.equal(streams(h), 0);

  const b = await track(h, null);
  h.tg.failNext('getFileStream', 400, 'Bad Request: file is too big');
  advance(3600);
  await send(h);
  assert.equal(row(h, b.id).cover_source, 'thumb');
  assert.equal(h.tg.callsOf('sendAudio', FLOW).length, 2, 'the post went out with the thumbnail');

  const c = await track(h, mp3WithCover([{ bytes: jpeg(1000, 1000) }]));
  h.tg.failNext('getFileStream', 502, 'Bad Gateway');
  advance(3600);
  await send(h);
  assert.equal(row(h, c.id).cover_source, null, 'not marked: tried again next time');
  assert.equal(h.tg.callsOf('sendAudio', FLOW).length, 3);
});
