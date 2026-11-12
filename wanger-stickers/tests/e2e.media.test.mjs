// Phase 3 server acceptance: Telegram video stickers, GIF / MP4 / file deliveries, frames ZIP, and
// WhatsApp packs (storage, the 3–30 rule, no mixing, emojis, tray, the ZIP export) — through the
// real endpoints and the bot screens, on the SDK emulation and the strict fake Bot API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER } from './helpers/harness.mjs';
import { sha, b64, webp, animWebp, webm, png, gif, mp4 } from './helpers/media.mjs';
import boot from '../tgcloud/endpoints/studio_boot.js';
import begin from '../tgcloud/endpoints/upload_begin.js';
import chunk from '../tgcloud/endpoints/upload_chunk.js';
import commit from '../tgcloud/endpoints/upload_commit.js';
import waExport from '../tgcloud/endpoints/wa_export.js';
import { readZip, makeZip } from '../tgcloud/lib/core/zip.js';
import { validateWhatsAppStatic, validateWhatsAppAnimated, validateWhatsAppTray, validateWhatsAppPack, validateTelegramVideo } from '../tgcloud/lib/core/validate.js';
import { WHATSAPP } from '../tgcloud/lib/core/limits.js';

const U = 760001;
const V = 760002;
const STORAGE = -1007777777777;
const ctx = (id) => ({ initData: { user: { id, first_name: `User${id}`, username: `user${id}`, language_code: 'fa' } } });
const refusedWith = async (p, code) => {
  try {
    await p;
  } catch (e) {
    assert.equal(e.name, 'EndpointError', String(e && e.stack));
    assert.equal(e.parameters.code, code, `${e.parameters.code}: ${e.description}`);
    return e;
  }
  assert.fail(`expected ${code}`);
};
const inline = (bytes, kind, format, extra) => ({ inline: b64(bytes), kind, format, size: bytes.length, sha256: sha(bytes), ...extra });

/** Chunked upload (begin → chunks → commit) for files bigger than one chunk. */
async function upload(bytes, kind, format, extra, c) {
  const b = await begin({ kind, format, size: bytes.length, sha256: sha(bytes) }, c);
  for (let i = 0; i < b.chunks; i++) await chunk({ uploadId: b.uploadId, idx: i, b64: b64(bytes.subarray(i * b.chunkBytes, (i + 1) * b.chunkBytes)) }, c);
  return commit({ uploadId: b.uploadId, ...extra }, c);
}

test('Telegram video sticker: new pack, add, send; the server refuses a clip that breaks a rule', async () => {
  const h = setup();
  await h.ready(U);
  const clip = webm();
  assert.ok(validateTelegramVideo(clip).ok);
  let r = await commit(inline(clip, 'telegram_video', 'webm', { action: 'new', title: 'ویدیویی', emojis: '🎬' }), ctx(U));
  assert.equal(r.action, 'new');
  const up = h.tg.callsOf('uploadStickerFile')[0].params;
  assert.equal(up.sticker_format, 'video');
  assert.equal(up.sticker.type, 'video/webm');
  const set = h.tg.sets.get(r.name.toLowerCase());
  assert.equal(set.stickers[0].is_video, true);
  assert.equal(h.one('SELECT format FROM pack_items').format, 'video');
  r = await commit(inline(webm(), 'telegram_video', 'webm', { action: 'add', packId: r.packId, emojis: '😀', quiet: true }), ctx(U));
  assert.equal(r.count, 2);
  await commit(inline(webm(), 'telegram_video', 'webm', { action: 'send' }), ctx(U));
  assert.equal(h.tg.callsOf('sendSticker', U).length, 1);
  // each broken rule is caught before anything reaches Telegram
  const before = h.tg.callsOf('uploadStickerFile').length;
  for (const [bad, why] of [[webm({ frames: 100 }), 'TOO_LONG'], [webm({ w: 600 }), 'TOO_LARGE_DIMENSIONS'], [webm({ w: 400, h: 400 }), 'NO_SIDE_512'], [webm({ fps: 60, frames: 120 }), 'FPS']]) {
    const e = await refusedWith(commit(inline(bad, 'telegram_video', 'webm', { action: 'send' }), ctx(U)), 'studio.err.invalid');
    assert.match(e.description, new RegExp(why));
  }
  await refusedWith(begin({ kind: 'telegram_video', format: 'webm', size: 300 * 1024, sha256: 'a'.repeat(64) }, ctx(U)), 'studio.err.too_big_export');
  await refusedWith(commit(inline(webp(512, 512), 'telegram_video', 'webm', { action: 'send' }), ctx(U)), 'studio.err.invalid');
  assert.equal(h.tg.callsOf('uploadStickerFile').length, before);
  assert.equal(h.one("SELECT value FROM stats_daily WHERE metric = 'studio.export.video'").value, 3);
});

