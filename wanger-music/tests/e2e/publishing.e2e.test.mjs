// Phase 6 end to end. Done when: with one channel enabled and auto-publish on, a newly activated
// matching track is posted exactly once; with approval on, it waits for the owner; a wrong-language
// track never reaches that channel; a simulated 429 or permanent error behaves as in spec 10.6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, setClock, OWNER } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const FLOW = -1004391543350; // Persian
const BEAT = -1004370326177; // English
const ADMIN = 222;
let seq = 0;

/** Registers a destination through the real screens and sets it up. */
async function channel(h, chatId, { approval = false, enabled = true, auto = true, format } = {}) {
  if (!h.tg.channels.has(chatId)) h.tg.addChannel({ id: chatId, username: chatId === FLOW ? 'WangerFlow' : 'WangerBeat', title: chatId === FLOW ? 'WangerFlow' : 'WangerBeat' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${chatId}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', chatId).id;
  if (!approval) await h.pressLast(OWNER, `dst:appr:${id}`);
  if (format) await h.pressLast(OWNER, `dst:fmt:${id}`);
  if (enabled) await h.pressLast(OWNER, `dst:tog:${id}`);
  if (auto) await h.pressLast(OWNER, `dst:auto:${id}`);
  return id;
}

/** Imports and activates a track as the owner. @returns the track row */
async function track(h, title, performer, { activate = true, duration = 200 } = {}) {
  seq += 1;
  advance(61);
  await h.send(OWNER, null, { audio: { file_id: `F${seq}`, file_unique_id: `U${seq}`, duration: duration + seq, title, performer, file_name: 'x.mp3' } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  if (activate) await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}
const pubs = (h) => h.q('SELECT * FROM publications ORDER BY id');
const posts = (h, chatId) => h.tg.calls.filter((c) => c.result && ['sendAudio', 'sendPhoto'].includes(c.method) && c.params.chat_id === chatId);
const tick = async (h, seconds = 61) => { advance(seconds); return h.opsTick(OWNER); };

test('done when: a newly activated matching track is posted exactly once', async () => {
  const h = setup();
  await channel(h, FLOW);
  const tr = await track(h, 'دلم تنگه', 'شادمهر عقیلی');
  assert.equal(pubs(h).length, 1, 'routed to the one matching channel');
  for (let i = 0; i < 4; i++) await tick(h, 700);
  const sent = posts(h, FLOW);
  assert.equal(sent.length, 1, 'posted exactly once');
  assert.equal(sent[0].params.audio, tr.audio_file_id);
  assert.match(sent[0].params.caption, /^🎵 دلم تنگه\n👤 شادمهر عقیلی\n⏱ \d+:\d\d$/, 'default caption, empty album line dropped');
  assert.equal(sent[0].params.parse_mode, 'HTML');
  const p = pubs(h)[0];
  assert.deepEqual([p.status, p.telegram_message_id, p.attempt_count], ['published', sent[0].result.message_id, 1]);
  assert.ok(h.one('SELECT last_published_at FROM destination_channels WHERE chat_id = ?', FLOW).last_published_at > 0);
  // re-activation can't post it again
  await h.press(OWNER, `trk:hide:${tr.id}`, 1);
  await h.press(OWNER, `trk:act:${tr.id}`, 1);
  await tick(h, 700);
  assert.equal(pubs(h).length, 1, 'one publication per (track, channel)');
  assert.equal(posts(h, FLOW).length, 1);
});

test('a wrong-language track never reaches the channel; disabled / auto-publish-off channels get nothing', async () => {
  const h = setup();
  await channel(h, FLOW);
  await channel(h, BEAT, { enabled: false, auto: false });
  await track(h, 'Blinding Lights', 'The Weeknd'); // English: not for WangerFlow; WangerBeat is disabled
  await tick(h, 700);
  assert.deepEqual(pubs(h), []);
  assert.deepEqual(posts(h, FLOW), []);
  assert.deepEqual(posts(h, BEAT), []);
  const beat = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', BEAT).id;
  await h.pressLast(OWNER, `dst:tog:${beat}`); // enabled, but auto-publish still off
  await track(h, 'Hello', 'Adele');
  await tick(h, 700);
  assert.deepEqual(pubs(h), [], 'auto-publish off → nothing');
});

test('approval on: the track waits; a digest goes to reviewers; approve → posted; reject → never; two reviewers can’t both decide', async () => {
  const h = setup();
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, String(ADMIN));
  await channel(h, FLOW, { approval: true });
  const a = await track(h, 'دلم تنگه', 'شادمهر');
  const b = await track(h, 'بی تو', 'ابی');
  await tick(h, 700);
  assert.deepEqual(pubs(h).map((p) => p.status), ['pending_approval', 'pending_approval']);
  assert.deepEqual(posts(h, FLOW), [], 'waits for the owner');
  const digests = () => h.tg.calls.filter((c) => c.method === 'sendMessage' && /منتظر تأیید هستن/.test(c.params.text));
  assert.deepEqual(digests().map((c) => c.params.chat_id).sort(), [OWNER, ADMIN].sort(), 'one digest per reviewer');
  await tick(h, 120);
  assert.equal(digests().length, 2, 'throttled by digest.interval_seconds');

  await h.tap(OWNER, 'apr:next:0');
  const review = h.tg.callsOf('sendAudio', OWNER).at(-1);
  assert.equal(review.params.audio, a.audio_file_id, 'the audio by file_id');
  assert.match(review.params.caption, /^🎵 دلم تنگه/, 'with the channel’s rendered caption');
  assert.match(h.lastText(OWNER), /📢 کانال: WangerFlow/);
  const [pa, pb] = pubs(h);
  await h.tap(OWNER, `apr:ok:${pa.id}`);
  assert.equal(h.one('SELECT status, decided_by FROM publications WHERE id = ?', pa.id).status, 'queued');
  const mark = h.mark();
  await h.press(ADMIN, `apr:ok:${pa.id}`, 1);
  assert.match(h.tg.answers(mark).at(-1).text, /یکی دیگه زودتر رسیدگی کرده/);
  assert.match(h.lastText(ADMIN), /توسط User5557901897/, 'the second reviewer sees who handled it');
  await h.press(ADMIN, `apr:no:${pb.id}`, 1);
  assert.equal(h.one('SELECT status FROM publications WHERE id = ?', pb.id).status, 'rejected');
  await tick(h, 700);
  await tick(h, 700);
  assert.deepEqual(posts(h, FLOW).map((c) => c.params.audio), [a.audio_file_id], 'approved one posted, rejected one never');
  assert.equal(b.status, 'active');
});

test('language confidence below the channel minimum → approval even when approval is off', async () => {
  const h = setup();
  await channel(h, BEAT); // English, approval off, min confidence medium
  await track(h, 'Hello', 'Adele'); // Latin only → en, LOW confidence
  assert.deepEqual(pubs(h).map((p) => p.status), ['pending_approval']);
});

test('no backfill: tracks activated before the channel was enabled are not queued — until the owner backfills', async () => {
  const h = setup();
  const t1 = await track(h, 'دلم تنگه', 'شادمهر');
  const t2 = await track(h, 'بی تو', 'ابی');
  const id = await channel(h, FLOW);
  await tick(h, 700);
  assert.deepEqual(pubs(h), [], 'no automatic backfill');
  await h.pressLast(OWNER, `pub:bf:${id}`);
  assert.match(h.lastText(OWNER), /۲ آهنگ فعال با قوانین این کانال جور هستن/);
  assert.equal(pubs(h).length, 0, 'the preview writes nothing');
  await h.pressLast(OWNER, `pub:bfok:${id}`);
  assert.deepEqual(pubs(h).map((p) => [p.track_id, p.status]).sort(), [[t1.id, 'queued'], [t2.id, 'queued']].sort());
  await h.pressLast(OWNER, `pub:bf:${id}`);
  assert.match(h.lastText(OWNER), /۰ آهنگ فعال/, 'a second backfill finds nothing (no duplicates)');
  await tick(h, 700);
  await tick(h, 700);
  assert.equal(posts(h, FLOW).length, 2);
});

test('429: back to the queue after retry_after, global cooldown, the attempt not counted; then posted', async () => {
  const h = setup();
  await channel(h, FLOW);
  await track(h, 'دلم تنگه', 'شادمهر');
  h.tg.failNext('sendAudio', 429, 'Too Many Requests: retry after 120', { parameters: { retry_after: 120 }, match: (p) => p.chat_id === FLOW });
  await tick(h, 700);
  let p = pubs(h)[0];
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual([p.status, p.attempt_count], ['queued', 0]);
  assert.ok(p.next_attempt_at >= now + 119 && p.next_attempt_at <= now + 121);
  assert.ok(Number(h.one("SELECT value FROM settings WHERE key = 'telegram.cooldown_until'").value) >= now + 119, 'global cooldown');
  await tick(h, 30);
  assert.equal(pubs(h)[0].status, 'queued', 'not sooner than retry_after');
  await tick(h, 100);
  p = pubs(h)[0];
  assert.equal(p.status, 'published');
  assert.equal(posts(h, FLOW).length, 1);
});

test('transient errors: exponential backoff with jitter; after 6 attempts → failed', async () => {
  const h = setup();
  await channel(h, FLOW);
  await track(h, 'دلم تنگه', 'شادمهر');
  h.tg.failNext('sendAudio', 502, 'Bad Gateway', { times: 10, match: (p) => p.chat_id === FLOW });
  const expectMinutes = [1, 2, 4, 8, 16];
  for (let i = 0; i < 5; i++) {
    await tick(h, 4000);
    const p = pubs(h)[0];
    const wait = p.next_attempt_at - Math.floor(Date.now() / 1000);
    assert.equal(p.status, 'queued');
    assert.equal(p.attempt_count, i + 1);
    assert.ok(wait >= expectMinutes[i] * 60 * 0.8 - 1 && wait <= expectMinutes[i] * 60 * 1.2 + 1, `attempt ${i + 1}: ${wait}s`);
  }
  await tick(h, 4000);
  assert.deepEqual([pubs(h)[0].status, pubs(h)[0].attempt_count], ['failed', 6]);
  assert.deepEqual(posts(h, FLOW), []);
});

test('a permanent channel error fails the post, disables the channel and alerts the owner', async () => {
  const h = setup();
  await channel(h, FLOW);
  await track(h, 'دلم تنگه', 'شادمهر');
  h.tg.failNext('sendAudio', 400, 'Bad Request: not enough rights to send audios to the chat', { match: (p) => p.chat_id === FLOW });
  await tick(h, 700);
  assert.equal(pubs(h)[0].status, 'failed');
  const ch = h.one('SELECT enabled, bot_rights_ok, publishing_since FROM destination_channels WHERE chat_id = ?', FLOW);
  assert.deepEqual({ ...ch }, { enabled: 0, bot_rights_ok: 0, publishing_since: null });
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /کانال غیرفعال شد/.test(c.params.text)));
  await track(h, 'بی تو', 'ابی');
  assert.equal(pubs(h).length, 1, 'a disabled channel gets nothing new');
});

test('a broken file fails the post and hides the track; a refused caption alerts the owner', async () => {
  const h = setup();
  await channel(h, FLOW);
  const tr = await track(h, 'دلم تنگه', 'شادمهر');
  h.tg.failNext('sendAudio', 400, 'Bad Request: wrong file identifier/HTTP URL specified', { match: (p) => p.chat_id === FLOW });
  await tick(h, 700);
  assert.equal(pubs(h)[0].status, 'failed');
  assert.equal(h.one('SELECT status FROM tracks WHERE id = ?', tr.id).status, 'hidden');
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /توسط تلگرام قبول نشد/.test(c.params.text)));
  await track(h, 'بی تو', 'ابی');
  h.tg.failNext('sendAudio', 400, "Bad Request: can't parse entities: unexpected end tag", { match: (p) => p.chat_id === FLOW });
  await tick(h, 700);
  assert.equal(pubs(h)[1].status, 'failed');
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /کپشن کانال «WangerFlow» رو تلگرام قبول نکرد/.test(c.params.text)));
  assert.equal(h.one('SELECT enabled FROM destination_channels WHERE chat_id = ?', FLOW).enabled, 1, 'a caption problem does not disable the channel');
});

