// The owner, 2026-11-23: "both channels get everything — the song's language shouldn't matter".
// Plus the quick wins asked for at the same time: buttons under posts, hashtags, the file's
// quality, a promo line every N posts, and a daily report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, setClock, OWNER } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';
import { mp3WithCover, jpeg } from '../helpers/audio-files.mjs';

const FLOW = -1004391543350;
const BEAT = -1004370326177;
const SRC = -1003300000001;
const chat = { id: SRC, title: 'Archive music', username: 'ArchiveMusic' };
let seq = 0;

/** A suggested channel, enabled, auto-publish on, no approval; `every`: «🌍 every language». */
async function channel(h, chatId, { every = true } = {}) {
  h.tg.addChannel({ id: chatId, username: chatId === FLOW ? 'WangerFlow' : 'WangerBeat', title: chatId === FLOW ? 'WangerFlow' : 'WangerBeat' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${chatId}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', chatId).id;
  for (const a of ['appr', 'tog', 'auto']) await h.pressLast(OWNER, `dst:${a}:${id}`);
  if (every) {
    await h.tap(OWNER, `dst:langs:${id}`);
    await h.tap(OWNER, `dst:tla:${id}`);
  }
  return id;
}

async function source(h) {
  h.tg.addChannel({ id: SRC, username: 'ArchiveMusic', title: 'Archive music' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, '@ArchiveMusic');
  h.db().prepare("UPDATE sources SET auto_import = 'active'").run();
}

/** A source post; `bytes`: the audio file (else the fake's plain MP3). */
async function post(h, title, performer, { bytes = null, size = 4_800_000, duration = 300 } = {}) {
  seq += 1;
  advance(30);
  if (bytes) h.tg.files.set(`E${seq}`, bytes);
  await h.channelPost(chat, { audio: { file_id: `E${seq}`, file_unique_id: `EU${seq}`, duration, title, performer, file_name: 'x.mp3', file_size: size } });
  return h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
}
const routed = (h, chatId) => h.q('SELECT t.title FROM publications p JOIN destination_channels d ON d.id = p.channel_id JOIN tracks t ON t.id = p.track_id WHERE d.chat_id = ? ORDER BY p.id', chatId).map((r) => r.title);
const audios = (h, chatId) => h.tg.callsOf('sendAudio', chatId).filter((c) => c.result);

test('«🌍 every language» on both channels: Persian, English and undecided songs go to both, with no language questions', async () => {
  const h = setup({ autoSend: false });
  const flow = await channel(h, FLOW);
  await channel(h, BEAT);
  assert.match(h.lastButtons(OWNER)[0].text, /^✅ 🌍 همه‌ی زبان‌ها/);
  assert.ok(!h.lastButtons(OWNER).some((b) => b.callback_data.startsWith('dst:tl:')), 'the per-language buttons are hidden');
  await source(h);
  await post(h, 'دلم تنگه', 'شادمهر');
  await post(h, 'Lucky Boyz', 'Mersad'); // Latin letters: undecided
  await post(h, 'Shape of You', 'Ed Sheeran');
  assert.deepEqual(routed(h, FLOW), ['دلم تنگه', 'Lucky Boyz', 'Shape of You']);
  assert.deepEqual(routed(h, BEAT), ['دلم تنگه', 'Lucky Boyz', 'Shape of You']);
  assert.deepEqual(h.q('SELECT DISTINCT status FROM publications').map((r) => r.status), ['queued'], 'no approval for an uncertain language');
  assert.equal(h.tg.callsOf('sendMessage', OWNER).filter((c) => /زبان منبع/.test(c.params.text)).length, 0, 'no source-language question');
  const note = h.tg.callsOf('sendMessage', OWNER).filter((c) => /آهنگ جدید از/.test(c.params.text)).at(-1);
  assert.doesNotMatch(note.params.text, /زبان/, 'the new-song message drops the language line…');
  assert.ok(!buttons(note.params).some((b) => b.callback_data.startsWith('nt:lang:')), '…and its buttons');
  const r = await h.opsTick(OWNER);
  assert.ok(!r.result.results.monitor.warnings.includes('no_language'));
  assert.deepEqual(r.result.results.languages, { skipped: 'any_language' });
  // the card and the list say so; switching it off brings the language choice back
  await h.press(OWNER, `dst:v:${flow}`, 1);
  assert.match(h.lastText(OWNER), /زبان: همه‌ی زبان‌ها/);
  await h.tap(OWNER, `dst:langs:${flow}`);
  await h.tap(OWNER, `dst:tla:${flow}`);
  assert.ok(h.lastButtons(OWNER).some((b) => b.callback_data === `dst:tl:${flow}:fa`));
});

test('under each post: «🎧 get it in the bot» and «📤 send to a friend» (a share link to the bot); off per channel', async () => {
  const h = setup({ autoSend: false });
  const id = await channel(h, FLOW);
  await source(h);
  const tr = await post(h, 'بی تو', 'ابی');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'pub:sendq');
  const [m] = audios(h, FLOW);
  const kb = m.params.reply_markup.inline_keyboard[0];
  assert.equal(kb[0].url, `https://t.me/Wange_Musicbot?start=t_${tr.public_id}`);
  assert.match(kb[1].url, /^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2FWange_Musicbot%3Fstart%3Dt_/);
  // the deep link works for a channel member who opens it
  await h.press(OWNER, `dst:v:${id}`, 1);
  await h.tap(OWNER, `dst:pbtn:${id}`);
  assert.match(h.lastButtons(OWNER).find((b) => b.callback_data === `dst:pbtn:${id}`).text, /خاموش/);
  await post(h, 'گل یخ', 'کورosh');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'pub:sendq');
  assert.equal(audios(h, FLOW).at(-1).params.reply_markup, undefined);
});

test('the file\'s quality and hashtags in captions; a better copy of a song says so on its card', async () => {
  const h = setup({ autoSend: false });
  await channel(h, FLOW);
  await source(h);
  // 4.8 MB, 300 s, a 50 KB tag → (4.8 MB − tag) × 8 / 300 s ≈ 128 kbps
  await post(h, 'دلم تنگه', 'شادمهر عقیلی', { bytes: mp3WithCover([{ bytes: jpeg(500, 500, 50_000) }]), size: 4_850_000 });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'pub:sendq');
  assert.match(audios(h, FLOW)[0].params.caption, /⏱ 5:00\n🎚 128kbps\n\n#شادمهر_عقیلی\n\n🆔 @WangerFlow$/);
  // the same song again, at 320 kbps: the card compares
  advance(120);
  await h.send(OWNER, null, { audio: { file_id: 'HQ', file_unique_id: 'HQU', duration: 300, title: 'دلم تنگه', performer: 'شادمهر عقیلی', file_name: 'x.mp3', file_size: 12_000_000 } });
  assert.match(h.lastText(OWNER), /🎚 320kbps/);
  assert.match(h.lastText(OWNER), /این نسخه باکیفیت‌تر است \(320kbps در برابر 128kbps\)/);
});

test('a promo line on every 3rd post (owner-written, escaped), above the channel link; «-» removes it', async () => {
  const h = setup({ autoSend: false });
  const id = await channel(h, FLOW);
  await h.press(OWNER, `dst:v:${id}`, 1);
  await h.tap(OWNER, `dst:promo:${id}`);
  await h.send(OWNER, 'کانال دوم ما: @WangerBeat <3');
  assert.match(h.lastText(OWNER), /📣 خط تبلیغ \(هر ۳ پست\): کانال دوم ما: @WangerBeat &lt;3/);
  await source(h);
  for (let i = 0; i < 4; i++) await post(h, `Song ${i}`, 'Band');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'pub:sendq');
  const caps = audios(h, FLOW).map((c) => /کانال دوم ما/.test(c.params.caption));
  assert.deepEqual(caps, [false, false, true, false]);
  assert.match(audios(h, FLOW)[2].params.caption, /کانال دوم ما: @WangerBeat &lt;3\n🆔 @WangerFlow$/);
  await h.press(OWNER, `dst:v:${id}`, 1);
  await h.tap(OWNER, `dst:pev:${id}`);
  assert.equal(h.one('SELECT promo_every FROM destination_channels WHERE id = ?', id).promo_every, 5);
  await h.tap(OWNER, `dst:promo:${id}`);
  await h.send(OWNER, '-');
  assert.deepEqual([h.one('SELECT promo_text, promo_every FROM destination_channels WHERE id = ?', id)].map((r) => [r.promo_text, r.promo_every]), [[null, 0]]);
});