test('flags: a feature that is off is refused for users, the owner may still test it', async () => {
  const h = setup({ settings: { 'flags.video': false } });
  await h.ready(U);
  await refusedWith(commit(inline(webm(), 'telegram_video', 'webm', { action: 'send' }), ctx(U)), 'common.feature_off');
  assert.equal((await boot({}, ctx(U))).flags.video, false);
  await h.ready(OWNER);
  await commit(inline(webm(), 'telegram_video', 'webm', { action: 'send' }), ctx(OWNER));
  assert.equal(h.tg.callsOf('sendSticker', OWNER).length, 1);
  await refusedWith(commit(inline(webm(), 'nonsense', 'webm', { action: 'send' }), ctx(U)), 'studio.err.bad_input');
  await refusedWith(commit(inline(gif(), 'gif', 'gif', { action: 'add', packId: 1 }), ctx(U)), 'studio.err.bad_input');
});

test('MP4 → sendAnimation, GIF → animation or a real file, frames → ZIP; one daily quota', async () => {
  const h = setup({ settings: { 'quota.media_send': 4 } });
  await h.ready(U);
  await commit(inline(mp4(), 'animation', 'mp4', { action: 'send' }), ctx(U));
  const a = h.tg.callsOf('sendAnimation', U)[0].params;
  assert.equal(a.width, 480);
  assert.equal(a.height, 270);
  assert.equal(a.duration, 2);
  assert.equal(a.animation.type, 'video/mp4');
  const e = await refusedWith(commit(inline(mp4({ audio: true }), 'animation', 'mp4', { action: 'send' }), ctx(U)), 'studio.err.invalid');
  assert.match(e.description, /AUDIO/);
  await commit(inline(gif(), 'gif', 'gif', { action: 'send' }), ctx(U));
  assert.equal(h.tg.callsOf('sendAnimation', U)[1].params.animation.type, 'image/gif');
  await commit(inline(gif(), 'gif', 'gif', { action: 'file' }), ctx(U));
  const d = h.tg.callsOf('sendDocument', U)[0].params;
  assert.equal(d.disable_content_type_detection, true);
  assert.match(d.document.name, /\.gif$/);
  // frames ZIP: PNG entries only
  const zip = makeZip([{ name: 'frame_001.png', data: png(8, 8) }, { name: 'frame_002.png', data: png(8, 8) }]);
  await commit(inline(zip, 'frames_zip', 'zip', { action: 'file' }), ctx(U));
  assert.match(h.tg.callsOf('sendDocument', U)[1].params.document.name, /\.zip$/);
  const bad = makeZip([{ name: 'evil.exe', data: new Uint8Array([1, 2, 3]) }]);
  await refusedWith(commit(inline(bad, 'frames_zip', 'zip', { action: 'file' }), ctx(U)), 'studio.err.invalid');
  // 4 sent today → the 5th is refused, and failed attempts were not counted
  await refusedWith(commit(inline(gif(), 'gif', 'gif', { action: 'send' }), ctx(U)), 'err.quota');
  assert.equal(h.one("SELECT count FROM usage_daily WHERE tg_id = ? AND feature = 'media_send'", U).count, 4);
});

