// Batch 4 of the owner's ideas (2026-11-23): 🎮 guess the song (groups and private), ⭐ Telegram
// Stars donations (+ /paysupport), 📱 the Mini App's endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';
import { realMp3 } from '../helpers/audio-files.mjs';

const U = 111;
const V = 222;
const GROUP = -1005500000001;
const BOT = 9280424458;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
let seq = 0;

async function song(h, title, performer, { bytes = realMp3(4000) } = {}) {
  seq += 1;
  advance(61);
  h.tg.files.set(`GF${seq}`, bytes);
  await h.send(OWNER, null, { audio: { file_id: `GF${seq}`, file_unique_id: `GU${seq}`, duration: 104, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: bytes.length } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}
const inGroup = (h, from, text, extra = {}) => h.send(from, text, { chat: { id: GROUP, type: 'supergroup', title: 'Friends' }, ...extra });
const groupAudio = (h) => h.tg.callsOf('sendAudio', GROUP).filter((c) => c.result);

test('🎮 in a group: /guess sends 15 s of a song with its name hidden; the first right reply (Finglish too) wins; no user rows', async () => {
  const h = setup();
  h.tg.addChannel({ id: GROUP, type: 'supergroup', title: 'Friends' }); // a group where the bot is a member
  const tr = await song(h, 'بی تو', 'شادمهر عقیلی');
  const usersBefore = h.one('SELECT count(*) AS n FROM users').n;
  const r = await inGroup(h, U, '/guess');
  assert.equal(r.result, 'game:started');
  const [clip] = groupAudio(h);
  assert.ok(clip.params.audio.bytes.length < 417 * 700 && clip.params.audio.bytes.length > 417 * 500, '~15 seconds of frames');
  assert.equal(clip.params.audio.bytes[0], 0xff, 'no tag: nothing gives the name away');
  assert.deepEqual([clip.params.title, clip.params.performer], ['❓', '❓']);
  assert.equal((await inGroup(h, V, '/guess')).result, 'game:busy', 'one round at a time');
  const reply = { reply_to_message: { message_id: clip.result.message_id, from: { id: BOT, is_bot: true } } };
  assert.equal((await inGroup(h, V, 'shadmehr', reply)).result, 'game:wrong', 'the artist alone is not the answer');
  assert.equal((await inGroup(h, V, 'bi to', reply)).result, 'game:won');
  const won = h.tg.callsOf('sendMessage', GROUP).at(-1);
  assert.match(won.params.text, /درست گفت! «بی تو» از شادمهر عقیلی/);
  assert.equal(buttons(won.params)[0].url, `https://t.me/Wange_Musicbot?start=t_${tr.public_id}`);
  assert.equal((await inGroup(h, U, 'بی تو', reply)).result, 'game:no_round', 'only the first one counts');
  await inGroup(h, U, '/top');
  assert.match(h.tg.callsOf('sendMessage', GROUP).at(-1).params.text, /۱\. User222 — ۱ امتیاز/);
  assert.equal(h.one('SELECT count(*) AS n FROM users').n, usersBefore, 'group players get no user rows');
  // a button in the group starts the next round, still without user rows
  await h.press(V, 'g:new', won.result.message_id, { id: GROUP, type: 'supergroup' });
  assert.equal(groupAudio(h).length, 2);
  assert.equal(h.one('SELECT count(*) AS n FROM users').n, usersBefore);
  // ordinary chatter is not a guess
  assert.equal((await inGroup(h, U, 'hello')).result, 'unregistered');
});

test('🎮 in private: the menu starts a round, the next messages are guesses', async () => {
  const h = setup();
  join(h, U);
  await song(h, 'Lucky Boyz', 'Mersad');
  await h.send(U, '/start');
  await h.tap(U, 'g:new');
  assert.equal(h.tg.callsOf('sendAudio', U).length, 1);
  await h.send(U, 'nope');
  assert.match(h.lastText(U), /❌ نه!/);
  await h.send(U, 'lucky boys');
  assert.match(h.lastText(U), /درست گفت! «Lucky Boyz»/);
  await h.send(U, 'Lucky Boyz');
  assert.match(h.lastText(U), /Lucky Boyz/, 'the round is over: plain text is a search again');
  assert.ok(h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === U).at(-1).params.text.startsWith('🔎'));
});

test('⭐ Stars: amounts → an XTR invoice; pre-checkout checks the payload; the payment is recorded once, the owner is told; /paysupport', async () => {
  const h = setup();
  join(h, U);
  await h.send(U, '/start');
  await h.tap(U, 'don:home');
  assert.deepEqual(h.lastButtons(U).slice(0, 4).map((b) => b.callback_data), ['don:pay:10', 'don:pay:50', 'don:pay:100', 'don:pay:500']);
  await h.tap(U, 'don:pay:50');
  const inv = h.tg.callsOf('sendInvoice', U)[0].params;
  assert.deepEqual([inv.currency, inv.payload, inv.prices[0].amount, inv.provider_token], ['XTR', 'donate:50', 50, '']);
  assert.equal((await h.preCheckout(U, { payload: 'donate:50', amount: 50 })).result, 'ok');
  assert.deepEqual(h.tg.callsOf('answerPreCheckoutQuery').at(-1).params.ok, true);
  assert.equal((await h.preCheckout(U, { payload: 'donate:50', amount: 1 })).result, 'refused');
  assert.equal((await h.preCheckout(U, { payload: 'other:1', amount: 1 })).result, 'refused');
  const paid = { successful_payment: { currency: 'XTR', total_amount: 50, invoice_payload: 'donate:50', telegram_payment_charge_id: 'CH1', provider_payment_charge_id: '' } };
  assert.equal((await h.send(U, null, paid)).result, 'donation');
  assert.match(h.lastText(U), /ممنون از حمایتت! ۵۰ استار رسید/);
  assert.match(h.lastText(OWNER), /حمایت جدید:.*۵۰ استار/);
  assert.equal((await h.send(U, null, paid)).result, 'duplicate');
  assert.deepEqual(h.q('SELECT user_id, amount, charge_id FROM donations').map((r) => [r.user_id, r.amount, r.charge_id]), [[U, 50, 'CH1']]);
  await h.send(U, '/paysupport');
  await h.send(U, 'my payment of 50 stars');
  assert.equal(h.tg.callsOf('copyMessage', OWNER).length, 1);
  assert.match(h.lastText(U), /پیامت برای مدیر ربات فرستاده شد/);
});

test('📱 the Mini App endpoint: home, Finglish search, send to chat (with the buttons), favourite; the gate; no user → refused', async () => {
  const h = setup();
  join(h, U);
  const tr = await song(h, 'دلم تنگه', 'شادمهر عقیلی');
  const home = await h.mini(U, { op: 'home' });
  assert.deepEqual(home.popular.map((x) => x.id), [tr.public_id]);
  const found = await h.mini(U, { op: 'search', q: 'shadmehr' });
  assert.deepEqual([found.fuzzy, found.tracks.map((x) => x.title)], [true, ['دلم تنگه']]);
  assert.deepEqual(await h.mini(U, { op: 'send', id: tr.public_id }), { sent: true });
  const sent = h.tg.callsOf('sendAudio', U).at(-1);
  assert.equal(sent.params.audio, tr.audio_file_id);
  assert.ok(buttons(sent.params).some((b) => b.callback_data === `l:fav:${tr.public_id}`));
  assert.deepEqual(await h.mini(U, { op: 'fav', id: tr.public_id }), { on: true });
  assert.deepEqual((await h.mini(U, { op: 'favs' })).tracks.map((x) => x.id), [tr.public_id]);
  assert.deepEqual(await h.mini(U, { op: 'send', id: 'ZZZZZZZZZ' }), { error: 'gone' });
  const gated = await h.mini(V, { op: 'home' });
  assert.equal(gated.gate, true);
  assert.ok(gated.channels.length > 0 && gated.channels.every((c) => /^https:\/\/t\.me\//.test(c.url)));
  await assert.rejects(h.mini(null, { op: 'home' }), (e) => e.name === 'EndpointError');
  // the welcome message opens the Mini App
  await h.send(U, '/start');
  assert.deepEqual(h.tg.lastTo(U).reply_markup.inline_keyboard[1][0].web_app, { url: 'https://app9280424458.tgcloud.ai/' });
});
