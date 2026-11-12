// After `vite build`: tgcloud serves a static file only below 16 MiB (measured 2026-11-12: 15 MiB
// served, 16 MiB → HTTP 500) and push refuses random-byte files. Keep every file under 15 MiB.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './tg.mjs';

const DIST = path.join(ROOT, 'dist');
const LIMIT = 15 * 1024 * 1024;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(DIST);
const big = files.filter((f) => fs.statSync(f).size >= LIMIT);
const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
if (big.length) {
  console.error(`dist files over 15 MiB (tgcloud won't serve them):\n${big.map((f) => `  ${path.relative(ROOT, f)} ${fs.statSync(f).size}`).join('\n')}`);
  process.exit(1);
}
console.log(`dist: ${files.length} files, ${(total / 1048576).toFixed(1)} MB, largest ${(Math.max(...files.map((f) => fs.statSync(f).size)) / 1048576).toFixed(1)} MB — ok`);
