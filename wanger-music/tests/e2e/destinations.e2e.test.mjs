// Phase 5 end to end. Done when: the owner can add the real channels, configure them and preview
// captions, and NOTHING gets posted to any channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const BEAT = -1004370326177;
const FLOW = -1004391543350;
const POSTING = ['sendMessage', 'sendAudio', 'sendPhoto', 'copyMessage', 'forwardMessage', 'sendMediaGroup'];
/** Bot API calls that would put something into a channel (negative chat ids). */
const channelPosts = (h) => h.tg.calls.filter((c) => POSTING.includes(c.method) && Number(c.params.chat_id) < 0);
const dest = (h, chatId) => h.one('SELECT * FROM destination_channels WHERE chat_id = ?', chatId);

function withRealChannels(h) {
  h.tg.addChannel({ id: BEAT, username: 'WangerBeat', title: 'WangerBeat' });
  h.tg.addChannel({ id: FLOW, username: 'WangerFlow', title: 'WangerFlow' });
}
async function openDestinations(h) {
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
}

test('the owner adds @WangerBeat (English) and @WangerFlow (Persian), configures them, and nothing is posted', async () => {
  const h = setup();
  withRealChannels(h);
  await openDestinations(h);
  assert.deepEqual(h.lastButtons(OWNER).map((b) => b.callback_data).filter((d) => d.startsWith('dst:sug:')), [`dst:sug:${BEAT}`, `dst:sug:${FLOW}`]);
  await h.tap(OWNER, `dst:sug:${BEAT}`);
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${FLOW}`);
  const beat = dest(h, BEAT);
  const flow = dest(h, FLOW);
  for (const d of [beat, flow]) assert.deepEqual([d.enabled, d.auto_publish, d.approval_required, d.bot_rights_ok, d.post_format, d.time_zone], [0, 0, 1, 1, 'audio', 'Asia/Tehran'], 'new channels: disabled, auto off, approval on');
  assert.deepEqual(JSON.parse(beat.rules).languages, ['en']);
  assert.deepEqual(JSON.parse(flow.rules).languages, ['fa']);
  assert.ok(h.tg.callsOf('getChatMember').some((c) => c.params.chat_id === BEAT), 'the bot’s rights were checked with Telegram');

  // configure WangerFlow completely
  const id = flow.id;
  await h.tap(OWNER, `dst:langs:${id}`);
  await h.tap(OWNER, `dst:tl:${id}:other`);
  await h.tap(OWNER, `dst:v:${id}`);
  await h.tap(OWNER, `dst:gen:${id}:inc`);
  await h.tap(OWNER, `dst:tg:${id}:inc:pop`);
  await h.tap(OWNER, `dst:tg:${id}:inc:traditional`);
  await h.tap(OWNER, `dst:v:${id}`);
  await h.tap(OWNER, `dst:gen:${id}:exc`);
  await h.tap(OWNER, `dst:tg:${id}:exc:rap`);
  await h.tap(OWNER, `dst:v:${id}`);
  await h.tap(OWNER, `dst:conf:${id}`);
  await h.tap(OWNER, `dst:fmt:${id}`);
  await h.tap(OWNER, `dst:tz:${id}`);
  await h.tap(OWNER, `dst:int:${id}`);
  await h.send(OWNER, '۱۵');
  await h.tap(OWNER, `dst:hours:${id}`);
  await h.send(OWNER, '25-3');
  assert.match(h.lastText(OWNER), /این بازه رو نفهمیدم/);
  await h.send(OWNER, '9 تا 23');
  await h.tap(OWNER, `dst:daily:${id}`);
  await h.send(OWNER, '30');
  await h.tap(OWNER, `dst:appr:${id}`);
  await h.tap(OWNER, `dst:tog:${id}`);
  await h.tap(OWNER, `dst:auto:${id}`);
  const d = dest(h, FLOW);
  assert.deepEqual(JSON.parse(d.rules), { languages: ['fa', 'other'], genres: ['pop', 'traditional'], exclude_genres: ['rap'], min_language_confidence: 'high' });
  assert.deepEqual([d.post_format, d.time_zone, d.min_interval_seconds, JSON.parse(d.active_hours), d.daily_limit, d.approval_required, d.enabled, d.auto_publish],
    ['cover_then_audio', 'UTC', 900, { from: 9, to: 23 }, 30, 0, 1, 1]);
  assert.match(h.lastText(OWNER), /تا فاز ۶ هیچ پستی در کانال‌ها ارسال نمی‌شه/);
  assert.deepEqual(channelPosts(h), [], 'nothing was posted to any channel');
  assert.ok(h.q("SELECT action FROM audit_log WHERE action LIKE 'destination.%'").length >= 10);
});

test('adding: forward / @username; refused without post rights, for groups, twice', async () => {
  const h = setup();
  withRealChannels(h);
  h.tg.addChannel({ id: -1004000000301, username: 'NoPost', title: 'No Post', rights: { can_post_messages: false } });
  h.tg.addChannel({ id: -1004000000302, username: 'AGroup', title: 'Group', type: 'supergroup' });
  await openDestinations(h);
  await h.tap(OWNER, 'dst:add');
  await h.send(OWNER, null, { forward_origin: { type: 'channel', chat: { id: BEAT, type: 'channel', title: 'WangerBeat' }, message_id: 3, date: 0 }, text: 'x' });
  assert.ok(dest(h, BEAT));
  await h.tap(OWNER, 'dst:add');
  await h.send(OWNER, '@NoPost');
  assert.match(h.lastText(OWNER), /اجازه‌ی «Post messages» نداره/);
  await h.send(OWNER, '@AGroup');
  assert.match(h.lastText(OWNER), /فقط کانال \(نه گروه\)/);
  await h.send(OWNER, '@WangerBeat');
  assert.match(h.lastText(OWNER), /قبلاً مقصد شده/);
  assert.equal(h.one('SELECT count(*) AS n FROM destination_channels').n, 1);
});

test('caption template: unknown variables and bad HTML refused; a valid one is previewed to the owner only', async () => {
  const h = setup();
  withRealChannels(h);
  await openDestinations(h);
  await h.tap(OWNER, `dst:sug:${FLOW}`);
  const id = dest(h, FLOW).id;
  await h.tap(OWNER, `dst:cap:${id}`);
  await h.send(OWNER, '{title} {oops}');
  assert.match(h.lastText(OWNER), /شناخته نشدن: \{oops\}/);
  await h.send(OWNER, '<b>{title}');
  assert.match(h.lastText(OWNER), /تلگرام این متن رو قبول نکرد/);
  assert.equal(dest(h, FLOW).caption_template, null);
  await h.send(OWNER, '🎵 <b>{title}</b>\n👤 {artist}\n💿 {album}\n{artist_tag}\n<a href="{bot_link}">Wanger Music</a>');
  assert.equal(dest(h, FLOW).caption_template, '🎵 <b>{title}</b>\n👤 {artist}\n💿 {album}\n{artist_tag}\n<a href="{bot_link}">Wanger Music</a>');
  const preview = h.tg.callsOf('sendMessage', OWNER).filter((c) => c.result && /^🎵 <b>آهنگ نمونه/.test(c.params.text)).at(-1);
  assert.ok(preview, 'no matching track yet → a sample caption to the owner');
  assert.match(preview.params.text, /#خوانندهی_نمونه/, 'artist_tag: ZWNJ removed, spaces → _');
  await h.tap(OWNER, `dst:cap:${id}`);
  await h.send(OWNER, '-');
  assert.equal(dest(h, FLOW).caption_template, null, '«-» restores the default');
  assert.deepEqual(channelPosts(h), []);
});

test('preview with a real matching track: cover first (cover_then_audio), then the audio with the caption — to the owner', async () => {
  const h = setup();
  withRealChannels(h);
  // an active Persian track with a cover
  await h.send(OWNER, null, { audio: { file_id: 'FILE_FA', file_unique_id: 'U_FA', duration: 245, title: 'دلم تنگه <3', performer: 'شادمهر عقیلی', file_name: 'x.mp3' } });
  const tr = h.one('SELECT * FROM tracks');
  await h.press(OWNER, `trk:act:${tr.id}`, 1);
  await openDestinations(h);
  await h.tap(OWNER, `dst:sug:${FLOW}`);
  const id = dest(h, FLOW).id;
  await h.tap(OWNER, `dst:fmt:${id}`);
  await h.tap(OWNER, `trk:cover:${tr.id}`).catch(() => h.press(OWNER, `trk:cover:${tr.id}`, 1));
  await h.send(OWNER, null, { photo: [{ file_id: 'COVER', width: 640, height: 640 }] });
  await h.press(OWNER, `dst:prev:${id}`, 1);
  const photo = h.tg.callsOf('sendPhoto', OWNER).at(-1);
  const audio = h.tg.callsOf('sendAudio', OWNER).at(-1);
  assert.equal(photo.params.photo, 'COVER');
  assert.equal(audio.params.audio, 'FILE_FA');
  assert.equal(audio.params.caption, '🎵 دلم تنگه &lt;3\n👤 شادمهر عقیلی\n⏱ 4:05', 'default template, escaped, album line dropped');
  assert.match(h.lastText(OWNER), /چیزی توی کانال ارسال نشد/);
  assert.deepEqual(channelPosts(h), [], 'the preview never goes to the channel');
});

test('health: losing post rights disables the channel and alerts the owner; «check rights» brings it back', async () => {
  const h = setup();
  withRealChannels(h);
  await openDestinations(h);
  await h.tap(OWNER, `dst:sug:${BEAT}`);
  const id = dest(h, BEAT).id;
  await h.tap(OWNER, `dst:tog:${id}`);
  assert.equal(dest(h, BEAT).enabled, 1);
  const r = await h.myChatMember({ id: BEAT, type: 'channel', title: 'WangerBeat' }, OWNER, 'member', 'administrator');
  assert.equal(r.result, 'destination_channel');
  assert.deepEqual([dest(h, BEAT).bot_rights_ok, dest(h, BEAT).enabled], [0, 0]);
  assert.match(h.lastText(OWNER), /دیگه نمی‌تونه توی «WangerBeat» پست بذاره/);
  h.tg.setBotStatus(BEAT, 'administrator');
  await h.press(OWNER, `dst:check:${id}`, 1);
  assert.equal(dest(h, BEAT).bot_rights_ok, 1);
  assert.equal(dest(h, BEAT).enabled, 0, 'still disabled until the owner enables it');
  await h.press(OWNER, `dst:v:${id}`, 1);
  assert.match(h.lastText(OWNER), /اجازه‌ی ویرایش و حذف پیشنهاد می‌شه/, 'setBotStatus gave post only: edit/delete recommended');
});

test('removal is soft: hidden, disabled, history kept; adding again brings it back disabled with its rules', async () => {
  const h = setup();
  withRealChannels(h);
  await openDestinations(h);
  await h.tap(OWNER, `dst:sug:${FLOW}`);
  const id = dest(h, FLOW).id;
  await h.tap(OWNER, `dst:langs:${id}`);
  await h.tap(OWNER, `dst:tl:${id}:en`);
  await h.tap(OWNER, `dst:v:${id}`);
  await h.tap(OWNER, `dst:tog:${id}`);
  await h.press(OWNER, `dst:del:${id}`, 1);
  assert.match(h.lastText(OWNER), /تاریخچه‌ش نگه داشته می‌شه/);
  assert.equal(dest(h, FLOW).removed_at, null, 'not before confirming');
  await h.press(OWNER, `dst:delok:${id}`, 1);
  const removed = dest(h, FLOW);
  assert.ok(removed.removed_at > 0);
  assert.equal(removed.enabled, 0);
  assert.ok(h.lastButtons(OWNER).some((b) => b.callback_data === `dst:sug:${FLOW}`), 'offered again');
  await h.tap(OWNER, `dst:sug:${FLOW}`);
  const back = dest(h, FLOW);
  assert.deepEqual([back.id, back.removed_at, back.enabled, back.auto_publish, back.approval_required], [id, null, 0, 0, 1]);
  assert.deepEqual(JSON.parse(back.rules).languages, ['fa', 'en'], 'its rules were kept');
});

test('the “bot added” prompt’s 📢 button registers a destination; System Status lists destinations', async () => {
  const h = setup();
  const NEW = -1004000000400;
  h.tg.addChannel({ id: NEW, username: 'NewDest', title: 'New Dest' });
  await h.myChatMember({ id: NEW, type: 'channel', title: 'New Dest', username: 'NewDest' }, OWNER, 'administrator', 'left');
  await h.tap(OWNER, `bnew:dst:${NEW}`);
  assert.match(h.lastText(OWNER), /کانال مقصد شد/);
  assert.equal(dest(h, NEW).enabled, 0);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  assert.match(h.lastText(OWNER), /📢 کانال‌های مقصد: ⏸🟢 New Dest/);
  advance(1);
  assert.deepEqual(channelPosts(h), []);
});

test('destination routes are owner-only (admins have no destinations.manage)', async () => {
  const h = setup();
  withRealChannels(h);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, '222');
  for (const data of ['dst:home', `dst:sug:${BEAT}`, 'dst:add']) {
    const mark = h.mark();
    await h.press(222, data, 1);
    assert.equal(h.tg.answers(mark)[0].text, '⛔️ به این بخش دسترسی نداری.', data);
  }
  assert.equal(h.one('SELECT count(*) AS n FROM destination_channels').n, 0);
  assert.equal(buttons(h.tg.lastTo(OWNER)).length > 0, true);
});
