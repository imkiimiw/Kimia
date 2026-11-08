import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, extOf, mp4Handlers } from '../../tgcloud/lib/detect/index.js';
import { readCentralDirectory } from '../../tgcloud/lib/detect/zip.js';
import { TYPES } from '../../tgcloud/lib/detect/types.js';
import { SAMPLES, polyglotJpegZip, exeAsJpg, zip, bytes } from '../helpers/fixtures.mjs';

// sample name → expected detected id (a few samples exercise a second path to the same type)
const EXPECT = { mp3_raw: 'mp3', m4a_tracks: 'm4a', macho_fat: 'macho', script_ext: 'script' };

for (const [name, [data, fileName]] of Object.entries(SAMPLES)) {
  const expected = EXPECT[name] || name;
  test(`detects ${name} as ${expected}`, () => {
    const r = detect(data, fileName);
    assert.equal(r.id, expected, `${fileName}: got ${r.id}`);
    assert.ok(TYPES[r.id], 'known type');
  });
}

test('every type in the table has a sample (spec §6: a test for every format)', () => {
  const covered = new Set(Object.keys(SAMPLES).map((k) => EXPECT[k] || k));
  const missing = Object.keys(TYPES).filter((id) => !covered.has(id) && !['ole', 'ttf'].includes(id));
  assert.deepEqual(missing, []);
});

test('filename and claimed type are never trusted', () => {
  const [png] = SAMPLES.png;
  const r = detect(png, 'photo.jpg');
  assert.equal(r.id, 'png');
  assert.equal(r.extOk, false);
  assert.equal(r.ext, 'png');
  assert.equal(detect(png, 'photo.png').extOk, true);
  assert.equal(detect(png, 'photo').extOk, false);
});

test('MP4 vs M4A is decided by the track handlers', () => {
  assert.equal(detect(SAMPLES.mp4[0], 'x.mp4').id, 'mp4');
  assert.equal(detect(SAMPLES.m4a_tracks[0], 'x.mp4').id, 'm4a');
  assert.equal(detect(SAMPLES.m4a_tracks[0], 'x.mp4').extOk, true, 'audio-only .mp4 is a fine name');
  assert.deepEqual([...mp4Handlers(SAMPLES.mp4[0])].sort(), ['soun', 'vide']);
});

test('executables are dangerous whatever their name', () => {
  const [data, name] = exeAsJpg();
  const r = detect(data, name);
  assert.equal(r.id, 'exe');
  assert.equal(r.dangerous, 'executable');
  assert.equal(r.extOk, false);
  for (const k of ['elf', 'macho', 'apk', 'jar', 'dex', 'msi', 'lnk', 'javaclass', 'script', 'docm', 'xlsm', 'pptm', 'ole_macro']) {
    assert.ok(detect(...SAMPLES[k]).dangerous, `${k} is dangerous`);
  }
  assert.equal(detect(...SAMPLES.script_ext).dangerous, 'script');
});

test('a harmless file named with a dangerous extension is a mismatch', () => {
  const r = detect(SAMPLES.jpeg[0], 'invoice.exe');
  assert.equal(r.id, 'jpeg');
  assert.equal(r.dangerous, null);
  assert.equal(r.extOk, false);
});

test('a polyglot (JPEG + ZIP) is flagged and treated as dangerous', () => {
  const r = detect(polyglotJpegZip(), 'cat.jpg');
  assert.equal(r.id, 'jpeg');
  assert.equal(r.polyglot, 'zip');
  assert.equal(r.dangerous, 'polyglot');
});

test('text: any text-like extension is fine, a binary one is not', () => {
  const [t] = SAMPLES.text;
  assert.equal(detect(t, 'notes.md').extOk, true);
  assert.equal(detect(t, 'data.csv').extOk, true);
  assert.equal(detect(t, 'photo.png').extOk, false);
  assert.equal(detect(SAMPLES.json[0], 'x.txt').extOk, true);
  assert.equal(detect(new TextEncoder().encode('a\u0000b'), 'x.txt').id, 'unknown');
});

