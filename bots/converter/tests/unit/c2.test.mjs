// C2 pure modules: archives (incl. the malicious cases of spec §12), PDF page tools, images, ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, zipSync } from '../../tgcloud/lib/vendor/fflate.js';
import { PDFDocument } from '../../tgcloud/lib/vendor/pdf-lib.js';
import { openArchive, extract, makeZip, zipParts, inflateBounded, safePath, flatNames, zipEntries } from '../../tgcloud/lib/archive.js';
import { parseRanges, rangeGroups, everyN, objectCount, pdfInfo, loadPdf, looksLikePdf } from '../../tgcloud/lib/pdf.js';
import { jpegInfo, pngInfo, orientationMatrix, displayed } from '../../tgcloud/lib/images.js';
import { OPS, withSuffix, batchNames } from '../../tgcloud/lib/ops.js';
import { detect } from '../../tgcloud/lib/detect/index.js';
import { DEFAULT_LIMITS } from '../../tgcloud/lib/config.js';
import { zipOf, tarOf, paxPath, gzipOf, pdfOf, jpegOf, pngOf } from '../helpers/c2fixtures.mjs';
import { zip as storedZip } from '../helpers/fixtures.mjs';

const MB = 1024 * 1024;
const L = DEFAULT_LIMITS;
const AL = { maxEntries: L.ARCHIVE_MAX_ENTRIES, maxUnpacked: L.ARCHIVE_MAX_UNPACKED_MB * MB, maxRatio: L.ARCHIVE_MAX_RATIO };
const enc = new TextEncoder();
const code = async (fn, expected) => {
  try { await fn(); } catch (e) { assert.equal(e.code, expected, `${e.code || e.message} ≠ ${expected}`); return; }
  assert.fail(`expected ${expected}`);
};

// ---- archives ----
test('ZIP: index, extraction with CRC check, Persian names, nested archives returned as files', () => {
  const inner = zipOf({ 'deep.txt': 'x' });
  const z = zipOf({ 'docs/گزارش.txt': 'سلام', 'img/a.txt': 'aaaa', 'nested.zip': inner, 'dir/': new Uint8Array(0) });
  const arc = openArchive(z, 'zip', 'a.zip', AL);
  assert.equal(arc.entries.length, 4);
  const files = extract(arc, AL);
  assert.deepEqual(files.map((f) => f.name), ['گزارش.txt', 'a.txt', 'nested.zip']);
  assert.equal(new TextDecoder().decode(files[0].bytes), 'سلام');
  assert.equal(detect(files[2].bytes, 'nested.zip').id, 'zip', 'not opened');
});

test('zip-slip and absolute paths are refused before anything is extracted', () => {
  for (const name of ['../evil.txt', 'a/../../evil', '/etc/passwd', 'C:/win.ini', 'a\\..\\..\\x']) {
    assert.throws(() => zipEntries(storedZip([[name, 'x']]), AL), (e) => e.code === 'ARCHIVE_UNSAFE_PATH', name);
  }
  assert.equal(safePath('a/b..c/d'), true);
});

