// Index and query review (spec Phase 8): runs the whole test suite with query-plan recording on
// (tests/sdk/db.mjs explains every statement once), then lists every FULL SCAN of a table that can
// grow. Each one must be in ALLOWED below, with the reason it is acceptable; anything else fails
// (exit 1). Sorts in a temporary b-tree after an index lookup are listed for information (they sort
// only the rows the index found). Small, bounded tables (≤ 100 rows by rule) are not reported.
//   npm run query-review
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wanger-plans-'));

/** Tables that grow with use. The rest are capped by rule (force-join ≤ 10, sources ≤ 50, destinations ≤ 20, settings, broadcasts…). */
const LARGE = ['users', 'tracks', 'track_terms', 'artists', 'artist_aliases', 'publications', 'stats_daily', 'processed_updates', 'error_log', 'audit_log', 'alerts', 'user_flows', 'import_sessions'];

/**
 * Accepted scans: [pattern on the SQL, table, why]. Keep this list short and honest.
 * @type {[RegExp, string, string][]}
 */
const ALLOWED = [
  [/^SELECT count\(\*\) AS total, coalesce\(sum\(last_seen_at >=/, 'users', 'users.stats(): totals for 👥 Users, 🧪 System Status and 📊 (owner/admin screens only; one pass, no sort)'],
  [/^SELECT count\(\*\) AS n FROM users WHERE is_blocked = 0 AND is_banned = 0/, 'users', 'broadcast recipient count, shown before a broadcast (owner only)'],
  [/^SELECT count\(\*\) AS total, coalesce\(sum\(status = 'draft'\)/, 'tracks', 'catalog.counts(): totals for 🎵 Music / System Status / 📊 (staff screens only)'],
  [/^SELECT coalesce\(sum\(status = 'pending_approval'\), 0\) AS pending/, 'publications', 'publisher.counts(): totals for System Status (owner only)'],
  [/^SELECT id, created_at, handler, code, message FROM error_log ORDER BY id DESC LIMIT/, 'error_log', 'newest errors: a reverse rowid walk that stops after LIMIT rows'],
  [/^SELECT \* FROM audit_log ORDER BY id DESC LIMIT/, 'audit_log', 'newest audit rows: reverse rowid walk with LIMIT'],
  [/^DELETE FROM error_log WHERE id <=/, 'error_log', 'retention: rowid range'],
  [/^SELECT count\(\*\) AS n FROM track_terms/, 'track_terms', 'index size on 🧪 System Status (owner only, on demand; a count over the covering primary key)'],
  [/^UPDATE users SET force_join_ok_until = 0 WHERE id IN \( SELECT id FROM users WHERE force_join_ok_until > /, 'users', 'invalidates every pass when the owner changes the force-join list, 5000 rows per statement (rare owner action; an index would cost a write on every pass)'],
  [/^SELECT count\(\*\) AS n FROM \(SELECT created_at FROM error_log ORDER BY id DESC LIMIT/, 'error_log', 'monitoring: errors of the last hour among the newest 500 rows (a reverse rowid walk that stops after LIMIT)'],
  // backup export / restore (repositories/backup.js, quoted identifiers): reading or clearing a whole table is the point
  ...LARGE.map((t) => [new RegExp(`^SELECT .* FROM "${t}"( WHERE .*)? ORDER BY .* LIMIT`), t, 'backup export: the whole table in key order, 1000 rows per page (owner action / weekly)']),
  ...LARGE.map((t) => [new RegExp(`^SELECT count\\(\\*\\) AS n FROM "${t}"$`), t, 'backup/restore: row count to compare with the backup']),
  ...LARGE.map((t) => [new RegExp(`^DELETE FROM "${t}" WHERE`), t, 'restore --replace: empties the table, 5000 rows per statement']),
];

const r = spawnSync(process.execPath, ['--no-warnings', '--import', './tests/sdk/register.mjs', '--test', 'tests/unit/*.test.mjs', 'tests/e2e/*.test.mjs'], {
  cwd: ROOT, env: { ...process.env, WANGER_QUERY_PLAN_DIR: DIR }, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
});
const summary = (r.stdout.match(/^# (tests|pass|fail) \d+$/gm) || []).join(' · ');
if (r.status !== 0) {
  console.error(`tests failed (${summary}); fix them first`);
  process.exit(1);
}

/** @type {Map<string, string[]>} */
const all = new Map();
for (const f of fs.readdirSync(DIR)) for (const p of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) all.set(p.query, p.plan);
fs.rmSync(DIR, { recursive: true, force: true });

const findings = [];
const accepted = [];
const sorts = [];
for (const [query, plan] of all) {
  for (const step of plan) {
    const m = /^(SCAN|USE TEMP B-TREE)\b\s*(\w+)?/.exec(step);
    if (!m) continue;
    // temp sorts name no table: attribute them to the FROM table
    const table = m[1] === 'SCAN' ? m[2] : (/\bFROM\s+(\w+)/i.exec(query) || [])[1];
    if (!table || !LARGE.includes(table)) continue;
    if (m[1] !== 'SCAN') {
      sorts.push(`${table}: ${step} — ${query.slice(0, 140)}`);
      continue;
    }
    if (/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/.test(step) && /\bLIMIT\b/i.test(query)) continue; // index-ordered walk with a LIMIT
    const allow = ALLOWED.find(([re, t]) => t === table && re.test(query));
    (allow ? accepted : findings).push({ table, step, query: query.slice(0, 220), why: allow ? allow[2] : '' });
  }
}

console.log(`Statements explained: ${all.size} (${summary})`);
console.log(`Sorts after an index lookup (information): ${sorts.length}`);
if (process.argv.includes('--sorts')) for (const x of sorts) console.log(`  · ${x}`);
console.log(`Accepted scans: ${accepted.length}`);
for (const a of accepted) console.log(`  ✓ ${a.table}: ${a.step}\n      ${a.query}\n      → ${a.why}`);
if (findings.length) {
  console.log(`\nNOT ACCEPTED: ${findings.length}`);
  for (const f of findings) console.log(`  ✗ ${f.table}: ${f.step}\n      ${f.query}`);
  process.exit(1);
}
console.log('\nNo unexpected full scans of growing tables.');
