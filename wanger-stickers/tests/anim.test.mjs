// Pure parts of the Phase 3 engine and the shared validators (run in Node; the browser parts are
// checked by scripts/engine-local.mjs and scripts/studio-local.mjs in Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFrames, clampClip, defaultClip, outputMs, maxSpanMs, resampleIndexes } from '../src/engine/anim/timeline.ts';
import { findStickers, foregroundMask, hasTransparency, components, mergeBoxes, readingOrder } from '../src/engine/anim/split.ts';
import { frameDurations } from '../src/engine/anim/awebp.ts';
import { makeZip, readZip, crc32 } from '../tgcloud/lib/core/zip.js';
import { inspectGif, inspectMp4, inspectLottie, inspectWebM } from '../tgcloud/lib/core/inspect.js';
import { validateTelegramVideo, validateWhatsAppAnimated, validateWhatsAppStatic, validateWhatsAppTray, validateWhatsAppPack, validateGif, validateMp4Animation, sniffImage, UPLOAD_KINDS } from '../tgcloud/lib/core/validate.js';
import { makeWaIdentifier, cleanWaText, parseWaEmojis, waFileName } from '../tgcloud/lib/core/packs.js';
import { TELEGRAM, WHATSAPP, SIZE_TARGETING } from '../tgcloud/lib/core/limits.js';
import { webm, animWebp, webp, png, gif, mp4 } from './helpers/media.mjs';

test('timeline: a 10 s source is clamped to Telegram’s 3 s at 30 fps — exactly 90 frames, 3.000 s', () => {
  const c = clampClip(defaultClip(10000, TELEGRAM.video.maxDurationMs), 10000, TELEGRAM.video.maxDurationMs);
  assert.deepEqual([c.startMs, c.endMs], [0, 3000]);
  const p = planFrames(c, 30, 3000);
  assert.equal(p.frames.length, 90);
  assert.equal(p.durationMs, 3000);
  assert.ok(p.frames.every((f, i) => i === 0 || f.t > p.frames[i - 1].t));
  // a window that starts late slides back inside the source
  const late = clampClip({ ...c, startMs: 9500, endMs: 12000 }, 10000, 3000);
  assert.ok(late.endMs <= 10000 && late.endMs - late.startMs <= 3000);
});

test('timeline: speed, reverse, boomerang and the loop fade keep the output within the limit', () => {
  const fast = clampClip({ startMs: 0, endMs: 9000, speed: 2, reverse: false, boomerang: false, loopFadeMs: 0 }, 10000, 3000);
  assert.equal(fast.endMs, 6000); // 6 s at 2× = 3 s
  assert.equal(outputMs(fast), 3000);
  const boom = clampClip({ startMs: 1000, endMs: 9000, speed: 1, reverse: false, boomerang: true, loopFadeMs: 0 }, 10000, 3000);
  assert.equal(boom.endMs - boom.startMs, 1500);
  const pb = planFrames(boom, 30, 3000);
  assert.equal(pb.frames.length, 90);
  assert.ok(Math.abs(pb.frames[0].t - pb.frames[89].t) < 60, 'a boomerang ends where it started');
  const rev = planFrames({ ...defaultClip(3000, 3000), reverse: true }, 30, 3000);
  assert.ok(rev.frames[0].t > rev.frames[89].t);
  const fade = clampClip({ startMs: 0, endMs: 5000, speed: 1, reverse: false, boomerang: false, loopFadeMs: 500 }, 10000, 3000);
  assert.equal(fade.endMs, 3500);
  const pf = planFrames(fade, 30, 3000);
  assert.equal(pf.frames.length, 90);
  assert.equal(pf.frames[0].mix.w, 0);
  assert.ok(pf.frames[14].mix.w > 0.9);
  assert.equal(pf.frames[15].mix, undefined);
  assert.equal(maxSpanMs({ speed: 1, boomerang: false, loopFadeMs: 0 }, WHATSAPP.animated.maxDurationMs), 10000);
});

test('frame-rate ladders: lower rates reuse the rendered frames; WebP durations never pass the limit', () => {
  assert.deepEqual(SIZE_TARGETING.fpsLadder, [30, 24, 20, 15]);
  assert.equal(resampleIndexes(90, 30, 24).length, 72);
  assert.equal(resampleIndexes(90, 30, 15).length, 45);
  assert.deepEqual(resampleIndexes(90, 30, 15).slice(0, 3), [0, 2, 4]);
  for (const fps of SIZE_TARGETING.waFpsLadder) {
    const n = Math.floor((10000 * fps) / 1000);
    const d = frameDurations(n, fps);
    assert.ok(d.reduce((a, b) => a + b, 0) <= WHATSAPP.animated.maxDurationMs, `${fps} fps`);
    assert.ok(Math.min(...d) >= WHATSAPP.animated.minFrameMs);
  }
});