test('symlinks, encrypted entries, too many entries, too big, unknown method', () => {
  assert.throws(() => zipEntries(storedZip([['link', 'target', { symlink: true }]]), AL), (e) => e.code === 'ARCHIVE_LINKS');
  assert.throws(() => zipEntries(storedZip([['s', 'x', { encrypted: true }]]), AL), (e) => e.code === 'ARCHIVE_ENCRYPTED');
  const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}.txt`, 'x']));
  assert.throws(() => zipEntries(zipOf(many, 0), AL), (e) => e.code === 'ARCHIVE_TOO_MANY');
  assert.throws(() => zipEntries(zipOf({ 'a.bin': new Uint8Array(3 * MB) }), { ...AL, maxUnpacked: 2 * MB, maxRatio: 1e9 }), (e) => e.code === 'ARCHIVE_TOO_BIG');
  const z = storedZip([['a.txt', 'hello']]);
  z[8 + 0] = z[8]; // keep
  const bad = Uint8Array.from(z);
  const cd = bad.length - 22 - (46 + 5); // central entry of "a.txt"
  bad[cd + 10] = 12; // bzip2
  assert.throws(() => zipEntries(bad, AL), (e) => e.code === 'ARCHIVE_UNSUPPORTED');
});

test('a small zip bomb is refused by ratio, and a lying size header can\'t inflate past it', () => {
  const bomb = zipOf({ 'zeros.bin': new Uint8Array(20 * MB) }, 9);
  assert.ok(bomb.length < 50 * 1024);
  assert.throws(() => zipEntries(bomb, AL), (e) => e.code === 'ARCHIVE_BOMB');
  // forge the declared size down to 1 KB and the ratio check passes — extraction still stops
  const forged = Uint8Array.from(bomb);
  const cdOff = forged.length - 22 - (46 + 'zeros.bin'.length);
  new DataView(forged.buffer).setUint32(cdOff + 24, 1024, true);
  const arc = openArchive(forged, 'zip', 'b.zip', AL);
  assert.throws(() => extract(arc, AL), (e) => e.code === 'ARCHIVE_DAMAGED');
  assert.throws(() => inflateBounded(deflateSync(new Uint8Array(30 * MB)), 5 * MB), (e) => e.code === 'ARCHIVE_BOMB');
});

test('small but very compressible files are not called bombs', () => {
  const arc = openArchive(zipOf({ 'zeros.txt': new Uint8Array(100 * 1024) }, 9), 'zip', 'a.zip', AL);
  assert.equal(extract(arc, AL)[0].bytes.length, 100 * 1024);
});

test('truncated / damaged archives', () => {
  const z = zipOf({ 'a.txt': 'hello world'.repeat(100) });
  assert.throws(() => openArchive(z.subarray(0, z.length - 10), 'zip', 'a.zip', AL), (e) => e.code === 'ARCHIVE_DAMAGED');
  const c = Uint8Array.from(z);
  c[40] ^= 0xff; // flip a byte of the compressed data
  assert.throws(() => extract(openArchive(c, 'zip', 'a.zip', AL), AL), (e) => e.code === 'ARCHIVE_DAMAGED');
  const t = tarOf([{ name: 'a.txt', data: 'hi' }]);
  const t2 = Uint8Array.from(t);
  t2[0] = 0x41; // header checksum no longer matches
  assert.throws(() => openArchive(t2, 'tar', 'a.tar', AL), (e) => e.code === 'ARCHIVE_DAMAGED');
});

test('TAR: files, dirs, ustar prefix, pax long names; links and devices refused', () => {
  const long = `${'d'.repeat(120)}/file.txt`;
  const t = tarOf([{ name: 'dir/', type: '5' }, { name: 'dir/a.txt', data: 'A' }, { name: 'b.txt', prefix: 'pre', data: 'B' }, paxPath(long), { name: 'short', data: 'C' }]);
  const arc = openArchive(t, 'tar', 'x.tar', AL);
  assert.deepEqual(arc.entries.map((e) => e.name), ['dir/', 'dir/a.txt', 'pre/b.txt', long]);
  assert.deepEqual(extract(arc, AL).map((f) => [f.name, new TextDecoder().decode(f.bytes)]), [['a.txt', 'A'], ['b.txt', 'B'], ['file.txt', 'C']]);
  for (const type of ['1', '2', '3']) {
    assert.throws(() => openArchive(tarOf([{ name: 'x', type, linkname: '/etc/passwd' }]), 'tar', 'x.tar', AL), (e) => e.code === 'ARCHIVE_LINKS', type);
  }
  assert.throws(() => openArchive(tarOf([{ name: '../../x', data: 'x' }]), 'tar', 'x.tar', AL), (e) => e.code === 'ARCHIVE_UNSAFE_PATH');
});

test('GZIP: tar.gz opens the tar; a plain .gz is one file; bombs and bad CRCs refused', () => {
  const tgz = gzipOf(tarOf([{ name: 'a.txt', data: 'A' }, { name: 'b.txt', data: 'B' }]));
  const arc = openArchive(tgz, 'gzip', 'x.tar.gz', AL);
  assert.equal(arc.inner, 'tar');
  assert.deepEqual(extract(arc, AL).map((f) => f.name), ['a.txt', 'b.txt']);
  const gz = gzipOf(enc.encode('hello'), 'notes.txt');
  const single = openArchive(gz, 'gzip', 'notes.txt.gz', AL);
  assert.equal(single.inner, 'file');
  assert.deepEqual(extract(single, AL).map((f) => f.name), ['notes.txt']);
  assert.throws(() => openArchive(gzipOf(new Uint8Array(20 * MB)), 'gzip', 'z.gz', AL), (e) => e.code === 'ARCHIVE_BOMB');
  const broken = Uint8Array.from(gz);
  broken[broken.length - 6] ^= 1;
  assert.throws(() => openArchive(broken, 'gzip', 'z.gz', AL), (e) => e.code === 'ARCHIVE_DAMAGED');
});

test('making ZIPs: compressed types stored, others deflated, unique names; parts ≤ max', () => {
  const z = makeZip([{ name: 'a.txt', bytes: enc.encode('x'.repeat(10000)), type: 'text' }, { name: 'a.txt', bytes: jpegOf(), type: 'jpeg' }]);
  const arc = openArchive(z, 'zip', 'o.zip', AL);
  assert.deepEqual(arc.entries.map((e) => [e.name, e.method]), [['a.txt', 8], ['a (2).txt', 0]]);
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.bin`, bytes: new Uint8Array(3 * MB) }));
  const { parts, skipped } = zipParts([...files, { name: 'huge.bin', bytes: new Uint8Array(11 * MB) }], 10 * MB);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 10 * MB));
  assert.deepEqual(skipped, ['huge.bin']);
  assert.deepEqual(flatNames(['a/x.txt', 'b/x.txt', 'X.txt']), ['x.txt', 'x (2).txt', 'X (3).txt']);
});

