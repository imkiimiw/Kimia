// Load test on the STAGING bot (spec Phase 8: "load test via scripted tgcloud run on staging").
//   node scripts/loadtest.mjs seed [--tracks 5000] [--users 2000]   synthetic catalog + users (staging only)
//   node scripts/loadtest.mjs run  [--n 40] [--parallel 4]           timed handler runs, p50 / p95 / max
//
// seed writes straight into the staging database through a TEMPORARY module (multi-row inserts;
// track_terms built with the real lib/search/terms.js), in batches that fit one invocation.
// run calls the real handlers with `tgcloud run`: inline queries (empty, prefixes, full words,
// Persian, misses, page 2), private searches, chosen results; fake query ids make answerInlineQuery
// fail with QUERY_ID_INVALID, which the bot treats as an expired query — the time still includes
// that Bot API round trip. Times are the CLI's server-side duration and the wall time of each call.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync, tg, STAGING_DIR, stagingToken, retryAfter } from './staging.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };

const SEED = `// TEMPORARY staging seed module (scripts/loadtest.mjs) — never deploy.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { termsForTrack, artistKeys } from '../lib/search/terms.js';
import { key } from '../lib/music/normalize.js';
const FA_W = ['دل','عشق','شب','باران','ماه','دریا','خیال','رویا','بی\\u200cتو','کوچه','آسمان','گل','نامه','سکوت','فردا','دیوانه','غریب','آرام','پرواز','خاطره'];
const EN_W = ['love','night','rain','moon','dream','fire','heart','light','shadow','ocean','city','gold','summer','lonely','forever','wild','blue','echo','storm','home'];
const FA_A = ['شادمهر عقیلی','محسن یگانه','ابی','داریوش','گوگوش','هایده','معین','سیاوش قمیشی','مازیار فلاحی','رضا صادقی','حامد همایون','علی لهراسبی','بابک جهانبخش','محسن چاوشی','همایون شجریان'];
const EN_A = ['The Weeknd','Adele','Coldplay','Imagine Dragons','Billie Eilish','Ed Sheeran','Dua Lipa','Taylor Swift','Drake','Rihanna','Sia','Muse','Radiohead','Arctic Monkeys','Lana Del Rey'];
const cj = (parts) => parts.reduce((acc, p, i) => (i ? sql\`\${acc}, \${p}\` : p), sql\`\`);
let r = 1;
const rnd = (n) => { r = (r * 1103515245 + 12345) % 2147483648; return r % n; };
const pid = (i) => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; let s = 'L'; let x = i * 7919 + 13; for (let k = 0; k < 8; k++) { s += a[x % a.length]; x = Math.floor(x / a.length) + k * 31; } return s; };
export default async (input) => {
  const now = Math.floor(Date.now() / 1000);
  if (input.op === 'users') {
    const rows = [];
    for (let i = input.from; i < input.from + input.count; i++) rows.push(sql\`(\${8000000 + i}, \${'lt' + i}, \${'Load ' + i}, 'fa', 'user', 0, 0, 0, \${now - (i % 30) * 86400}, \${now - (i % 10) * 3600})\`);
    for (let k = 0; k < rows.length; k += 200) await db.run(sql\`INSERT INTO users (telegram_id, username, first_name, language_code, role, is_banned, is_blocked, force_join_ok_until, created_at, last_seen_at) VALUES \${cj(rows.slice(k, k + 200))} ON CONFLICT DO NOTHING\`);
    return { users: rows.length };
  }
  r = input.from + 1;
  const tracks = [];
  for (let i = input.from; i < input.from + input.count; i++) {
    const fa = i % 2 === 0;
    const W = fa ? FA_W : EN_W;
    const A = fa ? FA_A : EN_A;
    const title = W[rnd(W.length)] + ' ' + W[rnd(W.length)] + (i % 7 === 0 ? ' ' + W[rnd(W.length)] : '');
    const artist = A[rnd(A.length)];
    tracks.push({ i, public_id: pid(i), title, artist, language: fa ? 'fa' : 'en', plays: rnd(500) });
  }
  const values = tracks.map((t) => sql\`(\${t.public_id}, \${t.title}, \${t.artist}, \${200 + (t.i % 100)}, \${t.language}, 'high', 'manual', \${'LOADFILE' + t.i}, \${'LOADUNIQ' + t.i}, \${key(t.title)}, \${key(t.artist)}, \${key(t.artist) + '|' + key(t.title) + '|' + t.i}, 'manual', 'active', 0, \${t.plays}, \${now - t.i}, \${now - t.i}, \${now - t.i})\`);
  const ids = [];
  for (let k = 0; k < values.length; k += 100) {
    const res = await db.run(sql\`INSERT INTO tracks (public_id, title, artist, duration, language, language_confidence, language_source, audio_file_id, audio_file_unique_id, normalized_title, normalized_artist, dup_key, source_type, status, added_by, play_count, created_at, updated_at, activated_at) VALUES \${cj(values.slice(k, k + 100))} ON CONFLICT DO NOTHING RETURNING id, public_id\`);
    ids.push(...res.rows);
  }
  const byPid = new Map(ids.map((x) => [x.public_id, x.id]));
  const terms = [];
  const artists = new Map();
  for (const t of tracks) {
    const id = byPid.get(t.public_id);
    if (!id) continue;
    for (const term of termsForTrack(t)) terms.push(sql\`(\${term}, \${id})\`);
    for (const a of artistKeys(t)) artists.set(a.key, a.name);
  }
  for (let k = 0; k < terms.length; k += 300) await db.run(sql\`INSERT INTO track_terms (term, track_id) VALUES \${cj(terms.slice(k, k + 300))} ON CONFLICT DO NOTHING\`);
  if (artists.size) await db.run(sql\`INSERT INTO artists (name, normalized_name, language, created_at) VALUES \${cj([...artists].map(([k, n]) => sql\`(\${n}, \${k}, NULL, \${now})\`))} ON CONFLICT (normalized_name) DO NOTHING\`);
  return { tracks: ids.length, terms: terms.length };
};
`;

