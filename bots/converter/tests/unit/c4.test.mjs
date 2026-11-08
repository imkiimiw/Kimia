// C4 (bot side, pure parts): request signing compatible with the Python worker, the URL rule,
// presets and screens of the worker tools, typed-text checks, refusal mapping, labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedHeaders, hmacHex } from '../../tgcloud/lib/worker.js';
import { validate } from '../../tgcloud/lib/secrets.js';
import * as W from '../../tgcloud/lib/wtools.js';
import { checkText, refusalCode } from '../../tgcloud/lib/wflow.js';
import fa from '../../tgcloud/lib/i18n/fa.js';
import en from '../../tgcloud/lib/i18n/en.js';

const enc = new TextEncoder();
const WORKER_OPS = ['img.cv', 'img.rs', 'img.cr', 'img.ro', 'img.fl', 'img.cp', 'img.sm', 'img.gr', 'img.bl', 'img.sh', 'img.cm', 'img.wm', 'img.tx', 'tti'];
const ALL_TYPES = ['avif', 'bmp', 'gif', 'heic', 'ico', 'jpeg', 'png', 'tiff', 'webp'];
const workerCtx = (over = {}) => ({
  lang: 'fa', digits: true,
  worker: { available: true, ops: new Set(WORKER_OPS), inputs: Object.fromEntries(WORKER_OPS.map((o) => [o, o === 'tti' ? [] : ALL_TYPES])), write: ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'avif', 'heic'], maxMb: 20, ...over },
});

test('signatures match the Python worker (app/security.py) byte for byte', async () => {
  // vectors computed with the worker's sign() — any drift on either side breaks this test
  const body = enc.encode('{"op":"img.cv","text":"سلام"}');
  const h = await signedHeaders('s'.repeat(40), 'POST', '/v1/jobs', body, 1700000000, '0123456789abcdef0123456789abcdef');
  assert.equal(h['X-Wanger-Signature'], '2d78c1471b7ab05f80232cc460d0642340786c4bb53f90d38ee56985358261b5');
  assert.equal(h['X-Wanger-Timestamp'], '1700000000');
  const g = await signedHeaders('s'.repeat(40), 'GET', '/v1/jobs/01ABC?user_id=7', new Uint8Array(0), 1700000000, 'nonce-for-get-000001');
  assert.equal(g['X-Wanger-Signature'], 'a6a3ea5665e70f48376940c5a3fa106cd3a2897686e27a9958c58b2188dad0d5');
  // the value measured on Serverless itself (crypto.subtle there, C4 spike)
  assert.equal(await hmacHex('k'.repeat(40), enc.encode('1700000000.n.GET./v1/x.')), '7266e13bd4a7406852a71c8d5a7aa013521ee7186dea3b9beadd7b99ca0414ba');
  const a = await signedHeaders('x'.repeat(40), 'GET', '/v1/health', new Uint8Array(0));
  const b = await signedHeaders('x'.repeat(40), 'GET', '/v1/health', new Uint8Array(0));
  assert.notEqual(a['X-Wanger-Nonce'], b['X-Wanger-Nonce']);
  assert.match(a['X-Wanger-Nonce'], /^[0-9a-f]{32}$/);
});

test('WORKER_URL: https on the default port only (Serverless reaches 80/443 only)', () => {
  assert.equal(validate('WORKER_URL', 'https://worker.example.com'), null);
  assert.equal(validate('WORKER_URL', 'https://worker.example.com:443/'), null);
  assert.equal(validate('WORKER_URL', 'https://abc.trycloudflare.com'), null);
  assert.equal(validate('WORKER_URL', 'https://worker.example.com:8443'), 'sec.err_url');
  assert.equal(validate('WORKER_URL', 'https://localhost'), 'sec.err_url');
  assert.equal(validate('WORKER_URL', 'http://worker.example.com'), 'sec.err_url');
});

