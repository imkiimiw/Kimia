#!/usr/bin/env node
// Runs every scenario on Telegram Serverless itself, with `npx tgcloud run`: the platform executes
// the local handlers against the bot's real database, the real Bot API and the real FxTwitter /
// vxTwitter / twimg, without deploying.
//
//   npm run test:cloud        (needs X_BOT_TGCLOUD_TOKEN, see .env.example, and a migrated DB)
//
// - Downloads are sent to the OWNER's chat (5557901897), so the owner really receives the videos,
//   albums and GIFs in Telegram. The owner's settings are restored at the end.
// - Test users have fake ids 990000001-990000003: messages to them fail with "chat not found",
//   and the handlers return a trace of every Bot API call (method, view, text, buttons, Telegram's
//   answer), so the assertions run on that trace plus a read-back of the database.
// - The broadcast test runs only if the bot has no real users besides the owner (it never messages
//   real people); its recipients are the test users (400) and BotFather (a bot: a real 403).
// - Everything is restored at the end: test users, fake channels, removed channels, join on/off.
// - Raw CLI output goes to test/cloud/output/run.log, the summary to test/cloud/output/summary.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { cliEnv } from '../../scripts/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const DEVTOOLS_SRC = path.join(ROOT, 'test/cloud/devtools.js');
const DEVTOOLS_DIR = path.join(ROOT, 'tgcloud/endpoints');
const DEVTOOLS_DST = path.join(DEVTOOLS_DIR, 'zz_devtools.js');
const OUT_DIR = path.join(ROOT, 'test/cloud/output');

const OWNER = 5557901897;
const BOTFATHER = 93372553;
const TU1 = 990000001; // main test user
const TU2 = 990000002;
const TU3 = 990000003; // never a channel member
const TEST_USERS = [TU1, TU2, TU3, BOTFATHER];