test('screenshot to pack: three stickers on a plain background, in reading order; transparent sheets too', () => {
  const W = 300, H = 200;
  const img = new Uint8ClampedArray(W * H * 4).fill(250);
  const rect = (x0, y0, w, h, rgba) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.set(rgba, (y * W + x) * 4); };
  rect(200, 20, 60, 50, [0, 0, 200, 255]); // top right
  rect(20, 25, 60, 60, [200, 0, 0, 255]); // top left
  rect(110, 120, 70, 60, [0, 160, 0, 255]); // second row
  rect(150, 100, 1, 1, [0, 0, 0, 255]); // a speck: dropped
  const boxes = findStickers(img, W, H);
  assert.equal(boxes.length, 3);
  assert.ok(boxes[0].x < 30 && boxes[1].x > 180 && boxes[2].y > 100, JSON.stringify(boxes));
  assert.ok(boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H));
  // with alpha
  const t = new Uint8ClampedArray(W * H * 4);
  for (let y = 10; y < 60; y++) for (let x = 10; x < 60; x++) t.set([9, 9, 9, 255], (y * W + x) * 4);
  for (let y = 100; y < 150; y++) for (let x = 200; x < 260; x++) t.set([9, 9, 9, 255], (y * W + x) * 4);
  assert.ok(hasTransparency(t, W, H));
  assert.equal(findStickers(t, W, H).length, 2);
  // a sticker split by a thin gap stays one
  assert.equal(mergeBoxes([{ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 10, h: 10 }], 2).length, 1);
  assert.deepEqual(readingOrder([{ x: 50, y: 0, w: 10, h: 10 }, { x: 0, y: 2, w: 10, h: 10 }]).map((b) => b.x), [0, 50]);
  assert.equal(components(foregroundMask(new Uint8ClampedArray(16 * 16 * 4).fill(255), 16, 16), 16, 16).length, 0);
});

test('ZIP: stored entries round-trip with CRC-32; broken or compressed archives are refused', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = makeZip([{ name: 'a.txt', data: new TextEncoder().encode('hi') }, { name: 'پوشه/b.png', data: png(4, 4) }]);
  const r = readZip(z);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.entries.map((e) => e.name), ['a.txt', 'پوشه/b.png']);
  assert.equal(sniffImage(r.entries[1].data), 'png');
  const bad = z.slice();
  bad[35] ^= 0xff; // the first entry's data (30-byte header + 'a.txt') → CRC mismatch
  assert.equal(readZip(bad).error, 'CRC');
  assert.equal(readZip(new Uint8Array(10)).error, 'NOT_ZIP');
});

test('inspectors: GIF frames/delays/loop, MP4 tracks, Lottie fields, WebM video-track frames only', () => {
  const g = inspectGif(gif({ frames: 4, delayMs: 80 }));
  assert.deepEqual([g.width, g.height, g.frames, g.durationMs, g.loop], [64, 64, 4, 320, 0]);
  assert.equal(inspectGif(new Uint8Array([1, 2, 3])).error, 'NOT_GIF');
  const m = inspectMp4(mp4({ frames: 30 }));
  assert.equal(m.tracks[0].type, 'vide');
  assert.equal(m.tracks[0].codec, 'avc1');
  assert.equal(m.durationMs, 1000);
  assert.deepEqual(inspectLottie({ w: 512, h: 512, fr: 60, ip: 0, op: 180 }), { width: 512, height: 512, fps: 60, frames: 180, durationMs: 3000 });
  assert.equal(inspectLottie({ w: 1 }).error, 'NOT_LOTTIE');
  const w = inspectWebM(webm({ frames: 45, fps: 15 }));
  assert.deepEqual([w.frames, w.fps, w.durationMs], [45, 15, 3000]);
});

