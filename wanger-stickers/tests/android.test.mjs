// Phase 6: the Android companion app (android/) and its bot side. Checks that the app's WhatsApp
// numbers and provider columns match the bot's and WhatsApp's, that the app's test fixtures are
// still what the bot exports, and the owner-set APK flow (panel → button under the ZIP guide).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, OWNER } from './helpers/harness.mjs';
import { sha, b64, webp, animWebp, png } from './helpers/media.mjs';
import commit from '../tgcloud/endpoints/upload_commit.js';
import waExport from '../tgcloud/endpoints/wa_export.js';
import { readZip } from '../tgcloud/lib/core/zip.js';
import { WHATSAPP } from '../tgcloud/lib/core/limits.js';
import { buildFixtures } from '../scripts/android-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'android/app/src');
const kt = (name) => fs.readFileSync(path.join(APP, 'main/java/com/wanger/stickers', name), 'utf8');
const KB = 1024;

test('the app checks the same WhatsApp numbers as the bot', () => {
  const src = kt('Limits.kt');
  const val = (name) => {
    const m = new RegExp(`const val ${name} = ([^\\n]+)`).exec(src);
    assert.ok(m, name);
    return Function(`return (${m[1].replace(/_/g, '').replace(/L$/, '')})`)();
  };
  assert.equal(val('STICKER_SIDE'), WHATSAPP.static.width);
  assert.equal(val('STICKER_SIDE'), WHATSAPP.animated.height);
  assert.equal(val('STATIC_MAX_BYTES'), WHATSAPP.static.maxBytes);
  assert.equal(val('ANIMATED_MAX_BYTES'), WHATSAPP.animated.maxBytes);
  assert.equal(val('MIN_FRAME_MS'), WHATSAPP.animated.minFrameMs);
  assert.equal(val('MAX_DURATION_MS'), WHATSAPP.animated.maxDurationMs);
  assert.equal(val('TRAY_MAX_BYTES'), WHATSAPP.tray.maxBytes);
  assert.ok(val('TRAY_MIN_SIDE') <= WHATSAPP.tray.width && WHATSAPP.tray.width <= val('TRAY_MAX_SIDE'));
  assert.equal(val('MIN_STICKERS'), WHATSAPP.pack.minStickers);
  assert.equal(val('MAX_STICKERS'), WHATSAPP.pack.maxStickers);
  assert.equal(val('EMOJI_MIN'), WHATSAPP.pack.emojiPerStickerMin);
  assert.equal(val('EMOJI_MAX'), WHATSAPP.pack.emojiPerStickerMax);
  assert.equal(val('NAME_MAX_CHARS'), WHATSAPP.pack.nameMaxChars);
  assert.equal(val('PUBLISHER_MAX_CHARS'), WHATSAPP.pack.publisherMaxChars);
  assert.equal(val('IDENTIFIER_MAX_CHARS'), WHATSAPP.pack.identifierMaxChars);
  assert.equal(/val IDENTIFIER = Regex\("(.+)"\)/.exec(src)[1].replace(/\\\\/g, '\\'), WHATSAPP.pack.identifierPattern);
  assert.equal(val('STATIC_MAX_BYTES'), 100 * KB);
});