const P = {
  video: { id: '2118034216503955710', user: 'NASA' },
  photos: { id: '2112592291147747809', user: 'SpaceX' },
  gif: { id: '2090559778699489429', user: 'GIPHY' },
  text: { id: '20', user: 'jack' },
  twovid: { id: '2115476295169814978', user: 'SpaceX' },
  missing: { id: '1000000000000000000', user: 'jack' },
};
const link = (p, extra = '') => `https://x.com/${p.user}/status/${p.id}${extra}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'run.log');
fs.writeFileSync(LOG, `tgcloud run log — ${new Date().toISOString()}\n`);
const log = (s) => fs.appendFileSync(LOG, `${s}\n`);

// ---------- running modules on the platform ----------

// TGCLOUD_CLI_ARGS (JSON array of node arguments) replaces the real CLI; only
// test/cloud/local-harness.mjs sets it, to check this script against the local emulation.
const CLI_ARGS = process.env.TGCLOUD_CLI_ARGS ? JSON.parse(process.env.TGCLOUD_CLI_ARGS) : [CLI];
// The real CLI gets this bot's token (X_BOT_TGCLOUD_TOKEN) as TGCLOUD_TOKEN, see scripts/env.mjs.
const CHILD = process.env.TGCLOUD_CLI_ARGS ? { env: process.env } : cliEnv();
if (CHILD.error) {
  console.error(CHILD.error);
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, '.tgcloud'), { recursive: true });
let runs = 0;

// The CLI API rate-limits `run` ("Too many requests: retry after N"): the module never ran, so wait
// and send it again.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function tgcloudRun(module, args, ctx) {
  for (let attempt = 1; ; attempt += 1) {
    const r = tgcloudRunOnce(module, args, ctx);
    const m = !r.exitOk && /Too many requests: retry after (\d+)/i.exec(r.out);
    if (!m || attempt >= 6) return r;
    log(`(rate limited by the CLI API: waiting ${m[1]} s, attempt ${attempt + 1})`);
    sleepSync((Number(m[1]) + 1) * 1000);
  }
}

function tgcloudRunOnce(module, args, ctx) {
  const argv = [...CLI_ARGS, 'run', module, JSON.stringify(args)];
  if (ctx) argv.push('--ctx', JSON.stringify(ctx));
  runs += 1;
  let out;
  let exitOk = true;
  const started = Date.now();
  try {
    out = execFileSync(process.execPath, argv, {
      cwd: ROOT,
      env: { ...CHILD.env, FORCE_COLOR: '0', NO_COLOR: '1', TGCLOUD_NO_PAGER: '1' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exitOk = false;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const wall = Date.now() - started;
  log(`\n$ npx tgcloud run ${module} '${JSON.stringify(args)}'${ctx ? ` --ctx '${JSON.stringify(ctx)}'` : ''}\n${out.trimEnd()}`);
  const line = out.split('\n').reverse().find((l) => l.startsWith('< '));
  let value;
  let ms = null;
  if (line) {
    const m = line.slice(2).match(/^(.*?)\s+(\d+)ms\s*$/);
    const raw = m ? m[1] : line.slice(2);
    ms = m ? Number(m[2]) : null;
    try {
      value = JSON5.parse(raw);
    } catch {
      value = raw;
    }
  }
  return { exitOk, out, value, ms, wall };
}

function devtools(input) {
  const r = tgcloudRun('endpoints/zz_devtools', input, { initData: { user: { id: OWNER, first_name: 'Owner' } } });
  if (!r.exitOk) throw new Error(`devtools ${input.op} failed:\n${r.out.slice(-2000)}`);
  return r.value;
}

// ---------- realistic update payloads ----------

let seq = 1;
const nowSec = () => Math.floor(Date.now() / 1000);
const person = (id) => ({ id, is_bot: false, first_name: id === OWNER ? 'Owner' : `Tester${id % 1000}`, language_code: 'fa' });
const privateChat = (id) => ({ id, first_name: person(id).first_name, type: 'private' });

function sendText(uid, text, extraCtx = {}, messageId) {
  const n = seq++;
  const message = { message_id: messageId || 100000 + n, from: person(uid), chat: privateChat(uid), date: nowSec(), text };
  const cmd = /^\/[A-Za-z0-9_]+/.exec(text);
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  return analyse(tgcloudRun('handlers/message', message, { update: { update_id: 700000000 + n, message }, ...extraCtx }));
}

function press(uid, data, { media = false, messageId } = {}) {
  const n = seq++;
  const message = {
    message_id: messageId || 200000 + n,
    from: { id: 1, is_bot: true, first_name: 'Bot' },
    chat: privateChat(uid),
    date: nowSec() - 30,
  };
  if (media) Object.assign(message, { video: { file_id: 'x', file_unique_id: 'x', width: 720, height: 1280, duration: 41 }, caption: '…' });
  else message.text = '…';
  const callbackQuery = { id: `${4000000000000 + n}`, from: person(uid), message, chat_instance: '-5170000000000000000', data };
  return analyse(tgcloudRun('handlers/callback_query', callbackQuery, { update: { update_id: 700000000 + n, callback_query: callbackQuery } }));
}

const apiUse = { fx: 0, vx: 0, fxErrors: 0, vxErrors: 0 };

function analyse(r) {
  const v = r.value && typeof r.value === 'object' ? r.value : {};
  const trace = Array.isArray(v.trace) ? v.trace : [];
  const api = Array.isArray(v.api) ? v.api : [];
  for (const a of api) {
    if (a.result === 'ok') apiUse[a.api] += 1;
    else if (a.result === 'network_error' || a.result === 'temporary') apiUse[`${a.api}Errors`] += 1;
  }
  const screens = trace.filter((t) => (t.m === 'sendMessage' || t.m === 'editMessageText') && !['owner_warning', 'bc_progress', 'progress'].includes(t.view));
  const last = screens[screens.length - 1] || null;
  const answers = trace.filter((t) => t.m === 'answerCallbackQuery');
  const kb = last && last.kb ? last.kb.flat() : [];
  const data = kb.map((b) => (b.match(/\[([^\]]+)\]$/) || [])[1]).filter(Boolean);
  const urls = kb.map((b) => (b.match(/ -> (https:\S+)$/) || [])[1]).filter(Boolean);
  const media = trace.filter((t) => /^send(Video|Photo|Animation|Document|MediaGroup)$/.test(t.m));
  const handlerError = !r.exitOk || trace.some((t) => t.view === 'error') || !Array.isArray(v.trace);
  return { ...r, trace, api, screens, last, view: last ? last.view : null, text: last ? last.text || '' : '', data, urls, answers, media, results: v.results, handlerError };
}

const USER_NOT_IN_CHANNEL = /member not found|user not found|participant_id_invalid|user_id_invalid|user_not_participant/i;
const memberChecks = (res) => res.trace.filter((t) => t.m === 'getChatMember');
const mediaLine = (res) => res.media.map((m) => `${m.m}[${m.src || (m.media || []).join('+')}${m.q ? ` ${m.q}` : ''}${m.bytes ? ` ${(m.bytes / 1048576).toFixed(1)}MB` : ''}${m.ms != null ? ` ${m.ms}ms` : ''}]${m.ok ? '✓' : `✗ ${m.err}`}`).join(', ');
const apiLine = (res) => res.api.map((a) => `${a.api}#${a.attempt}=${a.http ? `${a.http} ` : ''}${a.result}${a.ms != null ? ` ${a.ms}ms` : ''}`).join(', ');

