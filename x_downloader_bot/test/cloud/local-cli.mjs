// Local stand-in for `tgcloud run`, used only to check test/cloud/run-tests.mjs itself
// (test/cloud/local-harness.mjs). Same output format as the real CLI: "> module(args)", then
// "< <JSON5 return value>  <ms>ms". Runs with the local sdk emulation and a file database.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSON5 from 'json5';
import { setupDatabase } from '../sdk/db.mjs';
import * as schema from '../../tgcloud/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [cmd, moduleName, args, flag, ctx] = process.argv.slice(2);
if (cmd !== 'run') throw new Error('only "run" is emulated');
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