test('UTF-8 cut at the 64 KB sniffing boundary is still text', () => {
  const s = 'س'.repeat(40000); // 2 bytes each: the boundary falls inside a character
  assert.equal(detect(new TextEncoder().encode(s), 'a.txt').id, 'text');
});

test('empty, unknown and truncated inputs', () => {
  assert.equal(detect(new Uint8Array(0), 'x').id, 'empty');
  assert.equal(detect(SAMPLES.unknown[0], 'x.dat').id, 'unknown');
  assert.equal(detect(SAMPLES.unknown[0], 'x.dat').extOk, true, 'nothing to fix for unknown');
  const [jpg] = SAMPLES.jpeg;
  assert.equal(detect(jpg.subarray(0, 3), 'x.jpg').id, 'jpeg', 'a truncated JPEG still has its signature');
  const z = SAMPLES.docx[0];
  const cut = detect(z.subarray(0, z.length - 30), 'x.docx');
  assert.equal(cut.id, 'zip', 'a truncated DOCX: the directory is gone, the container is still ZIP');
  assert.ok(cut.info.damaged);
});

test('the central directory reader: names, encryption, symlinks, no decompression', () => {
  const z = zip([['a.txt', 'x'], ['../evil', 'y'], ['link', 'target', { symlink: true }], ['secret', 'z', { encrypted: true }]]);
  const cd = readCentralDirectory(z);
  assert.equal(cd.ok, true);
  assert.deepEqual(cd.entries.map((e) => e.name), ['a.txt', '../evil', 'link', 'secret']);
  assert.equal(cd.entries[2].symlink, true);
  assert.equal(cd.entries[3].encrypted, true);
  assert.equal(detect(z, 'x.zip').info.encrypted, true);
  assert.equal(readCentralDirectory(bytes('PK\x03\x04', new Uint8Array(30))).ok, false);
});

test('extOf', () => {
  assert.equal(extOf('a.TAR.GZ'), 'gz');
  assert.equal(extOf('.hidden'), '');
  assert.equal(extOf('dir.x/name'), '');
  assert.equal(extOf('C:\\path\\file.PDF'), 'pdf');
});

test('detection of 20 MB stays cheap (bounded scans)', () => {
  const big = new Uint8Array(20 * 1024 * 1024);
  big.set(SAMPLES.png[0]);
  const t = performance.now();
  assert.equal(detect(big, 'x.png').id, 'png');
  assert.ok(performance.now() - t < 500, 'well under the CPU budget');
});

test('storedType / describe round-trip what a file card needs', async () => {
  const { storedType, describe } = await import('../../tgcloud/lib/detect/index.js');
  for (const [data, name] of [SAMPLES.png, [SAMPLES.png[0], 'x.jpg'], [polyglotJpegZip(), 'cat.jpg'], SAMPLES.exe]) {
    const d = detect(data, name);
    const back = describe(storedType(d), name);
    for (const k of ['id', 'label', 'family', 'ext', 'dangerous', 'polyglot', 'extOk', 'nameExt']) assert.deepEqual(back[k], d[k], k);
  }
  const enc = zip([['a', 'b', { encrypted: true }]]);
  assert.equal(describe(storedType(detect(enc, 'a.zip')), 'a.zip').info.encrypted, true);
  assert.equal(describe('nonsense', 'a').id, 'unknown');
});

test('a ZIP that stores a PDF stays a ZIP (exact signatures before the offset-PDF heuristic)', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
  assert.equal(detect(zip([['a.txt', 'x'], ['b.pdf', pdf]]), 'x.zip').id, 'zip');
  const junk = new Uint8Array(200).fill(32);
  const offset = new Uint8Array(junk.length + pdf.length); offset.set(junk); offset.set(pdf, junk.length);
  assert.equal(detect(offset, 'x.pdf').id, 'pdf', 'a PDF after some junk is still found');
});
