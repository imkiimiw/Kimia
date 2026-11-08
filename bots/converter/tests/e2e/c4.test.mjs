// C4 end to end (bot side) against a fake worker that checks every signature: tools hidden until the
// worker is configured and answering; image tools, watermark and text → image flows; what is sent to
// the worker (and what is never stored); refusals; worker down; lazy status; the result's card;
// cancel; the panel; the capabilities cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, advance, OWNER, setFetchHandler } from '../helpers/harness.mjs';
import { jpegOf, pngOf } from '../helpers/c2fixtures.mjs';
import { rawDatabase } from '../sdk/db.mjs';
import callbackHandler from '../../tgcloud/handlers/callback_query.js';

const U = 100000001;
const URL = 'https://worker.example.com';
const SECRET = 'w'.repeat(48);
const OPS = ['img.cv', 'img.rs', 'img.cr', 'img.ro', 'img.fl', 'img.cp', 'img.sm', 'img.gr', 'img.bl', 'img.sh', 'img.cm', 'img.wm', 'img.tx', 'tti'];
const TYPES = ['avif', 'bmp', 'gif', 'heic', 'ico', 'jpeg', 'png', 'tiff', 'webp'];
const CAPS = {
  version: '0.4.0', features: { raqm: true, heif: true },
  ops: Object.fromEntries(OPS.map((o) => [o, { group: 'image', queue: 'light', inputs: o === 'tti' ? [] : TYPES, min_inputs: o === 'tti' ? 0 : 1, max_inputs: o === 'tti' ? 0 : 1 }])),
  formats: { image_read: TYPES, image_write: ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'avif', 'heic'] },
  limits: { max_input_mb: 20 },
};

function configure() {
  const db = rawDatabase();
  for (const [n, v] of [['WORKER_URL', URL], ['WORKER_SECRET', SECRET]]) db.prepare('INSERT INTO secrets (name, value, updated_at, updated_by) VALUES (?, ?, 0, ?)').run(n, v, OWNER);
}

/** A fake worker: verifies HMAC + nonce + clock like app/security.py, records calls, keeps jobs. */
function fakeWorker({ caps = CAPS, submit = null, down = false } = {}) {
  const w = { calls: [], jobs: new Map(), nonces: new Set(), down };
  setFetchHandler(async (url, init) => {
    if (w.down) return new Error('connect failed');
    const u = new globalThis.URL(url);
    const path = u.pathname + u.search;
    const body = init.body ? (typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : '';
    const h = init.headers || {};
    const ts = h['X-Wanger-Timestamp'];
    const nonce = h['X-Wanger-Nonce'];
    const expected = createHmac('sha256', SECRET).update(`${ts}.${nonce}.${init.method}.${path}.${body}`).digest('hex');
    assert.equal(h['X-Wanger-Signature'], expected, `signature of ${init.method} ${path}`);
    assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 300, 'timestamp near now');
    assert.ok(!w.nonces.has(nonce), 'nonce reused');
    w.nonces.add(nonce);
    assert.ok(!JSON.stringify(h).includes(SECRET) && !url.includes(SECRET) && !body.includes(SECRET), 'the secret is never sent');
    const data = body ? JSON.parse(body) : null;
    w.calls.push({ method: init.method, path, data });
    if (path === '/v1/capabilities') return { status: 200, body: caps };
    if (path === '/v1/health') return { status: 200, body: { version: '0.4.0', uptime_s: 7200, queues: { light: { QUEUED: 2 }, heavy: {} }, disk_free_mb: 900 } };
    if (init.method === 'POST' && path === '/v1/jobs') {
      if (submit) { const r = submit(data); if (r) return r; }
      const job = { id: data.job_id, code: data.code, op: data.op, status: 'QUEUED', position: 1, cancel_requested: false, outputs: [], notes: [], error_code: null, finished_at: null, user: data.user_id };
      w.jobs.set(data.job_id, job);
      return { status: 202, body: { job } };
    }
    const m = /^\/v1\/jobs\/([^?]+)\?user_id=(\d+)$/.exec(path);
    if (m) {
      const job = w.jobs.get(m[1]);
      if (!job || String(job.user) !== m[2]) return { status: 404, body: { error: 'NOT_FOUND' } };
      if (init.method === 'DELETE') {
        if (job.status === 'QUEUED') job.status = 'CANCELLED';
        else if (['DOWNLOADING', 'PROCESSING', 'UPLOADING'].includes(job.status)) job.cancel_requested = true;
      }
      return { status: 200, body: { job } };
    }
    return { status: 404, body: { error: 'NOT_FOUND' } };
  });
  return w;
}

