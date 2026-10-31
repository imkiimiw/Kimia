// Runs the tgcloud CLI for the meme bot only:
//   npm run tg -- <command> [args]   any CLI command (status, diff, push, migrate, run, webhook, …)
//   npm run deploy                   gen-env → push → migrate --safe → webhook check
//
// - The token comes from Meme_BOT_TGCLOUD_TOKEN (environment or memebot/.env) and is given to the
//   CLI as TGCLOUD_TOKEN for the child process only. It is never printed or written to disk.
// - The CLI acts on the nearest folder that has a `.tgcloud/` directory. This script creates
//   memebot/.tgcloud/ and runs from memebot/, so it can never touch another bot in this repository
//   (the repository root is itself a tgcloud project: the to-do bot).
// - tgcloud/lib/env.js is regenerated first, so a push always carries the current settings.
// - Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1; it is set when a proxy is.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from './dotenv.mjs';

const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const TOKEN_VAR = 'Meme_BOT_TGCLOUD_TOKEN';
const token = loadEnv()[TOKEN_VAR];

if (!fs.existsSync(CLI)) {
  console.error('The tgcloud CLI is not installed: run `npm install` in memebot/ first.');
  process.exit(1);
}
if (!token) {
  console.error(`${TOKEN_VAR} is not set (environment or memebot/.env). See .env.example.`);
  process.exit(1);
}
if (!/^app\d+:\S+$/.test(token)) {
  console.error(`${TOKEN_VAR} doesn't look like a CLI access token (app<id>:<secret>). The bot token from BotFather is not it: use BotFather → your bot → Serverless → CLI Access.`);
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, '.tgcloud'), { recursive: true });

const childEnv = { ...process.env, TGCLOUD_TOKEN: token };
if (process.env.HTTPS_PROXY || process.env.https_proxy) childEnv.NODE_USE_ENV_PROXY = '1';

const run = (args, withToken = true) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: withToken ? childEnv : process.env, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
};
const cli = (args) => run([CLI, ...args]);
const genEnv = () => run([path.join(ROOT, 'scripts/gen-env.mjs')], false);

const args = process.argv.slice(2);
if (genEnv() !== 0) process.exit(1);
if (args[0] === 'deploy') {
  for (const step of [() => cli(['push', ...args.slice(1)]), () => cli(['migrate', '--safe']), () => cli(['webhook'])]) {
    const code = step();
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
}
process.exit(cli(args.length ? args : ['--help']));
