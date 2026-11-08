// Phase 4 end to end: source channels. Done when: a new audio post in a registered source becomes a
// draft or active track per its settings; duplicates are skipped; unregistered channels are ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const SRC = -1003300000001;
const OTHER = -1003300000002;
const U = 111;
const chat = { id: SRC, title: 'Persian Hits', username: 'PersianHits' };
let seq = 0;
const audio = (title, performer, extra = {}) => { seq += 1; return { audio: { file_id: `F${seq}`, file_unique_id: `UQ${seq}`, duration: 200 + seq, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: 1000 }, ...extra }; };
const tracks = (h) => h.q('SELECT * FROM tracks ORDER BY id');

async function addSource(h) {
  h.tg.addChannel({ id: SRC, username: 'PersianHits', title: 'Persian Hits' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, null, { forward_origin: { type: 'channel', chat: { id: SRC, type: 'channel', title: 'Persian Hits' }, message_id: 1, date: 0 }, text: 'x' });
  return h.one('SELECT * FROM sources WHERE chat_id = ?', SRC);
}

test('posts from unregistered channels are ignored', async () => {
  const h = setup();
  const r = await h.channelPost({ id: OTHER, title: 'Random' }, audio('Song', 'Artist'));
  assert.deepEqual([r.ok, r.result], [true, 'unregistered']);
  assert.equal(tracks(h).length, 0);
});

test('adding a source: forward / @username / id; the bot must be an admin; a group can be a source too', async () => {
  const h = setup();
  const s = await addSource(h);
  assert.deepEqual([s.title, s.username, s.enabled, s.auto_import, s.default_language, s.chat_type], ['Persian Hits', 'PersianHits', 1, 'draft', null, 'channel']);
  assert.match(h.tg.callsOf('sendMessage', OWNER).at(-2).params.text, /به‌عنوان منبع اضافه شد/);
  h.tg.addChannel({ id: OTHER, username: 'NoAdminHere', title: 'No Admin', botAdmin: false });
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, '@NoAdminHere');
  assert.match(h.lastText(OWNER), /ربات توی «No Admin» ادمین نیست/);
  h.tg.addChannel({ id: -1003300000008, username: 'SomeUser', title: 'Person', type: 'private' });
  await h.send(OWNER, '@SomeUser');
  assert.match(h.lastText(OWNER), /فقط کانال یا گروه می‌تونه منبع باشه/);
  h.tg.addChannel({ id: -1003300000009, username: 'SomeGroup', title: 'Group', type: 'supergroup' });
  await h.send(OWNER, '@SomeGroup');
  assert.equal(h.one('SELECT chat_type FROM sources WHERE chat_id = ?', -1003300000009).chat_type, 'supergroup');
  await h.tap(OWNER, 'src:home');
  assert.match(h.lastText(OWNER), /👥 Group/);
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, '@PersianHits');
  assert.match(h.lastText(OWNER), /قبلاً منبع شده/);
  assert.equal(h.one('SELECT count(*) AS n FROM sources').n, 2);
  assert.ok(h.q('SELECT action FROM audit_log').some((r) => r.action === 'source.add'));
});

test('draft mode: an audio post becomes a draft from the source; the owner gets a new-song message with buttons', async () => {
  const h = setup();
  const s = await addSource(h);
  const r = await h.channelPost(chat, audio('Blinding Lights', 'The Weeknd'), { messageId: 77 });
  assert.equal(r.result, 'draft');
  const tr = tracks(h)[0];
  assert.deepEqual([tr.status, tr.source_type, tr.source_id, tr.origin_chat_id, tr.origin_message_id, tr.added_by], ['draft', 'telegram_channel', s.id, SRC, 77, 0]);
  const src = h.one('SELECT * FROM sources WHERE id = ?', s.id);
  assert.equal(src.imported_count, 1);
  assert.ok(src.last_post_at > 0);
  const notes = () => h.tg.callsOf('sendMessage', OWNER).filter((c) => /آهنگ جدید از «Persian Hits»/.test(c.params.text));
  assert.equal(notes().length, 1);
  assert.ok(buttons(notes()[0].params).some((b) => b.callback_data === `nt:act:${tr.id}`), 'with «✅ فعال کن»');
  await h.channelPost(chat, audio('Save Your Tears', 'The Weeknd'));
  assert.equal(notes().length, 2, 'one message per new song');
  assert.equal(tracks(h).length, 2);
  assert.equal(h.tg.callsOf('sendAudio').length + h.tg.callsOf('copyMessage').length, 0, 'nothing is published');
  assert.ok(h.q("SELECT actor_id FROM audit_log WHERE action = 'catalog.import'").every((r) => r.actor_id === 0), 'imports are audited as the system');
});