// ---- PDF ----
test('page ranges: "1-3,7,10-", reversed, Persian digits and comma, errors', () => {
  assert.deepEqual(parseRanges('1-3,7,10-', 12).pages, [0, 1, 2, 6, 9, 10, 11]);
  assert.deepEqual(parseRanges('-2', 5).pages, [0, 1]);
  assert.deepEqual(parseRanges('۳–۱', 5).pages, [2, 1, 0]);
  assert.deepEqual(parseRanges('۱، ۴', 5).pages, [0, 3]);
  assert.deepEqual(parseRanges('6', 5), { ok: false, error: 'out_of_range', page: 6 });
  assert.deepEqual(parseRanges('a-b', 5), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRanges('  ', 5), { ok: false, error: 'empty' });
  assert.deepEqual(rangeGroups('1-2, 3-5', 5).groups, [[0, 1], [2, 3, 4]]);
  assert.deepEqual(everyN(5, 2), [[0, 1], [2, 3], [4]]);
});

test('PDF info, object count, encrypted and damaged files', async () => {
  const pdf = await pdfOf(4);
  assert.equal((await pdfInfo(pdf, 1000)).pages, 4);
  assert.ok(objectCount(pdf) > 4);
  assert.equal((await pdfInfo(pdf, 2)).problem, 'PDF_TOO_COMPLEX');
  await code(() => loadPdf(pdf, 2), 'PDF_TOO_COMPLEX');
  assert.equal((await pdfInfo(enc.encode('%PDF-1.4 garbage'), 1000)).problem, 'PDF_DAMAGED');
  // an encryption dictionary in the trailer marks it encrypted
  const doc = await PDFDocument.load(pdf);
  doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: 'x', U: 'y', P: -4 });
  const encrypted = await doc.save({ objectsPerTick: Infinity, useObjectStreams: false });
  assert.equal((await pdfInfo(encrypted, 1000)).problem, 'PDF_ENCRYPTED');
  await code(() => OPS.pdf_extract.run([{ bytes: encrypted, name: 'e.pdf', type: 'pdf' }], { ranges: '1' }, L), 'PDF_ENCRYPTED');
});

const pagesOf = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();
const texts = async (bytes) => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => { const c = p.node.Contents(); return c ? new TextDecoder('latin1').decode(c.contents || new Uint8Array()) : ''; });
};

test('extract / remove / reorder / rotate pages', async () => {
  const pdf = await pdfOf(5);
  const f = [{ bytes: pdf, name: 'گزارش.pdf', type: 'pdf' }];
  const ex = (await OPS.pdf_extract.run(f, { ranges: '4,2' }, L)).outputs[0];
  assert.equal(ex.name, 'گزارش_pages.pdf');
  assert.equal(await pagesOf(ex.bytes), 2);
  assert.equal(ex.meta.pdf.pages, 2);
  assert.equal(await pagesOf((await OPS.pdf_remove.run(f, { ranges: '1-2' }, L)).outputs[0].bytes), 3);
  await code(() => OPS.pdf_remove.run(f, { ranges: '1-5' }, L), 'PDF_NOTHING_LEFT');
  await code(() => OPS.pdf_extract.run(f, { ranges: '9' }, L), 'PDF_BAD_RANGE');
  const re = (await OPS.pdf_reorder.run(f, { ranges: '3,1' }, L)).outputs[0];
  assert.equal(await pagesOf(re.bytes), 5, 'pages not mentioned follow in order');
  const rot = (await OPS.pdf_rotate.run(f, { deg: 90, ranges: '2' }, L)).outputs[0];
  const doc = await PDFDocument.load(rot.bytes);
  assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [0, 90, 0, 0, 0]);
  const all = (await OPS.pdf_rotate.run([{ ...f[0], bytes: rot.bytes }], { deg: 270 }, L)).outputs[0];
  assert.deepEqual((await PDFDocument.load(all.bytes)).getPages().map((p) => p.getRotation().angle), [270, 0, 270, 270, 270]);
  assert.ok((await texts(re.bytes)).length === 5);
});