const posts = (w) => w.calls.filter((c) => c.method === 'POST');
const capsCalls = (w) => w.calls.filter((c) => c.path === '/v1/capabilities').length;
const lastJob = (h) => h.one("SELECT * FROM jobs WHERE engine = 'worker' ORDER BY created_at DESC, id DESC LIMIT 1");

test('no worker configured: no image tools, no menu entry, nothing fetched', async () => {
  const h = setup({ members: [U] });
  setFetchHandler(() => { throw new Error('must not fetch'); });
  await h.sendPhoto(U, jpegOf());
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('wi:')));
  await h.send(U, '/start');
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data === 'm:image'));
});

test('configured and answering: tools on image cards and in the menu; capabilities cached 10 min', async () => {
  const h = setup({ members: [U] });
  configure();
  const w = fakeWorker();
  await h.send(U, '/start');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === 'm:image'));
  await h.sendFile(U, pngOf(), 'pic.png');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('wi:')));
  assert.equal(capsCalls(w), 1, 'one capabilities request for both screens');
  advance(300);
  await h.send(U, '/start');
  assert.equal(capsCalls(w), 1);
  advance(301);
  await h.send(U, '/start');
  assert.equal(capsCalls(w), 2, 're-read after 10 minutes');
  await h.tap(U, 'm:image');
  assert.match(h.lastText(U), /ابزار عکس/);
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === 'wt'));
});

test('convert: the job goes to the worker with exactly what it needs; status message with cancel', async () => {
  const h = setup({ members: [U] });
  configure();
  const w = fakeWorker();
  await h.sendFile(U, jpegOf(), 'holiday.jpg');
  await h.tapText(U, 'ابزار عکس');
  assert.match(h.lastText(U), /holiday\.jpg/);
  await h.tapText(U, 'تبدیل فرمت');
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data && b.callback_data.endsWith(':cv.jpg')), 'no JPG → JPG');
  await h.tapText(U, 'WEBP');
  const [p] = posts(w);
  const file = h.one('SELECT * FROM files ORDER BY created_at DESC LIMIT 1');
  const job = lastJob(h);
  assert.equal(p.path, '/v1/jobs');
  assert.deepEqual(Object.keys(p.data).sort(), ['chat_id', 'code', 'inputs', 'job_id', 'lang', 'op', 'params', 'reply_to', 'status_message_id', 'user_id']);
  assert.equal(p.data.op, 'img.cv');
  assert.deepEqual(p.data.params, { format: 'webp' });
  assert.deepEqual(p.data.inputs, [{ file_id: file.file_id, name: 'holiday.jpg', type: 'jpeg', size: file.size }]);
  assert.equal(p.data.job_id, job.id);
  assert.equal(p.data.code, job.code);
  assert.equal(p.data.user_id, U);
  assert.equal(p.data.chat_id, U);
  assert.equal(p.data.lang, 'fa');
  assert.equal(job.status, 'QUEUED');
  assert.equal(job.engine, 'worker');
  assert.equal(job.operation, 'img.cv');
  // the status message is the one whose id went to the worker, with «🚫 لغو»
  const status = h.tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === U).at(-1);
  assert.equal(status.result.message_id, p.data.status_message_id);
  assert.match(status.params.text, /در صف/);
  assert.match(status.params.text, new RegExp(job.code));
  assert.equal(h.lastButtons(U)[0].callback_data, `wx:${job.code}`);
});

