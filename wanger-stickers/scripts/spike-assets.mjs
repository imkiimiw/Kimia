// Phase 0: adds the spike's extra static files to dist/ AFTER `vite build`:
//   dist/spike/blob-<n>mb.bin   random files to find the static hosting per-file limit
//   dist/spike/blobs.json       the list the spike page reads
//   dist/spike/models/u2netp.onnx  U²-Netp (Apache-2.0 weights, 4.7 MB) — self-hosted model test
//
//   SPIKE_BLOBS=1,5,10,20,32 npm run build:spike     (default 1,5,10,20)
//
// Only for a test deployment. Phase 1 builds never include dist/spike/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './tg.mjs';

const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'spike');
const CACHE = path.join(ROOT, 'node_modules/.cache/wanger-spike');
const U2NETP_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first.');
  process.exit(1);
}
fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

const sizes = (process.env.SPIKE_BLOBS || '1,5,10,20').split(',').map(Number).filter((n) => n > 0 && n <= 64);
for (const mb of sizes) {
  const file = path.join(OUT, `blob-${mb}mb.bin`);
  fs.writeFileSync(file, crypto.randomBytes(mb * 1024 * 1024));
}
fs.writeFileSync(path.join(OUT, 'blobs.json'), JSON.stringify(sizes));

const cached = path.join(CACHE, 'u2netp.onnx');
if (!fs.existsSync(cached)) {
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
    console.warn('Behind a proxy: re-run with NODE_USE_ENV_PROXY=1 if the download fails.');
  }
  const res = await fetch(U2NETP_URL, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`u2netp download failed: HTTP ${res.status} (the spike page will report the model as missing)`);
  } else {
    fs.writeFileSync(cached, new Uint8Array(await res.arrayBuffer()));
  }
}
if (fs.existsSync(cached)) {
  fs.copyFileSync(cached, path.join(OUT, 'models/u2netp.onnx'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex');
  console.log(`u2netp.onnx ${(fs.statSync(cached).size / 1048576).toFixed(1)} MB sha256 ${sha}`);
}
const total = fs.readdirSync(OUT, { recursive: true }).map((f) => path.join(OUT, String(f))).filter((f) => fs.statSync(f).isFile()).reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`dist/spike: blobs ${sizes.join(', ')} MB; ${(total / 1048576).toFixed(1)} MB in all`);