test('split: every N, by ranges, limits', async () => {
  const f = [{ bytes: await pdfOf(5), name: 'a.pdf', type: 'pdf' }];
  const each = await OPS.pdf_split.run(f, { mode: 'n', n: 2 }, L);
  assert.deepEqual(each.outputs.map((o) => [o.name, o.meta.pdf.pages]), [['a_part01.pdf', 2], ['a_part02.pdf', 2], ['a_part03.pdf', 1]]);
  const byRanges = await OPS.pdf_split.run(f, { mode: 'ranges', ranges: '1-3,4-5' }, L);
  assert.deepEqual(byRanges.outputs.map((o) => o.meta.pdf.pages), [3, 2]);
  await code(() => OPS.pdf_split.run(f, { mode: 'n', n: 1 }, { ...L, PDF_MAX_PARTS: 3 }), 'PDF_TOO_MANY_PARTS');
  await code(() => OPS.pdf_split.run(f, { mode: 'n', n: 10 }, L), 'PDF_ONE_PART');
});

test('combine: PDFs + JPEG (EXIF orientation) + PNG into one A4 PDF; limits', async () => {
  const items = [{ bytes: await pdfOf(2), name: 'a.pdf', type: 'pdf' }, { bytes: jpegOf(6), name: 'p.jpg', type: 'jpeg' }, { bytes: pngOf(40, 20), name: 'q.png', type: 'png' }];
  const r = await OPS.pdf_combine.run(items, { name: 'all.pdf' }, L);
  const out = r.outputs[0];
  assert.equal(out.name, 'all.pdf');
  assert.equal(await pagesOf(out.bytes), 4);
  const doc = await PDFDocument.load(out.bytes);
  const [, , jpgPage, pngPage] = doc.getPages();
  assert.ok(jpgPage.getHeight() > jpgPage.getWidth(), 'EXIF 6: a 64×32 photo is shown portrait');
  assert.ok(pngPage.getWidth() > pngPage.getHeight(), 'a landscape PNG gets a landscape A4 page');
  const single = await OPS.pdf_combine.run([{ bytes: jpegOf(), name: 'photo.jpg', type: 'jpeg' }], {}, L);
  assert.equal(single.outputs[0].name, 'photo.pdf');
  await code(() => OPS.pdf_combine.run([{ bytes: pngOf(4000, 4000), name: 'big.png', type: 'png' }], {}, L), 'IMAGE_TOO_BIG');
  await code(() => OPS.pdf_combine.run([{ bytes: jpegOf().subarray(0, 20), name: 'x.jpg', type: 'jpeg' }], {}, L), 'IMAGE_DAMAGED');
  await code(() => OPS.pdf_combine.run([{ bytes: enc.encode('x'), name: 'x.txt', type: 'text' }], {}, L), 'PDF_INPUT_TYPE');
  assert.ok(looksLikePdf(out.bytes));
});

