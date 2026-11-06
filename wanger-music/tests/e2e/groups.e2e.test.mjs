// Groups as sources (the owner asked for it after Phase 8), «✅ Activate all», and the setting that
// activates the staff's imports right away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const GROUP = -1003400000001;
const U = 111;
const MEMBER = 333;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
let seq = 0;
const audio = (title, performer, extra = {}) => { seq += 1; return { audio: { file_id: `G${seq}`, file_unique_id: `GU${seq}`, duration: 150 + seq, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: 1000 }, ...extra }; };
/** A message in a group, as Telegram delivers it to a bot that is admin there. */
const groupMsg = (h, chat, from, extra) => h.send(from, null, { chat: { type: 'supergroup', title: 'Persian Songs', ...chat }, ...extra });

async function groupSource(h, type = 'supergroup') {
  h.tg.addChannel({ id: GROUP, title: 'Persian Songs', type });
  const r = await h.myChatMember({ id: GROUP, type, title: 'Persian Songs' }, OWNER, 'administrator', 'member');
  assert.equal(r.result, 'owner_asked');
  return h.tg.lastTo(OWNER);
}

test('a group where the owner made the bot admin becomes a source: members\' audio is imported, chatter costs nothing', async () => {
  const h = setup();
  join(h, U);
  const prompt = await groupSource(h);
  assert.match(prompt.text, /ربات ادمین گروه «Persian Songs»/);
  assert.deepEqual(buttons(prompt).map((b) => b.callback_data), [`bnew:src:${GROUP}`, `bnew:no:${GROUP}`], 'a group can only be a source');
  await h.tap(OWNER, `bnew:src:${GROUP}`);
  const src = h.one('SELECT * FROM sources WHERE chat_id = ?', GROUP);
  assert.deepEqual([src.chat_type, src.auto_import, src.enabled], ['supergroup', 'draft', 1]);

  const usersBefore = h.one('SELECT count(*) AS n FROM users').n;
  const dedupeBefore = h.one('SELECT count(*) AS n FROM processed_updates').n;
  const calls = h.tg.calls.length;
  for (let i = 0; i < 5; i++) assert.equal((await groupMsg(h, { id: GROUP }, MEMBER, { text: `hello ${i}` })).result, 'not_audio');
  assert.equal(h.one('SELECT count(*) AS n FROM processed_updates').n, dedupeBefore, 'group chatter writes no dedupe row');
  assert.equal(h.tg.calls.length, calls, 'and the bot says nothing in the group');

  const r = await groupMsg(h, { id: GROUP }, MEMBER, audio('دلم تنگه', 'شادمهر عقیلی'));
  assert.equal(r.result, 'draft');
  const tr = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  assert.deepEqual([tr.status, tr.source_type, tr.source_id, tr.origin_chat_id, tr.added_by], ['draft', 'telegram_channel', src.id, GROUP, 0]);
  assert.equal((await groupMsg(h, { id: GROUP }, MEMBER, { ...audio('x', 'y'), audio: { ...audio('x', 'y').audio, file_unique_id: tr.audio_file_unique_id } })).result, 'duplicate');
  assert.equal(h.one('SELECT count(*) AS n FROM users').n, usersBefore, 'group members get no user rows');
  assert.equal(h.one('SELECT imported_count FROM sources WHERE id = ?', src.id).imported_count, 1);

  // an unregistered group is ignored; active mode puts new songs straight into search
  assert.equal((await groupMsg(h, { id: -1003400000099 }, MEMBER, audio('Other', 'Band'))).result, 'unregistered');
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, `src:v:${src.id}`);
  assert.match(h.lastText(OWNER), /نوع: گروه/);
  await h.tap(OWNER, `src:mode:${src.id}`);
  assert.equal((await groupMsg(h, { id: GROUP }, MEMBER, audio('بی تو', 'ابی'))).result, 'active');
  const res = await h.inline(U, 'ابی');
  assert.equal(res.answer.results.length, 1, 'searchable at once');
});

test('a basic group that becomes a supergroup keeps being the same source (new chat id)', async () => {
  const h = setup();
  await groupSource(h, 'group');
  await h.tap(OWNER, `bnew:src:${GROUP}`);
  assert.equal(h.one('SELECT chat_type FROM sources WHERE chat_id = ?', GROUP).chat_type, 'group');
  const NEW = -1003400000777;
  const r = await h.send(MEMBER, null, { chat: { id: GROUP, type: 'group', title: 'Persian Songs' }, migrate_to_chat_id: NEW });
  assert.equal(r.result, 'migrated');
  const src = h.one('SELECT * FROM sources');
  assert.deepEqual([src.chat_id, src.chat_type], [NEW, 'supergroup']);
  assert.equal((await groupMsg(h, { id: NEW }, MEMBER, audio('Song', 'Band'))).result, 'draft');
});

