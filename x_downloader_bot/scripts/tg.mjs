// Runs the tgcloud CLI for the X downloader bot only:
//   npm run tg -- <command> [args]   any CLI command (status, diff, push, migrate, run, webhook, …)
//   npm run deploy                   migrate --local --safe → push → migrate --safe → webhook
//     (new tables/columns reach the database BEFORE the new code goes live; old code ignores them)
// The CLI acts on the nearest folder with a `.tgcloud/` directory; this script makes sure
// x_downloader_bot/.tgcloud/ exists and runs from x_downloader_bot/, so it never touches another
// bot in this repository (the repository root is itself a tgcloud project: the to-do bot).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, cliEnv } from './env.mjs';

const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
if (!fs.existsSync(CLI)) {
  console.error('The tgcloud CLI is not installed: run `npm install` in x_downloader_bot/ first.');
  process.exit(1);
}
const { env, error } = cliEnv();
if (error) {
  console.error(error);
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, '.tgcloud'), { recursive: true });

const cli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
};

const args = process.argv.slice(2);
if (args[0] === 'deploy') {
  for (const step of [['migrate', '--local', '--safe'], ['push', ...args.slice(1)], ['migrate', '--safe'], ['webhook']]) {
    const code = cli(step);
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
}
process.exit(cli(args.length ? args : ['--help']));
