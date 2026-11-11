// Unit tests for the pure modules (no 'sdk'): limits, config, file inspectors, and the engine's
// muxers (TypeScript, loaded through Node's type stripping). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TELEGRAM, WHATSAPP, LIMITS } from '../tgcloud/lib/core/limits.js';
import { OWNER_ID, isOwner, SEED_CHANNELS, MAX_GATE_CHANNELS } from '../tgcloud/lib/config.js';
import { inspectWebP, inspectWebM } from '../tgcloud/lib/core/inspect.js';
import { muxAnimatedWebP } from '../src/engine/webp/animmux.ts';
import { muxWebM } from '../src/engine/webm/mux.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('limits match the official pages checked on 2026-11-11', () => {
  assert.equal(TELEGRAM.static.side, 512);
  assert.equal(TELEGRAM.static.maxBytes, 512 * 1024);
  assert.equal(TELEGRAM.video.maxBytes, 256 * 1024);
  assert.equal(TELEGRAM.video.maxDurationMs, 3000);
  assert.equal(TELEGRAM.video.maxFps, 30);
  assert.equal(TELEGRAM.video.audioAllowed, false);
  assert.equal(TELEGRAM.animated.maxBytes, 64 * 1024);
  assert.equal(TELEGRAM.thumbnail.staticMaxBytes, 128 * 1024);
  assert.equal(TELEGRAM.thumbnail.videoMaxBytes, 32 * 1024);
  assert.equal(TELEGRAM.set.maxStickersRegular, 120);
  assert.equal(TELEGRAM.set.maxStickersEmoji, 200);
  assert.equal(TELEGRAM.set.initialStickersMax, 50);
  assert.equal(TELEGRAM.set.emojiPerStickerMax, 20);
  assert.equal(TELEGRAM.ui.callbackDataMaxBytes, 64);
  assert.equal(WHATSAPP.static.maxBytes, 100 * 1024);
  assert.equal(WHATSAPP.animated.maxBytes, 500 * 1024);
  assert.equal(WHATSAPP.animated.minFrameMs, 8);
  assert.equal(WHATSAPP.animated.maxDurationMs, 10000);
  assert.equal(WHATSAPP.tray.maxBytes, 50 * 1024);
  assert.deepEqual([WHATSAPP.pack.minStickers, WHATSAPP.pack.maxStickers], [3, 30]);
  assert.deepEqual([WHATSAPP.pack.emojiPerStickerMin, WHATSAPP.pack.emojiPerStickerMax], [1, 3]);
});

test('limits are frozen (no feature can change a platform rule at runtime)', () => {
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(TELEGRAM.video) && Object.isFrozen(WHATSAPP.pack));
  assert.throws(() => {
    'use strict';
    TELEGRAM.video.maxBytes = 1;
  });
});

