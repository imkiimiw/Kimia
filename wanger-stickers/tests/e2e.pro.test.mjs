// Phase 4 server acceptance: custom emoji packs (100×100, their own sets, never mixed with regular
// stickers) and share links (QR that decodes to the link, open counts, people counted once).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import jsQR from 'jsqr';
import { setup, OWNER } from './helpers/harness.mjs';
import { sha, b64, webp, webm, png } from './helpers/media.mjs';
import commit from '../tgcloud/endpoints/upload_commit.js';
import boot from '../tgcloud/endpoints/studio_boot.js';
import { validateCustomEmojiStatic, validateCustomEmojiVideo } from '../tgcloud/lib/core/validate.js';
import { makeQr } from '../tgcloud/lib/core/qr.js';
import { qrPng } from '../tgcloud/lib/core/png.js';

const U = 770001;
const V = 770002;
const W = 770003;
const ctx = (id) => ({ initData: { user: { id, first_name: `User${id}`, username: `user${id}`, language_code: 'fa' } } });
const inline = (bytes, kind, format, extra) => ({ inline: b64(bytes), kind, format, size: bytes.length, sha256: sha(bytes), ...extra });
const refusedWith = async (p, code) => {
  try {
    await p;
  } catch (e) {
    assert.equal(e.parameters && e.parameters.code, code, `${e.parameters && e.parameters.code}: ${e.description}`);
    return e;
  }
  assert.fail(`expected ${code}`);
};

