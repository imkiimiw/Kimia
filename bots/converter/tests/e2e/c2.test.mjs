// C2 end to end: albums → one batch, batch actions, archive extraction (and refusals), PDF page
// tools with typed ranges, image → PDF, forced-join resume of a whole album.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';
import { SAMPLES } from '../helpers/fixtures.mjs';
import { zipOf, tarOf, gzipOf, pdfOf, jpegOf, pngOf } from '../helpers/c2fixtures.mjs';
import { PDFDocument } from '../../tgcloud/lib/vendor/pdf-lib.js';
import { detect } from '../../tgcloud/lib/detect/index.js';
import { openArchive, extract } from '../../tgcloud/lib/archive.js';

const U = 100000001;
const MB = 1024 * 1024;
const AL = { maxEntries: 1000, maxUnpacked: 200 * MB, maxRatio: 100 };
const pages = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();

/** Sends files as one album (separate updates sharing a media_group_id, like Telegram). */
async function album(h, user, files, mg = 'MG1') {
  const results = [];
  for (const [bytes, name] of files) {
    const doc = h.tg.putFile(bytes, { name });
    results.push(await h.send(user, null, { document: doc, media_group_id: mg }));
  }
  return results;
}

test('an album becomes one batch with ONE status message, then the batch menu', async () => {
  const h = setup({ members: [U] });
  const mark = h.mark();
  await album(h, U, [[await pdfOf(2), 'a.pdf'], [jpegOf(), 'b.jpg'], [pngOf(30, 20), 'c.png']]);
  const sends = h.tg.callsOf('sendMessage', U, mark);
  assert.equal(sends.length, 1, 'one status message, no cards');
  assert.match(h.lastText(U), /۳ فایل دریافت شد/);
  assert.equal(h.q('SELECT count(*) AS n FROM files WHERE batch_id IS NOT NULL')[0].n, 3);
  await h.tapText(U, 'تمام شد');
  const t = h.lastText(U);
  assert.match(t, /دسته\u200cی ۳ فایلی/);
  const data = h.lastButtons(U).map((b) => b.callback_data);
  for (const p of ['bz:', 'bp:', 'br:', 'bl:']) assert.ok(data.some((d) => d.startsWith(p)), p);
});

test('batch → one PDF from PDFs and photos, in order', async () => {
  const h = setup({ members: [U] });
  await album(h, U, [[await pdfOf(2), 'a.pdf'], [jpegOf(6), 'b.jpg'], [pngOf(30, 20), 'c.png']]);
  await h.tapText(U, 'تمام شد');
  const mark = h.mark();
  await h.tapText(U, 'ساخت یک PDF');
  const docs = h.docs(U, mark);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].document.file_name, 'combined_3.pdf');
  assert.equal(await pages(h.tg.files.get(docs[0].document.file_id).bytes), 4);
  const job = h.one('SELECT * FROM jobs');
  assert.equal(job.operation, 'pdf_combine');
  assert.equal(job.input_type, '3 files');
  // a status message went through the stages and ended done
  assert.match(h.tg.callsOf('editMessageText', U).map((c) => c.params.text).at(-1), /✅ انجام شد/);
});

test('batch → ZIP of all files; batch numbering rename as a document album', async () => {
  const h = setup({ members: [U] });
  await album(h, U, [[SAMPLES.text[0], 'notes.txt'], [jpegOf(), 'IMG_1.jpg'], [pngOf(4, 4), 'shot.png']]);
  await h.tapText(U, 'تمام شد');
  let mark = h.mark();
  await h.tapText(U, 'ساخت ZIP');
  const zipDoc = h.docs(U, mark)[0];
  assert.match(zipDoc.document.file_name, /^files_\d{4}-\d\d-\d\d\.zip$/);
  const arc = openArchive(h.tg.files.get(zipDoc.document.file_id).bytes, 'zip', 'x.zip', AL);
  assert.deepEqual(arc.entries.map((e) => e.name), ['notes.txt', 'IMG_1.jpg', 'shot.png']);
  await h.tapText(U, 'کار دیگری'); // the ZIP has its own card
  assert.match(h.lastText(U), /۳ فایل/);
  advance(61);
  await h.press(U, `bm:${h.one('SELECT id FROM batches').id}`, 1);
  await h.tapText(U, 'تغییر نام گروهی');
  await h.tapText(U, 'شماره\u200cگذاری');
  mark = h.mark();
  await h.send(U, 'سفر');
  const group = h.tg.callsOf('sendMediaGroup', U, mark);
  assert.equal(group.length, 1, 'one album of documents');
  assert.deepEqual(group[0].result.map((m) => m.document.file_name), ['سفر_01.txt', 'سفر_02.jpg', 'سفر_03.png']);
  assert.match(h.lastText(U), /۳ فایل آماده شد/);
});