test('every preset maps to a worker operation, has a label and fits callback_data', () => {
  const ctx = workerCtx();
  for (const [id, [op, params]] of Object.entries(W.PRESETS)) {
    assert.ok(WORKER_OPS.includes(op), id);
    assert.equal(typeof params, 'object');
    const label = W.presetLabel(ctx, id);
    assert.ok(label && !label.includes('wt.'), `${id} → ${label}`);
    assert.ok(enc.encode(`wo:ABCDEF:${id}`).length <= 64);
  }
  for (const cat of Object.keys(W.CATS)) for (const lang of [fa, en]) { assert.ok(lang[`wt.cat_${cat}`], cat); assert.ok(lang[`wt.pick_${cat}`], cat); }
  for (const op of WORKER_OPS) for (const lang of [fa, en]) assert.ok(lang[`op.${op}`], op);
  for (const th of W.THEMES) assert.ok(fa[`wt.theme_${th}`] && en[`wt.theme_${th}`], th);
  for (const s of W.SIZES) assert.ok(fa[`wt.size_${s}`] && en[`wt.size_${s}`], s);
});

test('presets follow the capabilities: op, input type, size, writable format, not the same format', () => {
  const file = { ref: 'ABCDEF', name: 'a.jpg', size: 1000 };
  const ctx = workerCtx();
  assert.ok(W.imageToolsOk(ctx, file, { id: 'jpeg' }));
  assert.ok(!W.presetOk(ctx, 'cv.jpg', file, { id: 'jpeg' }), 'no JPG → JPG');
  assert.ok(W.presetOk(ctx, 'cv.png', file, { id: 'jpeg' }));
  assert.ok(!W.imageToolsOk(ctx, file, { id: 'pdf' }));
  assert.ok(!W.imageToolsOk(ctx, file, { id: 'jpeg', dangerous: 'polyglot' }));
  assert.ok(!W.imageToolsOk(ctx, { ...file, size: 21 * 1024 * 1024 }, { id: 'jpeg' }));
  const noAvif = workerCtx({ write: ['jpg', 'png'] });
  assert.deepEqual(W.catPresets(noAvif, 'cv', file, { id: 'jpeg' }), ['cv.png']);
  const noText = workerCtx({ ops: new Set(WORKER_OPS.filter((o) => !['img.wm', 'img.tx', 'tti'].includes(o))) });
  assert.deepEqual(W.catPresets(noText, 'wm', file, { id: 'jpeg' }), []);
  assert.ok(!W.ttiOk(noText) && W.ttiOk(ctx));
  assert.ok(!W.imageToolsOk({ lang: 'fa', worker: { available: false, ops: new Set() } }, file, { id: 'jpeg' }));
  assert.ok(!W.imageToolsOk({ lang: 'fa' }, file, { id: 'jpeg' }));
});

test('screens: tools grid, categories, the queued status message with a cancel button', () => {
  const ctx = workerCtx();
  const file = { ref: 'ABCDEF', name: 'pic.png', size: 10 };
  const tools = W.toolsScreen(ctx, file, { id: 'png' });
  const data = tools.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('wi:ABCDEF:cv') && data.includes('wo:ABCDEF:sm') && data.includes('wi:ABCDEF:wm') && data.includes('f:ABCDEF'));
  const cv = W.catScreen(ctx, file, { id: 'png' }, 'cv').reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!cv.includes('wo:ABCDEF:cv.png') && cv.includes('wo:ABCDEF:cv.jpg'));
  const q = W.queued(ctx, 'WC-ABC123', 3);
  assert.match(q.text, /نفر ۳/);
  assert.equal(q.reply_markup.inline_keyboard[0][0].callback_data, 'wx:WC-ABC123');
});

test('typed text and worker refusals', () => {
  assert.deepEqual(checkText('  سلام  ', 10), { text: 'سلام' });
  assert.equal(checkText('   ', 10).error, 'empty');
  assert.equal(checkText('a'.repeat(11), 10).error, 'long');
  assert.deepEqual(checkText('😀'.repeat(10), 10), { text: '😀'.repeat(10) }, 'counted in characters, not UTF-16 units');
  assert.equal(refusalCode(429, 'USER_BUSY'), 'WORKER_USER_BUSY');
  assert.equal(refusalCode(503, 'QUEUE_FULL'), 'WORKER_BUSY');
  assert.equal(refusalCode(502, null), 'WORKER_BUSY');
  assert.equal(refusalCode(400, 'TOO_BIG'), 'TOO_BIG');
  assert.equal(refusalCode(400, 'UNKNOWN_OP'), 'WORKER_UNAVAILABLE');
  assert.equal(refusalCode(400, 'BAD_PARAMS'), 'INTERNAL');
});