test('a big GIF goes up in chunks; flags.gif_zip wraps the .gif file in a ZIP', async () => {
  const h = setup({ settings: { 'flags.gif_zip': true } });
  await h.ready(U);
  const big = gif({ w: 400, h: 400, frames: 8, noise: true });
  assert.ok(big.length > 256 * 1024, `${big.length}`);
  await upload(big, 'gif', 'gif', { action: 'file' }, ctx(U));
  const d = h.tg.callsOf('sendDocument', U)[0].params;
  assert.equal(d.document.type, 'application/zip');
  const z = readZip(d.document.bytes);
  assert.equal(z.entries.length, 1);
  assert.deepEqual(Buffer.from(z.entries[0].data), Buffer.from(big));
});

test('WhatsApp pack: new (name + publisher), 3 stickers, tray, export ZIP that passes every WhatsApp rule', async () => {
  const h = setup();
  await h.ready(U);
  await h.ready(OWNER);
  const s1 = webp(512, 512, 20000);
  let r = await commit(inline(s1, 'whatsapp_static', 'webp', { action: 'wa_new', title: 'پک واتس‌اپ من', publisher: 'کیمی', emojis: '😂🔥' }), ctx(U));
  assert.equal(r.count, 1);
  assert.equal(r.needTray, true);
  assert.equal(r.left, 2);
  const pack = h.one('SELECT * FROM packs WHERE id = ?', r.packId);
  assert.equal(pack.platform, 'whatsapp');
  assert.equal(pack.kind, 'static');
  assert.match(pack.wa_identifier, /^ws_[0-9a-z]+_w\d+$/);
  // no storage channel yet → kept silently in the user's own chat; the owner is told (once a day)
  const stored = h.tg.callsOf('sendDocument', U)[0].params;
  assert.equal(stored.disable_notification, true);
  assert.ok(h.texts(OWNER).some((t) => /کانال ذخیره/.test(t)));
  // the owner sets the storage channel → later files go there
  h.tg.addChannel({ id: STORAGE, title: 'Storage' });
  h.db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('storage.chat_id', ?, 0, 0)").run(JSON.stringify(STORAGE));
  await commit(inline(png(96, 96), 'whatsapp_tray', 'png', { action: 'wa_tray', packId: r.packId }), ctx(U));
  assert.equal(h.tg.callsOf('sendDocument', STORAGE).length, 1);
  // export too early → refused with what is missing
  const early = await refusedWith(waExport({ packId: r.packId }, ctx(U)), 'wa.err.not_ready');
  assert.match(early.description, /۳/);
  for (const e of ['😀', '🥲']) r = await commit(inline(webp(512, 512, 30000 + e.length), 'whatsapp_static', 'webp', { action: 'wa_add', packId: r.packId, emojis: e }), ctx(U));
  assert.equal(r.count, 3);
  assert.equal(r.left, 0);
  assert.equal(h.tg.callsOf('sendDocument', STORAGE).length, 3);
  // never mixed, 1–3 emojis, WhatsApp's own size and canvas rules
  await refusedWith(commit(inline(animWebp(), 'whatsapp_animated', 'webp', { action: 'wa_add', packId: r.packId, emojis: '😀' }), ctx(U)), 'wa.err.mixed');
  await refusedWith(commit(inline(webp(512, 512), 'whatsapp_static', 'webp', { action: 'wa_add', packId: r.packId, emojis: '😀😃😄😁' }), ctx(U)), 'wa.err.emojis');
  await refusedWith(commit(inline(webp(512, 400), 'whatsapp_static', 'webp', { action: 'wa_add', packId: r.packId, emojis: '😀' }), ctx(U)), 'studio.err.invalid');
  await refusedWith(begin({ kind: 'whatsapp_static', format: 'webp', size: 101 * 1024, sha256: 'a'.repeat(64) }, ctx(U)), 'studio.err.too_big_export');
  await refusedWith(commit(inline(png(100, 100), 'whatsapp_tray', 'png', { action: 'wa_tray', packId: r.packId }), ctx(U)), 'studio.err.invalid');
  // somebody else's pack
  await h.ready(V);
  await refusedWith(waExport({ packId: r.packId }, ctx(V)), 'wa.err.gone');
  await refusedWith(commit(inline(webp(512, 512), 'whatsapp_static', 'webp', { action: 'wa_add', packId: r.packId, emojis: '😀' }), ctx(V)), 'wa.err.gone');
  // export → one ZIP in the user's chat
  const out = await waExport({ packId: r.packId }, ctx(U));
  assert.equal(out.count, 3);
  const zipCall = h.tg.callsOf('sendDocument', U).find((c) => c.params.document.type === 'application/zip');
  assert.ok(zipCall);
  assert.equal(zipCall.params.disable_content_type_detection, true);
  const z = readZip(zipCall.params.document.bytes);
  assert.ifError(z.error);
  const names = z.entries.map((e) => e.name);
  assert.deepEqual(names, ['01.webp', '02.webp', '03.webp', 'tray.png', 'README.txt', 'pack.json']);
  for (const e of z.entries.filter((x) => x.name.endsWith('.webp'))) assert.deepEqual(validateWhatsAppStatic(e.data).violations, []);
  assert.deepEqual(validateWhatsAppTray(z.entries[3].data).violations, []);
  assert.deepEqual(Buffer.from(z.entries[0].data), Buffer.from(s1));
  const meta = JSON.parse(Buffer.from(z.entries[5].data).toString());
  assert.equal(meta.name, 'پک واتس‌اپ من');
  assert.equal(meta.publisher, 'کیمی');
  assert.equal(meta.animated_sticker_pack, false);
  assert.deepEqual(meta.stickers.map((s) => s.emojis), [['😂', '🔥'], ['😀'], ['🥲']]);
  assert.deepEqual(validateWhatsAppPack({ title: meta.name, publisher: meta.publisher, identifier: meta.identifier, kind: 'static', tray: true, items: meta.stickers.map((s) => ({ kind: 'static', emojis: s.emojis })) }).violations, []);
  assert.match(Buffer.from(z.entries[4].data).toString(), /WhatsApp/);
  // .wastickers is behind its flag (off by default)
  assert.ok(!h.tg.callsOf('sendDocument', U).some((c) => /\.wastickers$/.test(c.params.document.name)));
  assert.equal(h.one("SELECT count FROM usage_daily WHERE tg_id = ? AND feature = 'wa_export'", U).count, 1);
});

