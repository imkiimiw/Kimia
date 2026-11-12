// Runs the built Studio in a local headless Chromium with a mock of telegram-web-app.js
// (Serverless.call answered in the page), and drives the full static-sticker flow:
// chat job → download → automatic background removal → text (Persian + English) → export →
// the uploaded file is checked with the server's own validator. Also: quick mode and the gate.
//
//   npm run build && npm run studio:local [photo.jpg]   → docs/spike-results/studio-local.json (+ screenshots)
// A baseline in a container's Chromium, not a phone.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from './tg.mjs';
import { validateTelegramStatic, sniffImage } from '../tgcloud/lib/core/validate.js';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = createRequire(path.join(process.env.NODE_PATH || '/usr/local/lib/node_modules', 'x.js'))('playwright');
}
const DIST = path.join(ROOT, 'dist');
const OUTDIR = path.join(ROOT, 'docs/spike-results');
const photoPath = process.argv[2];
if (!photoPath || !fs.existsSync(photoPath)) {
  console.error('usage: npm run studio:local -- <photo.jpg>');
  process.exit(1);
}
const photo = fs.readFileSync(photoPath);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.onnx': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent((req.url || '/').split('?')[0]));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** The mock Telegram bridge: init data, back button, and the Studio's endpoints. */
const mock = (opts) => `
window.__commits = [];
const CHUNK = 256 * 1024;
const PHOTO = ${JSON.stringify(photo.toString('base64'))};
const raw = atob(PHOTO);
const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
const handlers = {
  studio_boot: () => ${opts.gate ? `({ error: { message: 'Join first', type: 'ENDPOINT_ERROR', parameters: { code: 'JOIN_REQUIRED', channels: [{ title: 'HIDE & SEEK', url: 'https://t.me/HIDE_i_SEEK' }] } } })` : `({ result: { user: { id: 1, first_name: 'Test', lang: 'fa' }, role: 'user', packs: [{ id: 7, title: 'گربه‌ها', count: 3, name: 'ws_1_1_by_Wanger_Motionbot' }], quota: { pack_create: 10, sticker_add: 300 }, limits: { static: { side: 512, maxBytes: 524288 }, set: { maxStickersRegular: 120, titleMaxChars: 64 }, chunkBytes: CHUNK }, bot: 'Wanger_Motionbot' } })`},
  studio_media: (i) => { const total = Math.ceil(bytes.length / CHUNK); return { result: { idx: i.idx, total, size: bytes.length, b64: b64(bytes.subarray(i.idx * CHUNK, (i.idx + 1) * CHUNK)) } }; },
  upload_commit: (i) => { window.__commits.push(i); return { result: { action: i.action, packId: 9, name: 'ws_1_2_by_Wanger_Motionbot', count: 1 } }; },
  upload_begin: (i) => { window.__begin = i; return { result: { uploadId: 'U1', chunkBytes: CHUNK, chunks: Math.ceil(i.size / CHUNK) } }; },
  upload_chunk: (i) => { (window.__chunks ||= []).push(i); return { result: { received: i.idx } }; },
};
window.Telegram = { WebApp: {
  initData: 'query_id=x&user=%7B%22id%22%3A1%7D', initDataUnsafe: { user: { id: 1, first_name: 'Test', language_code: 'fa' } },
  platform: 'web', version: '9.1', ready() {}, expand() {}, close() {}, openTelegramLink(u) { window.__opened = u; },
  BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
  HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
  Serverless: { call(name, input, cb) { setTimeout(() => { const r = handlers[name] ? handlers[name](input) : { error: { message: 'no ' + name } }; r.error ? cb(r.error) : cb(null, r.result); }, 5); } },
} };`;

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await playwright.chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
async function page(opts = {}) {
  const p = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
  await p.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: mock(opts) }));
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  return p;
}
const report = { at: new Date().toISOString(), photo: path.basename(photoPath), photoBytes: photo.length };

// 1. the full flow
{
  const p = await page();
  const t0 = Date.now();
  await p.goto(`${base}/?job=J1`);
  await p.getByRole('button', { name: /حذف خودکار/ }).waitFor({ timeout: 30000 });
  report.openMs = Date.now() - t0;
  const t1 = Date.now();
  await p.getByRole('button', { name: /حذف خودکار/ }).click();
  await p.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 120000 });
  report.autoRemoveMs = Date.now() - t1;
  await p.screenshot({ path: path.join(OUTDIR, 'studio-bg.png') });
  await p.getByRole('button', { name: 'متن' }).click();
  await p.getByRole('button', { name: /متن تازه/ }).click();
  await p.locator('textarea').fill('سلام Wanger ۱۲۳');
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUTDIR, 'studio-text.png') });
  const t2 = Date.now();
  await p.getByRole('button', { name: /ذخیره‌ی استیکر|ذخیره‌ی استیکر/ }).click();
  await p.locator('.export img').waitFor({ timeout: 60000 });
  report.exportMs = Date.now() - t2;
  report.exportLine = await p.locator('.export .hint').first().innerText();
  await p.screenshot({ path: path.join(OUTDIR, 'studio-export.png'), fullPage: true });
  await p.getByLabel(/پک جدید/).check();
  await p.locator('.export input[placeholder]').fill('استودیوی من');
  await p.getByRole('button', { name: /✅ ذخیره/ }).click();
  await p.getByText(/ساخته شد/).waitFor({ timeout: 30000 });
  report.totalMs = Date.now() - t0;
  const commits = await p.evaluate(() => window.__commits);
  const c = commits[0];
  const file = Buffer.from(c.inline, 'base64');
  const v = validateTelegramStatic(new Uint8Array(file), sniffImage(new Uint8Array(file)));
  report.upload = { action: c.action, title: c.title, emojis: c.emojis, format: c.format, bytes: file.length, sha256ok: crypto.createHash('sha256').update(file).digest('hex') === c.sha256, valid: v.ok, violations: v.violations, width: v.info.width, height: v.info.height };
  fs.writeFileSync(path.join(OUTDIR, 'studio-sticker.' + c.format), file);
  await p.close();
}
// 2. quick mode goes straight to the export sheet
{
  const p = await page();
  const t0 = Date.now();
  await p.goto(`${base}/?job=J1&quick=1`);
  await p.locator('.export img').waitFor({ timeout: 120000 });
  report.quickToExportMs = Date.now() - t0;
  await p.close();
}
// 3. a non-member sees the gate screen with the channel buttons
{
  const p = await page({ gate: true });
  await p.goto(`${base}/?job=J1`);
  await p.getByRole('button', { name: /HIDE & SEEK/ }).waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: /HIDE & SEEK/ }).click();
  report.gate = { opened: await p.evaluate(() => window.__opened) };
  await p.close();
}
await browser.close();
server.close();
report.browser = 'headless Chromium (container) — not a phone';
fs.writeFileSync(path.join(OUTDIR, 'studio-local.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