test('watermark: text asked, then the position; the text goes to the worker but is never stored', async () => {
  const h = setup({ members: [U] });
  configure();
  const w = fakeWorker();
  await h.sendFile(U, pngOf(), 'pic.png');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'واترمارک');
  assert.match(h.lastText(U), /متن واترمارک/);
  await h.send(U, 'x'.repeat(101));
  assert.match(h.lastText(U), /بیشتر از ۱۰۰ حرف/);
  await h.send(U, '@my_channel');
  assert.match(h.lastText(U), /کجای عکس/);
  assert.equal(posts(w).length, 0);
  await h.tapText(U, 'تکرار');
  const [p] = posts(w);
  assert.deepEqual(p.data.params, { position: 'tile', text: '@my_channel' });
  assert.equal(h.one('SELECT count(*) n FROM pending_actions').n, 0, 'pending text deleted');
  assert.ok(!lastJob(h).params.includes('my_channel'), 'the job row never holds user text');
});

test('text → image: text, theme, size → one job without input files', async () => {
  const h = setup({ members: [U] });
  configure();
  const w = fakeWorker();
  await h.send(U, '/start');
  await h.tap(U, 'm:image');
  await h.tap(U, 'wt');
  assert.match(h.lastText(U), /متن به عکس/);
  await h.send(U, 'سلام دنیا\nخط دوم');
  assert.match(h.lastText(U), /طرح رنگی/);
  await h.tapText(U, 'غروب');
  assert.match(h.lastText(U), /اندازه/);
  await h.tapText(U, 'استوری');
  const [p] = posts(w);
  assert.equal(p.data.op, 'tti');
  assert.deepEqual(p.data.inputs, []);
  assert.deepEqual(p.data.params, { text: 'سلام دنیا\nخط دوم', theme: 'sunset', preset: 'story' });
  const job = lastJob(h);
  assert.equal(job.input_type, 'TEXT');
  assert.ok(!job.params.includes('سلام'));
  assert.equal(h.one('SELECT count(*) n FROM pending_actions').n, 0);
  // pressing an old theme button after the job: asks for text again instead of failing
  await h.press(U, 'wt:g:dark:square', 1);
  assert.match(h.lastText(U), /متن را بفرستید/);
});

test('refusals and a dead worker: friendly texts, FAILED rows, tools hidden while down', async () => {
  const h = setup({ members: [U] });
  configure();
  let reply = { status: 429, body: { error: 'USER_BUSY' } };
  const w = fakeWorker({ submit: () => reply });
  await h.sendFile(U, pngOf(), 'pic.png');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'حذف EXIF');
  assert.match(h.lastText(U), /چند کار شما هنوز در صف است/);
  assert.equal(lastJob(h).status, 'FAILED');
  assert.equal(lastJob(h).error_code, 'WORKER_USER_BUSY');
  reply = { status: 401, body: { error: 'BAD_SIGNATURE' } };
  advance(3);
  await h.sendFile(U, pngOf(), 'pic2.png');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'حذف EXIF');
  assert.match(h.lastText(U), /درست تنظیم نشده/);
  assert.equal(h.one("SELECT code FROM errors WHERE code = 'WORKER_AUTH' LIMIT 1").code, 'WORKER_AUTH');
  // now the worker dies between the card and the button
  reply = null;
  await h.sendFile(U, pngOf(), 'pic3.png');
  await h.tapText(U, 'ابزار عکس');
  w.down = true;
  await h.tapText(U, 'حذف EXIF');
  assert.match(h.lastText(U), /سرور تبدیل الان در دسترس نیست/);
  assert.equal(lastJob(h).error_code, 'WORKER_DOWN');
  await h.sendFile(U, pngOf(), 'pic4.png');
  assert.ok(!h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('wi:')), 'hidden while down');
  w.down = false;
  advance(121);
  await h.sendFile(U, pngOf(), 'pic5.png');
  assert.ok(h.lastButtons(U).some((b) => b.callback_data && b.callback_data.startsWith('wi:')), 'back after 2 minutes');
});

