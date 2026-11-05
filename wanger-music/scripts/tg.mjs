// Runs the tgcloud CLI for Wanger Music only:
//   npm run tg -- <command> [args]   any CLI command (status, diff, push, migrate, run, webhook, …)
//
// - The CLI access token (app<id>:<secret>, never the bot token) comes from the environment
//   variable Music_BOT_TGCLOUD_TOKEN (or TGCLOUD_TOKEN in CI) and is handed to the CLI as
//   TGCLOUD_TOKEN for the child process only. It is never printed or written to disk.
// - The CLI acts on the nearest folder with a `.tgcloud/` directory. This script runs from
//   wanger-music/ and makes sure wanger-music/.tgcloud/ exists, so it can never touch another bot
//   in this repository (the repository root is the to-do bot).
// - Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1; it is set when a proxy is.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const token = process.env.Music_BOT_TGCLOUD_TOKEN || process.env.TGCLOUD_TOKEN || '';

if (!fs.existsSync(CLI)) {
  console.error('The tgcloud CLI is not installed: run `npm install` in wanger-music/ first.');
  process.exit(1);
}
if (!/^app\d+:\S+$/.test(token)) {
  console.error('Music_BOT_TGCLOUD_TOKEN is missing or is not a CLI access token (app<id>:<secret>). Get it from BotFather → the bot → Serverless → CLI Access.');
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, '.tgcloud'), { recursive: true });

const env = { ...process.env, TGCLOUD_TOKEN: token };
delete env.Music_BOT_TGCLOUD_TOKEN;
if (process.env.HTTPS_PROXY || process.env.https_proxy) env.NODE_USE_ENV_PROXY = '1';

const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [CLI, ...(args.length ? args : ['--help'])], { cwd: ROOT, env, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
