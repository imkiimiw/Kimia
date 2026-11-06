// Smoke tests with `tgcloud run` (spec §12).
//   npm run smoke              production, READ-ONLY: a temporary module returns the System Status
//                              data and compares the 📊 dashboard with direct SQL counts (no messages
//                              sent; the only write is the dashboard's refresh of today's derived stats)
//   npm run smoke -- --staging every fixture in tests/fixtures/updates/ through its handler, on the
//                              STAGING bot only (scripts/staging.mjs: WANGER_STAGING_TGCLOUD_TOKEN or
//                              WANGER_STAGING_TOKEN_FILE); these write to the staging database and may
//                              message the owner from the staging bot
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
  // the staging mirror (scripts/staging.mjs): its own folder and CLI state, patched for the staging bot
  const { sync, tg } = await import('./staging.mjs');
  try {
    sync();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const dir = path.join(ROOT, 'tests/fixtures/updates');
  let failed = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json5')).sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log(`\n=== ${f}: ${fx.about}`);
    const r = tg(['run', fx.module, JSON.stringify(fx.payload), ...(fx.ctx ? ['--ctx', JSON.stringify(fx.ctx)] : [])]);
    if (r.status !== 0) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

const file = path.join(ROOT, 'tgcloud/endpoints/zz_smoke.js');
fs.writeFileSync(file, `// TEMPORARY read-only smoke module (scripts/smoke.mjs) — never deploy.
// Phase 7: the 📊 dashboard numbers are compared with direct SQL on the tables (SELECTs only; the
// dashboard itself refreshes today's and yesterday's derived rows in stats_daily, nothing else).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { runEndpoint } from '../lib/core/boundary.js';
import { healthReport } from '../lib/core/health.js';
const one = async (q) => Number(((await db.get(q)) || {}).n) || 0;
async function compare(app, days) {
  const d = await app.stats.dashboard(days);
  const want = {
    'users.total': await one(sql\`SELECT count(*) AS n FROM users\`),
    'users.blocked': await one(sql\`SELECT coalesce(sum(is_blocked), 0) AS n FROM users\`),
    'users.new': await one(sql\`SELECT count(*) AS n FROM users WHERE created_at >= \${d.since}\`),
    'users.active': await one(sql\`SELECT count(*) AS n FROM users WHERE last_seen_at >= \${d.since}\`),
    'tracks.active': await one(sql\`SELECT count(*) AS n FROM tracks WHERE status = 'active'\`),
  };
  const got = { 'users.total': d.users.total, 'users.blocked': d.users.blocked, 'users.new': d.users.new, 'users.active': d.users.active, 'tracks.active': d.tracks.active };
  for (const c of d.channels) {
    const id = c.id;
    want[\`ch\${id}.published\`] = await one(sql\`SELECT count(*) AS n FROM publications WHERE channel_id = \${id} AND status = 'published' AND published_at >= \${d.since}\`);
    want[\`ch\${id}.published_all\`] = await one(sql\`SELECT count(*) AS n FROM publications WHERE channel_id = \${id} AND status = 'published'\`);
    want[\`ch\${id}.waiting\`] = await one(sql\`SELECT count(*) AS n FROM publications WHERE channel_id = \${id} AND status = 'pending_approval'\`);
    want[\`ch\${id}.failed\`] = await one(sql\`SELECT count(*) AS n FROM publications WHERE channel_id = \${id} AND status = 'failed'\`);
    Object.assign(got, { [\`ch\${id}.published\`]: c.published, [\`ch\${id}.published_all\`]: c.publishedAll, [\`ch\${id}.waiting\`]: c.waiting, [\`ch\${id}.failed\`]: c.failed });
  }
  const mismatches = Object.keys(want).filter((k) => want[k] !== got[k]).map((k) => ({ k, dashboard: got[k], direct: want[k] }));
  return { days, checked: Object.keys(want).length, mismatches, users: d.users, search: d.search, plays: d.plays, fj: d.fj };
}
export default () => runEndpoint('zz_smoke', async (app) => {
  const h = await healthReport(app);
  const stats = [await compare(app, 1), await compare(app, 7)];
  return { version: h.version, bot: h.me && h.me.username, db_ms: h.dbMs, users: h.stats, tick: h.tickLast, webhook: h.webhook.info ? 'ok' : 'restricted',
    force_join: h.channels.map((c) => [c.title, c.enabled ? c.last_check_status : 'disabled']), errors: h.errors.length,
    stats_match: stats.every((s) => !s.mismatches.length), stats };
});
`);
try {
  const r = run(['endpoints/zz_smoke', '{}', '--ctx', JSON.stringify({ initData: { user: { id: OWNER } } })]);
  process.exitCode = r.status || 0;
} finally {
  fs.rmSync(file, { force: true });
}
