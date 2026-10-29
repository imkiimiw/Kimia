// Local stand-in for `tgcloud run` / `tgcloud webhook`, used only to check test/cloud/run-tests.mjs
// itself (test/cloud/local-harness.mjs). Same output format as the real CLI: "> module(args)", then
// "< <JSON5 return value>  <ms>ms". Runs with the local sdk emulation and a file database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSON5 from 'json5';
import { setupDatabase } from '../sdk/db.mjs';
import * as schema from '../../tgcloud/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [cmd, moduleName, args, flag, ctx] = process.argv.slice(2);
if (cmd === 'webhook') {
  const handlers = fs.readdirSync(path.join(ROOT, 'tgcloud/handlers')).map((f) => f.replace(/\.js$/, '')).sort();
  console.log(`Webhook:\n  url:              https://local.invalid/webhook\n  allowed updates:  ${handlers.join(', ')}\n  pending updates:  0\n  ✓ in sync with your deployed handlers`);
  process.exit(0);
}
if (cmd !== 'run') throw new Error('only "run" and "webhook" are emulated');
// Like the platform's rate limit: every Nth call is refused before anything runs.
if (process.env.LOCAL_RATE_LIMIT_EVERY && process.env.MOCK_DB_FILE) {
  const counter = `${process.env.MOCK_DB_FILE}.calls`;
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  if (n % Number(process.env.LOCAL_RATE_LIMIT_EVERY) === 0) {
    console.log(`> ${moduleName.split('/').pop()}(${args})`);
    console.log('✗ Too many requests: retry after 1');
    process.exit(1);
  }
}
setupDatabase(schema, process.env.MOCK_DB_FILE);
const mod = await import(pathToFileURL(path.join(ROOT, 'tgcloud', `${moduleName}.js`)).href);
const started = Date.now();
console.log(`> ${moduleName.split('/').pop()}(${args})`);
try {
  const result = await mod.default(JSON5.parse(args), flag === '--ctx' ? JSON5.parse(ctx) : {});
  console.log(`< ${JSON5.stringify(result)}  ${Date.now() - started}ms`);
} catch (err) {
  console.log(`✗ ${err.message}`);
  process.exit(1);
}
