// C3 pure parts: base64, the Gemini request/response contract, script detection, DOCX, Pacific days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBase64, toBase64Bytes } from '../../tgcloud/lib/base64.js';
import { buildRequest, requestBody, parseResponse, scriptOf, MODELS, PROMPT } from '../../tgcloud/lib/gemini.js';
import { textToDocx, isRtlLine } from '../../tgcloud/lib/docx.js';
import { detect } from '../../tgcloud/lib/detect/index.js';
import { openArchive, extract } from '../../tgcloud/lib/archive.js';
import { pacificDay, secondsToPacificMidnight } from '../../tgcloud/lib/util.js';
import { OPS } from '../../tgcloud/lib/ops.js';
import { DEFAULT_LIMITS } from '../../tgcloud/lib/config.js';
import { jpegOf, pdfOf } from '../helpers/c2fixtures.mjs';

const code = async (fn, expected) => {
  try { await fn(); } catch (e) { assert.equal(e.code, expected, `${e.code || e.message} ≠ ${expected}`); return; }
  assert.fail(`expected ${expected}`);
};

test('base64 matches Node for every remainder and a large input', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100, 49152, 49153, 49154]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
    assert.equal(toBase64(b), Buffer.from(b).toString('base64'), String(n));
  }
  const big = new Uint8Array(14 * 1024 * 1024).map((_, i) => i & 255);
  const t = performance.now();
  assert.equal(toBase64(big).length, Math.ceil(big.length / 3) * 4);
  assert.ok(performance.now() - t < 2000);
});

test('base64 as bytes = base64 as a string; the byte body is the same JSON as buildRequest', () => {
  for (const n of [0, 1, 2, 3, 7, 1000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 13 + 5) & 255);
    assert.equal(new TextDecoder().decode(toBase64Bytes(b)), Buffer.from(b).toString('base64'), String(n));
  }
  const img = new Uint8Array(5000).map((_, i) => i & 255);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(requestBody(img, 'image/png'))), buildRequest(img, 'image/png'));
});

test('the request: inline image + strict prompt, temperature 0; the key is never in it', () => {
  const r = buildRequest(new Uint8Array([1, 2, 3]), 'image/png');
  assert.deepEqual(r.contents[0].parts[0], { inline_data: { mime_type: 'image/png', data: 'AQID' } });
  assert.equal(r.contents[0].parts[1].text, PROMPT);
  assert.match(PROMPT, /Do not translate/);
  assert.equal(r.generationConfig.temperature, 0);
  assert.ok(MODELS.includes('gemini-3.6-flash') && !MODELS.includes('gemini-2.5-flash'), 'no deprecated model');
});

test('responses: text, code fences stripped, no text, blocked, errors by status/reason', () => {
  const ok = (text, finish = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: finish }], usageMetadata: { totalTokenCount: 42 } });
  assert.deepEqual(parseResponse(200, ok('سلام\nدنیا')), { text: 'سلام\nدنیا', finish: 'STOP', tokens: 42, truncated: false });
  assert.equal(parseResponse(200, ok('```\nhello\n```')).text, 'hello');
  assert.equal(parseResponse(200, ok('a', 'MAX_TOKENS')).truncated, true);
  assert.throws(() => parseResponse(200, ok('[NO_TEXT]')), (e) => e.code === 'OCR_NO_TEXT');
  assert.throws(() => parseResponse(200, ok('x', 'SAFETY')), (e) => e.code === 'GEMINI_BLOCKED');
  assert.throws(() => parseResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }), (e) => e.code === 'GEMINI_BLOCKED');
  const err = (status, reason, st, message = '') => JSON.stringify({ error: { code: status, status: st, message, details: reason ? [{ reason }] : [] } });
  assert.throws(() => parseResponse(400, err(400, 'API_KEY_INVALID', 'INVALID_ARGUMENT', 'API key not valid')), (e) => e.code === 'GEMINI_KEY');
  assert.throws(() => parseResponse(429, err(429, null, 'RESOURCE_EXHAUSTED')), (e) => e.code === 'GEMINI_QUOTA');
  assert.throws(() => parseResponse(404, err(404, null, 'NOT_FOUND')), (e) => e.code === 'GEMINI_MODEL');
  assert.throws(() => parseResponse(400, err(400, null, 'FAILED_PRECONDITION', 'User location is not supported')), (e) => e.code === 'GEMINI_REGION');
  assert.throws(() => parseResponse(503, 'oops'), (e) => e.code === 'GEMINI_FAILED');
});