test('at most once: an expired sending lease becomes uncertain; the owner marks it published or sends it again', async () => {
  const h = setup();
  await channel(h, FLOW);
  await track(h, 'دلم تنگه', 'شادمهر');
  await track(h, 'بی تو', 'ابی');
  const [p1, p2] = pubs(h);
  const before = posts(h, FLOW).length; // a piggyback tick may already have posted the first one
  const now = Math.floor(Date.now() / 1000);
  h.db().prepare("UPDATE publications SET status = 'sending', locked_until = ? WHERE id IN (?, ?)").run(now - 1, p1.id, p2.id); // a crashed send
  await tick(h, 1);
  assert.deepEqual(pubs(h).map((p) => p.status), ['uncertain', 'uncertain']);
  assert.equal(posts(h, FLOW).length, before, 'never re-sent automatically');
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((c) => /انتشار نامطمئن/.test(c.params.text)));
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'apr:home');
  await h.tap(OWNER, 'pub:ls:uncertain');
  await h.tap(OWNER, `pub:v:${p1.id}`);
  assert.match(h.lastText(OWNER), /هیچ‌وقت خودش دوباره نمی‌فرسته/);
  await h.tap(OWNER, `pub:mark:${p1.id}`);
  await h.pressLast(OWNER, `pub:resend:${p2.id}`);
  assert.deepEqual(pubs(h).map((p) => p.status), ['published', 'queued']);
  await tick(h, 700);
  assert.equal(posts(h, FLOW).length, before + 1, 'only the re-sent one is posted');
});

