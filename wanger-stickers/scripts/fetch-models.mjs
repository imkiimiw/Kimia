// Downloads the background-removal models into public/assets/models/ (served from the static
// build; both below the measured 15 MiB serving limit) and checks their SHA-256 pins.
// Runs before `vite build` (npm run build). The files are not committed (see .gitignore).
//
//   u2netp-v1.onnx      U²-Netp, Apache-2.0 weights (xuebinqin/U-2-Net), file from rembg's release
//   modnet-q8-v1.onnx   MODNet quantized, Apache-2.0 (Hugging Face Xenova/modnet)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/assets/models');
const MODELS = [
  { file: 'u2netp-v1.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx', sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8' },
  { file: 'modnet-q8-v1.onnx', url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_quantized.onnx', sha256: '92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a' },
];
const MAX_SERVED = 15 * 1024 * 1024;

fs.mkdirSync(OUT, { recursive: true });
let failed = false;
for (const m of MODELS) {
  const dst = path.join(OUT, m.file);
  if (!fs.existsSync(dst)) {
    process.stdout.write(`downloading ${m.file}… `);
    const res = await fetch(m.url, { redirect: 'follow' });
    if (!res.ok) {
      console.error(`HTTP ${res.status}`);
      failed = true;
      continue;
    }
    fs.writeFileSync(dst, new Uint8Array(await res.arrayBuffer()));
    console.log('ok');
  }
  const bytes = fs.readFileSync(dst);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (m.sha256 !== 'PIN' && sha !== m.sha256) {
    console.error(`${m.file}: sha256 ${sha} does not match the pin ${m.sha256}; deleting it`);
    fs.rmSync(dst);
    failed = true;
    continue;
  }
  if (bytes.length >= MAX_SERVED) {
    console.error(`${m.file} is ${bytes.length} bytes: tgcloud serves static files only below 16 MiB`);
    failed = true;
  }
  console.log(`${m.file} ${(bytes.length / 1048576).toFixed(1)} MB sha256 ${sha}`);
}
if (failed) process.exit(1);