test('WhatsApp animated pack holds at most 30; the ZIP marks it animated; .wastickers when the flag is on', async () => {
  const h = setup({ settings: { 'flags.wastickers': true } });
  await h.ready(U);
  let r = await commit(inline(animWebp({ frameBytes: 2000 }), 'whatsapp_animated', 'webp', { action: 'wa_new', title: 'Moving', publisher: 'me', emojis: '🎉' }), ctx(U));
  await commit(inline(png(96, 96), 'whatsapp_tray', 'png', { action: 'wa_tray', packId: r.packId }), ctx(U));
  for (let i = 1; i < WHATSAPP.pack.maxStickers; i++) {
    r = await commit(inline(animWebp({ frames: 3, frameBytes: 1000 + i }), 'whatsapp_animated', 'webp', { action: 'wa_add', packId: r.packId, emojis: '🎉' }), ctx(U));
  }
  assert.equal(r.count, 30);
  await refusedWith(commit(inline(animWebp({ frames: 4 }), 'whatsapp_animated', 'webp', { action: 'wa_add', packId: r.packId, emojis: '🎉' }), ctx(U)), 'wa.err.full');
  await refusedWith(commit(inline(webp(512, 512), 'whatsapp_static', 'webp', { action: 'wa_add', packId: r.packId, emojis: '🎉' }), ctx(U)), 'wa.err.mixed');
  // an animated WebP that breaks WhatsApp's rules
  const e = await refusedWith(commit(inline(animWebp({ frameMs: 4 }), 'whatsapp_animated', 'webp', { action: 'wa_add', packId: r.packId, emojis: '🎉' }), ctx(U)), 'studio.err.invalid');
  assert.match(e.description, /FRAME_TOO_SHORT/);
  await waExport({ packId: r.packId }, ctx(U));
  const docs = h.tg.callsOf('sendDocument', U).map((c) => c.params.document);
  const zip = readZip(docs.find((d) => d.name.endsWith('.zip')).bytes);
  assert.equal(zip.entries.filter((x) => x.name.endsWith('.webp')).length, 30);
  for (const x of zip.entries.filter((y) => y.name.endsWith('.webp'))) assert.deepEqual(validateWhatsAppAnimated(x.data).violations, []);
  assert.equal(JSON.parse(Buffer.from(zip.entries.find((x) => x.name === 'pack.json').data).toString()).animated_sticker_pack, true);
  const pkg = readZip(docs.find((d) => d.name.endsWith('.wastickers')).bytes);
  assert.deepEqual(pkg.entries.slice(0, 3).map((x) => x.name), ['title.txt', 'author.txt', 'tray.png']);
  assert.equal(Buffer.from(pkg.entries[0].data).toString(), 'Moving');
});