test('schedule: minimum interval, active hours, daily limit', async () => {
  const h = setup();
  setClock('2026-11-05T06:00:00Z'); // 09:30 in Tehran: the whole test stays inside one local day
  const id = await channel(h, FLOW);
  await h.pressLast(OWNER, `dst:daily:${id}`);
  await h.send(OWNER, '2');
  for (const [t1, a1] of [['یک', 'الف'], ['دو', 'ب'], ['سه', 'پ']]) await track(h, t1, a1);
  await tick(h, 1);
  assert.equal(posts(h, FLOW).length, 1);
  await tick(h, 300);
  assert.equal(posts(h, FLOW).length, 1, 'within the 10-minute interval');
  await tick(h, 301);
  assert.equal(posts(h, FLOW).length, 2);
  await tick(h, 700);
  assert.equal(posts(h, FLOW).length, 2, 'daily limit 2');
  // active hours: allow only a window that excludes "now"
  const nowHour = new Date((Math.floor(Date.now() / 1000) + 12600) * 1000).getUTCHours();
  const from = (nowHour + 2) % 24;
  await h.pressLast(OWNER, `dst:v:${id}`);
  await h.pressLast(OWNER, `dst:daily:${id}`);
  await h.send(OWNER, '0');
  await h.pressLast(OWNER, `dst:hours:${id}`);
  await h.send(OWNER, `${from}-${(from + 1) % 24}`);
  await tick(h, 700);
  assert.equal(posts(h, FLOW).length, 2, 'outside the active hours');
});

