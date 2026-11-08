// C5 end to end (bot side): one OCR button, two engines (Gemini in the bot, Tesseract on the worker),
// the user's engine and language settings, automatic fallback, PDF tools, and the PDF password that is
// deleted from the chat and stored nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER } from '../helpers/harness.mjs';
import { jpegOf, pdfOf } from '../helpers/c2fixtures.mjs';
import { configureWorker, fakeWorker, posts } from '../helpers/fake-worker.mjs';
import { rawDatabase } from '../sdk/db.mjs';

const U = 100000001;
const KEY = 'AIzaTestKeyForGemini00000000000000000';
const withKey = () => rawDatabase().prepare("INSERT INTO secrets (name, value, updated_at, updated_by) VALUES ('GEMINI_API_KEY', ?, 0, ?)").run(KEY, OWNER);
const geminiOk = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'از هوش مصنوعی' }] } }] } });
const lastJob = (h) => h.one("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT 1");

async function encryptedPdf() {
  const bytes = await pdfOf(2);
  const s = Buffer.from(bytes).toString('latin1').replace('trailer\n<<', 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /P -4 >>');
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

test('worker only: the OCR button uses Tesseract with the language from the settings', async () => {
  const h = setup({ members: [U] });
  configureWorker();
  const w = fakeWorker();
  await h.send(U, '/start');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === 'm:ocr'), 'the OCR menu shows for offline OCR too');
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  let [job] = posts(w);
  assert.equal(job.op, 'ocr');
  assert.deepEqual(job.params, { lang: 'auto' });
  assert.equal(w.other.length, 0, 'nothing went to Google');
  // the language setting
  await h.send(U, '/settings');
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data === 's:oe'), 'no engine choice with one engine');
  await h.tap(U, 's:ol');
  await h.tap(U, 's:ol:ara');
  assert.match(h.lastText(U), /تنظیمات/);
  assert.ok(h.lastButtons(U).some((b) => b.text.includes('عربی')));
  advance(3);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  job = posts(w).at(-1);
  assert.deepEqual(job.params, { lang: 'ara' });
});

test('both engines: automatic = AI, offline from the settings or the consent screen, AI quota → offline', async () => {
  const h = setup({ members: [U] });
  withKey();
  configureWorker();
  const w = fakeWorker({ other: () => geminiOk() });
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('ox:')), 'consent offers offline');
  await h.tapText(U, 'آفلاین');
  assert.equal(posts(w).at(-1).op, 'ocr');
  assert.equal(w.other.length, 0, 'offline from the consent screen: Google never asked');
  advance(3);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  assert.equal(w.other.length, 1, 'automatic: the AI');
  assert.match(h.lastText(U), /از هوش مصنوعی/);
  // settings: engine → offline
  await h.send(U, '/settings');
  await h.tap(U, 's:oe');
  await h.tap(U, 's:oe');
  assert.match(JSON.stringify(h.lastButtons(U)), /آفلاین/);
  advance(3);
  const before = posts(w).length;
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.equal(posts(w).length, before + 1, 'offline by choice');
  // back to automatic; the AI's quota is used up → offline without asking
  await h.send(U, '/settings');
  await h.tap(U, 's:oe');
  rawDatabase().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('gemini.exhausted', ?, 0)").run(String(Math.floor(Date.now() / 1000) + 3600));
  advance(61); // past the 3-jobs-a-minute limit
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.equal(posts(w).length, before + 2);
  assert.equal(w.other.length, 1, 'the paused AI is not asked');
});

test('PDF OCR: ≤ 5 pages AI, 6–20 pages offline, more than 20 no OCR', async () => {
  const h = setup({ members: [U] });
  withKey();
  configureWorker();
  const w = fakeWorker({ other: () => geminiOk() });
  await h.sendFile(U, await pdfOf(8), 'eight.pdf');
  await h.tapText(U, 'استخراج متن');
  const job = posts(w).at(-1);
  assert.equal(job.op, 'ocr');
  assert.equal(job.inputs[0].pages, 8, 'the page count goes along (timeouts)');
  await h.sendFile(U, await pdfOf(21), 'long.pdf');
  assert.ok(!JSON.stringify(h.lastButtons(U)).includes('"oc:'), 'no OCR for 21 pages');
});

test('PDF tools: compress, to images, watermark with text', async () => {
  const h = setup({ members: [U] });
  configureWorker();
  const w = fakeWorker();
  await h.sendFile(U, await pdfOf(3), 'report.pdf');
  await h.tapText(U, 'ابزار پیشرفته');
  assert.match(h.lastText(U), /ابزار پیشرفته\u200cی PDF|ابزار پیشرفته\u200cی PDF/);
  await h.tapText(U, 'کم\u200cحجم کردن');
  await h.tapText(U, 'متعادل');
  let job = posts(w).at(-1);
  assert.equal(job.op, 'pdf.cp');
  assert.deepEqual(job.params, { level: 'md' });
  assert.equal(job.inputs[0].pages, 3);
  advance(3);
  await h.sendFile(U, await pdfOf(3), 'report2.pdf');
  await h.tapText(U, 'ابزار پیشرفته');
  await h.tapText(U, 'تبدیل به عکس');
  await h.tapText(U, 'باکیفیت');
  assert.deepEqual(posts(w).at(-1).params, { dpi: 300, format: 'jpg' });
  advance(3);
  await h.sendFile(U, await pdfOf(3), 'report3.pdf');
  await h.tapText(U, 'ابزار پیشرفته');
  await h.tapText(U, 'واترمارک');
  await h.send(U, 'محرمانه');
  await h.tapText(U, 'مورب');
  job = posts(w).at(-1);
  assert.equal(job.op, 'pdf.wm');
  assert.deepEqual(job.params, { position: 'diag', text: 'محرمانه' });
  assert.ok(!lastJob(h).params.includes('محرمانه'));
});

test('encrypted PDF: only «unlock»; the password message is deleted and the password stored nowhere', async () => {
  const h = setup({ members: [U] });
  configureWorker();
  const w = fakeWorker();
  await h.sendFile(U, await encryptedPdf(), 'locked.pdf');
  const btns = h.lastButtons(U).map((b) => b.callback_data);
  assert.ok(btns.some((b) => b && b.startsWith('wo:') && b.endsWith(':pu')), JSON.stringify(btns));
  assert.ok(!btns.some((b) => b && (b.startsWith('wi:') || b.startsWith('oc:'))));
  await h.tapText(U, 'باز کردن با رمز');
  assert.match(h.lastText(U), /پاک می\u200cشود/);
  const r = await h.send(U, 'S3cret-pass');
  const pwMsgId = h.tg.calls.filter((c) => c.method === 'deleteMessage').at(-1);
  assert.ok(pwMsgId, 'the password message was deleted');
  const job = posts(w).at(-1);
  assert.equal(job.op, 'pdf.ul');
  assert.deepEqual(job.params, { password: 'S3cret-pass' });
  const dump = JSON.stringify([h.q('SELECT * FROM jobs'), h.q('SELECT * FROM pending_actions'), h.q('SELECT * FROM errors')]);
  assert.ok(!dump.includes('S3cret'), 'the password is in no table');
  assert.ok(!JSON.stringify(r.trace).includes('S3cret'), 'nor in the trace');
});