test('/status asks the worker and stores the outcome; the result button opens a card', async () => {
  const h = setup({ members: [U] });
  configure();
  const w = fakeWorker();
  await h.sendFile(U, pngOf(), 'pic.png');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'تبدیل فرمت');
  await h.tapText(U, 'WEBP');
  const job = lastJob(h);
  // the worker finished and sent the document itself
  const doc = h.tg.putFile(new Uint8Array([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), { name: 'pic.webp' });
  Object.assign(w.jobs.get(job.id), { status: 'COMPLETED', finished_at: Date.now() / 1000, outputs: [{ file_id: doc.file_id, file_unique_id: doc.file_unique_id, name: 'pic.webp', type: 'webp', size: doc.file_size }] });
  await h.send(U, `/status ${job.code}`);
  assert.match(h.lastText(U), /انجام شد/);
  const row = h.one('SELECT * FROM jobs WHERE id = ?', job.id);
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.output_type, 'WEBP');
  assert.equal(row.output_file_id, doc.file_id);
  // «⚙️ کار دیگری با نتیجه» on the worker's document message
  advance(3);
  const cq = { id: 'cqwf', from: h.person(U), chat_instance: 'x', data: `wf:${job.code}`, message: { message_id: 4242, chat: { id: U, type: 'private' }, date: 0, document: doc } };
  await callbackHandler(cq, { update: { update_id: 900001, callback_query: cq } });
  const f = h.one('SELECT * FROM files WHERE file_id = ?', doc.file_id);
  assert.equal(f.type, 'webp');
  assert.equal(f.name, 'pic.webp');
  assert.match(h.lastText(U), /pic\.webp/);
  assert.ok(h.lastButtons(U).some((b) => b.callback_data === `wi:${f.ref}`), 'the result has its own tools');
  // someone else's code: nothing
  const cq2 = { ...cq, id: 'cqwf2', from: h.person(U + 1), message: { ...cq.message, chat: { id: U + 1, type: 'private' } } };
  h.join(U + 1);
  await callbackHandler(cq2, { update: { update_id: 900002, callback_query: cq2 } });
  assert.match(h.lastText(U + 1), /دیگر در دسترس نیست/);
});

test('cancel: the button, /cancel and /cancel CODE; finished jobs stay', async () => {
  const h = setup({ members: [U] });
  configure();
  const w = fakeWorker();
  await h.sendFile(U, pngOf(), 'pic.png');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'حذف EXIF');
  const job = lastJob(h);
  await h.tap(U, `wx:${job.code}`);
  assert.equal(w.calls.at(-1).method, 'DELETE');
  assert.equal(h.one('SELECT status FROM jobs WHERE id = ?', job.id).status, 'CANCELLED');
  // /cancel alone → the newest unfinished worker job; a running one gets "cancelling"
  advance(3);
  await h.sendFile(U, pngOf(), 'pic2.png');
  await h.tapText(U, 'ابزار عکس');
  await h.tapText(U, 'حذف EXIF');
  const j2 = lastJob(h);
  w.jobs.get(j2.id).status = 'PROCESSING';
  await h.send(U, '/cancel');
  assert.match(h.lastText(U), /درخواست لغو/);
  w.jobs.get(j2.id).status = 'COMPLETED';
  await h.send(U, `/cancel ${j2.code}`);
  assert.match(h.lastText(U), /دیگر قابل لغو نیست/);
  assert.equal(h.one('SELECT status FROM jobs WHERE id = ?', j2.id).status, 'COMPLETED');
  await h.send(U, '/cancel WC-ZZZZZZ');
  assert.match(h.lastText(U), /پیدا نشد/);
});

test('panel: worker screen (owner and admins), secrets reset the cache, history syncs', async () => {
  const h = setup({ members: [U] });
  fakeWorker();
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:wk');
  assert.match(h.lastText(OWNER), /وصل نیست/);
  await h.send(OWNER, `/secret set WORKER_URL ${URL}:8443`);
  assert.match(h.lastText(OWNER), /پورت/);
  await h.send(OWNER, `/secret set WORKER_URL ${URL}`);
  await h.send(OWNER, `/secret set WORKER_SECRET ${SECRET}`);
  await h.send(OWNER, '/panel');
  await h.tap(OWNER, 'p:wk');
  const t = h.lastText(OWNER);
  assert.match(t, /وصل است/);
  assert.match(t, /۱۴ ابزار/);
  assert.match(t, /سبک ۲/);
  assert.ok(!t.includes(SECRET));
  await h.send(OWNER, '/secret set WORKER_URL https://other.example.com');
  assert.equal(h.one("SELECT value FROM settings WHERE key = 'worker.caps'").value, 'null', 'cache cleared');
});
