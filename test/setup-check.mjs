// Simulates a half-finished dashboard setup (no D1 binding, no secrets, no cron) and checks the
// status page explains each missing piece instead of crashing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.resolve(process.env.SETUP_CHECK_MAIN || path.join(ROOT, 'src/index.js'));
const work = mkdtempSync(path.join(tmpdir(), 'todo-bot-setup-'));
const config = path.join(work, 'wrangler.toml');
writeFileSync(config, `name = "todo-bot-bare"\nmain = ${JSON.stringify(main)}\ncompatibility_date = "2025-09-01"\n`);
const port = 20000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${port}`;

const child = spawn('npx', ['wrangler', 'dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', path.join(work, 'state'), '--show-interactive-dev-session=false'], {
  cwd: ROOT,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

let code = 0;
try {
  for (let i = 0; !/Ready on/.test(log); i += 1) {
    if (i > 600 || child.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  let html = '';
  for (let i = 0; i < 100 && !html; i += 1) {
    try {
      html = await (await fetch(BASE + '/')).text();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  for (const part of ['❌</span><div>دیتابیس D1', 'Variable name دقیقاً <code>DB</code>', '❌</span><div>توکن ربات', '❌</span><div>رمز وبهوک']) {
    assert.ok(html.includes(part), `expected «${part}» in status page:\n${html}`);
  }
  assert.equal((await fetch(BASE + '/webhook', { method: 'POST', body: '{}' })).status, 403);
  const setup = await fetch(BASE + '/setup?secret=x');
  assert.equal(setup.status, 500);
  assert.match(await setup.text(), /BOT_TOKEN/);
  console.log('  ✔ half-finished setup: status page lists DB, BOT_TOKEN and WEBHOOK_SECRET as missing; /webhook and /setup refuse safely');
} catch (err) {
  code = 1;
  console.log(`  ✘ setup check\n${String(err.stack || err).replace(/^/gm, '      ')}`);
} finally {
  child.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
