// Batch 3 of the owner's ideas (2026-11-23): 🧹 clean files (other channels' tags replaced on the
// first post), ❤️ reactions on channel posts, 🔥 the weekly chart and 🗳 the next-song poll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';
import { jpeg, mp3WithCover, m4aWithCover } from '../helpers/audio-files.mjs';
import { scanCover } from '../../tgcloud/lib/music/artwork.js';

const FLOW = -1004391543350;
const BEAT = -1004370326177;
const U = 111;
let seq = 0;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
const latin1 = (b) => String.fromCharCode(...b.subarray(0, Math.min(b.length, 4000)));

async function channel(h, chatId) {
  h.tg.addChannel({ id: chatId, username: chatId === FLOW ? 'WangerFlow' : 'WangerBeat', title: chatId === FLOW ? 'WangerFlow' : 'WangerBeat' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${chatId}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', chatId).id;
  for (const a of ['appr', 'tog', 'auto']) await h.pressLast(OWNER, `dst:${a}:${id}`);
  await h.tap(OWNER, `dst:langs:${id}`);
  await h.tap(OWNER, `dst:tla:${id}`);
  return id;
}

/** An owner import (activated); `bytes` = the audio file; `thumb` = a thumbnail file the bot can download. */
async function song(h, title, performer, { bytes = null, thumb = null, name = 'x.mp3' } = {}) {
  seq += 1;
  advance(61);
  if (bytes) h.tg.files.set(`EF${seq}`, bytes);
  if (thumb) h.tg.files.set(`TH${seq}`, thumb);
  await h.send(OWNER, null, { audio: { file_id: `EF${seq}`, file_unique_id: `EU${seq}`, duration: 200, title, performer, file_name: name, mime_type: 'audio/mpeg', file_size: bytes ? bytes.length : 1000, ...(thumb ? { thumbnail: { file_id: `TH${seq}`, file_unique_id: `THU${seq}`, width: 90, height: 90 } } : {}) } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}
const sendQueue = async (h) => { await h.send(OWNER, '/admin'); await h.tap(OWNER, 'pub:sendq'); };
const audios = (h, chat) => h.tg.callsOf('sendAudio', chat).filter((c) => c.result);

test('🧹 the first post re-uploads the MP3 with clean tags (no other channel inside), with its cover and thumbnail; later posts reuse it', async () => {
  const h = setup({ autoSend: false });
  await channel(h, FLOW);
  await channel(h, BEAT);
  const cover = jpeg(1000, 1000, 4000);
  // the "dirty" file: an ad in its title frame, and an ID3v1 tag at the end
  const dirty = mp3WithCover([{ bytes: cover }], { audio: 60000 });
  const ad = new TextEncoder().encode('TAG' + 'Download @OtherMusicChannel'.padEnd(125, ' '));
  const file = new Uint8Array(dirty.length + 128);
  file.set(dirty);
  file.set(ad, dirty.length);
  const tr = await song(h, 'بی تو', 'شادمهر عقیلی', { bytes: file, thumb: jpeg(90, 90, 900) });
  await sendQueue(h);
  const [first] = audios(h, FLOW);
  const up = first.params.audio;
  assert.ok(up.bytes instanceof Uint8Array, 'uploaded, not sent by id');
  assert.equal(up.name, 'شادمهر عقیلی - بی تو.mp3');
  assert.deepEqual([first.params.title, first.params.performer], ['بی تو', 'شادمهر عقیلی']);
  assert.ok(first.params.thumbnail && first.params.thumbnail.bytes.length === 900, 'the ≤ 320 px thumbnail goes along');
  assert.equal(first.params.caption.includes('🆔 @WangerFlow'), true, 'caption and buttons as usual');
  assert.ok(first.params.reply_markup);
  // the new file: a fresh ID3v2.3 tag (UTF-16 title), the same audio frames, no ID3v1 ad, the cover kept
  assert.deepEqual([...up.bytes.subarray(0, 4)], [0x49, 0x44, 0x33, 3]);
  assert.doesNotMatch(latin1(up.bytes) + new TextDecoder().decode(up.bytes.subarray(-200)), /OtherMusicChannel|TAG/);
  assert.equal(up.bytes.length < file.length, true);
  assert.deepEqual(scanCover(up.bytes).picture.bytes, cover);
  assert.deepEqual(up.bytes.subarray(-60000), dirty.subarray(-60000), 'audio frames untouched');
  const row = h.one('SELECT audio_file_id, cleaned FROM tracks WHERE id = ?', tr.id);
  assert.deepEqual([row.audio_file_id, row.cleaned], [first.result.audio.file_id, 1]);
  // the second channel (and everyone after) gets the clean copy by id
  const [second] = audios(h, BEAT);
  assert.equal(second.params.audio, first.result.audio.file_id);
});

test('🧹 not an MP3 → sent as it is (and not tried again); the setting turns it off', async () => {
  const h = setup({ autoSend: false });
  await channel(h, FLOW);
  const m4a = await song(h, 'Song', 'Band', { bytes: m4aWithCover(jpeg(600, 600)), name: 'x.m4a' });
  await sendQueue(h);
  assert.equal(audios(h, FLOW)[0].params.audio, m4a.audio_file_id);
  assert.equal(h.one('SELECT cleaned FROM tracks WHERE id = ?', m4a.id).cleaned, 2);
  h.db().prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('publishing.clean_files', 'false', 0, 0)").run();
  const mp3 = await song(h, 'Other', 'Band', { bytes: mp3WithCover([]) });
  await sendQueue(h);
  assert.equal(audios(h, FLOW)[1].params.audio, mp3.audio_file_id);
  assert.equal(h.one('SELECT cleaned FROM tracks WHERE id = ?', mp3.id).cleaned, 0);
});

test('❤️ reactions on channel posts are kept; «most liked posts» and 🔥 the weekly chart (preview first, one tap, once)', async () => {
  const h = setup({ autoSend: false });
  join(h, U);
  const id = await channel(h, FLOW);
  const a = await song(h, 'دلم تنگه', 'شادمهر عقیلی');
  const b = await song(h, 'پرواز', 'ابی');
  const c = await song(h, 'Lucky', 'Band');
  await sendQueue(h);
  const posts = audios(h, FLOW).map((x) => x.result.message_id);
  const r = await h.reaction({ id: FLOW, title: 'WangerFlow' }, posts[1], { '❤': 7, '🔥': 2 });
  assert.equal(r.result, 'saved');
  assert.equal((await h.reaction({ id: -1009999, title: 'x' }, 5, { '❤': 1 })).result, 'unknown_channel');
  assert.equal(h.one('SELECT reactions FROM publications WHERE telegram_message_id = ?', posts[1]).reactions, 9);
  await h.reaction({ id: FLOW }, posts[2], { '👍': 1 });
  // plays in the bot count too
  for (let i = 0; i < 3; i++) await h.send(U, `/start t_${a.public_id}`);
  await h.press(OWNER, `dst:v:${id}`, 1);
  await h.tap(OWNER, `eng:top:${id}`);
  assert.match(h.lastText(OWNER), /1\. پرواز — ابی — ❤️ ۹|۱\. پرواز — ابی — ❤️ ۹/);
  await h.press(OWNER, `eng:chart:${id}`, 1);
  const preview = h.tg.callsOf('sendMessage', OWNER).filter((x) => /آهنگ برتر این هفته/.test(x.params.text)).at(-1);
  assert.ok(preview, 'a preview to the owner');
  assert.match(preview.params.text, new RegExp(`۱\\. <a href="https://t.me/Wange_Musicbot\\?start=t_${b.public_id}">پرواز — ابی</a>\\n۲\\. <a href="https://t.me/Wange_Musicbot\\?start=t_${a.public_id}">`));
  assert.equal(h.tg.callsOf('sendMessage', FLOW).length, 0, 'nothing in the channel yet');
  await h.tap(OWNER, `eng:chok:${id}`);
  const sent = h.tg.callsOf('sendMessage', FLOW);
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.text, /🆔 @WangerFlow$/);
  assert.equal(buttons(sent[0].params)[0].url, 'https://t.me/Wange_Musicbot');
  await h.tap(OWNER, `eng:chok:${id}`);
  assert.equal(h.tg.callsOf('sendMessage', FLOW).length, 1, 'a second tap does nothing');
  void c;
});

test('🗳 a next-song poll over the queue; closing it posts the winner at once', async () => {
  const h = setup({ autoSend: false });
  const id = await channel(h, FLOW);
  await song(h, 'Song A', 'Band');
  const b = await song(h, 'Song B', 'Band');
  await song(h, 'Song C', 'Band');
  await h.press(OWNER, `dst:v:${id}`, 1);
  await h.tap(OWNER, `eng:poll:${id}`);
  const poll = h.tg.callsOf('sendPoll', FLOW)[0];
  assert.deepEqual(poll.params.options.map((o) => o.text), ['Song A — Band', 'Song B — Band', 'Song C — Band']);
  assert.equal(poll.params.question, '🗳 آهنگ بعدی کدام باشد؟');
  assert.equal(poll.params.is_anonymous, true);
  await h.press(OWNER, `eng:poll:${id}`, 1);
  assert.equal(h.tg.answers().at(-1).text, 'یک نظرسنجی باز است؛ اول آن را تمام کن.');
  h.tg.setPollVotes([1, 4, 2]);
  await h.tap(OWNER, `eng:pend:${id}`);
  assert.match(h.lastText(OWNER), /برنده ۴ رأی از ۷ آورد/);
  const out = audios(h, FLOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].params.audio, b.audio_file_id);
  assert.equal(h.one('SELECT poll FROM destination_channels WHERE id = ?', id).poll, null);
});