// ---------- scenario bookkeeping ----------

const results = [];
class Fail extends Error {}
class Warn extends Error {}
function expect(cond, message) {
  if (!cond) throw new Fail(message);
}

async function scenario(name, fn) {
  log(`\n======== ${name} ========`);
  let status = 'PASS';
  let detail = '';
  try {
    detail = (await fn()) || '';
  } catch (err) {
    status = err instanceof Warn ? 'WARN' : 'FAIL';
    detail = err instanceof Fail || err instanceof Warn ? err.message : String(err.stack || err);
  }
  results.push({ name, status, detail });
  const icon = { PASS: '✔', FAIL: '✘', WARN: '⚠' }[status];
  console.log(`${icon} ${status}  ${name}${detail ? `\n         ${String(detail).split('\n').join('\n         ')}` : ''}`);
}

function screenOk(res, view, { callback = false } = {}) {
  expect(!res.handlerError, `handler error or no trace:\n${res.out.slice(-1500)}`);
  if (callback) expect(res.answers.length === 1, `answerCallbackQuery called ${res.answers.length} times`);
  if (view) expect(res.view === view, `expected view "${view}", got "${res.view}" (${res.text.slice(0, 200)})`);
  return res;
}

const delivered = (res, method) => res.media.find((m) => m.m === method && m.ok);
const cool = (uid) => devtools({ op: 'set_user', user: uid, set: { last_req: 0, busy_until: 0 } });
const today = () => new Date(Date.now() + 210 * 60000).toISOString().slice(0, 10);

// ---------- the scenarios ----------