test('EXIF orientation matrices put the image corners where they belong', () => {
  const apply = ([a, b, c, d, e, f], u, v) => [a * u + c * v + e, b * u + d * v + f];
  // display box (10, 20, 30 wide, 60 high); raw top-left is (u=0, v=1)
  const box = [10, 20, 30, 60];
  const tl = (o) => apply(orientationMatrix(o, ...box), 0, 1);
  assert.deepEqual(tl(1), [10, 80], '1: top-left stays top-left');
  assert.deepEqual(tl(3), [40, 20], '3: 180° → bottom-right');
  assert.deepEqual(tl(6), [40, 80], '6: rotated 90° CW → top-right');
  assert.deepEqual(tl(8), [10, 20], '8: rotated 90° CCW → bottom-left');
  assert.deepEqual(tl(2), [40, 80], '2: mirrored → top-right');
  assert.deepEqual(displayed(64, 32, 6), [32, 64]);
  assert.equal(jpegInfo(jpegOf(8)).orientation, 8);
  assert.deepEqual(pngInfo(pngOf(7, 9)), { width: 7, height: 9, bitDepth: 8, colorType: 2, interlace: 0 });
  assert.equal(jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
});

// ---- ops ----
test('ops: batch names (prefix, suffix, numbering), suffix names stay within Telegram\'s 64', () => {
  const inputs = [{ name: 'a.jpg', type: 'jpeg' }, { name: 'b.png', type: 'png' }, { name: 'c', type: 'unknown' }];
  assert.deepEqual(batchNames(inputs, 'number', 'سفر'), ['سفر_01.jpg', 'سفر_02.png', 'سفر_03']);
  assert.deepEqual(batchNames(inputs, 'prefix', '2026'), ['2026 a.jpg', '2026 b.png', '2026 c']);
  assert.deepEqual(batchNames(inputs, 'suffix', '-x'), ['a-x.jpg', 'b-x.png', 'c-x']);
  const long = withSuffix(`${'ن'.repeat(70)}.pdf`, '_part01', 'pdf');
  assert.equal([...long.replace(/\.pdf$/, '')].length, 64);
});

test('ops: zip, extract (empty files noted), extract_zip parts, batch fix', async () => {
  const z = (await OPS.zip.run([{ name: 'a.txt', bytes: enc.encode('A'), type: 'text' }, { name: 'b.pdf', bytes: await pdfOf(1), type: 'pdf' }], { name: 'x.zip' }, L)).outputs[0];
  assert.equal(z.name, 'x.zip');
  assert.equal(detect(z.bytes, 'x.zip').id, 'zip');
  const arcBytes = zipOf({ 'a.txt': 'A', 'empty.txt': new Uint8Array(0), 'b.pdf': await pdfOf(1) });
  const r = await OPS.extract.run([{ bytes: arcBytes, name: 'in.zip', type: 'zip' }], {}, L);
  assert.deepEqual(r.outputs.map((o) => [o.name, o.type]), [['a.txt', 'text'], ['b.pdf', 'pdf']]);
  assert.deepEqual(r.notes.map((n) => n.key), ['note.empty_skipped']);
  const one = await OPS.extract_one.run([{ bytes: arcBytes, name: 'in.zip', type: 'zip' }], { index: 2 }, L);
  assert.equal(one.outputs[0].name, 'b.pdf');
  const parts = await OPS.extract_zip.run([{ bytes: arcBytes, name: 'in.zip', type: 'zip' }], {}, L);
  assert.deepEqual(parts.outputs.map((o) => o.name), ['in.zip']);
  const fixed = await OPS.bfix.run([{ bytes: pngOf(2, 2), name: 'x.jpg', type: 'png' }, { bytes: jpegOf(), name: 'y.jpg', type: 'jpeg' }], {}, L);
  assert.deepEqual(fixed.outputs.map((o) => o.name), ['x.png']);
  await code(() => OPS.bfix.run([{ bytes: jpegOf(), name: 'y.jpg', type: 'jpeg' }], {}, L), 'NOTHING_TO_FIX');
});

test('15 MB inputs stay within the measured budgets (local Node is ~2x slower than Serverless)', async () => {
  // text-like data (≈ 5x compressible, like real text); a periodic pattern would be a "bomb"
  const words = ['سلام', 'فایل', 'تبدیل', 'hello', 'world', 'convert', 'telegram', '2026'].map((w) => enc.encode(`${w} `));
  const big = new Uint8Array(15 * MB);
  let x = 1;
  for (let o = 0; o < big.length;) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; const w = words[(x >>> 16) % words.length]; big.set(w.subarray(0, Math.min(w.length, big.length - o)), o); o += w.length; }
  let t = performance.now();
  const z = makeZip([{ name: 'big.txt', bytes: big, type: 'text' }]);
  const zipMs = performance.now() - t;
  t = performance.now();
  extract(openArchive(z, 'zip', 'b.zip', AL), AL);
  const unzipMs = performance.now() - t;
  assert.ok(zipMs < 3000 && unzipMs < 1000, `zip ${zipMs} ms, unzip ${unzipMs} ms`);
  assert.equal(detect(z, 'x.zip').id, 'zip');
});
