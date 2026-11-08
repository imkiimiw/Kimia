// A fake worker for end-to-end tests: checks HMAC + nonce + clock like worker/app/security.py,
// records the calls and keeps the jobs it accepted.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setFetchHandler, OWNER } from './harness.mjs';
import { rawDatabase } from '../sdk/db.mjs';

export const WORKER_URL = 'https://worker.example.com';
export const WORKER_SECRET = 'w'.repeat(48);
const IMG = ['avif', 'bmp', 'gif', 'heic', 'ico', 'jpeg', 'png', 'tiff', 'webp'];
const OPS = {
  ...Object.fromEntries(['img.cv', 'img.rs', 'img.cr', 'img.ro', 'img.fl', 'img.cp', 'img.sm', 'img.gr', 'img.bl', 'img.sh', 'img.cm', 'img.wm', 'img.tx'].map((o) => [o, IMG])),
  tti: [], 'pdf.tx': ['pdf'], 'pdf.im': ['pdf'], 'pdf.cp': ['pdf'], 'pdf.wm': ['pdf'], 'pdf.ul': ['pdf'], ocr: [...IMG, 'pdf'],
};
export const CAPS = {
  version: '0.5.0', features: { raqm: true, tesseract: true, pdfium: true, pikepdf: true },
  ops: Object.fromEntries(Object.entries(OPS).map(([o, inputs]) => [o, { group: 'x', queue: 'light', inputs }])),
  formats: { image_read: IMG, image_write: ['jpg', 'png', 'webp'] },
  ocr: { langs: ['ara', 'deu', 'eng', 'fas', 'fra', 'spa', 'tur'], max_pages: 20 },
  limits: { max_input_mb: 20 },
};

export function configureWorker() {
  const db = rawDatabase();
  for (const [n, v] of [['WORKER_URL', WORKER_URL], ['WORKER_SECRET', WORKER_SECRET]]) db.prepare('INSERT INTO secrets (name, value, updated_at, updated_by) VALUES (?, ?, 0, ?)').run(n, v, OWNER);
}

/** `other(url, init)` answers anything that isn't the worker (e.g. Gemini). */
export function fakeWorker({ caps = CAPS, other = null } = {}) {
  const w = { calls: [], jobs: new Map(), nonces: new Set(), other: [] };
  setFetchHandler(async (url, init) => {
    if (!url.startsWith(WORKER_URL)) {
      w.other.push({ url, init });
      return other ? other(url, init) : new Error(`unexpected fetch ${url}`);
    }
    const u = new globalThis.URL(url);
    const path = u.pathname + u.search;
    const body = init.body ? (typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : '';
    const h = init.headers || {};
    const expected = createHmac('sha256', WORKER_SECRET).update(`${h['X-Wanger-Timestamp']}.${h['X-Wanger-Nonce']}.${init.method}.${path}.${body}`).digest('hex');
    assert.equal(h['X-Wanger-Signature'], expected);
    assert.ok(!w.nonces.has(h['X-Wanger-Nonce']));
    w.nonces.add(h['X-Wanger-Nonce']);
    const data = body ? JSON.parse(body) : null;
    w.calls.push({ method: init.method, path, data });
    if (path === '/v1/capabilities') return { status: 200, body: caps };
    if (init.method === 'POST' && path === '/v1/jobs') {
      const job = { id: data.job_id, code: data.code, op: data.op, status: 'QUEUED', position: 1, cancel_requested: false, outputs: [], notes: [], user: data.user_id };
      w.jobs.set(data.job_id, job);
      return { status: 202, body: { job } };
    }
    return { status: 404, body: { error: 'NOT_FOUND' } };
  });
  return w;
}

export const posts = (w) => w.calls.filter((c) => c.method === 'POST').map((c) => c.data);