test('cover_then_audio: the cover first, then the audio; an audio failure removes the lone cover', async () => {
  const h = setup();
  await channel(h, FLOW, { format: true });
  const tr = await track(h, 'دلم تنگه', 'شادمهر');
  await h.press(OWNER, `trk:cover:${tr.id}`, 1);
  await h.send(OWNER, null, { photo: [{ file_id: 'COVER1', width: 640, height: 640 }] });
  h.tg.failNext('sendAudio', 502, 'Bad Gateway', { match: (p) => p.chat_id === FLOW });
  await tick(h, 700);
  assert.equal(h.tg.callsOf('deleteMessage', FLOW).length, 1, 'the lone cover was deleted');
  await tick(h, 200);
  const sent = posts(h, FLOW).map((c) => c.method);
  assert.deepEqual(sent, ['sendPhoto', 'sendPhoto', 'sendAudio']);
  const p = pubs(h)[0];
  assert.equal(p.status, 'published');
  assert.ok(p.cover_message_id > 0);
});

test('removal cancels waiting publications; «delete channel posts» deletes the published ones; history is visible', async () => {
  const h = setup();
  const id = await channel(h, FLOW);
  const a = await track(h, 'دلم تنگه', 'شادمهر');
  await tick(h, 700);
  const b = await track(h, 'بی تو', 'ابی');
  assert.deepEqual(pubs(h).map((p) => p.status), ['published', 'queued']);
  await h.press(OWNER, `trk:rmok:${b.id}`, 1);
  assert.equal(pubs(h)[1].status, 'cancelled');
  await h.press(OWNER, `trk:rmok:${a.id}`, 1);
  await h.press(OWNER, `trk:v:${a.id}`, 1);
  assert.match(h.lastText(OWNER), /📤 انتشار در کانال‌ها:\n✅ WangerFlow: منتشر شد/);
  await h.pressLast(OWNER, `pub:del:${a.id}`);
  await h.pressLast(OWNER, `pub:delok:${a.id}`);
  assert.match(h.lastText(OWNER), /۱ پست پاک شد · ۰ ناموفق/);
  assert.equal(h.tg.callsOf('deleteMessage', FLOW).at(-1).params.message_id, pubs(h)[0].telegram_message_id);
  assert.ok(pubs(h)[0].deleted_at > 0);
  await h.pressLast(OWNER, `pub:ch:${id}:0`);
  assert.match(h.lastText(OWNER), /انتشار<\/b>[\s\S]*✖️ بی تو — ابی[\s\S]*✅ دلم تنگه — شادمهر.*🧹/, 'newest first; deleted posts marked 🧹');
  await tick(h, 700);
  assert.equal(posts(h, FLOW).length, 1);
});

