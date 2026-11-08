// The platform fails a query that reads more than ~50 000 rows (measured by the other Wanger bots),
// so no statement may scan a table that grows. This runs a broad scenario, then checks the query
// plan of every distinct statement it ran (tests/sdk/db.mjs records them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, advance, setFetchHandler } from '../helpers/harness.mjs';
import { SAMPLES } from '../helpers/fixtures.mjs';
import { zipOf, pdfOf, jpegOf } from '../helpers/c2fixtures.mjs';
import { queryPlans, rawDatabase } from '../sdk/db.mjs';

const U = 100000001;
const GROWING = ['users', 'user_settings', 'files', 'jobs', 'pending_actions', 'rate_counters', 'result_cache', 'errors', 'processed_updates', 'counters', 'batches'];
// small by construction (≤ 10 channels, a few admins/keys/settings, one row per broadcast)
const SMALL = ['channels', 'staff', 'settings', 'secrets', 'broadcasts'];

test('no statement scans a growing table', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/start');
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  await h.tapText(U, '✅ بله');
  await h.sendFile(U, SAMPLES.jpeg[0], 'b.jpg');
  await h.tapText(U, 'تغییر نام');
  await h.tapText(U, 'نام جدید');
  await h.send(U, 'new');
  // C2: album → batch → actions; archive and PDF tools; a never-inspected card
  for (const [bytes, name] of [[await pdfOf(2), 'a.pdf'], [jpegOf(), 'b.jpg']]) await h.send(U, null, { document: h.tg.putFile(bytes, { name }), media_group_id: 'Q' });
  await h.tapText(U, 'تمام شد');
  advance(61);
  await h.tapText(U, 'ساخت یک PDF');
  await h.tapText(U, 'کار دیگری');
  await h.press(U, `bl:${h.one('SELECT id FROM batches').id}`, 1);
  advance(61);
  await h.sendFile(U, zipOf({ 'x.txt': 'x' }), 'z.zip');
  await h.tapText(U, 'استخراج');
  await h.sendFile(U, await pdfOf(3), 'p.pdf');
  await h.tapText(U, 'جدا کردن');
  await h.send(U, '1-2');
  await h.send(U, '/history');
  await h.send(U, '/status');
  await h.send(U, '/settings');
  await h.tap(U, 's:dg');
  await h.send(OWNER, '/panel');
  for (const p of ['p:fail', 'p:act', 'p:ch', 'p:ban', 'p:adm', 'p:sec']) { await h.tap(OWNER, p); await h.tap(OWNER, 'p'); }
  await h.tap(OWNER, 'p:bc');
  await h.send(OWNER, 'hello');
  const id = h.one('SELECT id FROM broadcasts').id;
  await h.tap(OWNER, `p:bcgo:${id}`);
  // C4: worker flows against a fake worker (submit, status, history, cancel, result card, panel, housekeeping)
  for (const [n, v] of [['WORKER_URL', 'https://w.example.com'], ['WORKER_SECRET', 'x'.repeat(40)]]) rawDatabase().prepare('INSERT INTO secrets (name, value, updated_at, updated_by) VALUES (?, ?, 0, ?)').run(n, v, OWNER);
  const caps = { version: 't', ops: { 'img.sm': { inputs: ['jpeg'] }, tti: { inputs: [] } }, formats: { image_write: ['png'] }, limits: { max_input_mb: 20 } };
  setFetchHandler(async (url, init) => (url.endsWith('/v1/capabilities') ? { status: 200, body: caps } : init.method === 'POST' ? { status: 202, body: { job: { status: 'QUEUED', position: 1 } } } : { status: 200, body: { job: { status: 'PROCESSING', cancel_requested: true, outputs: [] } } }));
  await h.sendFile(U, jpegOf(), 'w.jpg');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'حذف EXIF');
  await h.send(U, '/status');
  await h.send(U, '/history');
  await h.send(U, '/cancel');
  await h.send(U, '/start');
  await h.tap(U, 'm:image');
  await h.tap(U, 'wt');
  await h.send(U, 'متن');
  await h.tapText(U, 'شب');
  await h.tapText(U, 'مربع');
  await h.press(U, `wf:${h.one("SELECT code FROM jobs WHERE engine = 'worker' LIMIT 1").code}`, 1);
  // C5: OCR settings (engine, offline language)
  await h.send(U, '/settings');
  await h.press(U, 's:oe', 1);
  await h.press(U, 's:ol:fas', 1);
  advance(300);
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:wk');
  await h.send(U, '/deletemydata');
  await h.tap(U, 'dd:y');
  advance(40 * 86400);
  await h.send(OWNER, '/panel');

  const bad = [];
  for (const { query, plan } of queryPlans()) {
    for (const line of plan) {
      const m = /^SCAN (\w+)\b(?! USING (?:COVERING )?INDEX)/.exec(line); // an index scan (incl. partial) is fine
      if (m && GROWING.includes(m[1])) bad.push(`${line}  ←  ${query}`);
      if (m && !GROWING.includes(m[1]) && !SMALL.includes(m[1]) && !/^SCAN (CONSTANT ROW|\d+-ROW VALUES CLAUSE)/.test(line)) bad.push(`unclassified: ${line}  ←  ${query}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(queryPlans().length > 40, `checked ${queryPlans().length} statements`);
});
