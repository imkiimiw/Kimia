// Backups from the command line (docs/OPERATIONS.md). Every command runs a TEMPORARY owner-only
// module (tgcloud/endpoints/zz_backup.js) with `tgcloud run`; it is deleted afterwards and
// scripts/deploy.mjs refuses to push while it exists.
//
//   node scripts/backup.mjs export  [--staging]                 make a backup now (sent to the owner as a document)
//   node scripts/backup.mjs fetch   <out.json> [--staging]      download the last backup document (≤ 20 MB)
//   node scripts/backup.mjs counts  [--staging]                 rows per backed-up table
//   node scripts/backup.mjs restore <file.json> [--staging | --production] [--replace] [--tables a,b]
//
// restore: upserts every row by primary key (a row with the same id is overwritten; rows that clash
// on another unique column are skipped and reported). --replace first empties each restored table
// (and the search index) — a full restore into an empty or broken database. The target is the
// staging bot unless --production is given, which asks for the bot username to be typed.
// After the rows: the search index is rebuilt by the tick, stats are recounted, and the row counts
// are compared with the backup's.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 5557901897;
const ARG_BYTES = 96 * 1024; // one argument of `tgcloud run` (Linux caps a single argument at 128 KiB)
const SLICE = 768 * 1024; // bytes per download call (≈ 1 MB of base64 output)

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--tables');
const staging = !flag('--production');

const MODULE = `// TEMPORARY owner-only backup module (scripts/backup.mjs) — never deploy.
import { runEndpoint } from '../lib/core/boundary.js';
import { isOwnerId } from '../lib/permissions/policy.js';
import { base64 } from '../lib/backup/service.js';
const pack = (v) => ({ b64: base64(new TextEncoder().encode(JSON.stringify(v))) });
export default (input, ctx) => runEndpoint('zz_backup', async (app) => {
  const uid = ctx && ctx.initData && ctx.initData.user ? ctx.initData.user.id : 0;
  if (!isOwnerId(uid)) return pack({ error: 'owner only' });
  const actor = { telegram_id: uid, role: 'user' };
  try {
    if (input.op === 'export') { const r = await app.backup.exportToOwner(actor); return pack({ rows: r.rows, bytes: r.bytes, ms: r.ms, name: r.name, counts: r.counts }); }
    if (input.op === 'slice') return pack(await app.backup.lastFileSlice(actor, input.offset, input.length));
    if (input.op === 'chunk') return pack(await app.backup.restoreChunk(actor, input));
    if (input.op === 'finish') return pack(await app.backup.finishRestore(actor, { replace: !!input.replace }));
    if (input.op === 'reindex') return pack(await app.search.runReindex({ deadlineMs: app.clock.ms() + 8000 }));
    if (input.op === 'counts') { const counts = {}; for (const t of Object.keys(input.tables || {})) counts[t] = await app.repos.backup.count(t); return pack({ counts }); }
    return pack({ error: 'unknown op' });
  } catch (e) {
    return pack({ error: String((e && (e.key || e.description || e.message)) || e).slice(0, 300) });
  }
});
`;

/** Runs one op on the target bot; returns the decoded result. */
let runOp;
async function setup() {
  if (staging) {
    const s = await import('./staging.mjs');
    s.sync({ extraModules: { 'endpoints/zz_backup.js': MODULE } });
    runOp = (input) => decode(s.tg(['run', 'endpoints/zz_backup', JSON.stringify(input), '--ctx', JSON.stringify({ initData: { user: { id: OWNER } } })], { capture: true }));
    return { target: 'staging', cleanup: () => {} };
  }
  const file = path.join(ROOT, 'tgcloud/endpoints/zz_backup.js');
  fs.writeFileSync(file, MODULE);
  runOp = (input) => {
    for (let attempt = 0; ; attempt += 1) {
      const r = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'scripts/tg.mjs'), 'run', 'endpoints/zz_backup', JSON.stringify(input), '--ctx', JSON.stringify({ initData: { user: { id: OWNER } } })], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const m = /Too many requests: retry after (\d+)/i.exec(out); // the platform rate-limits `tgcloud run`
      if (m && attempt < 6) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (Number(m[1]) + 1) * 1000);
        continue;
      }
      return decode({ status: r.status || 0, stdout: out });
    }
  };
  return { target: 'PRODUCTION', cleanup: () => fs.rmSync(file, { force: true }) };
}

function decode({ status, stdout }) {
  const m = /b64:'([A-Za-z0-9+/=]*)'/.exec(stdout);
  if (!m) throw new Error(`no result (exit ${status}): ${stdout.replace(/\s+/g, ' ').slice(-400)}`);
  const v = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  if (v && v.error) throw new Error(v.error);
  return v;
}

