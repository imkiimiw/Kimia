// Runs the tgcloud CLI for Aegis only:
//   npm run tg -- <command> [args]   any CLI command (status, push, migrate, run, webhook, …)
//   npm run deploy                   build (locales + env.js) → push → migrate --safe → webhook check
//
// - The token comes from Aegis_BOT_TGCLOUD_TOKEN (environment or aegis/.env) and is handed to the
//   CLI as TGCLOUD_TOKEN for the child process only. It is never printed or written to disk.
// - The CLI acts on the nearest folder that has a `.tgcloud/` directory. This script creates
//   aegis/.tgcloud/ and runs from aegis/, so it can never touch another bot in this repository.
// - Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1; it is set when a proxy is.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from './dotenv.mjs';

const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const env = loadEnv();
const token = env.Aegis_BOT_TGCLOUD_TOKEN;

if (!fs.existsSync(CLI)) {
  console.error('The tgcloud CLI is not installed: run `npm install` in aegis/ first.');
  process.exit(1);
}
if (!token) {
  console.error('Aegis_BOT_TGCLOUD_TOKEN is not set (environment or aegis/.env). See .env.example.');
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, '.tgcloud'), { recursive: true });

const childEnv = { ...process.env, TGCLOUD_TOKEN: token };
if (process.env.HTTPS_PROXY || process.env.https_proxy) childEnv.NODE_USE_ENV_PROXY = '1';

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env: childEnv, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

function node(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

const args = process.argv.slice(2);
if (args[0] === 'deploy') {
  for (const step of [
    () => node('scripts/build-locales.mjs'),
    () => node('scripts/gen-env.mjs'),
    () => cli(['push', ...args.slice(1)]),
    () => cli(['migrate', '--safe']),
    () => cli(['webhook']),
  ]) {
    const code = step();
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
}
process.exit(cli(args.length ? args : ['--help']));