test('WhatsApp packs in the chat: list, screen with status, preview album, remove, emojis, rename, ZIP, delete', async () => {
  const h = setup();
  await h.ready(U);
  let r = await commit(inline(webp(512, 512, 5000), 'whatsapp_static', 'webp', { action: 'wa_new', title: 'Chat pack', publisher: 'me', emojis: '😀' }), ctx(U));
  const id = r.packId;
  await commit(inline(png(96, 96), 'whatsapp_tray', 'png', { action: 'wa_tray', packId: id }), ctx(U));
  for (const e of ['😃', '😄', '😁']) await commit(inline(webp(512, 512, 5000 + e.codePointAt(0) % 97), 'whatsapp_static', 'webp', { action: 'wa_add', packId: id, emojis: e }), ctx(U));
  // My packs → WhatsApp packs → the pack
  await h.send(U, '/packs');
  await h.tap(U, 'w:list:0');
  await h.tap(U, `w:open:${id}`);
  assert.match(h.lastText(U), /آماده/);
  const urls = h.lastButtons(U).map((b) => b.web_app && b.web_app.url).filter(Boolean);
  assert.ok(urls.some((x) => x.endsWith(`?mode=wa&wpack=${id}`)));
  // preview = albums of the stored files by file_id (nothing uploaded again)
  await h.tap(U, `w:prev:${id}`);
  const album = h.tg.callsOf('sendMediaGroup', U)[0].params.media;
  assert.equal(album.length, 4);
  assert.ok(album.every((m) => m.type === 'document' && typeof m.media === 'string'));
  // remove #2 → 3 left; emojis of #1; rename
  await h.tap(U, `w:rm:${id}`);
  await h.send(U, '۲');
  assert.equal(h.one('SELECT sticker_count FROM packs WHERE id = ?', id).sticker_count, 3);
  await h.tap(U, `w:emo:${id}`);
  await h.send(U, '1 😺🔥');
  assert.equal(h.one('SELECT emojis FROM pack_items WHERE pack_id = ? ORDER BY position LIMIT 1', id).emojis, '["😺","🔥"]');
  await h.tap(U, `w:emo:${id}`);
  await h.send(U, '1 😺🔥😀🤩');
  assert.match(h.lastText(U), /۳/);
  await h.send(U, '/cancel');
  await h.tap(U, `w:ren:${id}`);
  await h.send(U, 'New name\nNew publisher');
  assert.equal(h.one('SELECT title, publisher FROM packs WHERE id = ?', id).publisher, 'New publisher');
  await h.tap(U, `w:zip:${id}`);
  assert.ok(h.tg.callsOf('sendDocument', U).some((c) => c.params.document.type === 'application/zip'));
  // a WhatsApp pack is not a Telegram pack: the Telegram screens refuse its id
  assert.equal((await h.press(U, `pk:open:${id}`)).result, 'refused:pk.err.gone');
  await h.tap(U, `w:drop:${id}`);
  await h.tap(U, `w:dropok:${id}`);
  assert.equal(h.one('SELECT count(*) AS n FROM packs').n, 0);
  assert.equal(h.one('SELECT count(*) AS n FROM pack_items').n, 0);
  // another user's id is refused
  await h.ready(V);
  assert.equal((await h.press(V, `w:open:${id}`)).result, 'refused:wa.err.gone');
});