/** Splits rows so that each op's JSON stays under the argument limit. */
function chunks(table, columns, rows, max) {
  const out = [];
  let cur = [];
  let size = 200 + Buffer.byteLength(JSON.stringify(columns));
  for (const r of rows) {
    const n = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (cur.length && (size + n > ARG_BYTES || cur.length >= max)) {
      out.push(cur);
      cur = [];
      size = 200 + Buffer.byteLength(JSON.stringify(columns));
    }
    if (n > ARG_BYTES - 400) throw new Error(`${table}: one row is larger than a chunk (${n} bytes)`);
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function main() {
  if (!['export', 'fetch', 'counts', 'restore'].includes(cmd)) {
    console.error('usage: node scripts/backup.mjs export|fetch <out>|counts|restore <file> [--staging|--production] [--replace] [--tables a,b]');
    process.exit(2);
  }
  let doc = null;
  if (cmd === 'restore') {
    if (!positional[0]) throw new Error('restore needs a backup file');
    doc = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    if (doc.format !== 'wanger-music-backup' || doc.version !== 1) throw new Error('not a Wanger Music backup (format/version)');
  }
  if (!staging && (cmd === 'restore')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Restore into PRODUCTION${flag('--replace') ? ' and REPLACE the tables' : ''}? Type the bot username (Wange_Musicbot) to go on: `);
    rl.close();
    if (answer.trim() !== 'Wange_Musicbot') throw new Error('cancelled');
  }
  const { target, cleanup } = await setup();
  try {
    if (cmd === 'export') {
      const r = runOp({ op: 'export' });
      console.log(`${target}: backup sent to the owner — ${r.name}, ${r.rows} rows, ${Math.ceil(r.bytes / 1024)} KB, built in ${r.ms} ms`);
      console.log(JSON.stringify(r.counts));
    } else if (cmd === 'fetch') {
      const out = positional[0];
      if (!out) throw new Error('fetch needs an output file');
      const parts = [];
      let offset = 0;
      let size = Infinity;
      while (offset < size) {
        const s = runOp({ op: 'slice', offset, length: SLICE });
        size = s.size;
        const bytes = Buffer.from(s.b64, 'base64');
        if (!bytes.length && offset < size) throw new Error('empty slice');
        parts.push(bytes);
        offset += bytes.length;
        process.stdout.write(`\r${target}: ${Math.round((offset / size) * 100)}% of ${Math.ceil(size / 1024)} KB`);
      }
      const all = Buffer.concat(parts);
      const parsed = JSON.parse(all.toString('utf8'));
      if (parsed.format !== 'wanger-music-backup') throw new Error('downloaded file is not a backup');
      fs.writeFileSync(out, all);
      console.log(`\nsaved ${out}: ${Object.values(parsed.counts).reduce((a, b) => a + b, 0)} rows, created ${new Date(parsed.created_at * 1000).toISOString()}`);
    } else if (cmd === 'counts') {
      const tables = Object.fromEntries(['settings', 'users', 'force_join_channels', 'artists', 'artist_aliases', 'sources', 'tracks', 'destination_channels', 'publications', 'broadcasts', 'stats_daily', 'audit_log'].map((t) => [t, 1]));
      console.log(JSON.stringify(runOp({ op: 'counts', tables }).counts));
    } else {
      const only = opt('--tables') ? opt('--tables').split(',') : null;
      const replace = flag('--replace');
      const names = Object.keys(doc.tables).filter((t) => !only || only.includes(t));
      const t0 = Date.now();
      let calls = 0;
      for (const name of names) {
        const { columns, rows } = doc.tables[name];
        const parts = chunks(name, columns, rows, 2000);
        if (!parts.length && replace) parts.push([]);
        let written = 0;
        for (let i = 0; i < parts.length; i++) {
          const r = runOp({ op: 'chunk', table: name, columns, rows: parts[i], replace: replace && i === 0 });
          written += r.written;
          calls += 1;
          process.stdout.write(`\r${target}: ${name} ${written}/${rows.length}   `);
        }
        console.log(`\r${target}: ${name}: ${written}/${rows.length} rows written${written < rows.length ? ` (${rows.length - written} skipped: another row holds a unique value)` : ''}`);
      }
      const fin = runOp({ op: 'finish', replace });
      // rebuild the search index now (the tick would do it too, a batch per tick)
      for (let i = 0, r = { done: false, indexed: 0 }; !r.done && i < 500; i++) {
        r = runOp({ op: 'reindex' });
        process.stdout.write(`\r${target}: search index ${r.done ? 'rebuilt' : `… ${r.indexed} tracks this round`}      `);
        if (r.skipped) break;
      }
      console.log('');
      // expected after a restore: the restore's own audit row, and internal settings it (re)writes
      const expected = (n) => (n === 'audit_log' ? [doc.counts[n], doc.counts[n] + 1] : n === 'settings' ? [doc.counts[n], doc.counts[n] + 1, doc.counts[n] + 2, doc.counts[n] + 3] : [doc.counts[n]]);
      const mismatch = names.filter((n) => !expected(n).includes(fin.counts[n]));
      console.log(`${target}: ${calls} chunks in ${Math.round((Date.now() - t0) / 1000)} s`);
      for (const n of names) console.log(`  ${n.padEnd(22)} backup ${String(doc.counts[n]).padStart(7)} · now ${String(fin.counts[n]).padStart(7)}${mismatch.includes(n) ? '  ← differs' : fin.counts[n] === doc.counts[n] ? '' : '  (+ the restore\'s own rows)'}`);
      if (!mismatch.length) console.log(`${target}: restore complete — every table has the backup's rows`);
      if (mismatch.length && replace) process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error(`\n${String(e.message || e)}`);
  process.exit(1);
});
