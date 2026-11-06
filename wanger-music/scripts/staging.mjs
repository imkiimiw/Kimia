// The staging bot (spec §12: smoke tests, load tests and restores run on staging, never production).
//   node scripts/staging.mjs sync            mirror this project into the staging folder
//   node scripts/staging.mjs tg <cli args>   the tgcloud CLI, in the staging folder, for the staging bot
//   node scripts/staging.mjs deploy          sync → migrate --local --safe → push → migrate --safe → webhook
//
// - Token: WANGER_STAGING_TGCLOUD_TOKEN (the staging bot's CLI access token), or a file named by
//   WANGER_STAGING_TOKEN_FILE. Refused when it is the production token or the production app id.
// - Folder: WANGER_STAGING_DIR (default <os tmp>/wanger-music-staging), outside the repository, with
//   its OWN .tgcloud/ — the production project's CLI state is never used for staging.
// - The mirror is patched for the staging bot: BOT_ID / BOT_USERNAME (from WANGER_STAGING_BOT_ID /
//   WANGER_STAGING_BOT_USERNAME), an empty force-join seed and no suggested destination channels,
//   so staging can never post to or gate on the real channels. Nothing else differs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_APP = '9280424458';
export const STAGING_DIR = process.env.WANGER_STAGING_DIR || path.join(os.tmpdir(), 'wanger-music-staging');

export function stagingToken() {
  const file = process.env.WANGER_STAGING_TOKEN_FILE;
  const token = (process.env.WANGER_STAGING_TGCLOUD_TOKEN || (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')).trim();
  if (!/^app\d+:\S+$/.test(token)) throw new Error('Set WANGER_STAGING_TGCLOUD_TOKEN (or WANGER_STAGING_TOKEN_FILE): the staging bot\'s CLI access token.');
  if (token === (process.env.Music_BOT_TGCLOUD_TOKEN || '').trim() || token.startsWith(`app${PROD_APP}:`)) throw new Error('That is the production bot. Staging commands never run on production.');
  return token;
}

const SKIP = (rel) => /(^|\/)endpoints\/zz_[^/]*\.js$/.test(rel);

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) copyTree(a, b);
    else if (!SKIP(path.relative(ROOT, a).split(path.sep).join('/'))) fs.copyFileSync(a, b);
  }
}

/** Mirrors tgcloud/ + project files into the staging folder and patches the static config. */
export function sync({ extraModules = {} } = {}) {
  const id = process.env.WANGER_STAGING_BOT_ID || '9217669709';
  const username = process.env.WANGER_STAGING_BOT_USERNAME || '';
  if (!/^\d{5,12}$/.test(id) || id === PROD_APP) throw new Error('WANGER_STAGING_BOT_ID must be the staging bot\'s numeric id.');
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  copyTree(path.join(ROOT, 'tgcloud'), path.join(STAGING_DIR, 'tgcloud'));
  for (const f of ['tgcloud.jsonc', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(STAGING_DIR, f));
  const nm = path.join(STAGING_DIR, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(ROOT, 'node_modules'), nm, 'dir');
  fs.mkdirSync(path.join(STAGING_DIR, '.tgcloud'), { recursive: true });
  const cfg = path.join(STAGING_DIR, 'tgcloud/lib/config/static.js');
  let s = fs.readFileSync(cfg, 'utf8');
  const patch = (re, to, what) => {
    if (!re.test(s)) throw new Error(`staging patch failed: ${what}`);
    s = s.replace(re, to);
  };
  patch(/export const BOT_ID = \d+;/, `export const BOT_ID = ${id}; // STAGING`, 'BOT_ID');
  if (username) patch(/export const BOT_USERNAME = '[^']*';/, `export const BOT_USERNAME = '${username.replace(/[^A-Za-z0-9_]/g, '')}'; // STAGING`, 'BOT_USERNAME');
  patch(/export const FORCE_JOIN_SEED = Object\.freeze\(\[[\s\S]*?\]\);/, 'export const FORCE_JOIN_SEED = Object.freeze([]); // STAGING: no real channels', 'FORCE_JOIN_SEED');
  patch(/export const SUGGESTED_DESTINATIONS = Object\.freeze\(\[[\s\S]*?\]\);/, 'export const SUGGESTED_DESTINATIONS = Object.freeze([]); // STAGING: never the real channels', 'SUGGESTED_DESTINATIONS');
  fs.writeFileSync(cfg, s);
  for (const [rel, code] of Object.entries(extraModules)) fs.writeFileSync(path.join(STAGING_DIR, 'tgcloud', rel), code);
  return STAGING_DIR;
}

/** Blocking sleep for CLI scripts (no timers needed). */
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** `tgcloud run` is rate-limited by the platform ("Too many requests: retry after N"): seconds to wait, or 0. */
export const retryAfter = (out) => { const m = /Too many requests: retry after (\d+)/i.exec(String(out || '')); return m ? Number(m[1]) : 0; };

/** Runs the CLI in the staging folder (waits and retries when the platform rate-limits the CLI). @returns {{status: number, stdout: string}} */
export function tg(args, { capture = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const r = tgOnce(args, { capture: true });
    const wait = retryAfter(r.stdout);
    if (wait && attempt < 6) {
      process.stderr.write(`(CLI rate limit: waiting ${wait + 1} s)\n`);
      sleepSync((wait + 1) * 1000);
      continue;
    }
    if (!capture) process.stdout.write(r.stdout);
    return r;
  }
}

function tgOnce(args, { capture = false } = {}) {
  const env = { ...process.env, TGCLOUD_TOKEN: stagingToken() };
  delete env.Music_BOT_TGCLOUD_TOKEN;
  delete env.WANGER_STAGING_TGCLOUD_TOKEN;
  if (process.env.HTTPS_PROXY || process.env.https_proxy) env.NODE_USE_ENV_PROXY = '1';
  const cli = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
  const r = spawnSync(process.execPath, ['--no-warnings', cli, ...args], { cwd: STAGING_DIR, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? 1 : r.status, stdout: capture ? `${r.stdout || ''}${r.stderr || ''}` : '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'sync') console.log(`staging folder: ${sync()}`);
    else if (cmd === 'tg') {
      if (!fs.existsSync(path.join(STAGING_DIR, 'tgcloud'))) sync();
      process.exit(tg(rest).status);
    } else if (cmd === 'deploy') {
      sync();
      for (const [label, args] of [['migrate (local schema, safe)', ['migrate', '--local', '--safe']], ['push', ['push']], ['migrate (deployed, safe)', ['migrate', '--safe']], ['webhook', ['webhook']]]) {
        console.log(`\n▶ staging: ${label}`);
        const r = tg(args);
        if (r.status !== 0) process.exit(r.status);
      }
    } else {
      console.error('usage: node scripts/staging.mjs sync | tg <cli args> | deploy');
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