test('owner check is numeric and exact', () => {
  assert.equal(OWNER_ID, 5557901897);
  assert.equal(isOwner(5557901897), true);
  assert.equal(isOwner('5557901897'), false);
  assert.equal(isOwner(5557901898), false);
  assert.equal(isOwner(undefined), false);
  assert.deepEqual(SEED_CHANNELS, ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots']);
  assert.equal(MAX_GATE_CHANNELS, 10);
});

/* a still lossless WebP: RIFF/WEBP + VP8L header only (enough for the inspector and the muxer) */
function stillVP8L(w, h, alpha = true) {
  const bits = ((w - 1) | ((h - 1) << 14) | ((alpha ? 1 : 0) << 28)) >>> 0;
  const payload = [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255];
  const chunk = [...Buffer.from('VP8L'), payload.length, 0, 0, 0, ...payload, 0];
  const size = 4 + chunk.length;
  return new Uint8Array([...Buffer.from('RIFF'), size & 255, size >> 8, 0, 0, ...Buffer.from('WEBP'), ...chunk]);
}

test('inspectWebP reads a still VP8L and rejects garbage', () => {
  const info = inspectWebP(stillVP8L(512, 300));
  assert.equal(info.error, undefined);
  assert.equal(info.width, 512);
  assert.equal(info.height, 300);
  assert.equal(info.alpha, true);
  assert.equal(info.lossless, true);
  assert.equal(info.animated, false);
  assert.equal(inspectWebP(new Uint8Array([1, 2, 3])).error, 'NOT_WEBP');
  const cut = stillVP8L(10, 10).slice(0, 22);
  assert.ok(inspectWebP(cut).error);
});

test('muxAnimatedWebP: loops forever, keeps alpha, frame durations add up', () => {
  const frames = [0, 1, 2].map(() => ({ webp: stillVP8L(512, 512), durationMs: 100 }));
  const out = muxAnimatedWebP(frames, 512, 512, 0);
  const info = inspectWebP(out);
  assert.equal(info.error, undefined);
  assert.equal(info.animated, true);
  assert.equal(info.alpha, true);
  assert.equal(info.frames, 3);
  assert.equal(info.durationMs, 300);
  assert.equal(info.minFrameMs, 100);
  assert.equal(info.loop, 0);
  assert.deepEqual([info.width, info.height], [512, 512]);
  assert.throws(() => muxAnimatedWebP([], 512, 512));
  assert.throws(() => muxAnimatedWebP([{ webp: out, durationMs: 10 }], 512, 512), /already animated/);
});

test('muxWebM: VP9 track with AlphaMode, 90 frames at 30 fps = 3 s, no audio', () => {
  const frames = Array.from({ length: 90 }, (_, i) => ({ data: new Uint8Array([i, 1, 2, 3]), alpha: new Uint8Array([9, 9]), timestampMs: (i * 1000) / 30, key: i === 0 }));
  const out = muxWebM(frames, { width: 512, height: 384, fps: 30, alpha: true });
  const info = inspectWebM(out);
  assert.equal(info.error, undefined);
  assert.equal(info.docType, 'webm');
  assert.equal(info.tracks.length, 1);
  assert.equal(info.tracks[0].codec, 'V_VP9');
  assert.equal(info.tracks[0].alphaMode, 1);
  assert.deepEqual([info.tracks[0].width, info.tracks[0].height], [512, 384]);
  assert.equal(info.frames, 90);
  assert.equal(info.fps, 30);
  assert.equal(info.durationMs, 3000);
  assert.equal(info.hasAudio, false);
});

test('muxWebM without alpha writes SimpleBlocks; first frame must be a keyframe', () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ data: new Uint8Array([i]), timestampMs: i * 40, key: i === 0 }));
  const info = inspectWebM(muxWebM(frames, { width: 512, height: 512, fps: 25, alpha: false }));
  assert.equal(info.frames, 10);
  assert.equal(info.tracks[0].alphaMode, undefined);
  assert.throws(() => muxWebM([{ data: new Uint8Array([1]), timestampMs: 0, key: false }], { width: 1, height: 1, fps: 30, alpha: false }), /keyframe/);
  assert.equal(inspectWebM(new Uint8Array([0, 0, 0, 0])).error, 'NOT_EBML');
});

test('platform rules: pure modules never import sdk; relative imports end in .js', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(path.join(ROOT, 'tgcloud')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    for (const m of src.matchAll(/\bfrom\s+'(\.[^']+)'/g)) assert.ok(m[1].endsWith('.js'), `${rel}: relative import ${m[1]} must end in .js`);
    if (rel.startsWith(path.join('tgcloud', 'lib', 'core')) || rel === path.join('tgcloud', 'lib', 'config.js')) {
      assert.ok(!/from\s+'sdk/.test(src), `${rel} is a pure module and must not import sdk`);
    }
    assert.ok(!/(^|[=(,;]\s*|await\s+)import\s*\(/m.test(src), `${rel}: dynamic import() is not supported on the platform`);
  }
  // handlers/ and endpoints/ are flat
  for (const dir of ['handlers', 'endpoints']) {
    const p = path.join(ROOT, 'tgcloud', dir);
    if (fs.existsSync(p)) for (const e of fs.readdirSync(p, { withFileTypes: true })) assert.ok(!e.isDirectory(), `tgcloud/${dir}/ must be flat`);
  }
});

test('utf8() matches TextEncoder, including Persian and emoji', async () => {
  const { utf8, hex } = await import('../tgcloud/lib/core/bytes.js');
  for (const s of ['', 'abc', 'سلام‌دنیا', 'Wanger ۱۲۳ 😀🎨']) assert.deepEqual(utf8(s), new TextEncoder().encode(s));
  assert.equal(hex(new Uint8Array([0, 15, 255])), '000fff');
});
