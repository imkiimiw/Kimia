// Runs the device spike page in a local headless Chromium (Playwright) as a BASELINE before the
// real device runs inside Telegram. It is not a Telegram webview and not a phone: numbers are for
// comparison only. Endpoint tests are skipped (no init data outside Telegram).
//
//   npm run build:spike && npm run spike:local      → docs/spike-results/chromium-local.json
//
// Needs Playwright with Chromium installed (globally or as a dev dependency).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './tg.mjs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = createRequire(path.join(process.env.NODE_PATH || '/usr/local/lib/node_modules', 'x.js'))('playwright');
}

const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'docs/spike-results/chromium-local.json');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(DIST, url);
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const t0 = Date.now();
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await playwright.chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
const only = process.argv.slice(2);
const merged = { results: {} };
let keys = null;
let shot = null;
// one fresh page per test, so a crash (e.g. out of memory) is recorded instead of ending the run
for (let i = 0; ; i++) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text().slice(0, 300)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__spike, null, { timeout: 30000 });
  keys ??= (await page.evaluate(() => window.__spike.keys)).filter((k) => !only.length || only.includes(k) || k === 'caps');
  if (i >= keys.length) {
    await page.close();
    break;
  }
  const key = keys[i];
  const t1 = Date.now();
  try {
    await page.evaluate((k) => window.__spike.runKey(k), key);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => window.__spike.report());
    merged.results[key] = r.results[key];
    if (key === 'caps') merged.device = r.device;
    if (key === 'segU2netp' || key === 'webpAnimated') shot = await page.screenshot({ fullPage: true });
  } catch (e) {
    merged.results[key] = { crashed: String(e.message || e).split('\n')[0], ms: Date.now() - t1 };
  }
  console.log(key, JSON.stringify(merged.results[key]).slice(0, 160));
  await page.close().catch(() => {});
}
const report = { spike: 'wanger-stickers phase 0', at: new Date().toISOString(), ...merged };
report.harness = { runner: 'scripts/spike-local.mjs', browser: browser.version(), totalMs: Date.now() - t0, note: 'local headless Chromium in a cloud container: NOT a Telegram webview, NOT a phone' };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
if (shot) fs.writeFileSync(path.join(path.dirname(OUT), 'chromium-local.png'), shot);
await browser.close();
server.close();
console.log(`wrote ${path.relative(ROOT, OUT)} in ${Math.round((Date.now() - t0) / 1000)} s`);