test('the provider speaks WhatsApp’s contract and the app asks for nothing else', () => {
  const p = kt('StickerContentProvider.kt');
  // column names from WhatsApp's sample StickerContentProvider (github.com/WhatsApp/stickers)
  for (const c of ['sticker_pack_identifier', 'sticker_pack_name', 'sticker_pack_publisher', 'sticker_pack_icon', 'android_play_store_link', 'ios_app_download_link', 'sticker_pack_publisher_email', 'sticker_pack_publisher_website', 'sticker_pack_privacy_policy_website', 'sticker_pack_license_agreement_website', 'image_data_version', 'whatsapp_will_not_cache_stickers', 'animated_sticker_pack', 'sticker_file_name', 'sticker_emoji', 'sticker_accessibility_text']) {
    assert.ok(p.includes(`"${c}"`), c);
  }
  for (const seg of ['"metadata"', '"stickers"', '"stickers_asset"']) assert.ok(p.includes(seg), seg);
  assert.ok(kt('WhatsApp.kt').includes('"com.whatsapp.intent.action.ENABLE_STICKER_PACK"'));
  const manifest = fs.readFileSync(path.join(APP, 'main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.stickercontentprovider"/);
  assert.match(manifest, /android:readPermission="com\.whatsapp\.sticker\.READ"/);
  // the bot tells users the app has no internet permission: keep it true
  assert.doesNotMatch(manifest, /uses-permission/);
});

test('the app’s fixtures are still exactly what the bot exports', async () => {
  const one = (w) => webp(512, 512, 3000 + w);
  const images = { stickers: [1, 2, 3].map((i) => [one(i), one(i + 10), one(i + 20), one(i + 30)]), tray: png(96, 96) };
  const now = await buildFixtures(images);
  for (const name of ['static.zip', 'animated.zip', 'animated.wastickers']) {
    const committed = readZip(new Uint8Array(fs.readFileSync(path.join(APP, 'test/resources/fixtures', name))));
    const fresh = readZip(now[name]);
    assert.ifError(committed.error);
    assert.deepEqual(committed.entries.map((e) => e.name), fresh.entries.map((e) => e.name), `${name}: entries (rerun scripts/android-fixtures.mjs)`);
    for (const meta of ['pack.json', 'title.txt', 'author.txt', 'README.txt']) {
      const a = committed.entries.find((e) => e.name === meta);
      if (!a) continue;
      assert.equal(Buffer.from(a.data).toString(), Buffer.from(fresh.entries.find((e) => e.name === meta).data).toString(), `${name}: ${meta} (rerun scripts/android-fixtures.mjs)`);
    }
  }
});

const U = 780001;
const ctx = { initData: { user: { id: U, first_name: 'Sara', username: 'sara', language_code: 'fa' } } };
const inline = (bytes, kind, format, extra) => ({ inline: b64(bytes), kind, format, size: bytes.length, sha256: sha(bytes), ...extra });

async function readyPack(h) {
  let r = await commit(inline(webp(512, 512, 4000), 'whatsapp_static', 'webp', { action: 'wa_new', title: 'Pack', publisher: 'me', emojis: '😀' }), ctx);
  await commit(inline(png(96, 96), 'whatsapp_tray', 'png', { action: 'wa_tray', packId: r.packId }), ctx);
  for (const e of ['😃', '😄']) r = await commit(inline(webp(512, 512, 4100 + e.length), 'whatsapp_static', 'webp', { action: 'wa_add', packId: r.packId, emojis: e }), ctx);
  return r.packId;
}

test('owner sets the APK; the ZIP guide offers it; removing it removes the button', async () => {
  const h = setup();
  await h.ready(OWNER);
  await h.ready(U);
  const id = await readyPack(h);

  // no APK yet: the generic guide, no button, and w:apk refuses
  await h.press(U, `w:zip:${id}`);
  assert.match(h.lastText(U), /برنامه‌ی واردکننده/);
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data === 'w:apk'));
  assert.equal((await h.press(U, 'w:apk')).result, 'refused:wa.err.no_app');

  // owner: settings → 📱 Android app → send the file
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'a:set');
  await h.tap(OWNER, 'a:apk');
  assert.match(h.lastText(OWNER), /هنوز فایلی/);
  await h.tap(OWNER, 'a:apkset');
  await h.send(OWNER, null, { document: h.tg.document(new Uint8Array(500), { mime: 'application/zip', name: 'pack.zip' }) });
  assert.match(h.lastText(OWNER), /APK نیست/);
  const apk = h.tg.document(new Uint8Array(83 * 1024), { mime: 'application/vnd.android.package-archive', name: 'WangerStickers-1.0.0.apk' });
  await h.send(OWNER, null, { document: apk });
  assert.match(h.lastText(OWNER), /WangerStickers-1\.0\.0\.apk/);
  assert.match(h.lastText(OWNER), /۸۳|83/);
  assert.equal(JSON.parse(h.one("SELECT value FROM settings WHERE key = 'android.apk'").value).file_id, apk.file_id);

  // a user's ZIP guide now carries the button; pressing it sends that very file by file_id
  await waExport({ packId: id }, ctx);
  assert.match(h.lastText(U), /اندروید/);
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === 'w:apk'));
  await h.tap(U, 'w:apk');
  const sent = h.tg.callsOf('sendDocument', U).at(-1).params;
  assert.equal(sent.document, apk.file_id);
  assert.match(sent.caption, /افزودن به واتس‌اپ/);

  // only the owner reaches the APK screens
  for (const data of ['a:apk', 'a:apkset', 'a:apkdel', 'a:apktest']) {
    const before = h.tg.calls.length;
    await h.press(U, data);
    const after = h.tg.calls.slice(before);
    assert.deepEqual(after.map((c) => c.method), ['answerCallbackQuery'], data);
    assert.equal(after[0].params.show_alert, true, data);
  }
  assert.equal(JSON.parse(h.one("SELECT value FROM settings WHERE key = 'android.apk'").value).file_id, apk.file_id);

  // owner previews and removes it
  await h.tap(OWNER, 'a:apk');
  await h.tap(OWNER, 'a:apktest');
  assert.ok(h.lastButtons(OWNER).some((b) => b.callback_data === 'w:apk'));
  await h.tap(OWNER, 'a:apk');
  await h.tap(OWNER, 'a:apkdel');
  assert.equal(JSON.parse(h.one("SELECT value FROM settings WHERE key = 'android.apk'").value), null);
  await h.press(U, `w:zip:${id}`);
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data === 'w:apk'));
  assert.equal((await h.press(U, 'w:apk')).result, 'refused:wa.err.no_app');

  // "-" in the step removes it too
  await h.tap(OWNER, 'a:apk');
  await h.tap(OWNER, 'a:apkset');
  await h.send(OWNER, null, { document: apk });
  await h.tap(OWNER, 'a:apkset');
  await h.send(OWNER, '-');
  assert.equal(JSON.parse(h.one("SELECT value FROM settings WHERE key = 'android.apk'").value), null);
});
