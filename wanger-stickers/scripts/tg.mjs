// Runs the tgcloud CLI for Wanger Stickers only (cross-platform; Node >= 18):
//   npm run tg -- <command> [args]   any CLI command (status, diff, push, migrate, run, webhook, …)
//   npm run deploy                   = npm run build, then `tg push` (never migrate)
//
// - The CLI access token (app<id>:<secret> from BotFather → the bot → Serverless → CLI Access — NOT
//   the bot token) comes ONLY from the environment variable WangerStickers_BOT_TGCLOUD_TOKEN and is
//   handed to the CLI as TGCLOUD_TOKEN for this child process only. It is never printed, logged or
//   written to disk. A generic TGCLOUD_TOKEN is ignored on purpose: this repository holds several
//   bots and that token could belong to any of them.
// - The CLI acts on the nearest folder with a `.tgcloud/` directory. This script runs from
//   wanger-stickers/ and makes sure wanger-stickers/.tgcloud/ exists, so it can never touch another
//   bot in this repository (the repository root is the to-do bot).
// - `migrate` is passed through as typed: the CLI asks before applying. Never add --yes here.
// - Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1; it is set when a proxy is.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN_VAR = 'WangerStickers_BOT_TGCLOUD_TOKEN';
const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');

/** Environment for a CLI child process, or an error message. */
export function cliEnv() {
  const token = (process.env[TOKEN_VAR] || '').trim(); // pasted values often carry stray spaces
  if (!fs.existsSync(CLI)) return { error: 'The tgcloud CLI is not installed: run `npm install` in wanger-stickers/ first.' };
  if (!/^app\d+:\S+$/.test(token)) {
    return { error: `${TOKEN_VAR} is missing or is not a CLI access token (app<id>:<secret>). Get it from BotFather → the bot → Serverless → CLI Access.` };
  }
  fs.mkdirSync(path.join(ROOT, '.tgcloud'), { recursive: true });
  const env = { ...process.env, TGCLOUD_TOKEN: token };
  delete env[TOKEN_VAR];
  if (process.env.HTTPS_PROXY || process.env.https_proxy) env.NODE_USE_ENV_PROXY = '1';
  return { env };
}

/** Runs the CLI with inherited stdio; returns the exit code. */
export function runCli(args, opts = {}) {
  const { env, error } = cliEnv();
  if (error) {
    console.error(error);
    return 1;
  }
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (opts.capture) return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  return r.status === null ? 1 : r.status;
}

function npm(script) {
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['run', script], { cwd: ROOT, stdio: 'inherit', shell: isWin });
  return r.status === null ? 1 : r.status;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === 'deploy') {
    // Build first (push uploads dist/ as it is on disk), then push. Never migrate here.
    const b = npm('build');
    if (b !== 0) process.exit(b);
    process.exit(runCli(['push', ...args.slice(1)]));
  }
  process.exit(runCli(args.length ? args : ['--help']));
}