/** Our 1-bit PNG → RGBA, then jsQR. */
function decodeQr(pngBytes) {
  const b = Buffer.from(pngBytes);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const idat = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    if (b.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rb = Math.ceil(w / 8);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = (raw[y * (rb + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    rgba.set([v, v, v, 255], (y * w + x) * 4);
  }
  const r = jsQR(rgba, w, h);
  return r ? r.data : null;
}

test('QR codes decode back to the text for every version up to 10', () => {
  for (const t of ['https://t.me/Wanger_Motionbot?start=pack_Ab12Cd34Ef', 'x'.repeat(60), 'سلام Wanger', 'y'.repeat(150), 'z'.repeat(213)]) {
    assert.equal(decodeQr(qrPng(makeQr(t), 4)), t);
  }
  assert.throws(() => makeQr('q'.repeat(214)));
});

test('custom emoji pack: a 100×100 static emoji makes a custom_emoji set; video emoji join it; never mixed', async () => {
  const h = setup();
  await h.ready(U);
  const e1 = webp(100, 100, 3000);
  assert.ok(validateCustomEmojiStatic(e1, 'webp').ok);
  let r = await commit(inline(e1, 'emoji_static', 'webp', { action: 'new', title: 'ایموجی من', emojis: '😺', repaint: true }), ctx(U));
  const pack = h.one('SELECT * FROM packs WHERE id = ?', r.packId);
  assert.equal(pack.kind, 'emoji');
  const create = h.tg.callsOf('createNewStickerSet')[0].params;
  assert.equal(create.sticker_type, 'custom_emoji');
  assert.equal(create.needs_repainting, true);
  assert.ok(h.texts(U).some((t) => t.includes(`https://t.me/addemoji/${pack.tg_name}`)));
  const v1 = webm({ w: 100, h: 100, frames: 60, frameBytes: 400 });
  assert.ok(validateCustomEmojiVideo(v1).ok, JSON.stringify(validateCustomEmojiVideo(v1).violations));
  r = await commit(inline(v1, 'emoji_video', 'webm', { action: 'add', packId: pack.id, emojis: '🔥' }), ctx(U));
  assert.equal(r.count, 2);
  // a 512 sticker can't go into the emoji set; an emoji can't go into a regular set
  await refusedWith(commit(inline(webp(512, 512), 'telegram_static', 'webp', { action: 'add', packId: pack.id }), ctx(U)), 'pk.err.emoji_set');
  const reg = await commit(inline(webp(512, 400), 'telegram_static', 'webp', { action: 'new', title: 'Regular' }), ctx(U));
  await refusedWith(commit(inline(webp(100, 100), 'emoji_static', 'webp', { action: 'add', packId: reg.packId }), ctx(U)), 'pk.err.not_emoji_set');
  // the emoji rules
  for (const [bytes, kind, format, why] of [[webp(100, 99), 'emoji_static', 'webp', 'NOT_100X100'], [webp(512, 512), 'emoji_static', 'webp', 'NOT_100X100'], [webm({ w: 512, h: 512 }), 'emoji_video', 'webm', 'NOT_100X100'], [webm({ w: 100, h: 100, frames: 120 }), 'emoji_video', 'webm', 'TOO_LONG']]) {
    const e = await refusedWith(commit(inline(bytes, kind, format, { action: 'add', packId: pack.id }), ctx(U)), 'studio.err.invalid');
    assert.match(e.description, new RegExp(why));
  }
  await refusedWith(commit(inline(e1, 'emoji_static', 'webp', { action: 'send' }), ctx(U)), 'studio.err.bad_input');
  // boot tells the Studio which packs are emoji packs
  const b = await boot({}, ctx(U));
  assert.deepEqual(b.packs.map((p) => p.kind).sort(), ['emoji', 'sticker']);
  assert.equal(b.limits.customEmoji.width, 100);
  // in chat: the emoji pack screen links to addemoji and offers no copy / merge / publish
  await h.press(U, `pk:open:${pack.id}`);
  const btns = h.lastButtons(U);
  assert.ok(btns.some((x) => x.url === `https://t.me/addemoji/${pack.tg_name}`));
  assert.ok(!btns.some((x) => /^pk:(copy|dup|merge|thumb):/.test(x.callback_data || '')));
  assert.ok(!btns.some((x) => /^pb:ask:/.test(x.callback_data || '')));
  assert.match(h.lastText(U), /۲۰۰/);
  // a sticker sent in chat is offered only the regular pack
  await h.sendSticker(U, h.tg.sticker());
  const picks = h.lastButtons(U).map((x) => x.callback_data).filter((d) => d && d.startsWith('st:add:'));
  assert.deepEqual(picks, [`st:add:${reg.packId}`]);
});

test('share link: QR of the link, opens counted, each person once, the owner never; unknown codes refused', async () => {
  const h = setup();
  await h.ready(U);
  const r = await commit(inline(webp(512, 512), 'telegram_static', 'webp', { action: 'new', title: 'Shared' }), ctx(U));
  await h.press(U, `pk:open:${r.packId}`);
  await h.tap(U, `pk:share:${r.packId}`);
  const photo = h.tg.callsOf('sendPhoto', U)[0].params;
  const code = h.one('SELECT share_code FROM packs WHERE id = ?', r.packId).share_code;
  assert.match(code, /^[A-Za-z0-9]{10}$/);
  const link = `https://t.me/Wanger_Motionbot?start=pack_${code}`;
  assert.equal(decodeQr(photo.photo.bytes), link);
  assert.ok(photo.caption.includes(link));
  assert.ok(photo.caption.includes(`https://t.me/addstickers/${r.name}`));
  // the code stays the same on the next share
  await h.press(U, `pk:share:${r.packId}`);
  assert.equal(h.one('SELECT share_code FROM packs WHERE id = ?', r.packId).share_code, code);
  // V opens it twice, W once, the owner once
  await h.ready(V);
  await h.ready(W);
  await h.send(V, `/start pack_${code}`);
  const shown = h.tg.callsOf('sendSticker', V).at(-1).params;
  assert.ok(shown.reply_markup.inline_keyboard.flat().some((b) => b.url === `https://t.me/addstickers/${r.name}`));
  await h.send(V, `/start pack_${code}`);
  await h.send(W, `/start pack_${code}`);
  await h.send(U, `/start pack_${code}`);
  const row = h.one('SELECT share_opens FROM packs WHERE id = ?', r.packId);
  assert.equal(row.share_opens, 3);
  assert.equal(h.one('SELECT count(*) AS n FROM share_visits WHERE pack_id = ?', r.packId).n, 2);
  await h.press(U, `pk:share:${r.packId}`);
  assert.match(h.tg.callsOf('sendPhoto', U).at(-1).params.caption, /۳ بار · 👤 ۲ نفر/);
  // a wrong code → "not available", nothing counted
  await h.send(V, '/start pack_ZZZZZZZZZZ');
  assert.match(h.lastText(V), /در دسترس نیست/);
  // a new user arriving by the link: language, gate, then the pack (the start is kept as pending)
  const N = 770009;
  await h.send(N, `/start pack_${code}`);
  await h.tap(N, 'l:set:fa');
  h.join(N);
  await h.tap(N, 'fj:check');
  assert.ok(h.tg.callsOf('sendSticker', N).length >= 1, 'the shared pack is shown after joining');
  // deleting the pack removes its visits
  await h.press(U, `pk:drop:${r.packId}`);
  const yes = h.findData(U, 'pk:dropok:');
  if (yes) await h.tap(U, yes);
  assert.equal(h.one('SELECT count(*) AS n FROM share_visits').n, 0);
  void OWNER;
});