test('chat inputs: GIF file, round video, video sticker and TGS sticker become Studio jobs', async () => {
  const h = setup();
  await h.ready(U);
  await h.send(U, null, { document: h.tg.document(gif(), { mime: 'image/gif', name: 'a.gif' }) });
  await h.send(U, null, { video_note: { file_id: 'VN1', file_unique_id: 'VNU1', length: 240, duration: 5, file_size: 9000 } });
  await h.send(U, null, { animation: { file_id: 'AN1', file_unique_id: 'ANU1', width: 320, height: 240, duration: 2, mime_type: 'video/mp4', file_size: 9000 } });
  assert.deepEqual(h.q('SELECT source_kind FROM jobs ORDER BY created_at, rowid').map((j) => j.source_kind), ['gif', 'video_note', 'animation']);
  assert.ok(h.texts(U).some((t) => /دایره/.test(t)));
  await h.sendSticker(U, h.tg.sticker({ video: true }));
  await h.tap(U, 'st:edit');
  await h.sendSticker(U, h.tg.sticker({ animated: true }));
  await h.tap(U, 'st:edit');
  const kinds = h.q('SELECT source_kind, mime FROM jobs').map((j) => `${j.source_kind}:${j.mime}`);
  assert.ok(kinds.includes('video_sticker:video/webm'));
  assert.ok(kinds.includes('tgs:application/x-tgsticker'));
  // unknown files are explained
  await h.send(U, null, { document: h.tg.document(new Uint8Array(10), { mime: 'application/pdf', name: 'a.pdf' }) });
  assert.match(h.lastText(U), /نمی‌شناسم/);
});

test('studio_boot reports WhatsApp packs, flags, every limit the engine needs, and today’s quotas', async () => {
  const h = setup();
  await h.ready(U);
  const r0 = await commit(inline(webp(512, 512), 'whatsapp_static', 'webp', { action: 'wa_new', title: 'B', publisher: 'p', emojis: '😀' }), ctx(U));
  const b = await boot({}, ctx(U));
  assert.deepEqual(b.wa, [{ id: r0.packId, title: 'B', publisher: 'p', kind: 'static', count: 1, tray: false }]);
  assert.deepEqual(b.packs, []);
  assert.deepEqual(b.flags, { studio: true, video: true, gif_studio: true, convert: true, whatsapp: true });
  assert.equal(b.limits.video.maxBytes, 256 * 1024);
  assert.equal(b.limits.whatsapp.static.maxBytes, 100 * 1024);
  assert.deepEqual(b.limits.sizeTargeting.waFpsLadder, [15, 12, 10, 8]);
  assert.equal(b.quota.media_send, 100);
  assert.equal(b.quota.sticker_add, 299);
});