/** Runs a CLI call asynchronously in the staging folder; resolves with server ms, wall ms and ok. */
function runAsync(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, TGCLOUD_TOKEN: stagingToken() };
    delete env.Music_BOT_TGCLOUD_TOKEN;
    delete env.WANGER_STAGING_TGCLOUD_TOKEN;
    if (process.env.HTTPS_PROXY || process.env.https_proxy) env.NODE_USE_ENV_PROXY = '1';
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js'), ...args], { cwd: STAGING_DIR, env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const m = /\s(\d+)ms\s*$/m.exec(out);
      resolve({ ok: code === 0 && /\{ok:true/.test(out), serverMs: m ? Number(m[1]) : null, wallMs: Date.now() - t0, tail: out.replace(/\s+/g, ' ').slice(-200) });
    });
  });
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

async function main() {
  const cmd = argv[0];
  stagingToken(); // refuses production
  if (cmd === 'seed') {
    const tracks = opt('--tracks', 5000);
    const users = opt('--users', 2000);
    sync({ extraModules: { 'endpoints/zz_seed.js': SEED } });
    for (let from = 0; from < users; from += 1000) {
      const r = tg(['run', 'endpoints/zz_seed', JSON.stringify({ op: 'users', from, count: Math.min(1000, users - from) })], { capture: true });
      console.log(`users ${from}…: ${r.stdout.replace(/\s+/g, ' ').slice(-120)}`);
    }
    for (let from = 0; from < tracks; from += 500) {
      const r = tg(['run', 'endpoints/zz_seed', JSON.stringify({ op: 'tracks', from, count: Math.min(500, tracks - from) })], { capture: true });
      console.log(`tracks ${from}…: ${r.stdout.replace(/\s+/g, ' ').slice(-120)}`);
    }
    sync(); // removes the temporary module from the mirror
    return;
  }
  if (cmd !== 'run') {
    console.error('usage: node scripts/loadtest.mjs seed [--tracks N] [--users N] | run [--n N] [--parallel K]');
    process.exit(2);
  }
  sync();
  const n = opt('--n', 40);
  const parallel = opt('--parallel', 4);
  const queries = ['', 'دل', 'عشق شب', 'شادمهر', 'love', 'lo', 'the weeknd', 'coldplay night', 'zzzz qqq', 'بی‌تو', 'آسمان باران', 'drea', 'muse', 'ابی'];
  /** @type {{name: string, args: string[]}[]} */
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const q = queries[i % queries.length];
    const from = { id: 8100000 + i, is_bot: false, first_name: 'Load', language_code: 'fa' };
    jobs.push({ name: 'inline_query', args: ['run', 'handlers/inline_query', JSON.stringify({ id: `lt${Date.now()}${i}`, from, query: q, offset: i % 9 === 8 ? '20' : '', chat_type: 'sender' })] });
    if (i % 4 === 0) jobs.push({ name: 'message (search)', args: ['run', 'handlers/message', JSON.stringify({ message_id: i + 1, date: 0, chat: { id: 8200000 + i, type: 'private' }, from: { ...from, id: 8200000 + i }, text: q || 'love' }), '--ctx', JSON.stringify({ update: { update_id: 900000000 + i } })] });
    if (i % 4 === 1) jobs.push({ name: 'chosen_inline_result', args: ['run', 'handlers/chosen_inline_result', JSON.stringify({ result_id: 'LnotATrack', from, query: q })] });
  }
  /** @type {Record<string, {server: number[], wall: number[], failed: number, tails: string[]}>} */
  const res = {};
  let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      let r = await runAsync(j.args);
      for (let k = 0; k < 6 && retryAfter(r.tail); k += 1) { // the platform rate-limits `tgcloud run`; not the bot
        await new Promise((ok) => setTimeout(ok, (retryAfter(r.tail) + 1) * 1000)); // local Node script: timers are fine here
        r = await runAsync(j.args);
      }
      const s = (res[j.name] ||= { server: [], wall: [], failed: 0, tails: [] });
      if (r.serverMs !== null) s.server.push(r.serverMs);
      s.wall.push(r.wallMs);
      if (!r.ok) { s.failed += 1; if (s.tails.length < 2) s.tails.push(r.tail); }
    }
  }));
  console.log(`${jobs.length} runs, ${parallel} in parallel, ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const [name, s] of Object.entries(res)) {
    console.log(`${name.padEnd(22)} n=${String(s.server.length).padStart(3)}  server p50 ${pct(s.server, 50)} ms · p95 ${pct(s.server, 95)} ms · max ${Math.max(...s.server)} ms   wall p50 ${pct(s.wall, 50)} ms · p95 ${pct(s.wall, 95)} ms   failed ${s.failed}`);
    for (const t of s.tails) console.log(`   ✗ ${t}`);
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