test('the pause switch stops all publishing; purge deletes a track’s publications first', async () => {
  const h = setup();
  await channel(h, FLOW);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:publishing.paused');
  const tr = await track(h, 'دلم تنگه', 'شادمهر');
  await tick(h, 700);
  assert.deepEqual(posts(h, FLOW), []);
  assert.equal(pubs(h)[0].status, 'queued');
  await h.press(OWNER, `trk:rmok:${tr.id}`, 1);
  await h.press(OWNER, `trk:purgeok:${tr.id}`, 1);
  assert.deepEqual(pubs(h), [], 'children first (no foreign keys)');
  assert.ok(buttons(h.tg.lastTo(OWNER)).length >= 0);
});

test('a claimed publication whose track left the catalog meanwhile is cancelled, not failed', async () => {
  const h = setup();
  await channel(h, FLOW);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:publishing.paused'); // hold the queue
  const tr = await track(h, 'دلم تنگه', 'شادمهر');
  assert.equal(pubs(h)[0].status, 'queued');
  h.db().prepare("UPDATE tracks SET status = 'hidden' WHERE id = ?").run(tr.id); // hidden behind the service's back (a race)
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:publishing.paused'); // resume
  await tick(h, 700);
  assert.deepEqual([pubs(h)[0].status, pubs(h)[0].last_error], ['cancelled', 'track no longer active']);
  assert.deepEqual(posts(h, FLOW), []);
});