test('the daily report: once a day from 9:00 Tehran time, yesterday\'s numbers, off in ⚙️ Settings', async () => {
  const h = setup({ dailyReport: true });
  setClock('2026-11-23T03:00:00Z'); // 06:30 in Tehran
  await h.send(OWNER, '/start');
  const reports = () => h.tg.callsOf('sendMessage', OWNER).filter((c) => /گزارش دیروز/.test(c.params.text));
  assert.equal((await h.opsTick(OWNER)).result.results.report, 'early');
  setClock('2026-11-23T06:00:00Z'); // 09:30
  assert.equal((await h.opsTick(OWNER)).result.results.report, 'sent_now');
  assert.equal((await h.opsTick(OWNER)).result.results.report, 'sent');
  assert.equal(reports().length, 1);
  assert.match(reports()[0].params.text, /گزارش دیروز<\/b> \(۱۴۰۵\/۰۹\/۰۱\)\n👥 کاربران:/);
  assert.ok(buttons(reports()[0].params).some((b) => b.callback_data === 'set:e:report.daily'));
  setClock('2026-11-24T07:00:00Z');
  await h.opsTick(OWNER);
  assert.equal(reports().length, 2, 'the next day again');
  await h.press(OWNER, 'set:e:report.daily', 1);
  setClock('2026-11-25T07:00:00Z');
  assert.equal((await h.opsTick(OWNER)).result.results.report, 'off');
});
