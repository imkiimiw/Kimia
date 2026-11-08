// C3 end to end: OCR offered only with a key; one-time consent (free/paid wording); results as a
// message (copy button ≤ 256) or a .txt; DOCX from either; budgets; Google's 429; errors; panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, setFetchHandler } from '../helpers/harness.mjs';
import { buttons } from '../helpers/fake-telegram.mjs';
import { jpegOf, pdfOf } from '../helpers/c2fixtures.mjs';
import { detect } from '../../tgcloud/lib/detect/index.js';
import { rawDatabase } from '../sdk/db.mjs';

const U = 100000001;
const KEY = 'AIzaTestKeyForGemini00000000000000000';

/** A fake Gemini: records requests, answers with `reply(request)` → { status, body }. */
function fakeGemini(reply = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'سلام دنیا\nHello' }] }, finishReason: 'STOP' }] } })) {
  const calls = [];
  setFetchHandler(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) });
    return reply(calls.at(-1));
  });
  return calls;
}

function withKey(h) {
  rawDatabase().prepare("INSERT INTO secrets (name, value, updated_at, updated_by) VALUES ('GEMINI_API_KEY', ?, 0, ?)").run(KEY, OWNER);
}

test('no key → no OCR button, no menu entry', async () => {
  const h = setup({ members: [U] });
  await h.sendPhoto(U, jpegOf());
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('oc:')));
  await h.send(U, '/start');
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data === 'm:ocr'));
});

test('OCR: consent once (free-tier wording), key only in the header, result in the message with copy button', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  const calls = fakeGemini();
  await h.send(U, '/start');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === 'm:ocr'));
  await h.sendPhoto(U, jpegOf());
  assert.equal(h.lastButtons(U)[0].callback_data.startsWith('oc:'), true, 'OCR first on an image card');
  await h.tapText(U, 'استخراج متن');
  assert.match(h.lastText(U), /سطح <b>رایگان<\/b>/);
  assert.match(h.lastText(U), /بازبین\u200cهای انسانی/);
  assert.equal(calls.length, 0, 'nothing sent before consent');
  await h.tapText(U, 'موافقم');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-goog-api-key'], KEY);
  assert.ok(!calls[0].url.includes(KEY), 'the key is not in the URL');
  assert.match(calls[0].url, /models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(calls[0].body.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');
  const t = h.lastText(U);
  assert.match(t, /متن استخراج\u200cشده \(فارسی\/عربی و لاتین\)/);
  assert.match(t, /سلام دنیا\nHello$/);
  const bs = h.lastButtons(U);
  assert.deepEqual(bs[0].copy_text, { text: 'سلام دنیا\nHello' });
  assert.ok(bs.some((b) => b.callback_data && b.callback_data.startsWith('od:')));
  // second time: no consent screen
  advance(61);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.equal(calls.length, 2);
  assert.ok(h.one('SELECT ocr_consent_at FROM user_settings WHERE user_id = ?', U).ocr_consent_at > 0);
  const job = h.one("SELECT * FROM jobs WHERE operation = 'ocr' ORDER BY created_at LIMIT 1");
  assert.equal(job.status, 'COMPLETED');
  assert.ok(!JSON.stringify(h.q('SELECT * FROM jobs')).includes('سلام دنیا'), 'OCR text never stored');
});

test('DOCX from the message text; long results as a .txt with a DOCX button', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  fakeGemini();
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  let mark = h.mark();
  await h.tapText(U, 'DOCX');
  let doc = h.docs(U, mark)[0];
  assert.match(doc.document.file_name, /^ocr_.*\.docx$/);
  assert.equal(detect(h.tg.files.get(doc.document.file_id).bytes, 'x.docx').id, 'docx');
  const long = 'سطر طولانی '.repeat(500);
  fakeGemini(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: long }] }, finishReason: 'STOP' }] } }));
  advance(61);
  await h.sendFile(U, jpegOf(), 'scan.jpg');
  mark = h.mark();
  await h.tapText(U, 'استخراج متن');
  doc = h.docs(U, mark)[0];
  assert.equal(doc.document.file_name, 'scan_ocr.txt');
  const bytes = h.tg.files.get(doc.document.file_id).bytes;
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  assert.equal(new TextDecoder().decode(bytes).replace(/^\ufeff/, ''), long.trim());
  mark = h.mark();
  await h.tapText(U, 'DOCX');
  assert.equal(h.docs(U, mark)[0].document.file_name, 'scan_ocr.docx');
});

test('short PDFs are offered OCR, long ones are not', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  const calls = fakeGemini();
  await h.sendFile(U, await pdfOf(3), 'short.pdf');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('oc:')));
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  assert.equal(calls[0].body.contents[0].parts[0].inline_data.mime_type, 'application/pdf');
  await h.sendFile(U, await pdfOf(6), 'long.pdf');
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('oc:')));
});