test('active mode: a complete track is activated (and searchable); an incomplete one stays a draft', async () => {
  const h = setup();
  const s = await addSource(h);
  await h.tap(OWNER, `src:mode:${s.id}`); // draft → active
  assert.equal(h.one('SELECT auto_import FROM sources WHERE id = ?', s.id).auto_import, 'active');
  assert.equal((await h.channelPost(chat, audio('Hello', 'Adele'))).result, 'active');
  assert.equal((await h.channelPost(chat, { audio: { file_id: 'Fx', file_unique_id: 'UQx', duration: 100, file_name: 'NoTags.mp3' } })).result, 'draft');
  assert.deepEqual(tracks(h).map((t) => t.status), ['active', 'draft']);
  for (const c of SEED) h.tg.setMember(c, U, 'member');
  assert.deepEqual((await h.inline(U, 'adele')).answer.results.map((r) => r.id), [tracks(h)[0].public_id]);
  assert.equal(h.tg.callsOf('sendAudio').length, 0, 'activation is not publishing (no archive set)');
});

test('the source’s default language decides the language (high confidence)', async () => {
  const h = setup();
  const s = await addSource(h);
  await h.tap(OWNER, `src:lang:${s.id}`);
  assert.equal(h.one('SELECT default_language FROM sources WHERE id = ?', s.id).default_language, 'fa');
  await h.channelPost(chat, audio('Ghalbe Man', 'Shadmehr'));
  const tr = tracks(h)[0];
  assert.deepEqual([tr.language, tr.language_confidence, tr.language_source], ['fa', 'high', 'source'], 'Latin letters, but the source says Persian');
});

test('duplicates are skipped: the same post again, the same file elsewhere, an admin forwarding the post', async () => {
  const h = setup();
  await addSource(h);
  const a = audio('Song', 'Artist');
  await h.channelPost(chat, a, { messageId: 10, updateId: 5000 });
  assert.equal((await h.channelPost(chat, a, { messageId: 10, updateId: 5000 })).duplicate, true, 'same update: deduped');
  assert.equal((await h.channelPost(chat, a, { messageId: 10 })).result, 'duplicate', 'same post');
  assert.equal((await h.channelPost(chat, a, { messageId: 11 })).result, 'duplicate', 'same file in another post');
  advance(61);
  await h.send(OWNER, null, { ...a, forward_origin: { type: 'channel', chat: { id: SRC, type: 'channel' }, message_id: 10, date: 0 } });
  assert.match(h.lastText(OWNER), /قبلاً توی آرشیو هست/);
  assert.equal(tracks(h).length, 1);
  assert.equal(h.one('SELECT imported_count FROM sources').imported_count, 1);
});

test('off and disabled sources import nothing; non-audio posts are ignored; removal keeps the tracks', async () => {
  const h = setup();
  const s = await addSource(h);
  assert.equal((await h.channelPost(chat, { text: 'hello' })).result, 'not_audio');
  await h.tap(OWNER, `src:tog:${s.id}`);
  assert.equal((await h.channelPost(chat, audio('A', 'B'))).result, 'off');
  await h.tap(OWNER, `src:tog:${s.id}`);
  await h.channelPost(chat, audio('C', 'D'));
  await h.tap(OWNER, `src:mode:${s.id}`);
  await h.tap(OWNER, `src:mode:${s.id}`); // draft → active → off
  assert.equal(h.one('SELECT auto_import FROM sources').auto_import, 'off');
  assert.equal((await h.channelPost(chat, audio('E', 'F'))).result, 'off');
  assert.equal(tracks(h).length, 1);
  await h.tap(OWNER, `src:del:${s.id}`);
  assert.match(h.lastText(OWNER), /از منبع‌ها حذف بشه؟/);
  await h.tap(OWNER, `src:delok:${s.id}`);
  assert.equal(h.one('SELECT count(*) AS n FROM sources').n, 0);
  assert.equal(tracks(h).length, 1, 'imported tracks stay');
  assert.equal((await h.channelPost(chat, audio('G', 'H'))).result, 'unregistered');
});