test('validators: Telegram video, WhatsApp static / animated / tray / pack, GIF and MP4', () => {
  assert.deepEqual(validateTelegramVideo(webm()).violations, []);
  assert.deepEqual(validateTelegramVideo(webm({ w: 512, h: 300 })).violations, []);
  assert.ok(validateTelegramVideo(webm({ frames: 91 })).violations.includes('TOO_LONG'));
  assert.ok(validateTelegramVideo(webm({ frameBytes: 3200 })).violations.includes('TOO_BIG'));
  assert.ok(validateTelegramVideo(new Uint8Array(100)).violations.includes('NOT_WEBM'));
  assert.deepEqual(validateWhatsAppStatic(webp(512, 512, 50000)).violations, []);
  assert.ok(validateWhatsAppStatic(webp(512, 512, 110 * 1024)).violations.includes('TOO_BIG'));
  assert.ok(validateWhatsAppStatic(animWebp()).violations.includes('ANIMATED'));
  assert.ok(validateWhatsAppStatic(webp(512, 500)).violations.includes('NOT_512X512'));
  assert.deepEqual(validateWhatsAppAnimated(animWebp()).violations, []);
  assert.ok(validateWhatsAppAnimated(animWebp({ frames: 101, frameMs: 100 })).violations.includes('TOO_LONG'));
  assert.ok(validateWhatsAppAnimated(webp(512, 512)).violations.includes('NOT_ANIMATED'));
  assert.deepEqual(validateWhatsAppTray(png(96, 96)).violations, []);
  assert.ok(validateWhatsAppTray(png(128, 128)).violations.includes('NOT_96X96'));
  assert.deepEqual(validateGif(gif()).violations, []);
  assert.ok(validateGif(gif({ delayMs: 10, frames: 3 })).violations.includes('FRAME_TOO_SHORT'));
  assert.deepEqual(validateMp4Animation(mp4()).violations, []);
  assert.ok(validateMp4Animation(mp4({ audio: true })).violations.includes('AUDIO'));
  const item = (kind, emojis = ['😀']) => ({ kind, emojis });
  const pack = { title: 'P', publisher: 'me', identifier: makeWaIdentifier(5557901897, 2), kind: 'static', tray: true, items: [item('static'), item('static'), item('static')] };
  assert.deepEqual(validateWhatsAppPack(pack).violations, []);
  assert.deepEqual(validateWhatsAppPack({ ...pack, items: pack.items.slice(0, 2) }).violations, ['TOO_FEW']);
  assert.deepEqual(validateWhatsAppPack({ ...pack, items: Array.from({ length: 31 }, () => item('static')) }).violations, ['TOO_MANY']);
  assert.ok(validateWhatsAppPack({ ...pack, items: [...pack.items, item('animated')] }).violations.includes('MIXED'));
  assert.ok(validateWhatsAppPack({ ...pack, items: [...pack.items, item('static', ['😀', '😃', '😄', '😁'])] }).violations.includes('EMOJIS'));
  assert.ok(validateWhatsAppPack({ ...pack, tray: false, publisher: '' }).violations.includes('NO_TRAY'));
  // every upload kind names its formats and a byte cap
  for (const [k, v] of Object.entries(UPLOAD_KINDS)) assert.ok(v.formats.length && v.maxBytes > 0, k);
});

test('WhatsApp helpers: identifier, one-line texts, 1–3 emojis, file names', () => {
  assert.match(makeWaIdentifier(5557901897, 1), /^[A-Za-z0-9_.\- ]{1,127}$/);
  assert.equal(cleanWaText('  my\npack  '), 'my pack');
  assert.equal(cleanWaText('x'.repeat(129)), null);
  assert.deepEqual(parseWaEmojis('😂 🔥'), ['😂', '🔥']);
  assert.equal(parseWaEmojis('😀😃😄😁'), null);
  assert.equal(parseWaEmojis('none'), null);
  assert.equal(waFileName(0), '01.webp');
  assert.equal(waFileName(29), '30.webp');
});

test('motion effects loop seamlessly; text animations progress; ≥ 6 effects and text motions', async () => {
  const { EFFECTS, TEXT_ANIMS, motionAt, textAt, graphemes } = await import('../src/engine/effects.ts');
  assert.ok(EFFECTS.filter((e) => e !== 'none').length >= 6);
  assert.ok(TEXT_ANIMS.filter((e) => e !== 'none').length >= 4);
  for (const k of EFFECTS) {
    const a = motionAt(k, 0, 1);
    const b = motionAt(k, 1, 1);
    for (const f of ['dx', 'dy', 'scale', 'alpha', 'glow']) assert.ok(Math.abs(a[f] - b[f]) < 1e-6, `${k}.${f} loops`);
    assert.ok(Math.abs(Math.cos(a.rotate) - Math.cos(b.rotate)) < 1e-6, `${k} rotation loops`);
    if (k !== 'none') assert.ok([0.1, 0.25, 0.4, 0.6].some((p) => JSON.stringify(motionAt(k, p, 1)) !== JSON.stringify(a)), `${k} moves`);
  }
  const n = graphemes('سلام 👍🏽!').length;
  assert.equal(n, 7);
  const shown = [0, 0.2, 0.4, 0.69, 0.9].map((p) => textAt('typewriter', p, n).chars);
  assert.deepEqual(shown, [...shown].sort((x, y) => x - y));
  assert.equal(shown[0], 0);
  assert.equal(shown[4], n);
  assert.ok(textAt('pop', 0, n).scale < textAt('pop', 0.5, n).scale + 1e-9);
});