test('script detection (Persian and Arabic can\'t be told apart — the help says so)', () => {
  assert.equal(scriptOf('سلام دنیا'), 'arabic');
  assert.equal(scriptOf('hello world'), 'latin');
  assert.equal(scriptOf('سلام hello دنیا world'), 'mixed');
  assert.equal(scriptOf('12345 !!'), 'other');
});

test('DOCX: a valid Word file our detector recognizes, RTL paragraphs for Persian lines', () => {
  const docx = textToDocx('سلام دنیا\nHello <world> & co\n۱۲۳');
  assert.equal(detect(docx, 'x.docx').id, 'docx');
  const arc = openArchive(docx, 'zip', 'x.docx', { maxEntries: 10, maxUnpacked: 1e7, maxRatio: 1e4 });
  const xml = new TextDecoder().decode(extract(arc, { maxEntries: 10, maxUnpacked: 1e7, maxRatio: 1e4 }).find((f) => f.name === 'document.xml').bytes);
  assert.match(xml, /<w:bidi\/><w:jc w:val="right"\/><\/w:pPr><w:r><w:rPr><w:rtl\/>.*سلام دنیا/);
  assert.match(xml, /Hello &lt;world&gt; &amp; co/);
  assert.equal(isRtlLine('123 سلام'), true);
  assert.equal(isRtlLine('abc سلام'), false);
});

test('Pacific days roll over at midnight Los Angeles time (DST aware)', () => {
  assert.equal(pacificDay(Date.UTC(2026, 10, 8, 7, 59) / 1000), '2026-11-07', '23:59 PST');
  assert.equal(pacificDay(Date.UTC(2026, 10, 8, 8, 0) / 1000), '2026-11-08', '00:00 PST');
  assert.equal(pacificDay(Date.UTC(2026, 6, 1, 6, 59) / 1000), '2026-06-30', '23:59 PDT');
  assert.equal(secondsToPacificMidnight(Date.UTC(2026, 10, 8, 7, 0) / 1000), 3600);
});

test('the OCR op: types, size, PDF page cap, the injected service, truncation note', async () => {
  const L = DEFAULT_LIMITS;
  const calls = [];
  const services = { ocr: async (bytes, mime) => { calls.push(mime); return { text: 'متن', truncated: true }; } };
  const r = await OPS.ocr.run([{ bytes: jpegOf(), name: 'a.jpg', type: 'jpeg' }], {}, L, services);
  assert.deepEqual([r.text, r.script, r.name, r.notes.map((n) => n.key)], ['متن', 'arabic', 'a_ocr.txt', ['note.ocr_truncated']]);
  assert.deepEqual(calls, ['image/jpeg']);
  await OPS.ocr.run([{ bytes: await pdfOf(5), name: 'p.pdf', type: 'pdf' }], {}, L, services);
  const six = await pdfOf(6);
  await code(() => OPS.ocr.run([{ bytes: six, name: 'p.pdf', type: 'pdf' }], {}, L, services), 'OCR_TOO_MANY_PAGES');
  await code(() => OPS.ocr.run([{ bytes: new Uint8Array(15 * 1024 * 1024), name: 'a.png', type: 'png' }], {}, L, services), 'GEMINI_TOO_BIG');
  await code(() => OPS.ocr.run([{ bytes: new Uint8Array(10), name: 'a.gif', type: 'gif' }], {}, L, services), 'OCR_INPUT_TYPE');
  await code(() => OPS.ocr.run([{ bytes: jpegOf(), name: 'a.jpg', type: 'jpeg' }], {}, L, null), 'GEMINI_OFF');
});