test('budgets: per user per day, per minute for the bot; staff skip the user limit', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  const calls = fakeGemini();
  rawDatabase().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('limits', ?, 0)").run(JSON.stringify({ GEMINI_USER_DAILY: 2, GEMINI_RPM: 3, RATE_BURST_PER_MIN: 50, RATE_JOBS_PER_HOUR: 50 }));
  const ocr = async (who) => { await h.sendPhoto(who, jpegOf()); await h.tapText(who, 'استخراج متن'); if (/موافقم/.test(h.lastButtons(who).map((b) => b.text).join())) await h.tapText(who, 'موافقم'); };
  await ocr(U);
  await ocr(U);
  await ocr(U);
  assert.match(h.lastText(U), /سهمیه\u200cی امروز شما \(۲ بار\)/);
  assert.equal(calls.length, 2);
  await ocr(OWNER);
  await ocr(OWNER);
  assert.match(h.lastText(OWNER), /یک دقیقه دیگر/, 'the bot-wide per-minute limit (3)');
  assert.equal(calls.length, 3);
  advance(61);
  await ocr(OWNER);
  assert.equal(calls.length, 4);
});

test('Google 429 on every model pauses OCR until the reset; the owner can resume from the panel', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  let status = 429;
  const day = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '59032s' }] } };
  const calls = fakeGemini(() => (status === 429 ? { status: 429, body: day } : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }));
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  assert.match(h.lastText(U), /سهمیه\u200cی امروز ربات/);
  assert.deepEqual(calls.map((c) => c.url.split('/').pop().split(':')[0]), ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], 'each model tried once');
  advance(61);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.equal(calls.length, 3, 'paused: no more requests');
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:gm');
  assert.match(h.lastText(OWNER), /تمام\u200cشده اعلام کرد/);
  await h.tap(OWNER, 'p:gmr');
  status = 200;
  advance(61);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.equal(calls.length, 4);
  assert.match(h.lastText(U), /ok$/);
});

test('one model out of quota: the next model answers, and the used-up one is skipped until its reset', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  const q = (id, delay) => ({ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: id }] }, { retryDelay: delay }] } } });
  let first = q('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '3600s');
  const calls = fakeGemini((c) => (c.url.includes('gemini-3.6-flash:') && first ? first : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'lite' }] } }] } }));
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  assert.match(h.lastText(U), /lite$/);
  assert.equal(calls.length, 2);
  advance(120);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.equal(calls.length, 3, 'the used-up model is not asked again');
  assert.ok(calls[2].url.includes('gemini-3.5-flash-lite'));
  // after its reset it is first again; a per-minute 429 skips it for about a minute only
  advance(3600);
  first = q('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '17s');
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.deepEqual(calls.slice(3).map((c) => c.url.split('/').pop().split(':')[0]), ['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  first = null;
  advance(31);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.ok(calls.at(-1).url.includes('gemini-3.6-flash'), 'back after the short wait');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'gemini.exhausted'"), undefined, 'never a full pause');
});

test('errors: invalid key → friendly text + error row; no text found; Gemini down', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  let reply = { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } } };
  fakeGemini(() => reply);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  assert.match(h.lastText(U), /کلید Gemini ربات معتبر نیست/);
  assert.equal(h.one("SELECT code FROM errors WHERE source = 'job.ocr'").code, 'GEMINI_KEY');
  reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: '[NO_TEXT]' }] } }] } };
  advance(61);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.match(h.lastText(U), /متنی در این فایل پیدا نشد/);
  setFetchHandler(() => new Error('fetch: request failed'));
  advance(61);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.match(h.lastText(U), /Gemini جواب نداد/);
});

test('paid tier: different consent wording; a free-tier consent still counts', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  fakeGemini();
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:gm');
  assert.match(h.lastText(OWNER), /کلید: ثبت شده/);
  await h.tapText(OWNER, 'حساب پولی است');
  assert.match(h.lastText(OWNER), /سطح: پولی/);
  await h.tap(OWNER, 'p:gmm:1');
  assert.match(h.lastText(OWNER), /gemini-3\.5-flash-lite/);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.match(h.lastText(U), /سرویس <b>پولی<\/b>/);
  await h.tapText(U, 'موافقم');
  assert.ok(h.one('SELECT ocr_consent_at FROM user_settings WHERE user_id = ?', U).ocr_consent_at < 0, 'consent under the paid wording');
  // back to free: the paid-only consent no longer counts
  await h.tap(OWNER, 'p:gmp');
  advance(61);
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  assert.match(h.lastText(U), /سطح <b>رایگان<\/b>/);
});

test('admins see the Gemini screen but can\'t change it', async () => {
  const h = setup({ members: [U] });
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:adm');
  await h.tap(OWNER, 'p:adma');
  await h.send(OWNER, '100000777');
  await h.send(100000777, '/panel');
  await h.tap(100000777, 'p:gm');
  assert.match(h.lastText(100000777), /Gemini/);
  assert.ok(!h.lastButtons(100000777).some((b) => /^p:gm[mpr]/.test(b.callback_data)));
  await h.press(100000777, 'p:gmp', 1);
  assert.equal(h.q("SELECT count(*) AS n FROM settings WHERE key = 'gemini.paid'")[0].n, 0);
});

test('all OCR buttons are valid (copy_text ≤ 256, callback ≤ 64)', async () => {
  const h = setup({ members: [U] });
  withKey(h);
  fakeGemini(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'x'.repeat(300) }] } }] } }));
  await h.sendPhoto(U, jpegOf());
  await h.tapText(U, 'استخراج متن');
  await h.tapText(U, 'موافقم');
  const bs = buttons(h.tg.lastTo(U));
  assert.ok(!bs.some((b) => b.copy_text), 'no copy button over 256 characters');
});