test('«✅ Activate all» on a forwarded batch activates that batch\'s ready drafts; the rest need a review', async () => {
  const h = setup();
  join(h, U);
  await h.send(OWNER, '/start');
  await h.send(OWNER, null, audio('Song A', 'Band'));
  await h.send(OWNER, null, audio('Song B', 'Band'));
  await h.send(OWNER, null, audio('Song C', 'Band'));
  seq += 1;
  await h.send(OWNER, null, { audio: { file_id: `G${seq}`, file_unique_id: `GU${seq}`, duration: 99, file_name: 'track01.mp3' } }); // no title, no artist
  const summary = h.tg.calls.filter((c) => c.params && c.params.chat_id === OWNER && /ورود گروهی/.test(c.params.text || '')).at(-1);
  assert.ok(summary, 'a batch summary');
  const act = buttons(summary.params).find((b) => b.callback_data.startsWith('imp:act:'));
  assert.ok(act, 'it has «✅ فعال‌سازی همه»');
  // a later batch must not be activated by the first summary's button
  advance(120);
  await h.send(OWNER, null, audio('Later 1', 'Other'));
  await h.send(OWNER, null, audio('Later 2', 'Other'));
  const res = await h.press(OWNER, act.callback_data, summary.result.message_id);
  assert.equal(res.ok, true);
  assert.match(h.tg.answers().at(-1).text, /۳ آهنگ فعال شد[\s\S]*۱ پیش‌نویس بررسی لازم دارد/);
  assert.deepEqual(h.q("SELECT title FROM tracks WHERE status = 'active' ORDER BY id").map((r) => r.title), ['Song A', 'Song B', 'Song C']);
  assert.equal(h.one("SELECT count(*) AS n FROM tracks WHERE status = 'draft'").n, 3, 'the untitled one and the later batch stay drafts');
  assert.equal((await h.inline(U, 'song')).answer.results.length, 3);
});

test('«✅ Activate all ready drafts» in 🎵 Music also takes the drafts a source group imported', async () => {
  const h = setup();
  await groupSource(h);
  await h.tap(OWNER, `bnew:src:${GROUP}`);
  for (const n of ['One', 'Two', 'Three']) await groupMsg(h, { id: GROUP }, MEMBER, audio(`Group ${n}`, 'Band'));
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'mus:home');
  await h.tap(OWNER, 'mus:ls:draft:0');
  assert.ok(h.lastButtons(OWNER).some((b) => b.callback_data === 'mus:actall:draft'));
  await h.tap(OWNER, 'mus:actall:draft');
  assert.match(h.tg.answers().at(-1).text, /۳ آهنگ فعال شد/);
  assert.equal(h.one("SELECT count(*) AS n FROM tracks WHERE status = 'active'").n, 3);
  assert.ok(!h.lastButtons(OWNER).some((b) => b.callback_data === 'mus:actall:draft'), 'no drafts left: no button');
  // an admin with catalog.manage may use it; a normal user can't
  const res = await h.press(U, 'mus:actall:draft', 1);
  assert.equal(res.ok, true);
});

test('setting «activate tracks admins send right away»: off by default; on → the import card says active', async () => {
  const h = setup();
  join(h, U);
  await h.send(OWNER, null, audio('Draft Song', 'Band'));
  assert.equal(h.one('SELECT status FROM tracks ORDER BY id DESC LIMIT 1').status, 'draft');
  h.db().prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('import.auto_activate', 'true', 0, 0) ON CONFLICT (key) DO UPDATE SET value = 'true'").run();
  advance(120);
  await h.send(OWNER, null, audio('Live Song', 'Band'));
  assert.equal(h.one('SELECT status FROM tracks ORDER BY id DESC LIMIT 1').status, 'active');
  assert.match(h.lastText(OWNER), /آهنگ جدید وارد و فعال شد/);
  advance(120);
  seq += 1;
  await h.send(OWNER, null, { audio: { file_id: `G${seq}`, file_unique_id: `GU${seq}`, duration: 77, file_name: 'track02.mp3' } });
  assert.equal(h.one('SELECT status FROM tracks ORDER BY id DESC LIMIT 1').status, 'draft', 'not ready (no title/artist): stays a draft');
  assert.equal((await h.inline(U, 'live')).answer.results.length, 1);
});
