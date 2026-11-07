import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, cleanBase, splitName, normalizeBase, renameTo, fixedName, allowedExts, hadSuspiciousChars, defaultName } from '../../tgcloud/lib/names.js';
import { detect } from '../../tgcloud/lib/detect/index.js';
import { SAMPLES, exeAsJpg } from '../helpers/fixtures.mjs';
import { telegramName } from '../helpers/fake-telegram.mjs';
import { tehranDay } from '../../tgcloud/lib/util.js';

const png = detect(SAMPLES.png[0], 'a.png');
const pngWrong = detect(SAMPLES.png[0], 'a.jpg');
const jpeg = detect(SAMPLES.jpeg[0], 'a.jpg');
const unknown = detect(SAMPLES.unknown[0], 'x.dat');

test('the RTLO trick: bidi controls are removed, the real extension shows', () => {
  const evil = 'photo\u202egnp.exe'; // displays as "photoexe.png"
  assert.equal(hadSuspiciousChars(evil), true);
  assert.equal(sanitizeName(evil), 'photognp.exe');
  for (const c of ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']) {
    assert.equal(sanitizeName(`a${c}b.txt`), 'ab.txt');
  }
});

test('control characters, separators, hidden-file dots and Windows-reserved characters', () => {
  assert.equal(sanitizeName('a\u0000b\nc.txt'), 'a b c.txt');
  assert.equal(sanitizeName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeName('..\\..\\win.ini'), '_.._win.ini');
  assert.equal(sanitizeName('.bashrc'), 'bashrc');
  assert.equal(sanitizeName('name...  .pdf'), 'name.pdf');
  assert.equal(sanitizeName('a:b*c?d"e<f>g|h.txt'), 'a_b_c_d_e_f_g_h.txt');
});

test('Persian is kept (NFC, ZWNJ), emoji are removed like Telegram does', () => {
  assert.equal(sanitizeName('گزارش نهایی ۱۴۰۵.pdf'), 'گزارش نهایی ۱۴۰۵.pdf');
  assert.equal(sanitizeName('می\u200cخواهم.txt'), 'می\u200cخواهم.txt');
  assert.equal(sanitizeName('emoji-🙂.txt'), 'emoji-.txt');
  assert.equal(sanitizeName('👍🏽🇮🇷.txt'), 'file.txt', 'nothing left → fallback');
  assert.equal(sanitizeName('é.txt'), 'é.txt', 'NFC');
});

test('lengths follow Telegram: base ≤ 64 characters, extension ≤ 16', () => {
  const long = 'ق'.repeat(100) + '.txt';
  const out = sanitizeName(long);
  assert.equal([...splitName(out).base].length, 64);
  assert.equal(out, telegramName(out), 'Telegram keeps the sanitized name unchanged');
  for (const name of ['a'.repeat(110) + '.txt', 'x'.repeat(30) + '.' + 'y'.repeat(16), 'emoji-🙂.txt', 'سلام Hello ۱۲۳ (نسخه ۲).txt']) {
    const s = sanitizeName(name);
    assert.equal(telegramName(s), s, name);
  }
  assert.equal(sanitizeName('x.' + 'y'.repeat(17)), 'x_' + 'y'.repeat(17), 'a 17-char "extension" would be cut by Telegram');
  assert.equal(telegramName(sanitizeName('a.b.' + 'c'.repeat(20))), sanitizeName('a.b.' + 'c'.repeat(20)));
  assert.equal(sanitizeName('Dr. Smith'), 'Dr. Smith', 'short dot segments are left alone');
});

test('fallback names', () => {
  assert.equal(sanitizeName('', { fallback: 'photo_2026-11-07' }), 'photo_2026-11-07');
  assert.equal(sanitizeName('...', { fallback: 'doc' }), 'doc');
  assert.equal(defaultName('photo', jpeg, 1794000000), `photo_${tehranDay(1794000000)}.jpg`);
  assert.equal(tehranDay(Date.UTC(2026, 10, 6, 21, 0) / 1000), '2026-11-07', 'Tehran is 3:30 ahead');
});

test('normalize: Arabic letters → Persian, tatweel, separators', () => {
  assert.equal(normalizeBase('علي__كتاب'), 'علی کتاب');
  assert.equal(normalizeBase('مـــحمد ٣'), 'محمد ۳');
  assert.equal(normalizeBase('a--b...c'), 'a - b.c');
});

test('rename keeps a matching extension and fixes a wrong one', () => {
  assert.deepEqual(renameTo('a.png', png, { mode: 'name', value: 'گزارش' }), { ok: true, name: 'گزارش.png' });
  assert.deepEqual(renameTo('a.jpg', pngWrong, { mode: 'name', value: 'b' }), { ok: true, name: 'b.png' });
  assert.deepEqual(renameTo('a.png', png, { mode: 'prefix', value: '2026' }), { ok: true, name: '2026 a.png' });
  assert.deepEqual(renameTo('a.png', png, { mode: 'suffix', value: '-final' }), { ok: true, name: 'a-final.png' });
  assert.deepEqual(renameTo('x.jpg', jpeg, { mode: 'ext', value: 'jpeg' }), { ok: true, name: 'x.jpeg' });
});

test('extension changes only to one that matches the detected type', () => {
  assert.deepEqual(renameTo('x.jpg', jpeg, { mode: 'ext', value: 'png' }), { ok: false, error: 'ext_not_allowed' });
  assert.deepEqual(renameTo('x.png', png, { mode: 'name', value: 'y.exe' }), { ok: true, name: 'y.exe.png' }, 'a typed foreign extension stays part of the name');
  assert.deepEqual(renameTo('x.jpg', jpeg, { mode: 'name', value: 'y.jpeg' }), { ok: true, name: 'y.jpeg' });
  assert.deepEqual(allowedExts(unknown), []);
  assert.deepEqual(renameTo('x.dat', unknown, { mode: 'name', value: 'y' }), { ok: true, name: 'y.dat' }, 'unknown: base only');
});

test('dangerous files are never renamed; same or empty names are refused', () => {
  const [exe, name] = exeAsJpg();
  const d = detect(exe, name);
  assert.deepEqual(renameTo(name, d, { mode: 'name', value: 'x' }), { ok: false, error: 'dangerous' });
  assert.deepEqual(allowedExts(d), []);
  assert.deepEqual(renameTo('a.png', png, { mode: 'name', value: 'a' }), { ok: false, error: 'same' });
  assert.deepEqual(renameTo('a.png', png, { mode: 'name', value: '\u202e  ' }), { ok: false, error: 'empty' });
});

test('Detect & Fix name', () => {
  assert.equal(fixedName('holiday.jpg', pngWrong), 'holiday.png');
  assert.equal(fixedName('noext', png), 'noext.png');
  assert.equal(fixedName('\u202ecod.exe', pngWrong), 'cod.png');
});

test('cleanBase never returns separators or leading dots', () => {
  for (const s of ['/', '\\', '..', ' . ', '\u200c\u200c', 'a/b']) assert.ok(!/^[.\s]|[/\\]/.test(cleanBase(s)), s);
});
