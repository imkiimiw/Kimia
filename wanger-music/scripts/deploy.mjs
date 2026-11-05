// npm run deploy — the only deploy path:
//   tests → stamp version → migrate --local --safe → push → migrate --safe → webhook check
// The database gets new tables BEFORE the new code goes live (migrations are additive), so new code
// never meets an old database. Only "safe" migration steps are applied; a warning/manual step stops
// here and must be reviewed by hand (`npm run tg -- migrate --dry-run`). Never uses --yes or --force.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const step = (label, args, cmd = process.execPath) => {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`✗ ${label} failed — stopping.`);
    process.exit(r.status || 1);
  }
};
const tg = (...args) => [path.join(ROOT, 'scripts/tg.mjs'), ...args];

const leftovers = fs.readdirSync(path.join(ROOT, 'tgcloud/endpoints')).filter((f) => f.startsWith('zz_'));
if (leftovers.length) {
  console.error(`✗ temporary modules present (${leftovers.join(', ')}): a smoke run is in progress or was interrupted. Remove them first.`);
  process.exit(1);
}

step('tests', ['--no-warnings', '--import', './tests/sdk/register.mjs', '--test', 'tests/unit/*.test.mjs', 'tests/e2e/*.test.mjs']);
step('stamp version', [path.join(ROOT, 'scripts/stamp-version.mjs')]);
step('migrate (local schema, safe steps only)', tg('migrate', '--local', '--safe'));
step('push', tg('push'));
step('migrate (deployed schema, safe steps only)', tg('migrate', '--safe'));
step('migrate dry-run (should show nothing pending)', tg('migrate', '--dry-run'));
step('webhook', tg('webhook'));
console.log('\n✓ deployed. Check 🧪 System Status in the bot.');
