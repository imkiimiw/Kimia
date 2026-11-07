// Tracks whose language nobody decided never reach a channel (production, 2026-11-07: Persian songs
// titled in Latin letters, from sources without a default language). The bot now asks the owner once
// per source, applies the answer to the tracks already imported (and routes them), learns per artist,
// and warns about what is still stuck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const FLOW = -1004391543350;
const BEAT = -1004370326177;
const SRC = -1003300000001;
const chat = { id: SRC, title: 'Archive music', username: 'ArchiveMusic' };
let seq = 0;
const audio = (title, performer) => { seq += 1; return { audio: { file_id: `L${seq}`, file_unique_id: `LU${seq}`, duration: 150 + seq, title, performer, file_name: 'x.mp3' } }; };
const pubs = (h) => h.q('SELECT p.status, d.chat_id, t.title FROM publications p JOIN destination_channels d ON d.id = p.channel_id JOIN tracks t ON t.id = p.track_id ORDER BY p.id');
const prompts = (h) => h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER && /زبان منبع «Archive music»/.test(c.params.text));

async function channel(h, chatId) {
  h.tg.addChannel({ id: chatId, username: chatId === FLOW ? 'WangerFlow' : 'WangerBeat', title: chatId === FLOW ? 'WangerFlow' : 'WangerBeat' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${chatId}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', chatId).id;
  await h.pressLast(OWNER, `dst:appr:${id}`);
  await h.pressLast(OWNER, `dst:tog:${id}`);
  await h.pressLast(OWNER, `dst:auto:${id}`);
  return id;
}

async function activeSource(h) {
  h.tg.addChannel({ id: SRC, username: 'ArchiveMusic', title: 'Archive music' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, '@ArchiveMusic');
  const src = h.one('SELECT * FROM sources WHERE chat_id = ?', SRC);
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, `src:v:${src.id}`);
  await h.tap(OWNER, `src:mode:${src.id}`); // draft → active
  return src;
}

test('the production case: Latin-titled Persian songs from a source without a language are stuck → one question → one tap → published to @WangerFlow', async () => {
  const h = setup();
  await channel(h, FLOW);
  await channel(h, BEAT);
  await activeSource(h);
  for (const [t, a] of [['Halam Khoob Nist Maman', 'Tiem'], ['Lucky Boyz', 'Mersad'], ['Before You Gone', 'Ashkan Kagan']]) {
    advance(30);
    assert.equal((await h.channelPost(chat, audio(t, a))).result, 'active');
  }
  assert.equal(h.one("SELECT count(*) AS n FROM tracks WHERE status = 'active' AND language = 'unknown'").n, 3);
  assert.deepEqual(pubs(h), [], 'no language → no channel (the reported problem)');
  assert.equal(prompts(h).length, 1, 'the owner is asked once, not per track');
  const prompt = prompts(h)[0];
  assert.deepEqual(buttons(prompt.params).map((b) => b.text), ['🇮🇷 فارسی', '🇬🇧 انگلیسی', '🌍 دیگر', '🔀 مخلوط (خودم تک‌تک تعیین می‌کنم)']);

  const fa = buttons(prompt.params).find((b) => b.text === '🇮🇷 فارسی');
  await h.press(OWNER, fa.callback_data, prompt.result.message_id);
  assert.match(h.lastText(OWNER), /زبان منبع «Archive music»: فارسی\n۳ آهنگ به‌روز شد و ۳ پست در صف انتشار کانال‌ها رفت/);
  assert.equal(h.one('SELECT default_language FROM sources WHERE chat_id = ?', SRC).default_language, 'fa');
  assert.deepEqual(h.q('SELECT DISTINCT language, language_confidence, language_source FROM tracks').map((r) => ({ ...r })), [{ language: 'fa', language_confidence: 'high', language_source: 'source' }]);
  assert.deepEqual(pubs(h).map((p) => [p.chat_id, p.status]), [[FLOW, 'queued'], [FLOW, 'queued'], [FLOW, 'queued']], 'all to the Persian channel, none to the English one');
  for (let i = 0; i < 4; i++) { advance(700); await h.opsTick(OWNER); }
  const sent = h.tg.calls.filter((c) => c.method === 'sendAudio' && c.params.chat_id === FLOW);
  assert.equal(sent.length, 3);
  assert.match(sent[0].params.caption, /\n\n🆔 @WangerFlow$/);
  assert.equal(h.tg.calls.filter((c) => c.method === 'sendAudio' && c.params.chat_id === BEAT).length, 0);

  // from now on the source decides: a new post is Persian at once, no question
  advance(30);
  await h.channelPost(chat, audio('Tane To', 'Pidar'));
  assert.equal(h.one('SELECT language FROM tracks ORDER BY id DESC LIMIT 1').language, 'fa');
  assert.equal(prompts(h).length, 1);
});

test('sources already stuck before this fix are asked from the tick (every 12 h at most); «mixed» changes nothing', async () => {
  const h = setup();
  await channel(h, FLOW);
  await activeSource(h);
  await h.channelPost(chat, audio('Derakht', 'Tqvis'));
  await h.channelPost(chat, audio('Miresam', 'Young Sudden'));
  assert.equal(prompts(h).length, 1);
  advance(3600);
  let r = await h.opsTick(OWNER);
  assert.deepEqual(r.result.results.languages, { asked: 0 }, 'throttled');
  advance(12 * 3600);
  r = await h.opsTick(OWNER);
  assert.deepEqual(r.result.results.languages, { asked: 1 });
  const again = prompts(h).at(-1);
  assert.match(again.params.text, /۲ آهنگ از این منبع زبان مشخصی ندارند/);
  const mix = buttons(again.params).find((b) => b.callback_data.endsWith(':mix'));
  await h.press(OWNER, mix.callback_data, again.result.message_id);
  assert.match(h.lastText(OWNER), /زبان پیش‌فرض ندارد/);
  assert.equal(h.one('SELECT default_language FROM sources').default_language, null);
  assert.equal(h.one("SELECT count(*) AS n FROM tracks WHERE language = 'unknown'").n, 2);
});

test('setting one track\'s language teaches the artist\'s other undecided tracks (and routes them); a person\'s choice is never overwritten', async () => {
  const h = setup();
  await channel(h, FLOW);
  await activeSource(h);
  await h.channelPost(chat, audio('Bassame', 'Pidar'));
  await h.channelPost(chat, audio('Tane To', 'Pidar'));
  await h.channelPost(chat, audio('Girim', 'Dalu'));
  const [a, b, c] = h.q('SELECT id FROM tracks ORDER BY id').map((r) => r.id);
  await h.press(OWNER, `trk:setl:${c}:en`, 1); // a person decided Dalu's track
  await h.press(OWNER, `trk:setl:${a}:fa`, 1);
  assert.match(h.tg.answers().at(-1).text, /۱ آهنگ دیگر از همین خواننده هم تنظیم شد/);
  assert.deepEqual(h.q('SELECT id, language, language_source FROM tracks ORDER BY id').map((r) => [r.id, r.language, r.language_source]), [[a, 'fa', 'manual'], [b, 'fa', 'artist'], [c, 'en', 'manual']]);
  assert.deepEqual(pubs(h).map((p) => p.title).sort(), ['Bassame', 'Tane To'], 'both of Pidar\'s tracks go to the Persian channel');
  // the source's language later doesn't override decisions
  const src = h.one('SELECT id FROM sources').id;
  await h.press(OWNER, `src:dl:${src}:fa`, 1);
  assert.equal(h.one('SELECT language FROM tracks WHERE id = ?', c).language, 'en');
});

test('stuck tracks show on System Status and alert the owner (≤ 1 per 3 h); an English default never overrides a Persian-script guess', async () => {
  const h = setup();
  await activeSource(h);
  await h.channelPost(chat, audio('Lucky Boyz', 'Mersad'));
  await h.channelPost(chat, audio('دلم تنگه', 'شادمهر'));
  const r = await h.opsTick(OWNER);
  assert.ok(r.result.results.monitor.warnings.includes('no_language'));
  assert.ok(h.tg.callsOf('sendMessage', OWNER).some((m) => /۱ آهنگ فعال زبان مشخصی ندارند/.test(m.params.text)));
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  assert.match(h.lastText(OWNER), /آهنگ فعال زبان مشخصی ندارند/);
  const src = h.one('SELECT id FROM sources').id;
  await h.press(OWNER, `src:dl:${src}:en`, 1);
  assert.deepEqual(h.q('SELECT title, language FROM tracks ORDER BY id').map((x) => [x.title, x.language]), [['Lucky Boyz', 'en'], ['دلم تنگه', 'fa']]);
  assert.ok(!(await h.opsTick(OWNER)).result.results.monitor.warnings.includes('no_language'));
});