test('files sent while a batch is open join it; the batch closes after 10 quiet minutes', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, jpegOf(), 'a.jpg');
  await h.tapText(U, 'چند فایل با هم');
  assert.match(h.lastText(U), /۱ فایل دریافت شد/);
  await h.sendFile(U, pngOf(3, 3), 'b.png');
  assert.match(h.lastText(U), /۲ فایل دریافت شد/);
  advance(601);
  const mark = h.mark();
  await h.sendFile(U, SAMPLES.text[0], 'c.txt');
  assert.match(h.tg.callsOf('sendMessage', U, mark)[0].params.text, /متنی دریافت شد/, 'a card again: the batch went quiet');
});

test('batch limits: dangerous files left out, 20 files max, 50 MB total', async () => {
  const h = setup({ members: [U] });
  const [exe] = SAMPLES.exe;
  await album(h, U, [[jpegOf(), 'a.jpg'], [exe, 'setup.exe']]);
  await h.tapText(U, 'تمام شد');
  assert.match(h.lastText(U), /۱ فایل.*شرکت داده نمی\u200cشود/);
  // a too-big total switches the actions off
  const h2 = setup({ members: [U] });
  const big = new Uint8Array(19 * MB); big.set(SAMPLES.png[0]);
  await album(h2, U, [[big, 'a.png'], [big, 'b.png'], [big, 'c.png']]);
  await h2.tapText(U, 'تمام شد');
  assert.match(h2.lastText(U), /بیشتر از ۵۰ MB/);
  assert.ok(!h2.lastButtons(U).some((b) => b.callback_data.startsWith('bz:')));
  // 21st file: refused once, checked on its own
  const h3 = setup({ members: [U] });
  const files = Array.from({ length: 21 }, (_, i) => [SAMPLES.text[0], `f${i}.txt`]);
  await album(h3, U, files.slice(0, 10), 'A');
  await album(h3, U, files.slice(10, 20), 'B');
  advance(61);
  await album(h3, U, files.slice(20), 'C');
  assert.equal(h3.q('SELECT count(*) AS n FROM files WHERE batch_id IS NOT NULL')[0].n, 20);
  assert.ok(h3.tg.callsOf('sendMessage', U).some((c) => /حداکثر ۲۰ فایل/.test(c.params.text)));
});

test('archive card shows the index; extract ≤ 10 files sends them; nested archive stays closed', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, zipOf({ 'docs/a.txt': 'A', 'b.pdf': await pdfOf(1), 'inner.zip': zipOf({ 'x': 'x' }) }), 'pack.zip');
  assert.match(h.lastText(U), /۳ فایل،/);
  const mark = h.mark();
  await h.tapText(U, 'استخراج');
  assert.deepEqual(h.docs(U, mark).map((d) => d.document.file_name), ['a.txt', 'b.pdf', 'inner.zip']);
});

test('archive with > 10 files: pick from a paginated list, or all as ZIP parts', async () => {
  const h = setup({ members: [U] });
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, `file ${i}`]));
  await h.sendFile(U, tarOf(Object.entries(files).map(([name, data]) => ({ name, data }))), 'many.tar');
  await h.tapText(U, 'استخراج');
  assert.match(h.lastText(U), /۱۲ فایل دارد/);
  await h.tapText(U, 'انتخاب از فهرست');
  assert.match(h.lastText(U), /صفحه\u200cی ۱ از ۲/);
  await h.tapText(U, 'بعدی');
  let mark = h.mark();
  await h.tapText(U, 'f10.txt');
  assert.deepEqual(h.docs(U, mark).map((d) => d.document.file_name), ['f10.txt']);
  advance(61);
  await h.tapText(U, 'قبلی').catch(() => null);
  const ref = h.one("SELECT ref FROM files WHERE name = 'many.tar'").ref;
  mark = h.mark();
  await h.press(U, `ax:${ref}:z`, 1);
  const zips = h.docs(U, mark);
  assert.deepEqual(zips.map((d) => d.document.file_name), ['many.zip']);
  const arc = openArchive(h.tg.files.get(zips[0].document.file_id).bytes, 'zip', 'x.zip', AL);
  assert.equal(arc.entries.length, 12, 'TAR converted to ZIP');
});

