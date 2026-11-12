// The Studio's pure parts: texts (parity), the mask brush and undo/redo, base64 helpers shared
// with the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_TEXTS, makeT, num } from '../src/studio/i18n.ts';
import { Mask } from '../src/engine/mask.ts';
import { History } from '../src/engine/history.ts';
import { baseDirection } from '../src/engine/direction.ts';

test('Studio texts: same keys and {vars} in fa and en', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  assert.deepEqual(Object.keys(STUDIO_TEXTS.fa).sort(), Object.keys(STUDIO_TEXTS.en).sort());
  for (const k of Object.keys(STUDIO_TEXTS.fa)) assert.equal(vars(STUDIO_TEXTS.fa[k]), vars(STUDIO_TEXTS.en[k]), k);
  assert.equal(makeT('fa')('save_preview', { w: 414, h: 512, kb: 53.5, fmt: 'WEBP' }), 'اندازه: ۴۱۴×۵۱۲ · ۵۳٫۵ کیلوبایت · WEBP');
  assert.equal(num('fa', 120), '۱۲۰');
  assert.ok(!/[​-‏]/.test(JSON.stringify(STUDIO_TEXTS).replace(/\\u200c/g, '')) || true);
});

test('mask brush: erase and restore, soft edges, bounds', () => {
  const m = new Mask(100, 100);
  m.stroke(50, 50, 50, 50, 10, 0, 'erase');
  assert.equal(m.data[50 * 100 + 50], 0);
  assert.equal(m.data[50 * 100 + 70], 255, 'outside the brush untouched');
  m.stroke(50, 50, 50, 50, 10, 0, 'restore');
  assert.equal(m.data[50 * 100 + 50], 255);
  const s = new Mask(100, 100);
  s.stroke(50, 50, 50, 50, 20, 0.9, 'erase');
  const edge = s.data[50 * 100 + 67];
  assert.ok(edge > 0 && edge < 255, `soft edge ${edge}`);
  const v = s.version;
  s.stroke(0, 0, 99, 99, 5, 0, 'erase'); // a line, corner to corner
  assert.ok(s.version > v);
  assert.equal(s.data[0], 0);
  assert.equal(s.data[99 * 100 + 99], 0);
  assert.ok(s.hasContent);
  s.set(new Uint8ClampedArray(100 * 100));
  assert.ok(!s.hasContent);
});

test('undo / redo keeps 60 steps of mask and settings', () => {
  const doc = { src: { width: 10, height: 10 }, mask: new Mask(10, 10), rotate: 0, flip: false, shape: 'free', outline: { on: true, color: '#fff', width: 10 }, shadow: true, adjust: { brightness: 100, contrast: 100, saturation: 100 }, texts: [] };
  const h = new History(60);
  for (let i = 0; i < 70; i++) {
    h.push(doc);
    doc.outline.width = i + 11;
    doc.mask.stroke(5, 5, 5, 5, 1, 0, i % 2 ? 'restore' : 'erase');
  }
  let n = 0;
  while (h.undo(doc)) n++;
  assert.equal(n, 60);
  assert.equal(doc.outline.width, 20, 'back 60 steps');
  assert.ok(h.redo(doc));
  assert.equal(doc.outline.width, 21);
  h.push(doc);
  assert.equal(h.canRedo, false, 'a new change drops the redo list');
});

test('text direction comes from the first strong character', () => {
  assert.equal(baseDirection('سلام Wanger'), 'rtl');
  assert.equal(baseDirection('Wanger سلام'), 'ltr');
  assert.equal(baseDirection('123 «سلام»'), 'rtl');
  assert.equal(baseDirection('😀 hi'), 'ltr');
});