test('the bot made admin of a new channel: the owner is asked Source · Destination · Force-join · Ignore', async () => {
  const h = setup();
  const NEW = -1003300000077;
  h.tg.addChannel({ id: NEW, username: 'FreshChan', title: 'Fresh' });
  // a stranger making the bot admin of their channel asks nobody (Phase 8: no prompt flood)
  const stranger = await h.myChatMember({ id: NEW, type: 'channel', title: 'Fresh', username: 'FreshChan' }, 999, 'administrator', 'left');
  assert.equal(stranger.result, 'other_chat');
  assert.equal(h.tg.callsOf('sendMessage', OWNER).length, 0);
  const r = await h.myChatMember({ id: NEW, type: 'channel', title: 'Fresh', username: 'FreshChan' }, OWNER, 'administrator', 'left');
  assert.equal(r.result, 'owner_asked');
  const prompt = h.tg.lastTo(OWNER);
  assert.match(prompt.text, /ربات ادمین کانال «Fresh» @FreshChan شد/);
  assert.deepEqual(buttons(prompt).map((b) => b.callback_data), [`bnew:src:${NEW}`, `bnew:dst:${NEW}`, `bnew:fj:${NEW}`, `bnew:no:${NEW}`]);
  await h.tap(OWNER, `bnew:src:${NEW}`);
  assert.equal(h.one('SELECT auto_import FROM sources WHERE chat_id = ?', NEW).auto_import, 'draft');
  assert.match(h.lastText(OWNER), /منبع شد/);
  let mark;

  // a registered channel is not prompted again; another one can become force-join
  await h.myChatMember({ id: NEW, type: 'channel', title: 'Fresh' }, 999, 'administrator', 'left');
  assert.equal(h.tg.callsOf('sendMessage', OWNER).filter((c) => /این کانال برای چیه/.test(c.params.text)).length, 1);
  const FJ = -1003300000088;
  h.tg.addChannel({ id: FJ, username: 'JoinMe', title: 'Join Me' });
  await h.myChatMember({ id: FJ, type: 'channel', title: 'Join Me', username: 'JoinMe' }, OWNER, 'administrator', 'left');
  await h.tap(OWNER, `bnew:fj:${FJ}`);
  assert.equal(h.one('SELECT count(*) AS n FROM force_join_channels WHERE chat_id = ?', FJ).n, 1);
  const IG = -1003300000099;
  await h.myChatMember({ id: IG, type: 'channel', title: 'Nope' }, OWNER, 'administrator', 'left');
  await h.tap(OWNER, `bnew:no:${IG}`);
  assert.match(h.lastText(OWNER), /نادیده گرفته شد/);
  assert.equal(h.one('SELECT count(*) AS n FROM sources WHERE chat_id = ?', IG).n, 0);
  mark = h.mark();
  await h.press(U, `bnew:src:${IG}`, 1);
  assert.deepEqual(h.tg.calls.slice(mark).map((c) => c.method), ['answerCallbackQuery'], 'only the owner can answer');
});

test('losing admin in a source warns the owner', async () => {
  const h = setup();
  await addSource(h);
  const r = await h.myChatMember({ id: SRC, type: 'channel', title: 'Persian Hits' }, OWNER, 'left', 'administrator');
  assert.equal(r.result, 'source_channel');
  assert.match(h.lastText(OWNER), /دیگه ادمین منبع «Persian Hits» نیست/);
});