test('unsafe archives are refused on the card: zip-slip, symlink tar, bomb, encrypted', async () => {
  const h = setup({ members: [U] });
  const { zip: storedZip } = await import('../helpers/fixtures.mjs');
  const cases = [
    [storedZip([['../../evil.sh', 'x']]), 'slip.zip', /مسیرهای ناامن/],
    [tarOf([{ name: 'link', type: '2', linkname: '/etc/passwd' }]), 'links.tar', /لینک نمادین/],
    [zipOf({ 'z.bin': new Uint8Array(20 * MB) }, 9), 'bomb.zip', /بمب زیپ/],
    [storedZip([['s.txt', 'x', { encrypted: true }]]), 'enc.zip', /رمز دارند/],
    [gzipOf(new Uint8Array(30 * MB)), 'bomb.gz', /بمب زیپ/],
  ];
  for (const [bytes, name, re] of cases) {
    advance(4);
    await h.sendFile(U, bytes, name);
    assert.match(h.lastText(U), re, name);
    assert.ok(!h.lastButtons(U).some((b) => b.callback_data.startsWith('ax:')), `${name}: no extract button`);
  }
  const ref = h.one("SELECT ref FROM files WHERE name = 'slip.zip'").ref;
  const mark = h.mark();
  await h.press(U, `ax:${ref}`, 1);
  assert.equal(h.docs(U, mark).length, 0, 'a forged extract press does nothing');
});

test('tar.gz extracts; a plain .gz gives its single file', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, gzipOf(tarOf([{ name: 'a.txt', data: 'A' }])), 'x.tar.gz');
  let mark = h.mark();
  await h.tapText(U, 'استخراج');
  assert.deepEqual(h.docs(U, mark).map((d) => d.document.file_name), ['a.txt']);
  await h.sendFile(U, gzipOf(new TextEncoder().encode('hi'), 'notes.txt'), 'notes.txt.gz');
  mark = h.mark();
  await h.tapText(U, 'استخراج');
  assert.deepEqual(h.docs(U, mark).map((d) => d.document.file_name), ['notes.txt']);
});

test('PDF card: page count; extract / remove / reorder by typed ranges; range errors keep waiting', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, await pdfOf(6), 'گزارش.pdf');
  assert.match(h.lastText(U), /PDF دریافت شد — ۶ صفحه/);
  await h.tapText(U, 'جدا کردن صفحه\u200cها');
  await h.send(U, '9');
  assert.match(h.lastText(U), /صفحه\u200cی ۹ وجود ندارد/);
  await h.send(U, 'abc');
  assert.match(h.lastText(U), /متوجه نشدم/);
  let mark = h.mark();
  await h.send(U, '۱-۲، ۵');
  let doc = h.docs(U, mark)[0];
  assert.equal(doc.document.file_name, 'گزارش_pages.pdf');
  assert.equal(await pages(h.tg.files.get(doc.document.file_id).bytes), 3);
  // the result's own card knows its page count
  await h.tapText(U, 'کار دیگری');
  assert.match(h.lastText(U), /۳ صفحه/);
  await h.tapText(U, 'حذف صفحه\u200cها');
  await h.send(U, '1-3');
  assert.match(h.lastText(U), /همه\u200cی ۳ صفحه/);
  mark = h.mark();
  await h.send(U, '2');
  doc = h.docs(U, mark)[0];
  assert.equal(await pages(h.tg.files.get(doc.document.file_id).bytes), 2);
});

test('PDF rotate (all / some pages) and split (every N, ranges; > 5 parts → one ZIP)', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, await pdfOf(12), 'big.pdf');
  await h.tapText(U, 'چرخش');
  let mark = h.mark();
  await h.tapText(U, '↻ 90°');
  let doc = h.docs(U, mark)[0];
  let rot = (await PDFDocument.load(h.tg.files.get(doc.document.file_id).bytes)).getPages().map((p) => p.getRotation().angle);
  assert.ok(rot.every((a) => a === 90));
  const ref = h.one("SELECT ref FROM files WHERE name = 'big.pdf'").ref;
  await h.press(U, `pd:${ref}:r`, 1);
  await h.tapText(U, 'فقط بعضی');
  await h.send(U, '2,4');
  assert.match(h.lastText(U), /<code>2,4<\/code>/);
  mark = h.mark();
  await h.tapText(U, '180°');
  doc = h.docs(U, mark)[0];
  rot = (await PDFDocument.load(h.tg.files.get(doc.document.file_id).bytes)).getPages().map((p) => p.getRotation().angle);
  assert.deepEqual(rot.slice(0, 5), [0, 180, 0, 180, 0]);
  advance(61);
  await h.press(U, `pd:${ref}:s`, 1);
  const opts = h.lastButtons(U).map((b) => b.text).join(' | ');
  assert.match(opts, /هر صفحه جدا \(۱۲ فایل\)/);
  mark = h.mark();
  await h.tapText(U, 'هر ۵ صفحه');
  assert.deepEqual(h.docs(U, mark).map((d) => d.document.file_name), ['big_part01.pdf', 'big_part02.pdf', 'big_part03.pdf']);
  mark = h.mark();
  await h.press(U, `ps:${ref}:1`, 1);
  const z = h.docs(U, mark);
  assert.deepEqual(z.map((d) => d.document.file_name), ['big_files.zip'], '12 parts > 5 → one ZIP');
  assert.equal(openArchive(h.tg.files.get(z[0].document.file_id).bytes, 'zip', 'x', AL).entries.length, 12);
  advance(61);
  await h.press(U, `ps:${ref}:r`, 1);
  mark = h.mark();
  await h.send(U, '1-6, 7-');
  assert.deepEqual(h.docs(U, mark).map((d) => d.document.file_name), ['big_part01.pdf', 'big_part02.pdf']);
});

