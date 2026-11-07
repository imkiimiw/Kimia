// Runs one C0 spike on Serverless without deploying anything:
//   npm run spike -- core '{ case: "globals" }'
//   npm run spike -- lib  '{ case: "zip_deflate", level: 6 }'
//   npm run spike -- size 4        (a module holding a 4 MB string literal)
//
// The probe files live in spikes/ (never deployed). This script copies them into tgcloud/ as zz_*
// modules, runs `tgcloud run` through scripts/tg.mjs (this bot only), and ALWAYS deletes them again,
// also on errors and Ctrl-C. Never run `push` while a spike is running: the CLI uploads every file
// under tgcloud/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = (...p) => path.join(ROOT, 'tgcloud', ...p);
const S = (...p) => path.join(ROOT, 'spikes', ...p);
const [kind, arg = '{}'] = process.argv.slice(2);

const staged = [];
function stage(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (typeof from === 'string') fs.copyFileSync(from, to); else fs.writeFileSync(to, from.content);
  staged.push(to);
}
function cleanup() {
  for (const f of staged.reverse()) fs.rmSync(f, { force: true });
  for (const d of [T('lib', 'zz_spike', 'vendor'), T('lib', 'zz_spike'), T('endpoints')]) {
    try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* keep */ }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let module;
let input = arg;
try {
  if (kind === 'core') {
    stage(S('endpoints', 'zz_core.js'), T('endpoints', 'zz_core.js'));
    module = 'endpoints/zz_core';
  } else if (kind === 'lib') {
    stage(S('endpoints', 'zz_lib.js'), T('endpoints', 'zz_lib.js'));
    stage(S('bench.js'), T('lib', 'zz_spike', 'bench.js'));
    stage(S('vendor', 'fflate.js'), T('lib', 'zz_spike', 'vendor', 'fflate.js'));
    stage(S('vendor', 'pdf-lib.js'), T('lib', 'zz_spike', 'vendor', 'pdf-lib.js'));
    module = 'endpoints/zz_lib';
  } else if (kind === 'size') {
    const mb = Number(arg);
    const n = Math.round(mb * 1024 * 1024);
    const chunk = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(16); // 1 KiB
    const body = chunk.repeat(Math.ceil(n / chunk.length)).slice(0, n);
    stage({ content: `// TEMPORARY C0 module-size probe (${mb} MB literal).\nexport const blob = '${body}';\n` }, T('lib', 'zz_spike', 'blob.js'));
    stage({ content: `import { blob } from '../lib/zz_spike/blob.js';\nexport default async function () { return { length: blob.length }; }\n` }, T('endpoints', 'zz_size.js'));
    module = 'endpoints/zz_size';
    input = '{}';
  } else {
    console.error('usage: npm run spike -- <core|lib|size> [json5 input | MB]');
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tg.mjs'), 'run', module, input], { cwd: ROOT, stdio: 'inherit' });
  process.exitCode = r.status === null ? 1 : r.status;
} finally {
  cleanup();
}
