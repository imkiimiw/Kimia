// Smoke tests with `tgcloud run` (spec §12).
//   npm run smoke              production, READ-ONLY: a temporary module returns the System Status
//                              data (no writes after the first bootstrap, no messages sent)
//   npm run smoke -- --staging every fixture in tests/fixtures/updates/ through its handler, on the
//                              STAGING bot only (needs WANGER_STAGING_TGCLOUD_TOKEN); these write to
//                              the staging database and message the owner from the staging bot
// The temporary module tgcloud/endpoints/zz_smoke.js is deleted afterwards; never push while it exists
// (scripts/deploy.mjs refuses to).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 5557901897;
const staging = process.argv.includes('--staging');
const run = (args, env = process.env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/tg.mjs'), 'run', ...args], { cwd: ROOT, stdio: 'inherit', env });

if (staging) {
  const token = process.env.WANGER_STAGING_TGCLOUD_TOKEN;
  if (!/^app\d+:\S+$/.test(token || '')) {
    console.error('Set WANGER_STAGING_TGCLOUD_TOKEN (the staging bot\'s CLI access token). Fixtures never run on production.');
    process.exit(1);
  }
  if (token === process.env.Music_BOT_TGCLOUD_TOKEN) {
    console.error('WANGER_STAGING_TGCLOUD_TOKEN is the production token. Refusing.');
    process.exit(1);
  }
  const env = { ...process.env, Music_BOT_TGCLOUD_TOKEN: token };
  const dir = path.join(ROOT, 'tests/fixtures/updates');
  let failed = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json5')).sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log(`\n=== ${f}: ${fx.about}`);
    const r = run([fx.module, JSON.stringify(fx.payload), ...(fx.ctx ? ['--ctx', JSON.stringify(fx.ctx)] : [])], env);
    if (r.status !== 0) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

const file = path.join(ROOT, 'tgcloud/endpoints/zz_smoke.js');
fs.writeFileSync(file, `// TEMPORARY read-only smoke module (scripts/smoke.mjs) — never deploy.
import { runEndpoint } from '../lib/core/boundary.js';
import { healthReport } from '../lib/core/health.js';
export default () => runEndpoint('zz_smoke', async (app) => {
  const h = await healthReport(app);
  return { version: h.version, bot: h.me && h.me.username, db_ms: h.dbMs, users: h.stats, tick: h.tickLast, webhook: h.webhook.info ? 'ok' : 'restricted',
    force_join: h.channels.map((c) => [c.title, c.enabled ? c.last_check_status : 'disabled']), errors: h.errors.length };
});
`);
try {
  const r = run(['endpoints/zz_smoke', '{}', '--ctx', JSON.stringify({ initData: { user: { id: OWNER } } })]);
  process.exitCode = r.status || 0;
} finally {
  fs.rmSync(file, { force: true });
}