test('JPG / PNG → PDF from the card; encrypted and damaged PDFs are reported only', async () => {
  const h = setup({ members: [U] });
  await h.sendPhoto(U, jpegOf(8));
  let mark = h.mark();
  await h.tapText(U, 'تبدیل به PDF');
  const doc = h.docs(U, mark)[0];
  assert.match(doc.document.file_name, /^photo_.*\.pdf$/);
  assert.equal(detect(h.tg.files.get(doc.document.file_id).bytes, 'x.pdf').id, 'pdf');
  const enc = await PDFDocument.load(await pdfOf(2));
  enc.context.trailerInfo.Encrypt = enc.context.obj({ Filter: 'Standard', V: 1, R: 2 });
  await h.sendFile(U, await enc.save({ objectsPerTick: Infinity, useObjectStreams: false }), 'locked.pdf');
  assert.match(h.lastText(U), /رمز دارد/);
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data.startsWith('pd:')));
  await h.sendFile(U, new TextEncoder().encode('%PDF-1.4\nbroken'), 'broken.pdf');
  assert.match(h.lastText(U), /خراب است/);
});

test('ZIP of one file from the card; «بیشتر ▸» shows the rest of the actions', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, await pdfOf(3), 'doc.pdf');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data.startsWith('fm:')), 'a PDF has more than 7 actions');
  await h.tapText(U, 'بیشتر');
  const mark = h.mark();
  await h.tapText(U, '📦 ZIP');
  const z = h.docs(U, mark)[0];
  assert.equal(z.document.file_name, 'doc.zip');
  assert.deepEqual(extract(openArchive(h.tg.files.get(z.document.file_id).bytes, 'zip', 'x', AL), AL).map((f) => f.name), ['doc.pdf']);
});

test('forced join: an album is queued (one join screen) and resumed as one batch', async () => {
  const h = setup();
  const mark = h.mark();
  await album(h, U, [[jpegOf(), 'a.jpg'], [pngOf(2, 2), 'b.png'], [SAMPLES.text[0], 'c.txt']]);
  assert.equal(h.tg.callsOf('sendMessage', U, mark).length, 1, 'one join screen for three files');
  h.join(U);
  await h.tap(U, 'j');
  assert.match(h.lastText(U), /۳ فایل دریافت شد/);
  assert.equal(h.q('SELECT count(*) AS n FROM files WHERE batch_id IS NOT NULL')[0].n, 3);
});

test('maintenance: an album gets one notice, not one per file', async () => {
  const h = setup({ members: [U] });
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:mt');
  const mark = h.mark();
  await album(h, U, [[jpegOf(), 'a.jpg'], [jpegOf(), 'b.jpg'], [jpegOf(), 'c.jpg']], 'M');
  assert.equal(h.tg.callsOf('sendMessage', U, mark).length, 1);
});

test('staff retry of a failed batch job sends the result to the user', async () => {
  const h = setup({ members: [U] });
  await album(h, U, [[await pdfOf(1), 'a.pdf'], [await pdfOf(1), 'b.pdf']]);
  await h.tapText(U, 'تمام شد');
  h.tg.failNext('sendDocument', 500, 'Internal Server Error');
  await h.tapText(U, 'ساخت یک PDF');
  const failed = h.one("SELECT * FROM jobs WHERE status = 'FAILED'");
  assert.equal(failed.error_code, 'UPLOAD_FAILED');
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:fail');
  const mark = h.mark();
  await h.tap(OWNER, `p:rt:${failed.id}`);
  const docs = h.docs(U, mark);
  assert.equal(docs.length, 1);
  assert.equal(await pages(h.tg.files.get(docs[0].document.file_id).bytes), 2);
});

test('every new button stays ≤ 64 bytes (the fake Telegram refuses longer ones)', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, await pdfOf(3), `${'ن'.repeat(60)}.pdf`);
  for (const b of buttons(h.tg.lastTo(U))) if (b.callback_data) assert.ok(new TextEncoder().encode(b.callback_data).length <= 64);
});