async function main() {
  const probe = devtools({ op: 'probe' });
  console.log(`platform: ${JSON.stringify(probe)}\n`);
  const tables = devtools({ op: 'tables' }).filter((t) => t.type === 'table').map((t) => t.name);
  const start = devtools({ op: 'snapshot' });
  const originalChannels = start.channels.filter((c) => !c.uname.startsWith('zz_fake_'));
  const originalJoin = (start.settings.find((s) => s.key === 'join') || {}).value ?? '1';
  const ownerSettings = start.owner;
  devtools({ op: 'cleanup', users: TEST_USERS });
  devtools({ op: 'drop_fake_channels' });
  devtools({ op: 'set_setting', key: 'join', value: '1' });
  console.log(`tables: ${tables.join(', ')}\nchannels at start: ${originalChannels.map((c) => `@${c.username}`).join(', ') || '(none yet — the first update seeds them)'}; join=${originalJoin}; real users: ${start.realUsers}\n`);

  let joinEnforced = true;

  try {
    await scenario('0 all tables exist', () => {
      const want = ['users', 'posts', 'file_cache', 'downloads', 'channels', 'settings', 'counters', 'daily', 'user_state', 'broadcasts'];
      const missing = want.filter((t) => !tables.includes(t));
      expect(!missing.length, `missing tables: ${missing.join(', ')} — run npx tgcloud migrate --safe`);
      return `${want.length} tables: ${want.join(', ')}`;
    });

    await scenario('0b platform fetch: HEAD, Range and binary chunks work', () => {
      expect(probe.body && probe.body.total === 25042, `binary body: ${JSON.stringify(probe.body)}`);
      expect(probe.body.mp4Header === 'ftyp', `bytes intact (mp4 header): ${JSON.stringify(probe.body)}`);
      return JSON.stringify(probe);
    });

    // A re-run starts from an empty cache for the test posts, so downloads are really exercised.
    for (const p of [P.video, P.photos, P.gif, P.twovid]) devtools({ op: 'cache_forget', id: p.id });

    // ===== A. Forced join =====
    await scenario('A1 /start from a non-member → join screen with a link button per channel + ✅ عضو شدم', () => {
      const r = screenOk(sendText(TU3, '/start'));
      const checks = memberChecks(r);
      const snap = devtools({ op: 'snapshot' });
      expect(snap.channels.length >= 1, 'channels table is empty (seed failed)');
      if (r.view !== 'join') {
        const errs = checks.filter((c) => !c.ok).map((c) => `${c.chat}: ${c.err}`);
        joinEnforced = false;
        if (errs.length === checks.length && checks.length) {
          throw new Warn(`every membership check failed, so join is not enforced:\n${errs.join('\n')}\n→ make the bot an ADMIN in each channel`);
        }
        throw new Fail(`expected the join screen, got ${r.view}`);
      }
      expect(r.data.includes('j'), 'no ✅ عضو شدم button');
      // "member not found" etc. is Telegram's answer for a user who is not in the channel: a real check.
      const failed = checks.filter((c) => !c.ok && !USER_NOT_IN_CHANNEL.test(c.err || ''));
      if (failed.length) {
        throw new Warn(`join screen shown for ${r.urls.join(', ')}, but these checks failed and are skipped (bot not admin?):\n${failed.map((c) => `${c.chat}: ${c.err}`).join('\n')}`);
      }
      return `join screen: ${r.urls.join(', ')} · channels seeded: ${snap.channels.map((c) => `@${c.username}`).join(', ')}`;
    });

    await scenario('A2 /start as the owner → menu, no membership check', () => {
      const r = screenOk(sendText(OWNER, '/start'), 'menu');
      expect(memberChecks(r).length === 0, 'owner was checked');
      expect(r.last.ok, `Telegram refused: ${r.last.err}`);
      expect(r.data.includes('a'), 'no admin button');
      return `sent to the owner (message ${r.last.mid})`;
    });

    await scenario('A3 "✅ عضو شدم" while still not a member → stays on the join screen, alert', () => {
      const r = screenOk(press(TU3, 'j'), null, { callback: true });
      if (!joinEnforced) throw new Warn('join not enforced (see A1)');
      expect(r.view === 'join' && r.answers[0].text.includes('هنوز'), `got ${r.view}: ${r.answers[0] && r.answers[0].text}`);
    });

    // ===== B. Downloads, delivered to the owner's chat =====
    devtools({ op: 'set_user', user: OWNER, set: { quality: 'auto', cap_text: 1, cap_author: 1, cap_link: 1, day: today(), day_count: 500 } });

    await scenario('B1 video post (NASA) → downloaded and sent with sendVideo; file_id cached', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.video)));
      const v = delivered(r, 'sendVideo');
      expect(v, `no video delivered: ${mediaLine(r)} ${r.text}`);
      const cache = devtools({ op: 'cache', id: P.video.id });
      expect(cache.some((c) => c.q === v.q), `file_id not cached: ${JSON.stringify(cache)}`);
      return `${apiLine(r)} → ${mediaLine(r)} · run ${r.ms}ms (owner had 500 downloads today: unlimited ✓)`;
    });

    await scenario('B2 the same link again → resent from cache (no API call, no download)', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.video, '?s=20&t=abc')));
      const v = delivered(r, 'sendVideo');
      expect(v && v.src === 'file_id' && r.api.length === 0, `expected a file_id resend: ${apiLine(r)} ${mediaLine(r)}`);
      return `${mediaLine(r)} · run ${r.ms}ms`;
    });

    await scenario('B3 post with 3 photos → one album (sendMediaGroup), original size', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.photos)));
      const a = delivered(r, 'sendMediaGroup');
      expect(a && a.media.length === 3 && a.media.every((m) => m.startsWith('photo')), `album: ${mediaLine(r)}`);
      expect(a.q === 'orig,orig,orig', `sizes: ${a.q}`);
      return `${apiLine(r)} → ${mediaLine(r)} · run ${r.ms}ms`;
    });

    await scenario('B3b 🖼 photos as original files (documents, no recompression)', () => {
      cool(OWNER);
      const r = screenOk(press(OWNER, `pd:${P.photos.id}`), null, { callback: true });
      const a = delivered(r, 'sendMediaGroup');
      expect(a && a.media.every((m) => m.startsWith('document')), `documents: ${mediaLine(r)}`);
      return mediaLine(r);
    });

    await scenario('B4 GIF post → sendAnimation (not a plain video)', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.gif)));
      expect(delivered(r, 'sendAnimation') && !r.media.some((m) => m.m === 'sendVideo'), `gif: ${mediaLine(r)}`);
      return `${apiLine(r)} → ${mediaLine(r)}`;
    });

    await scenario('B5 text-only post → clear Persian "no media" message', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.text)), 'download_failed');
      expect(r.text.includes('فقط متن'), r.text);
      return `${apiLine(r)} → "${r.text}"`;
    });

    await scenario('B6 deleted / invalid post → clear Persian "not found" message', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.missing)), 'download_failed');
      expect(r.text.includes('پیدا نشد'), r.text);
      return `${apiLine(r)} → "${r.text}"`;
    });

    await scenario('B7 every link format (x.com, twitter.com, mobile, fxtwitter, fixupx, vxtwitter, fixvx, /i/web/, query strings)', () => {
      const id = P.video.id;
      const forms = [`https://twitter.com/NASA/status/${id}?s=46&t=xyz`, `https://mobile.twitter.com/NASA/status/${id}`,
        `https://fxtwitter.com/NASA/status/${id}`, `https://fixupx.com/NASA/status/${id}/video/1`, `https://vxtwitter.com/NASA/status/${id}?lang=en`,
        `https://fixvx.com/NASA/status/${id}`, `https://x.com/i/web/status/${id}`, `x.com/NASA/status/${id}?utm_source=share`];
      const bad = [];
      for (const f of forms) {
        cool(OWNER);
        const r = sendText(OWNER, f);
        if (r.handlerError || !r.results || !r.results[0] || r.results[0].id !== id || !r.results[0].ok) bad.push(`${f}: ${JSON.stringify(r.results)}`);
      }
      expect(!bad.length, bad.join('\n'));
      return `${forms.length} formats → post ${id}`;
    });

    await scenario('B8 simulated FxTwitter outage → one retry, then vxTwitter answers', () => {
      devtools({ op: 'post_forget', id: P.gif.id });
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.gif), { simulate: { fx: 'down' } }));
      const fx = r.api.filter((a) => a.api === 'fx');
      const vx = r.api.filter((a) => a.api === 'vx');
      expect(fx.length === 2 && fx.every((a) => a.result !== 'ok'), `fx: ${apiLine(r)}`);
      expect(vx.length === 1 && vx[0].result === 'ok', `vx: ${apiLine(r)}`);
      expect(delivered(r, 'sendAnimation'), `delivered: ${mediaLine(r)}`);
      devtools({ op: 'post_forget', id: P.gif.id }); // next real request reads it from FxTwitter again
      return `${apiLine(r)} → ${mediaLine(r)}`;
    });

    await scenario('B9 five links in one message → one by one with a progress message, then a summary', () => {
      cool(OWNER);
      const body = [link(P.video), link(P.photos), link(P.gif), link(P.text), link(P.missing)].join('\n');
      const r = screenOk(sendText(OWNER, body), 'links_summary');
      const progress = r.trace.filter((t) => t.view === 'progress');
      expect(progress.length >= 5, `progress updates: ${progress.length}`);
      expect(r.results.length === 5 && r.results.filter((x) => x.ok).length === 3, JSON.stringify(r.results));
      return `${JSON.stringify(r.results)} · run ${r.ms}ms`;
    });

    await scenario('B10 quality setting low / best, and the per-post quality picker', () => {
      screenOk(press(OWNER, 'sq:low'), 'settings', { callback: true });
      cool(OWNER);
      const low = screenOk(sendText(OWNER, link(P.video)));
      expect(delivered(low, 'sendVideo') && low.media[0].q === '320x568', `low: ${mediaLine(low)}`);
      screenOk(press(OWNER, 'sq:best'), 'settings', { callback: true });
      cool(OWNER);
      const best = screenOk(sendText(OWNER, link(P.video)));
      expect(delivered(best, 'sendVideo') && best.media[0].q === '1080x1920', `best: ${mediaLine(best)}`);
      const picker = screenOk(press(OWNER, `qp:${P.video.id}`, { media: true }), 'qualities', { callback: true });
      expect(picker.data.includes(`qv:${P.video.id}:0:480x852`), `picker: ${picker.data.join(' ')}`);
      cool(OWNER);
      const one = screenOk(press(OWNER, `qv:${P.video.id}:0:480x852`), null, { callback: true });
      expect(delivered(one, 'sendVideo') && one.media[0].q === '480x852', `picked: ${mediaLine(one)}`);
      screenOk(press(OWNER, 'sq:auto'), 'settings', { callback: true });
      return `low → ${mediaLine(low)}\nbest → ${mediaLine(best)}\npicker → ${picker.data.filter((d) => d.startsWith('qv:')).join(' ')}\n480p → ${mediaLine(one)}`;
    });

    await scenario('B11 two-video post, "best": the 41 MB 1080p goes through Range chunks (above the 30 MB fetch cap)', () => {
      screenOk(press(OWNER, 'sq:best'), 'settings', { callback: true });
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.twovid)));
      screenOk(press(OWNER, 'sq:auto'), 'settings', { callback: true });
      const vids = r.media.filter((m) => m.m === 'sendVideo' && m.ok);
      expect(vids.length === 2, `videos: ${mediaLine(r)}`);
      const big = vids.find((v) => v.q === '1920x1080' && v.bytes > 30 * 1048576);
      expect(big, `the 41 MB variant was not sent: ${mediaLine(r)}`);
      return `${apiLine(r)} → ${mediaLine(r)} · run ${r.ms}ms`;
    });

    await scenario('B12 too big even at the lowest quality (vxTwitter only has the 143 MB 4K file) → explained + direct link', () => {
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.twovid), { simulate: { fx: 'down' } }));
      const big = r.trace.find((t) => t.view === 'too_big');
      expect(big && big.ok && big.kb && big.kb.flat()[0].includes('video.twimg.com'), `too_big: ${JSON.stringify(big)}`);
      return `${apiLine(r)} → "${big.text.split('\n')[0]}" + ${big.kb.flat()[0]}`;
    });

    await scenario('B13 caption options: text off + author off → only the link', () => {
      screenOk(press(OWNER, 'sc:t'), 'settings', { callback: true });
      screenOk(press(OWNER, 'sc:a'), 'settings', { callback: true });
      cool(OWNER);
      const r = screenOk(sendText(OWNER, link(P.video)));
      screenOk(press(OWNER, 'sc:t'), 'settings', { callback: true });
      screenOk(press(OWNER, 'sc:a'), 'settings', { callback: true });
      const cap = (r.media[0] || {}).caption || '';
      expect(!cap.includes('spacewalk') && !cap.includes('👤') && cap.includes('🔗 https://x.com/NASA/status/'), `caption: ${cap}`);
      return `caption: ${JSON.stringify(cap)}`;
    });

    await scenario('B14 history (last 20 with resend buttons) → resend from cache', () => {
      const h = screenOk(press(OWNER, 'hi'), 'history', { callback: true });
      const rs = h.data.filter((d) => d.startsWith('r:'));
      expect(rs.length >= 5 && rs.length <= 20, `resend buttons: ${rs.length}`);
      cool(OWNER);
      const again = screenOk(press(OWNER, rs[0]), null, { callback: true });
      expect(again.media.length && again.media.every((m) => m.ok && m.src !== 'download+upload' && !(m.media || []).some((x) => x.includes('upload'))), `resend: ${mediaLine(again)}`);
      return `${rs.length} buttons; resend → ${mediaLine(again)}`;
    });

    await scenario('B15 profile: today / total / remaining quota', () => {
      const r = screenOk(sendText(OWNER, '/profile'), 'profile');
      expect(r.text.includes('کل دانلودها'), r.text);
      return r.text.split('\n').filter(Boolean).slice(1, 5).join(' | ');
    });

    // ===== C. Quota and cooldown (test users; join off so the fake ids can reach the features) =====
    devtools({ op: 'set_setting', key: 'join', value: '0' });

    await scenario('C1 daily quota reached (30/30) → refused with a clear message', () => {
      sendText(TU1, '/start');
      devtools({ op: 'set_user', user: TU1, set: { day: today(), day_count: 30, last_req: 0 } });
      const r = screenOk(sendText(TU1, link(P.video)), 'quota');
      expect(r.text.includes('سهمیه') && r.media.length === 0, r.text);
      devtools({ op: 'set_user', user: TU1, set: { day_count: 0 } });
      return `"${r.text.split('\n')[0]}"`;
    });

    await scenario('C2 cooldown: a request within 5 s of the previous one → "wait"', () => {
      devtools({ op: 'set_user', user: TU1, set: { last_req: nowSec(), busy_until: 0 } });
      const r = screenOk(sendText(TU1, link(P.gif)), 'cooldown');
      expect(r.text.includes('ثانیه'), r.text);
      return `"${r.text}"`;
    });

    await scenario('C3 a normal user\'s download goes through the same path (chat is fake → Telegram says chat not found)', () => {
      cool(TU1);
      const r = screenOk(sendText(TU1, link(P.gif)));
      expect(r.media.length >= 1 && r.media.every((m) => /chat not found/i.test(m.err || '')), `attempt: ${mediaLine(r)}`);
      return mediaLine(r);
    });

    // ===== D. Owner panel =====
    await scenario('D1 /admin from the owner → panel', () => {
      const r = screenOk(sendText(OWNER, '/admin'), 'admin_panel');
      expect(r.last.ok, r.last.err);
    });

    await scenario('D2 /admin from a normal user → refused; admin buttons refused too', () => {
      const r = screenOk(sendText(TU1, '/admin'), 'admin_refused');
      const cb = screenOk(press(TU1, 'al'), null, { callback: true });
      expect(cb.answers[0].text.includes('دسترسی ندارید') && !cb.trace.some((t) => t.view === 'admin_channels'), 'callback not refused');
      const st = screenOk(press(TU1, 'as'), null, { callback: true });
      expect(!st.trace.some((t) => t.view === 'admin_stats'), 'stats not refused');
      return `"${r.text}" / button: "${cb.answers[0].text}"`;
    });

    await scenario('D3 channel list with the bot\'s admin status', () => {
      const r = screenOk(press(OWNER, 'al'), 'admin_channels', { callback: true });
      return r.text.split('\n').filter((l) => /^[۰-۹]+\./.test(l)).join('\n');
    });

    await scenario('D4 add channel: validation (missing channel, bot not admin)', () => {
      screenOk(press(OWNER, 'aa'), 'admin_add_prompt', { callback: true });
      const missing = screenOk(sendText(OWNER, 'https://t.me/zz_no_such_channel_8812'), 'admin_add_not_found');
      const notAdmin = screenOk(sendText(OWNER, '@telegram'), 'admin_add_not_admin');
      press(OWNER, 'a'); // cancel the prompt
      return `"${missing.text}" / "${notAdmin.text.split('\n')[0]}"`;
    });

    await scenario('D5 an 11th channel is refused (hard limit 10)', () => {
      devtools({ op: 'fill_channels', to: 10 });
      const r = screenOk(press(OWNER, 'aa'), 'admin_channel_limit', { callback: true });
      expect(r.answers[0].text.includes('سقف'), r.answers[0].text);
      devtools({ op: 'drop_fake_channels' });
      return `"${r.answers[0].text}"`;
    });

    await scenario('D6 remove a channel, then add it back (@wangerBots)', () => {
      const snap = devtools({ op: 'snapshot' });
      const ch = snap.channels.find((c) => c.uname === 'wangerbots');
      expect(ch, 'wangerBots is not in the list');
      screenOk(press(OWNER, `ar:${ch.id}`), 'admin_remove_confirm', { callback: true });
      const removed = screenOk(press(OWNER, `ary:${ch.id}`), 'admin_channels', { callback: true });
      expect(!devtools({ op: 'snapshot' }).channels.some((c) => c.uname === 'wangerbots'), 'still in the db');
      screenOk(press(OWNER, 'aa'), 'admin_add_prompt', { callback: true });
      const back = sendText(OWNER, '@wangerBots');
      if (back.view === 'admin_add_not_admin') {
        devtools({ op: 'restore_channel', channel: ch });
        press(OWNER, 'a');
        throw new Warn(`removed OK, but re-adding was refused: the bot is not an admin in @wangerBots ("${back.text.split('\n')[0]}"). The row was restored. Make the bot an admin there and add it from /admin.`);
      }
      screenOk(back, 'admin_channels');
      expect(back.text.includes('اضافه شد'), back.text);
      return `"${removed.text.split('\n')[0]}" → "${back.text.split('\n')[0]}"`;
    });

    await scenario('D7 forced join off / on switch', () => {
      devtools({ op: 'set_setting', key: 'join', value: '1' });
      const off = screenOk(press(OWNER, 'at'), 'admin_panel', { callback: true });
      const on = screenOk(press(OWNER, 'at'), 'admin_panel', { callback: true });
      expect(off.text.includes('خاموش') && on.text.includes('روشن'), `${off.text.split('\n')[2]} / ${on.text.split('\n')[2]}`);
      devtools({ op: 'set_setting', key: 'join', value: '0' });
    });

    await scenario('D8 ban / unban a user by numeric id', () => {
      screenOk(press(OWNER, 'bb'), 'admin_ban_prompt', { callback: true });
      screenOk(sendText(OWNER, 'not-a-number'), 'admin_ban_invalid');
      const b = screenOk(sendText(OWNER, String(TU2)), 'admin_panel');
      expect(b.text.includes('مسدود شد'), b.text);
      cool(TU2);
      const blocked = screenOk(sendText(TU2, link(P.video)), 'banned');
      expect(blocked.media.length === 0, 'banned user got media');
      screenOk(press(OWNER, 'bu'), 'admin_unban_prompt', { callback: true });
      const u = screenOk(sendText(OWNER, String(TU2)), 'admin_panel');
      expect(u.text.includes('خارج شد'), u.text);
      const ok = screenOk(sendText(TU2, '/start'), 'menu');
      return `ban → "${blocked.text}" · unban → ${ok.view}`;
    });

    await scenario('D9 stats: users, active, downloads today/total, API failures today', () => {
      const r = screenOk(press(OWNER, 'as'), 'admin_stats', { callback: true });
      for (const s of ['کل کاربران', 'فعال', 'دانلود امروز', 'کل دانلودها', 'خطای API']) expect(r.text.includes(s), `missing ${s}`);
      return r.text.split('\n').filter((l) => /[۰-۹]/.test(l)).slice(0, 8).join(' | ');
    });

    // ===== E. Broadcast =====
    await scenario('E1 broadcast: preview + confirm, copyMessage batch, 400 counted failed, 403 (a bot) → marked inactive, final report', () => {
      const snap = devtools({ op: 'snapshot' });
      if (snap.realUsers > 0) throw new Warn(`skipped: the bot has ${snap.realUsers} real user(s), who would receive the test broadcast`);
      if (snap.running) throw new Warn('skipped: a broadcast is already running');
      for (const u of [TU1, TU2, BOTFATHER]) devtools({ op: 'add_test_user', user: u });
      const m = devtools({ op: 'owner_test_message', text: '🧪 آزمایش پیام سراسری (فقط کاربران آزمایشی)' });
      screenOk(press(OWNER, 'ab'), 'bc_prompt', { callback: true });
      const draft = screenOk(sendText(OWNER, '🧪 آزمایش پیام سراسری (فقط کاربران آزمایشی)', {}, m.message_id), 'bc_confirm');
      const preview = draft.trace.find((t) => t.view === 'bc_preview');
      expect(preview && preview.ok, `preview copy: ${JSON.stringify(preview)}`);
      const bs = draft.data.find((d) => d.startsWith('bs:'));
      expect(bs && draft.data.some((d) => d.startsWith('bx:')), 'no confirm/cancel');
      const confirmId = draft.trace.find((t) => t.view === 'bc_confirm').mid;
      const run = screenOk(press(OWNER, bs, { messageId: confirmId }), null, { callback: true });
      const copies = run.trace.filter((t) => t.m === 'copyMessage');
      const bc = devtools({ op: 'latest_broadcast' });
      expect(bc.status === 'done', `status ${bc.status}: ${copies.map((c) => `${c.chat}:${c.ok ? 'ok' : c.err}`).join(' ')}`);
      expect(bc.blocked >= 1, `403 not counted: ${JSON.stringify(bc)}`);
      const bf = devtools({ op: 'user', user: BOTFATHER });
      expect(bf.active === 0, 'the 403 recipient was not marked inactive');
      const report = run.trace.find((t) => t.view === 'bc_report');
      expect(report && report.ok, 'no final report to the owner');
      return `copies: ${copies.map((c) => `${c.chat}→${c.ok ? 'ok' : c.err}`).join(', ')}\nresult: sent=${bc.sent} failed=${bc.failed} blocked=${bc.blocked} · report sent to the owner`;
    });

    await scenario('F1 unknown / stale buttons are answered exactly once, never crash', () => {
      for (const d of ['zz', `qv:${P.video.id}:0:9999x1`, 'r:999999999', 'sq:huge']) screenOk(press(OWNER, d), null, { callback: true });
    });
  } finally {
    // ---------- restore ----------
    // Each step on its own: one failure must not leave the rest (e.g. forced join) unrestored.
    const step = (name, fn) => {
      try {
        fn();
      } catch (err) {
        console.log(`restore step "${name}" failed: ${err.message}`);
      }
    };
    step('fake channels', () => devtools({ op: 'drop_fake_channels' }));
    step('channels', () => {
      const now = devtools({ op: 'snapshot' });
      for (const ch of originalChannels) {
        if (!now.channels.some((c) => c.uname === ch.uname)) devtools({ op: 'restore_channel', channel: ch });
      }
    });
    step('join', () => devtools({ op: 'set_setting', key: 'join', value: originalJoin }));
    if (ownerSettings) step('owner', () => devtools({ op: 'set_user', user: OWNER, set: { ...ownerSettings, last_req: 0, busy_until: 0 } }));
    step('test users', () => devtools({ op: 'cleanup', users: TEST_USERS }));
  }

  const counts = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  const apiSummary = `FxTwitter answered ${apiUse.fx}× (failed attempts: ${apiUse.fxErrors}, incl. simulated outages); vxTwitter answered ${apiUse.vx}× (failed: ${apiUse.vxErrors})`;
  const summary = [
    `# Cloud test run — ${new Date().toISOString()}`,
    '',
    `${runs} \`tgcloud run\` invocations · PASS ${counts.PASS || 0} · WARN ${counts.WARN || 0} · FAIL ${counts.FAIL || 0}`,
    '',
    `APIs: ${apiSummary}`,
    '',
    `Platform probe: \`${JSON.stringify(probe)}\``,
    '',
    '| # | Scenario | Result | Detail |',
    '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`),
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), `${summary}\n`);
  console.log(`\n${apiSummary}\n${runs} runs · PASS ${counts.PASS || 0} · WARN ${counts.WARN || 0} · FAIL ${counts.FAIL || 0}\nlog: ${LOG}`);
  return counts.FAIL ? 1 : 0;
}

// The devtools endpoint exists only while the tests run.
fs.mkdirSync(DEVTOOLS_DIR, { recursive: true });
fs.copyFileSync(DEVTOOLS_SRC, DEVTOOLS_DST);
let code = 1;
try {
  code = await main();
} finally {
  fs.rmSync(DEVTOOLS_DST, { force: true });
  if (fs.existsSync(DEVTOOLS_DIR) && !fs.readdirSync(DEVTOOLS_DIR).length) fs.rmdirSync(DEVTOOLS_DIR);
}
process.exit(code);
