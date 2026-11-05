#!/usr/bin/env node
// Runs one action of the temporary devtools endpoint on the real platform and prints the result:
//   cd aegis && node test/cloud/dev.mjs <action> [json-input]      (needs Aegis_BOT_TGCLOUD_TOKEN)
// The endpoint file is copied in for the run and always removed again (never pushed).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEV_SRC = path.join(ROOT, 'test/cloud/devtools.js');
const DEV_DST = path.join(ROOT, 'tgcloud/endpoints/zz_devtools.js');
const [action, extra] = process.argv.slice(2);
if (!action) throw new Error('usage: node test/cloud/dev.mjs <action> [json-input]');
if (fs.existsSync(DEV_DST)) throw new Error('tgcloud/endpoints/zz_devtools.js already exists: a previous run did not clean up');
fs.copyFileSync(DEV_SRC, DEV_DST);
try {
  const input = { action, ...(extra ? JSON5.parse(extra) : {}) };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tg.mjs'), 'run', 'endpoints/zz_devtools', JSON5.stringify(input), '--ctx',
    JSON5.stringify({ initData: { user: { id: 990000101 } } })], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const line = out.split('\n').find((l) => l.startsWith('< '));
  console.log(line ? line.slice(2) : out.split('\n').filter((l) => !/Warning|trace-warnings/.test(l)).join('\n'));
} finally {
  fs.rmSync(DEV_DST, { force: true });
}
