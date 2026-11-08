// New songs from sources reach the owner and the admins at once, as a message with the next actions
// as buttons (the owner asked: nobody should have to keep checking the bot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';

const FLOW = -1004391543350;
const BEAT = -1004370326177;
const SRC = -1003300000001;
const ADMIN = 222;
const chat = { id: SRC, title: 'Archive music', username: 'ArchiveMusic' };
let seq = 0;
const audio = (title, performer) => { seq += 1; return { audio: { file_id: `N${seq}`, file_unique_id: `NU${seq}`, duration: 150 + seq, title, performer, file_name: 'x.mp3' } }; };
const messagesTo = (h, id) => h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === id && /آهنگ جدید از «Archive music»/.test(c.params.text));
const data = (call) => buttons(call.params).map((b) => b.callback_data);

async function channel(h, chatId, { approval = false } = {}) {
  h.tg.addChannel({ id: chatId, username: chatId === FLOW ? 'WangerFlow' : 'WangerBeat', title: chatId === FLOW ? 'WangerFlow' : 'WangerBeat' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, `dst:sug:${chatId}`);
  const id = h.one('SELECT id FROM destination_channels WHERE chat_id = ?', chatId).id;
  if (!approval) await h.pressLast(OWNER, `dst:appr:${id}`);
  await h.pressLast(OWNER, `dst:tog:${id}`);
  await h.pressLast(OWNER, `dst:auto:${id}`);
  return id;
}

async function source(h, { mode = 'active', language = null } = {}) {
  h.tg.addChannel({ id: SRC, username: 'ArchiveMusic', title: 'Archive music' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'src:home');
  await h.tap(OWNER, 'src:add');
  await h.send(OWNER, '@ArchiveMusic');
  const src = h.one('SELECT * FROM sources WHERE chat_id = ?', SRC);
  if (mode === 'active') h.db().prepare("UPDATE sources SET auto_import = 'active' WHERE id = ?").run(src.id);
  if (language) h.db().prepare('UPDATE sources SET default_language = ? WHERE id = ?').run(language, src.id);
  return src;
}

async function admin(h) {
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'usr:home');
  await h.tap(OWNER, 'usr:adm:0');
  await h.tap(OWNER, 'usr:addadm');
  await h.send(OWNER, String(ADMIN));
  await h.send(ADMIN, '/start');
}

test('a new song: the owner and the admin get a message at once; a language tap routes it; the owner sends it from the message', async () => {
  const h = setup({ autoSend: false });
  await admin(h);
  await channel(h, FLOW);
  await source(h);
  await h.channelPost(chat, audio('Halam Khoob Nist Maman', 'Tiem'));
  const tr = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  const [own] = messagesTo(h, OWNER);
  const [adm] = messagesTo(h, ADMIN);
  assert.ok(own && adm, 'both are told');
  assert.match(own.params.text, /🎵 Halam Khoob Nist Maman — Tiem\n🌐 زبان: ❔ نامشخص/);
  assert.deepEqual(data(adm).slice(0, 3), [`nt:lang:${tr.id}:fa`, `nt:lang:${tr.id}:en`, `nt:lang:${tr.id}:other`]);

  await h.press(ADMIN, `nt:lang:${tr.id}:fa`, adm.result.message_id);
  assert.match(h.lastText(ADMIN), /🌐 زبان: فارسی[\s\S]*📢 @WangerFlow: ⏳ در صف ارسال/);
  assert.ok(!h.lastButtons(ADMIN).some((b) => b.callback_data.startsWith('nt:send:')), 'sending is the owner\'s');
  await h.press(OWNER, `nt:v:${tr.id}`, own.result.message_id);
  const send = h.lastButtons(OWNER).find((b) => b.callback_data.startsWith('nt:send:'));
  assert.equal(send.text, '📤 ارسال الان به @WangerFlow');
  await h.press(OWNER, send.callback_data, own.result.message_id);
  assert.equal(h.tg.answers().at(-1).text, '✅ پست بعدی فرستاده شد.');
  assert.match(h.lastText(OWNER), /📢 @WangerFlow: ✅ منتشر شد/);
  assert.equal(h.tg.calls.filter((c) => c.method === 'sendAudio' && c.params.chat_id === FLOW).length, 1);
});

test('a channel with approval: the message has ✅ / ❌; the first reviewer wins', async () => {
  const h = setup({ autoSend: false });
  await admin(h);
  await channel(h, BEAT, { approval: true });
  await source(h, { language: 'en' });
  await h.channelPost(chat, audio('Lucky Boyz', 'Mersad'));
  const [adm] = messagesTo(h, ADMIN);
  const [own] = messagesTo(h, OWNER);
  assert.match(adm.params.text, /📢 @WangerBeat: 🗳 منتظر تأیید/);
  const ok = buttons(adm.params).find((b) => b.callback_data.startsWith('nt:ok:'));
  assert.equal(ok.text, '✅ تأیید برای @WangerBeat');
  await h.press(ADMIN, ok.callback_data, adm.result.message_id);
  assert.equal(h.tg.answers().at(-1).text, '✅ تأیید شد');
  assert.match(h.lastText(ADMIN), /⏳ در صف ارسال/);
  await h.press(OWNER, ok.callback_data.replace('nt:ok:', 'nt:no:'), own.result.message_id);
  assert.equal(h.tg.answers().at(-1).text, 'کس دیگری زودتر تصمیم گرفته.');
  assert.equal(h.one('SELECT status FROM publications').status, 'queued');
});

test('draft mode: «✅ فعال کن» on the message; many songs at once → the first five, then one summary; owner imports and the switch', async () => {
  const h = setup({ autoSend: false });
  await channel(h, FLOW);
  await source(h, { mode: 'draft', language: 'fa' });
  await h.channelPost(chat, audio('Derakht', 'Tqvis'));
  const tr = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  const [own] = messagesTo(h, OWNER);
  assert.ok(data(own).includes(`nt:act:${tr.id}`));
  await h.press(OWNER, `nt:act:${tr.id}`, own.result.message_id);
  assert.match(h.lastText(OWNER), /📌 وضعیت: ✅ فعال\n📢 @WangerFlow: ⏳ در صف ارسال/);

  for (let i = 0; i < 8; i++) await h.channelPost(chat, audio(`Song ${i}`, `Artist ${i}`));
  assert.equal(messagesTo(h, OWNER).length, 5, 'five messages in 15 minutes…');
  const summaries = h.tg.callsOf('sendMessage', OWNER).filter((c) => /آهنگ‌های جدید زیادی از منبع‌ها رسید/.test(c.params.text));
  assert.equal(summaries.length, 1, '…then one summary');
  assert.ok(data(summaries[0]).includes('pub:sendq'));

  advance(16 * 60);
  await h.send(OWNER, null, audio('Forwarded', 'By Owner')); // the owner's own import: no notice
  assert.equal(messagesTo(h, OWNER).length, 5);
  h.db().prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('notify.new_tracks', 'false', 0, 0) ON CONFLICT (key) DO UPDATE SET value = 'false'").run();
  await h.channelPost(chat, audio('Quiet', 'Band'));
  assert.equal(messagesTo(h, OWNER).length, 5, 'switched off in ⚙️ Settings');
});
