#!/usr/bin/env node
// Runs the scenarios on Telegram Serverless itself, with `npx tgcloud run` (the platform executes the
// local handlers against the bot's real database and the real Bot API, without deploying).
//
//   cd whisper_bot && node test/cloud/run-tests.mjs     (after `npx tgcloud login` or with TGCLOUD_TOKEN,
//                                                         and after push + migrate)
//
// - Test users have fake ids 990000001-990000009, so Telegram answers "chat not found" / "query is too
//   old" to whatever the bot sends them (four pick Persian, one Russian, on the first /start). The handlers return a trace of every Bot API call (method,
//   view, text — whisper content is hidden — buttons, Telegram's answer), and the checks run on that
//   trace plus a read-back of the database through a temporary test endpoint (test/cloud/devtools.js,
//   copied to tgcloud/endpoints/zz_devtools.js for the run and always deleted afterwards).
// - Owner scenarios use the real owner id 5557901897, so the owner receives those screens in Telegram.
// - Everything is restored at the end: test users' rows, their whispers and anonymous messages, ratings,
//   reports, fake channels, removed channels, the join setting, broadcasts made by the run, the owner's
//   anonymous-section settings and inbox counters, the n_anon counter.
// - Raw CLI output goes to test/cloud/output/run.log; the pass/fail table to test/cloud/output/summary.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const DEVTOOLS_SRC = path.join(ROOT, 'test/cloud/devtools.js');
const CARD_JPEG = path.join(ROOT, 'test/cloud/fixtures/card.jpg'); // a real card, rendered small by the Mini App
const DEVTOOLS_DIR = path.join(ROOT, 'tgcloud/endpoints');
const DEVTOOLS_DST = path.join(DEVTOOLS_DIR, 'zz_devtools.js');
const OUT_DIR = path.join(ROOT, 'test/cloud/output');

const OWNER = 5557901897;
const TARGET_403 = -1001005640892; // @telegram channel: the bot isn't a member, so copyMessage gets a real 403
const T = {
  sender: 990000001, // zzw_t1
  rcpt: 990000002, // zzw_t2, recipient by @username
  byId: 990000003, // zzw_t3, recipient by numeric id
  snoop: 990000004, // zzw_t4
  third: 990000005, // zzw_t5, picks Russian
  outsider: 990000009, // never a channel member, no join cache
};
const MEMBERS = [T.sender, T.rcpt, T.byId, T.snoop, T.third];
const TEST_USERS = [...MEMBERS, T.outsider, TARGET_403];
const uname = (id) => `zzw_t${id % 10}`;
let W1 = null; // whisper to @zzw_t2
let W2 = null; // whisper to the numeric id
let PANEL_MID = null; // a real message in the owner's chat (the /admin panel), copied by the broadcast test
let ANON_Q = null; // the anonymous answer to the question of the day (14c), reported in 14d

// TGCLOUD_CLI_ARGS (JSON array of node arguments) replaces the real CLI; only
// test/cloud/local-harness.mjs sets it, to check this script against a local emulation.
const CLI_ARGS = process.env.TGCLOUD_CLI_ARGS ? JSON.parse(process.env.TGCLOUD_CLI_ARGS) : [CLI];

fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'run.log');
fs.writeFileSync(LOG, `tgcloud run log — ${new Date().toISOString()}\n`);
const log = (s) => fs.appendFileSync(LOG, `${s}\n`);

// ---------- safety: run only inside whisper_bot/, linked, with no leftover devtools ----------

if (!fs.existsSync(path.join(ROOT, '.tgcloud')) && !process.env.TGCLOUD_CLI_ARGS) {
  console.error(`✘ ${ROOT}/.tgcloud is missing: this folder is not a linked tgcloud project. Run "npx tgcloud login" here first.`);
  process.exit(2);
}
if (fs.existsSync(DEVTOOLS_DST)) {
  console.error(`✘ ${path.relative(ROOT, DEVTOOLS_DST)} exists — another run in progress, or a crashed one. Delete it (never push it) and retry.`);
  process.exit(2);
}

// ---------- running modules on the platform ----------

let runs = 0;

function cli(args, { allowFail = false } = {}) {
  try {
    return execFileSync(process.execPath, [...CLI_ARGS, ...args], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TGCLOUD_NO_PAGER: '1' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (!allowFail) throw e;
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

// The platform rate-limits `tgcloud run` ("✗ Too many requests: retry after 8"). A refused call never
// ran (the CLI got a RATE_LIMITED error back), so it is retried after the wait the platform asks for.
const RATE_LIMITED = /Too many requests: retry after (\d+)/;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let rateWait = 0; // seconds spent waiting for the platform's rate limit

function tgcloudRun(module, args, ctx) {
  const argv = ['run', module, JSON.stringify(args)];
  if (ctx) argv.push('--ctx', JSON.stringify(ctx));
  let out;
  let exitOk;
  for (let attempt = 0; ; attempt += 1) {
    runs += 1;
    exitOk = true;
    try {
      out = cli(argv);
    } catch (e) {
      exitOk = false;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    const limited = !exitOk && RATE_LIMITED.exec(out);
    if (!limited || attempt >= 10) break;
    const wait = Math.min(Number(limited[1]), 60) + 1;
    log(`\n$ npx tgcloud run ${module} … → rate limited; waiting ${wait}s and retrying (the refused call did not run)`);
    rateWait += wait;
    pause(wait * 1000);
  }
  log(`\n$ npx tgcloud run ${module} '${JSON.stringify(args)}'${ctx ? ' --ctx …' : ''}\n${out.trimEnd()}`);
  const line = out.split('\n').reverse().find((l) => l.startsWith('< '));
  let value;
  if (line) {
    const m = line.slice(2).match(/^(.*?)\s+\d+ms\s*$/);
    const raw = m ? m[1] : line.slice(2);
    try {
      value = JSON5.parse(raw);
    } catch {
      value = raw;
    }
  }
  const time = line && (line.match(/(\d+)ms\s*$/) || [])[1];
  return { exitOk, out, value, ms: time ? Number(time) : null };
}

function devtools(input) {
  const r = tgcloudRun('endpoints/zz_devtools', input, { initData: { user: { id: OWNER, first_name: 'Owner' } } });
  if (!r.exitOk) throw new Error(`devtools ${input.op} failed:\n${r.out.slice(-1500)}`);
  return r.value;
}

// ---------- realistic update payloads ----------

let seq = 1;
const nowSec = () => Math.floor(Date.now() / 1000);
const person = (id) => ({
  id,
  is_bot: false,
  first_name: id === OWNER ? 'Owner' : `Tester${id % 1000}`,
  ...(id === OWNER ? {} : { username: uname(id) }),
  language_code: id === T.third ? 'ru' : 'fa',
});
const privateChat = (id) => ({ id, first_name: person(id).first_name, type: 'private' });
const updateId = () => 800000000 + seq;

function sendText(uid, text, messageId = null) {
  const n = seq++;
  const message = { message_id: messageId || 100000 + n, from: person(uid), chat: privateChat(uid), date: nowSec(), text };
  const cmd = /^\/[A-Za-z0-9_]+/.exec(text);
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  return analyse(tgcloudRun('handlers/message', message, { update: { update_id: updateId(), message } }));
}

function inlineQuery(uid, query) {
  const n = seq++;
  const q = { id: `${7000000000000000 + n}`, from: person(uid), query, offset: '', chat_type: 'supergroup' };
  return analyse(tgcloudRun('handlers/inline_query', q, { update: { update_id: updateId(), inline_query: q } }));
}

function chosen(uid, resultId, query) {
  const n = seq++;
  const inlineId = `AgAAAZZtest${n}xxxxxxxxxx`;
  const c = { result_id: resultId, from: person(uid), query, inline_message_id: inlineId };
  return { ...analyse(tgcloudRun('handlers/chosen_inline_result', c, { update: { update_id: updateId(), chosen_inline_result: c } })), inlineId };
}

function pressInline(uid, data, inlineId) {
  const n = seq++;
  const cq = { id: `${4000000000000 + n}`, from: person(uid), inline_message_id: inlineId, chat_instance: '-5170000000000000000', data };
  return analyse(tgcloudRun('handlers/callback_query', cq, { update: { update_id: updateId(), callback_query: cq } }));
}

function pressPm(uid, data, messageId = null) {
  const n = seq++;
  const cq = {
    id: `${4000000000000 + n}`,
    from: person(uid),
    message: { message_id: messageId || 200000 + n, from: { id: 1, is_bot: true, first_name: 'Bot' }, chat: privateChat(uid), date: nowSec() - 30, text: '…' },
    chat_instance: '-5170000000000000000',
    data,
  };
  return analyse(tgcloudRun('handlers/callback_query', cq, { update: { update_id: updateId(), callback_query: cq } }));
}

function analyse(r) {
  const trace = r.value && Array.isArray(r.value.trace) ? r.value.trace : [];
  const screens = trace.filter((t) => (['sendMessage', 'sendPhoto'].includes(t.m) || (t.m === 'editMessageText' && !t.inline)) && t.view && !NOT_SCREENS.includes(t.view));
  const last = screens[screens.length - 1] || null;
  const answers = trace.filter((t) => t.m === 'answerCallbackQuery');
  const inline = trace.find((t) => t.m === 'answerInlineQuery') || null;
  const edits = trace.filter((t) => t.m === 'editMessageText' && t.inline);
  const data = last && last.kb ? last.kb.flat().map((b) => (b.match(/\[([^\]]+)\]$/) || [])[1]).filter(Boolean) : [];
  const handlerError = !r.exitOk || !(r.value && Array.isArray(r.value.trace)) || !!(r.value && r.value.error);
  return { ...r, trace, screens, last, view: last ? last.view : null, text: last ? last.text || last.caption || '' : '', data, answers, answer: answers[0] || null, inline, edits, handlerError };
}
// Messages to someone else than the person acting (notifications, deliveries), not their screen.
const NOT_SCREENS = ['owner_warning', 'read_receipt', 'curious_notice', 'owner_report', 'anon_deliver', 'anon_header', 'card_photo'];

const byView = (res, view) => res.trace.filter((t) => t.view === view);

// ---------- bookkeeping ----------

const results = [];
class Fail extends Error {}
function expect(cond, message) {
  if (!cond) throw new Fail(message);
}

function ok(res, { view, callback = false } = {}) {
  expect(!res.handlerError, `handler error or no trace:\n${(res.value && res.value.error) || res.out.slice(-1500)}`);
  if (callback) expect(res.answers.length === 1, `answerCallbackQuery called ${res.answers.length} times`);
  if (view) expect(res.view === view, `expected view "${view}", got "${res.view}" (${String(res.text).slice(0, 200)})`);
  return res;
}

async function scenario(name, fn) {
  log(`\n======== ${name} ========`);
  let status = 'PASS';
  let detail = '';
  try {
    const out = await fn();
    if (out && out.status) status = out.status;
    if (out && out.detail) detail = out.detail;
  } catch (err) {
    status = 'FAIL';
    detail = err instanceof Fail ? err.message : String(err.stack || err);
  }
  results.push({ name, status, detail });
  const icon = { PASS: '✔', FAIL: '✘', WARN: '⚠', INFO: 'ℹ' }[status];
  console.log(`${icon} ${status}  ${name}${detail ? `\n         ${detail.split('\n').join('\n         ')}` : ''}`);
}

/** The whisper result of an inline answer, and its whisper id. */
function whisperResult(res) {
  const r = res.inline && (res.inline.results || []).find((x) => /^w\.\w{8}$/.test(x.id));
  return r ? { ...r, wid: r.id.slice(2) } : null;
}

function makeWhisper(query, sender = T.sender) {
  const q = ok(inlineQuery(sender, query));
  const res = whisperResult(q);
  expect(res, `no whisper result for "${query}": ${JSON.stringify(q.inline && q.inline.results)}`);
  const c = ok(chosen(sender, res.id, query));
  expect(c.value.chosen && c.value.chosen.created === true, `chosen_inline_result did not create it: ${JSON.stringify(c.value)}`);
  return { wid: res.wid, inlineId: c.inlineId, result: res };
}

const alertIs = (res, re) => res.answer && res.answer.alert === true && re.test(String(res.answer.text));
const revealed = (res, role) => res.answer && res.answer.alert === true && res.answer.meta && res.answer.meta.role === role && /hidden/.test(res.answer.text);

// ---------- the scenarios ----------

const LOCAL = !!process.env.TGCLOUD_CLI_ARGS; // the local stand-in of the CLI: no real hosts to reach

async function main() {
  const start = devtools({ op: 'snapshot' });
  const originalChannels = start.channels;
  const startKv = start.kv;
  devtools({ op: 'cleanup', users: TEST_USERS });
  devtools({ op: 'drop_fake_channels' });
  const maxBroadcast = start.maxBroadcast;
  const ownerAnon = devtools({ op: 'owner_anon' });
  const startAnon = Number((devtools({ op: 'kv_get', keys: ['n_anon'] })[0] || {}).value || 0);
  const startedAt = nowSec();
  console.log(`channels at start: ${originalChannels.map((c) => `@${c.username}`).join(', ') || '(none yet — the first update seeds them)'}\n`);

  let botUsername = (startKv.find((k) => k.key === 'bot_username') || {}).value || null;
  let joinCheckable = true;

  try {
    await scenario('0. all tables exist after migrate', () => {
      const t = devtools({ op: 'tables' });
      const bad = Object.entries(t).filter(([, v]) => v !== 'ok');
      expect(!bad.length, `missing tables: ${JSON.stringify(bad)}`);
      return { detail: Object.keys(t).join(', ') };
    });

    await scenario('1a. first /start → language picker (fa / en / ru); after picking, the two sections', () => {
      for (const id of MEMBERS) {
        const pick = ok(sendText(id, '/start'), { view: 'lang_picker' });
        expect(pick.data.join() === 'L:fa,L:en,L:ru', `picker buttons ${JSON.stringify(pick.data)}`);
      }
      const ch = devtools({ op: 'channels' });
      expect(ch.length >= 1, 'channels table is empty (seed failed)');
      devtools({ op: 'join_cache', users: MEMBERS }); // fake ids can't be channel members: simulate it
      for (const id of MEMBERS) {
        const lang = id === T.third ? 'ru' : 'fa';
        const main = ok(pressPm(id, `L:${lang}`), { view: 'main', callback: true });
        expect(main.data.slice(0, 2).join() === 'ws,an', `main buttons ${JSON.stringify(main.data)}`);
        expect((lang === 'ru' ? /Здесь два раздела/ : /دو بخش داریم/).test(main.text), main.text);
        const u = devtools({ op: 'user', user: id });
        expect(u.lang === lang && u.tg_lang === lang, `language saved: chosen ${u.lang}, Telegram ${u.tg_lang}`);
      }
      return { detail: `channels: ${ch.map((c) => `@${c.username}`).join(', ')}; 4 test users chose fa, 1 ru` };
    });

    await scenario('1b. inline whisper to a @username: result, message has no content, chosen → whisper', () => {
      const q = ok(inlineQuery(T.sender, 'zz cloud secret one @zzw_t2'));
      expect(q.inline.cache_time === 0 && q.inline.is_personal === true, 'cache_time 0 / is_personal true');
      const res = whisperResult(q);
      expect(res, 'no whisper result');
      expect(res.message === '🔒 یک نجوا برای @zzw_t2', `posted message: ${res.message}`);
      expect(JSON.stringify(res.kb) === JSON.stringify([[`👁 نمایش نجوا [s:${res.wid}]`]]), `keyboard ${JSON.stringify(res.kb)}`);
      const c = ok(chosen(T.sender, res.id, 'zz cloud secret one @zzw_t2'));
      const w = devtools({ op: 'whisper', id: res.wid });
      expect(w && w.rcpts.length === 1 && w.rcpts[0].runame === 'zzw_t2' && w.rcpts[0].rid === null, `db row ${JSON.stringify(w)}`);
      expect(w.inline_id === c.inlineId, 'inline_message_id stored');
      expect(devtools({ op: 'draft_count', user: T.sender }) === 0, 'draft finalized and removed');
      W1 = { wid: res.wid, inlineId: c.inlineId };
      return { detail: `whisper ${res.wid}; answerInlineQuery → ${q.inline.ok ? 'ok' : q.inline.err}` };
    });

    await scenario('1c. inline whisper to a numeric id; a Russian sender\'s whisper is posted in Russian', () => {
      const w = makeWhisper(`zz cloud by id ${T.byId}`);
      const row = devtools({ op: 'whisper', id: w.wid });
      expect(row.rcpts[0].rid === T.byId, `rid ${row.rcpts[0].rid}`);
      W2 = w;
      const ru = whisperResult(ok(inlineQuery(T.third, 'zz привет @zzw_t2')));
      expect(ru && ru.message === '🔒 Шёпот для @zzw_t2', `Russian posted message: ${ru && ru.message}`);
      return { detail: `whisper ${w.wid} → rid ${T.byId} (label ${row.rcpts[0].label}); ru: "${ru.message}"` };
    });

    await scenario('1d. the command menu and descriptions are set in Persian, English and Russian (read back from Telegram)', () => {
      const texts = devtools({ op: 'bot_texts' });
      const want = ['start', 'whisper', 'anon', 'link', 'inbox', 'profile', 'lang', 'help', 'privacy'];
      for (const t of texts) {
        expect(t.commands.join() === want.join(), `${t.lang} commands ${JSON.stringify(t.commands)}`);
        expect(t.description && t.short, `${t.lang}: description "${t.description}" / short "${t.short}"`);
      }
      const by = (l) => texts.find((t) => t.lang === l);
      expect(/نجوا/.test(by('fa').short) && /Whispers/.test(by('en').short) && /Шёпот/.test(by('ru').short), `short descriptions ${JSON.stringify(texts.map((t) => t.short))}`);
      return { detail: texts.map((t) => `${t.lang}: ${t.commands.length} commands, "${t.short}"`).join(' | ') };
    });

    await scenario('1e. BotFather: inline mode is on (getMe supports_inline_queries)', () => {
      const me = devtools({ op: 'me' });
      if (!me.inline) return { status: 'WARN', detail: `@${me.username}: inline mode is OFF — in @BotFather send /setinline, pick the bot, and send a placeholder such as "متن نجوا @username"` };
      return { detail: `@${me.username} (id ${me.id}): inline on, groups ${me.groups ? 'allowed' : 'not allowed'}` };
    });

    await scenario('2. typing many inline queries in a row keeps ONE draft row and creates no whispers', () => {
      const before = devtools({ op: 'whisper_count', user: T.sender });
      const typed = 'zz typing test @zzw_t3';
      const steps = [4, 8, 12, 15, 18, typed.length];
      for (const n of steps) ok(inlineQuery(T.sender, typed.slice(0, n)));
      const drafts = devtools({ op: 'draft_count', user: T.sender });
      const after = devtools({ op: 'whisper_count', user: T.sender });
      expect(drafts === 1, `drafts for the sender: ${drafts}`);
      expect(after === before, `whispers ${before} → ${after}`);
      return { detail: `${steps.length} queries → 1 draft row, ${after - before} new whispers` };
    });

    await scenario('3a. a curious person (not a recipient): refused, counted once, "👀 کنجکاوها: ۱", the sender is told at once', () => {
      const p = ok(pressInline(T.snoop, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(alertIs(p, /^این نجوا مال تو نیست 😏$/), `answer ${JSON.stringify(p.answer)}`);
      const edit = p.edits.find((e) => /👀 کنجکاوها: ۱/.test(e.text));
      expect(edit && !/فضول/.test(edit.text), `edit ${JSON.stringify(p.edits)}`);
      const notice = byView(p, 'curious_notice');
      expect(notice.length === 1 && notice[0].chat === T.sender && /@zzw_t4 کنجکاو شد/.test(notice[0].text), `notice ${JSON.stringify(notice)}`);
      const w = devtools({ op: 'whisper', id: W1.wid });
      expect(w.snoops === 1 && w.snoopers[0].user_id === T.snoop, `snoops ${w.snoops}`);
      const again = ok(pressInline(T.snoop, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(devtools({ op: 'whisper', id: W1.wid }).snoops === 1, 'counted once');
      expect(again.edits.length === 0 && !byView(again, 'curious_notice').length, 'no edit or notice for a repeat');
      return { detail: `edit: ${edit.text.replace(/\n/g, ' / ')}; notice: ${notice[0].text}` };
    });

    await scenario('3b. opening as the sender: content shown (alert), nothing marked seen, no notification', () => {
      const p = ok(pressInline(T.sender, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(revealed(p, 'sender'), `answer ${JSON.stringify(p.answer)}`);
      expect(p.answer.meta.length === 'zz cloud secret one'.length, 'the whole text');
      expect(devtools({ op: 'whisper', id: W1.wid }).rcpts[0].seen_at === 0, 'not seen');
      expect(!byView(p, 'read_receipt').length, 'no notification for the sender\'s own open');
    });

    await scenario('3c/5. the recipient opens: "👁 دیده شد", and EVERY open is announced to the sender at once, with the count', () => {
      const p = ok(pressInline(T.rcpt, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(revealed(p, 'recipient'), `answer ${JSON.stringify(p.answer)}`);
      const edit = p.edits.find((e) => /👁 دیده شد/.test(e.text));
      expect(edit && !/zz cloud secret/.test(edit.text), `seen edit ${JSON.stringify(p.edits)}`);
      const first = byView(p, 'read_receipt');
      expect(first.length === 1 && first[0].chat === T.sender && /@zzw_t2 نجوای شما را باز کرد\./.test(first[0].text), `notice ${JSON.stringify(first)}`);
      const p2 = ok(pressInline(T.rcpt, `s:${W1.wid}`, W1.inlineId), { callback: true });
      const second = byView(p2, 'read_receipt');
      expect(second.length === 1 && /دوباره نجوای شما را باز کرد — بار ۲م/.test(second[0].text), `second ${JSON.stringify(second)}`);
      const w = devtools({ op: 'whisper', id: W1.wid });
      expect(w.rcpts[0].seen_at > 0 && w.rcpts[0].rid === T.rcpt && w.rcpts[0].opens === 2, `rcpt ${JSON.stringify(w.rcpts[0])}`);
      // the numeric-id whisper: only that id; a Russian-speaking stranger gets the refusal in Russian
      const wrong = ok(pressInline(T.snoop, `s:${W2.wid}`, W2.inlineId), { callback: true });
      expect(alertIs(wrong, /مال تو نیست/), 'curious on the id whisper');
      const ru = ok(pressInline(T.third, `s:${W2.wid}`, W2.inlineId), { callback: true });
      expect(alertIs(ru, /^Этот шёпот не для вас 😏$/), `Russian refusal ${JSON.stringify(ru.answer)}`);
      const right = ok(pressInline(T.byId, `s:${W2.wid}`, W2.inlineId), { callback: true });
      expect(revealed(right, 'recipient'), `id recipient ${JSON.stringify(right.answer)}`);
      return { detail: `edit: ${edit.text.replace(/\n/g, ' / ')}; 1st: ${first[0].text}; 2nd: ${second[0].text}` };
    });

    await scenario('4. three recipients: each one and the sender can read, others not; a 4th is refused', () => {
      const w = makeWhisper(`zz three @zzw_t2 ${T.byId} @zzw_t5`);
      const row = devtools({ op: 'whisper', id: w.wid });
      expect(row.rcpts.length === 3, `rcpts ${row.rcpts.length}`);
      for (const id of [T.rcpt, T.byId, T.third, T.sender]) {
        const p = ok(pressInline(id, `s:${w.wid}`, w.inlineId), { callback: true });
        expect(revealed(p, id === T.sender ? 'sender' : 'recipient'), `${id}: ${JSON.stringify(p.answer)}`);
      }
      const no = ok(pressInline(T.snoop, `s:${w.wid}`, w.inlineId), { callback: true });
      expect(alertIs(no, /مال تو نیست/), 'curious');
      const seen = devtools({ op: 'whisper', id: w.wid }).rcpts.filter((r) => r.seen_at > 0).length;
      expect(seen === 3, `seen ${seen}/3`);
      const four = ok(inlineQuery(T.sender, 'zz four @zzw_t2 @zzw_t3 @zzw_t4 @zzw_t5'));
      expect(four.inline.results[0].id === 'h.too_many', `4 recipients → ${four.inline.results[0].id}`);
    });

    await scenario('6. one-time whisper ("!"): first open shows it, content deleted, second open fails', () => {
      const w = makeWhisper('!zz once only @zzw_t2');
      expect(/🔥 یک‌بار مصرف/.test(w.result.message), 'marked one-time');
      const first = ok(pressInline(T.rcpt, `s:${w.wid}`, w.inlineId), { callback: true });
      expect(revealed(first, 'recipient'), `first ${JSON.stringify(first.answer)}`);
      const row = devtools({ op: 'whisper', id: w.wid });
      expect(row.body === null && row.state === 1, `db ${row.body} / state ${row.state}`);
      expect(first.edits.some((e) => /🔥 <b>نجوا سوزانده شد<\/b>/.test(e.text)), 'burned edit');
      const second = ok(pressInline(T.rcpt, `s:${w.wid}`, w.inlineId), { callback: true });
      expect(alertIs(second, /سوزانده شده/), `second ${JSON.stringify(second.answer)}`);
    });

    await scenario('7. expired whisper ("30m"): refused after expiry (lazy), content removed', () => {
      const w = makeWhisper('zz expiring @zzw_t2 30m');
      expect(/⏳ مهلت باز کردن: ۳۰ دقیقه/.test(w.result.message), 'shows the lifetime');
      const before = ok(pressInline(T.rcpt, `s:${w.wid}`, w.inlineId), { callback: true });
      expect(revealed(before, 'recipient'), 'opens before expiry');
      devtools({ op: 'age_whisper', id: w.wid });
      const after = ok(pressInline(T.rcpt, `s:${w.wid}`, w.inlineId), { callback: true });
      expect(alertIs(after, /مهلت باز کردن این نجوا تمام شده/), `after ${JSON.stringify(after.answer)}`);
      const row = devtools({ op: 'whisper', id: w.wid });
      expect(row.state === 2 && row.body === null, `state ${row.state}`);
    });

    await scenario('8. long whisper (>200 chars): deep link; recipient reads in PM, stranger refused', () => {
      const long = `zz long ${'abcdefghij'.repeat(22)} end`;
      const w = makeWhisper(`${long} @zzw_t2`);
      const link = w.result.kb[1] && w.result.kb[1][0];
      expect(link && /^📖 خواندن در ربات -> https:\/\/t\.me\/\w+\?start=w_/.test(link), `deep link button ${JSON.stringify(w.result.kb)}`);
      botUsername = botUsername || link.match(/t\.me\/(\w+)\?/)[1];
      const p = ok(pressInline(T.rcpt, `s:${w.wid}`, w.inlineId), { callback: true });
      expect(p.answer.url === `https://t.me/${botUsername}?start=w_${w.wid}`, `button answer ${JSON.stringify(p.answer)}`);
      const stranger = ok(sendText(T.snoop, `/start w_${w.wid}`), { view: 'whisper_stranger' });
      expect(/مال تو نیست/.test(stranger.text), stranger.text);
      const read = ok(sendText(T.rcpt, `/start w_${w.wid}`), { view: 'whisper_read' });
      expect(read.last.meta && read.last.meta.role === 'recipient' && read.last.meta.length === long.length, `read ${JSON.stringify(read.last)}`);
      expect(devtools({ op: 'whisper', id: w.wid }).rcpts[0].seen_at > 0, 'seen via the deep link');
      const own = ok(sendText(T.sender, `/start w_${w.wid}`), { view: 'whisper_read' });
      expect(own.last.meta.role === 'sender', 'sender reads it too');
      return { detail: `${long.length} chars, link t.me/${botUsername}?start=w_${w.wid}` };
    });

    await scenario('9a. history; details; the curious list: the sender AND the recipient see who, nobody else', () => {
      const sent = ok(sendText(T.sender, '/history'), { view: 'history_sent' });
      expect(sent.last.meta && sent.last.meta.total >= 6, `sent meta ${JSON.stringify(sent.last.meta)}`);
      const recv = ok(pressPm(T.rcpt, 'h:r:0'), { view: 'history_received', callback: true });
      expect(recv.last.meta.total >= 4, `received ${JSON.stringify(recv.last.meta)}`);
      const det = ok(pressPm(T.sender, `d:${W1.wid}`), { view: 'whisper_details', callback: true });
      expect(det.last.meta.role === 'sender' && det.last.meta.snoops === 1 && det.last.meta.opens.join() === '2', `details ${JSON.stringify(det.last.meta)}`);
      const bySender = ok(pressPm(T.sender, `n:${W1.wid}`), { view: 'curious', callback: true });
      expect(/@zzw_t4/.test(bySender.text), bySender.text);
      const byRcpt = ok(pressPm(T.rcpt, `n:${W1.wid}`), { view: 'curious', callback: true });
      expect(/@zzw_t4/.test(byRcpt.text), byRcpt.text);
      const notYours = ok(pressPm(T.byId, `n:${W1.wid}`), { callback: true });
      expect(alertIs(notYours, /مال تو نیست/), `curious list refused to others ${JSON.stringify(notYours.answer)}`);
      return { detail: `sent ${sent.last.meta.total}, received ${recv.last.meta.total}; curious list shown to sender + recipient` };
    });

    await scenario('9b. quick results: text without recipient → 3 recent recipients', () => {
      const q = ok(inlineQuery(T.sender, 'zz quick text'));
      const quick = (q.inline.results || []).filter((r) => /^q\.\w{8}\.[1-3]$/.test(r.id));
      expect(quick.length === 3, `quick results ${JSON.stringify(q.inline.results.map((r) => r.id))}`);
      return { detail: quick.map((r) => r.title).join(' | ') };
    });

    await scenario('9c. block list: a blocked sender cannot create whispers to them; unblock restores', () => {
      const b = ok(pressPm(T.rcpt, `bk:${T.sender}`), { view: 'blocks', callback: true });
      expect(/بلاک شد/.test(b.answer.text), JSON.stringify(b.answer));
      const q = ok(inlineQuery(T.sender, 'zz blocked @zzw_t2'));
      expect(q.inline.results[0].id === 'h.blocked' && !whisperResult(q), `results ${JSON.stringify(q.inline.results.map((r) => r.id))}`);
      const list = ok(sendText(T.rcpt, '/blocks'), { view: 'blocks' });
      expect(list.data.includes(`ub:${T.sender}`), `block list ${list.text}`);
      ok(pressPm(T.rcpt, `ub:${T.sender}`), { view: 'blocks', callback: true });
      expect(whisperResult(ok(inlineQuery(T.sender, 'zz unblocked @zzw_t2'))), 'can send again');
    });

    await scenario('9d. whisper settings: open alerts on/off, default expiry', () => {
      ok(sendText(T.sender, '/settings'), { view: 'settings' });
      const off = ok(pressPm(T.sender, 'st:r'), { view: 'settings', callback: true });
      expect(/خبر باز شدن:<\/b> خاموش/.test(off.text), off.text);
      const exp = ok(pressPm(T.sender, 'st:e:3600'), { view: 'settings', callback: true });
      expect(/انقضای پیش‌فرض:<\/b> ۱ ساعت/.test(exp.text), exp.text);
      const u = devtools({ op: 'user', user: T.sender });
      expect(u.receipts === 0 && u.def_expiry === 3600, `db ${u.receipts}/${u.def_expiry}`);
      ok(pressPm(T.sender, 'st:r'), { callback: true });
      ok(pressPm(T.sender, 'st:e:0'), { callback: true });
    });

    await scenario('10. forced join for a non-member: inline → no whispers + join button; PM → language, then the lock screen', () => {
      const q = ok(inlineQuery(T.outsider, 'zz outsider @zzw_t2'));
      const checks = q.trace.filter((t) => t.m === 'getChatMember');
      const skipped = checks.filter((t) => !t.ok && /inaccessible|not enough rights|chat not found|CHAT_ADMIN_REQUIRED/i.test(t.err || ''));
      if (checks.length && skipped.length === checks.length) {
        joinCheckable = false;
        return { status: 'WARN', detail: `the bot can't check membership in any channel (${skipped.map((t) => t.err).join('; ')}). Make the bot an ADMIN in the channels, then re-run.` };
      }
      expect((q.inline.results || []).length === 0, `results ${JSON.stringify(q.inline.results)}`);
      expect(q.inline.button && q.inline.button.start_parameter === 'join', `button ${JSON.stringify(q.inline.button)}`);
      ok(sendText(T.outsider, '/start'), { view: 'lang_picker' });
      const pm = ok(pressPm(T.outsider, 'L:fa'), { view: 'join', callback: true });
      expect(/✅ عضو شدم \[j\]/.test(JSON.stringify(pm.last.kb)), `join screen ${JSON.stringify(pm.last.kb)}`);
      return { detail: `button "${q.inline.button.text}"; PM links: ${pm.last.kb.flat().filter((b) => b.includes('->')).length}` };
    });

    await scenario('11. /admin: the owner gets the panel (with reports); a normal user is refused', () => {
      const own = ok(sendText(OWNER, '/admin'), { view: 'admin_panel' });
      expect(own.data.join() === 'a:ch,a:add,a:j,a:ban,a:unban,a:st,a:rp,a:bc', `panel ${JSON.stringify(own.data)}`);
      ok(sendText(T.sender, '/admin'), { view: 'admin_refused' });
      for (const d of ['a:ch', 'a:rp', 'a:bc']) {
        const btn = ok(pressPm(T.sender, d), { callback: true });
        expect(alertIs(btn, /فقط برای مالک/), `${d}: ${JSON.stringify(btn.answer)}`);
      }
      PANEL_MID = own.last.ok ? own.last.mid : null;
      return { detail: own.last.ok ? 'owner panel delivered in Telegram' : `owner panel: Telegram said "${own.last.err}" (send /start to the bot from the owner account)` };
    });

    await scenario('12. channels: an 11th is refused; remove then re-add a channel', () => {
      const before = devtools({ op: 'channels' });
      devtools({ op: 'fill_channels', to: 10 });
      const eleventh = ok(pressPm(OWNER, 'a:add'), { callback: true });
      expect(alertIs(eleventh, /حداکثر ۱۰ کانال/), JSON.stringify(eleventh.answer));
      devtools({ op: 'drop_fake_channels' });
      const target = before.find((c) => c.uname === 'wangerbots') || before[before.length - 1];
      expect(target, 'no channel to remove');
      ok(pressPm(OWNER, `a:rm:${target.id}`), { view: 'admin_remove_confirm', callback: true });
      ok(pressPm(OWNER, `a:rmy:${target.id}`), { view: 'admin_channels', callback: true });
      expect(!devtools({ op: 'channels' }).some((c) => c.uname === target.uname), 'removed');
      ok(pressPm(OWNER, 'a:add'), { view: 'admin_add_channel', callback: true });
      const add = ok(sendText(OWNER, `https://t.me/${target.username}`));
      if (add.view === 'admin_channels' && devtools({ op: 'channels' }).some((c) => c.uname === target.uname)) {
        return { detail: `@${target.username} removed and re-added (getChat + bot admin verified)` };
      }
      devtools({ op: 'clear_owner_state' });
      devtools({ op: 'restore_channel', channel: originalChannels.find((c) => c.uname === target.uname) || target });
      devtools({ op: 'bump_chv' });
      if (add.view === 'admin_channel_not_admin') {
        return { status: 'WARN', detail: `removed OK; re-add refused because the bot is not an admin in @${target.username} (restored directly). Make the bot an admin there.` };
      }
      throw new Fail(`re-add: view ${add.view}: ${add.text}`);
    });

    // Changing the channel list invalidates cached memberships (by design): simulate them again.
    devtools({ op: 'join_cache', users: MEMBERS });

    await scenario('13. ban / unban by numeric id', () => {
      ok(pressPm(OWNER, 'a:ban'), { view: 'admin_ban_ask', callback: true });
      ok(sendText(OWNER, String(T.snoop)), { view: 'admin_banned' });
      const q = ok(inlineQuery(T.snoop, 'zz banned @zzw_t2'));
      expect((q.inline.results || []).length === 0 && q.inline.button && q.inline.button.start_parameter === 'banned', `banned inline ${JSON.stringify(q.inline)}`);
      ok(pressPm(OWNER, 'a:unban'), { view: 'admin_unban_ask', callback: true });
      ok(sendText(OWNER, String(T.snoop)), { view: 'admin_unbanned' });
      devtools({ op: 'join_cache', users: [T.snoop] });
      expect(whisperResult(ok(inlineQuery(T.snoop, 'zz free again @zzw_t2'))), 'can send after unban');
    });

    await scenario('14. broadcast to test users, one answering 403 → inactive; final report', () => {
      const real = devtools({ op: 'real_reachable' });
      if (real.length) return { status: 'WARN', detail: `skipped: ${real.length}+ real users would receive a test broadcast (${real.join(', ')}). Test it from /admin in Telegram instead.` };
      if (!PANEL_MID) return { status: 'WARN', detail: 'skipped: the owner has not started the bot, so there is no real message to copy. Send /start to the bot from the owner account and re-run.' };
      devtools({ op: 'seed_403_target' });
      ok(pressPm(OWNER, 'a:bc', PANEL_MID), { view: 'broadcast_ask', callback: true });
      const msg = ok(sendText(OWNER, 'zz broadcast test (the panel message is copied)', PANEL_MID));
      expect(msg.view === 'broadcast_confirm', `confirm screen: ${msg.view} ${msg.text}`);
      const id = Number((msg.data.find((d) => d.startsWith('a:bcy:')) || '').split(':')[2]);
      expect(id > 0, `broadcast id from ${JSON.stringify(msg.data)}`);
      expect(devtools({ op: 'bc_start_below', id, after: maxBroadcast }) === 1, 'queue start set');
      const go = ok(pressPm(OWNER, `a:bcy:${id}`, msg.last.mid), { callback: true });
      const copies = go.trace.filter((t) => t.m === 'copyMessage');
      const to403 = copies.find((t) => t.chat === TARGET_403);
      expect(to403 && /^403/.test(to403.err || ''), `copy to ${TARGET_403}: ${JSON.stringify(to403)}`);
      const target = devtools({ op: 'user', user: TARGET_403 });
      expect(target.active === 0, '403 → marked inactive, not retried');
      const again = ok(pressPm(OWNER, `a:bcc:${id}`, msg.last.mid), { callback: true });
      expect(!again.trace.some((t) => t.m === 'copyMessage' && t.chat === TARGET_403), 'no retry after 403');
      const report = byView(go, 'broadcast_report')[0];
      expect(report && report.chat === OWNER, `final report ${JSON.stringify(byView(go, 'broadcast_report'))}`);
      return { detail: `${copies.length} copies, ${TARGET_403} → ${to403.err}; report: ${report.text.replace(/\n+/g, ' / ')}` };
    });

    await scenario('14b. anonymous message to the owner (real delivery): link, profile card, category, no identity; reply; block without revealing who', () => {
      if (!PANEL_MID) return { status: 'WARN', detail: 'skipped: the owner has not started the bot, so nothing can be delivered for real. Send /start to the bot from the owner account and re-run.' };
      devtools({ op: 'owner_anon_on' });
      devtools({ op: 'join_cache', users: [T.sender] });
      const link = ok(pressPm(OWNER, 'al', PANEL_MID), { view: 'anon_link', callback: true });
      const code = (link.text.match(/start=a_([0-9A-Za-z]{10})/) || [])[1];
      expect(code, `no link in ${link.text}`);
      const card = ok(sendText(T.sender, `/start a_${code}`), { view: 'anon_profile' });
      expect(/در حال ارسال پیام ناشناس به/.test(card.text), `card: ${card.text}`);
      expect(['ac:q', 'ac:c', 'ac:o', 'ac:f', 'ac:h', 'ac:g'].every((d) => card.data.includes(d)), `categories ${JSON.stringify(card.data)}`);
      const pick = ok(pressPm(T.sender, 'ac:c'), { callback: true });
      expect(/اعتراف/.test(pick.answer.text), `category ${JSON.stringify(pick.answer)}`);
      const sent = ok(sendText(T.sender, 'zz anonymous cloud test'), { view: 'anon_sent' });
      const delivered = byView(sent, 'anon_deliver').find((t) => t.chat === OWNER);
      expect(delivered && delivered.ok, `delivery to the owner: ${JSON.stringify(delivered)}`);
      expect(/hidden/.test(delivered.text), `the content is kept out of the trace: ${delivered.text}`);
      const seen = JSON.stringify(byView(sent, 'anon_deliver'));
      expect(!seen.includes(String(T.sender)) && !seen.includes(uname(T.sender)) && !seen.includes(person(T.sender).first_name), `sender identity in what the owner got: ${seen}`);
      const ref = ((delivered.kb || []).flat().join(' ').match(/\[ar:([0-9A-Za-z]{10})\]/) || [])[1];
      expect(ref, `reply button ${JSON.stringify(delivered.kb)}`);
      ok(pressPm(OWNER, `ar:${ref}`, delivered.mid), { view: 'anon_reply_prompt', callback: true });
      const reply = ok(sendText(OWNER, 'zz owner reply'));
      const back = byView(reply, 'anon_deliver').find((t) => t.chat === T.sender);
      expect(back, `reply relayed to the sender: ${JSON.stringify(reply.trace.map((t) => [t.m, t.view, t.chat]))}`);
      expect(/hidden/.test(back.text), `the reply's text is kept out of the trace: ${back.text}`);
      const blk = ok(pressPm(OWNER, `ab:${ref}`, delivered.mid), { callback: true });
      expect(/بلاک شد/.test(blk.answer.text), JSON.stringify(blk.answer));
      expect(devtools({ op: 'anon_blocks_of_owner' }) === 1, 'blocked');
      ok(sendText(T.sender, `/start a_${code}`), { view: 'anon_refused' });
      const list = ok(sendText(OWNER, '/blocks'), { view: 'blocks' });
      expect(/ناشناس/.test(list.text) && !list.text.includes(String(T.sender)) && !list.text.includes(uname(T.sender)), `block list: ${list.text}`);
      ok(pressPm(OWNER, `ab:${ref}`, delivered.mid), { callback: true });
      expect(devtools({ op: 'anon_blocks_of_owner' }) === 0, 'unblocked');
      return { detail: `link a_${code}; delivered to the owner (message ${delivered.mid}); reply → ${back.ok ? 'ok' : back.err}; block/unblock ok` };
    });

    await scenario('14c. anonymous features: profile, ratings + average on the card, question of the day, filters (shadow), inbox, search, archive', () => {
      devtools({ op: 'join_cache', users: MEMBERS });
      devtools({ op: 'unflood', users: MEMBERS });
      const link = ok(sendText(T.rcpt, '/link'), { view: 'anon_link' });
      const code = (link.text.match(/start=a_([0-9A-Za-z]{10})/) || [])[1];
      expect(code, `no link in ${link.text}`);
      // a limited profile
      ok(pressPm(T.rcpt, 'pf:n'), { view: 'profile_name', callback: true });
      ok(sendText(T.rcpt, 't.me/zz_spam'), { view: 'profile_invalid' });
      ok(sendText(T.rcpt, 'zz Rcpt'), { view: 'profile' });
      ok(pressPm(T.rcpt, 'pf:b'), { view: 'profile_bio', callback: true });
      ok(sendText(T.rcpt, 'zz cloud bio'), { view: 'profile' });
      // ratings: one per visitor, the average on the card
      const r1 = ok(pressPm(T.sender, `rt:${code}:4`), { callback: true });
      expect(/میانگین: ۴٫۰ از ۵ \(۱ رأی\)/.test(r1.answer.text), `rating 1: ${r1.answer.text}`);
      const r2 = ok(pressPm(T.byId, `rt:${code}:2`), { callback: true });
      expect(/میانگین: ۳٫۰ از ۵ \(۲ رأی\)/.test(r2.answer.text), `rating 2: ${r2.answer.text}`);
      const self = ok(pressPm(T.rcpt, `rt:${code}:5`), { callback: true });
      expect(alertIs(self, /به خودت/), `self rating ${JSON.stringify(self.answer)}`);
      const totals = devtools({ op: 'ratings_of', user: T.rcpt });
      expect(totals.rating_sum === 6 && totals.rating_count === 2, `totals ${JSON.stringify(totals)}`);
      // the question of the day, and what a visitor sees when the link is opened
      ok(pressPm(T.rcpt, 'qd:d'), { view: 'qotd', callback: true });
      const card = ok(sendText(T.snoop, `/start a_${code}`), { view: 'anon_profile' });
      for (const re of [/در حال ارسال پیام ناشناس به <b>zz Rcpt<\/b>/, /zz cloud bio/, /⭐️ امتیاز: ۳٫۰ از ۵ \(۲ رأی\)/, /❓ <b>سؤال:<\/b>/]) expect(re.test(card.text), `card misses ${re}: ${card.text}`);
      const ans = ok(sendText(T.snoop, 'zz qotd answer'), { view: 'anon_sent' });
      expect(byView(ans, 'anon_deliver').some((t) => t.chat === T.rcpt), 'delivery attempted (a fake id: "chat not found", so it waits in the inbox)');
      const q = devtools({ op: 'anon_msgs_to', user: T.rcpt })[0];
      expect(q && q.cat === 'd' && q.q && q.folder === 0 && q.from_id === T.snoop, `stored ${JSON.stringify(q)}`);
      ANON_Q = q.id;
      // filters: offensive words and the user's own words go to the "filtered" folder, undelivered,
      // and the sender sees the usual confirmation (so there is nothing to learn by retrying)
      devtools({ op: 'unflood', users: [T.snoop] });
      ok(sendText(T.snoop, `/start a_${code}`), { view: 'anon_profile' });
      const off = ok(sendText(T.snoop, 'zz تو یه کصکش هستی'), { view: 'anon_sent' });
      expect(off.value.filtered === 'offensive' && !byView(off, 'anon_deliver').length, `offensive: ${off.value.filtered}`);
      ok(pressPm(T.rcpt, 'fw:add'), { callback: true });
      ok(sendText(T.rcpt, 'zzbanana'), { view: 'words' });
      ok(sendText(T.byId, `/start a_${code}`), { view: 'anon_profile' });
      const word = ok(sendText(T.byId, 'I like ZZBANANA a lot'), { view: 'anon_sent' });
      expect(word.value.filtered === 'word' && !byView(word, 'anon_deliver').length, `own word: ${word.value.filtered}`);
      // the inbox: folders, unread, view, search, archive
      const box = ok(sendText(T.rcpt, '/inbox'), { view: 'inbox' });
      expect(box.last.meta.ids.length === 1 && box.last.meta.unread === 1, `inbox ${JSON.stringify(box.last.meta)}`);
      const filtered = ok(pressPm(T.rcpt, 'ib:2:-:0'), { view: 'inbox', callback: true });
      expect(filtered.last.meta.ids.length === 2, `filtered folder ${JSON.stringify(filtered.last.meta)}`);
      const view = ok(pressPm(T.rcpt, `iv:${q.id}`), { view: 'inbox_message', callback: true });
      expect(/hidden/.test(view.text) && view.last.meta.cat === 'd', `message ${JSON.stringify(view.last)}`);
      expect(devtools({ op: 'user', user: T.rcpt }).anon_unread === 0, 'read');
      ok(pressPm(T.rcpt, 'is:0'), { callback: true });
      const found = ok(sendText(T.rcpt, 'QOTD answer'), { view: 'inbox_search' });
      expect(found.last.meta.found === 1, `search ${JSON.stringify(found.last.meta)}`);
      ok(pressPm(T.rcpt, `ia:${q.id}`), { callback: true });
      expect(devtools({ op: 'anon_msgs_to', user: T.rcpt }).find((m) => m.id === q.id).folder === 1, 'archived');
      return { detail: `link a_${code}; rating 3.0 (2); filtered: offensive + own word; inbox 1, filtered 2, search 1, archived` };
    });

    await scenario('14d. report: the owner reviews the content without the sender\'s identity and restricts them; restricted senders are refused', () => {
      const q = devtools({ op: 'anon_msgs_to', user: T.rcpt }).find((m) => m.id === ANON_Q);
      expect(q && q.from_id === T.snoop, 'no message to report (14c failed?)');
      ok(pressPm(T.rcpt, `ap:${q.id}`), { view: 'anon_report_ask', callback: true });
      const done = ok(pressPm(T.rcpt, `apy:${q.id}`), { callback: true });
      expect(/گزارش شد/.test(done.answer.text), JSON.stringify(done.answer));
      const note = byView(done, 'owner_report')[0];
      expect(note && note.chat === OWNER, `owner notified ${JSON.stringify(byView(done, 'owner_report'))}`);
      const reports = devtools({ op: 'reports_by', user: T.rcpt });
      expect(reports.length === 1 && reports[0].status === 'open', `reports ${JSON.stringify(reports)}`);
      const list = ok(pressPm(OWNER, 'a:rp', PANEL_MID), { view: 'admin_reports', callback: true });
      expect(list.data.includes(`a:rv:${reports[0].id}`), `report list ${JSON.stringify(list.data)}`);
      const review = ok(pressPm(OWNER, `a:rv:${reports[0].id}`, PANEL_MID), { view: 'admin_report', callback: true });
      const shown = JSON.stringify(review.trace.filter((t) => t.chat === OWNER));
      expect(/hidden/.test(review.text) && !shown.includes(String(T.snoop)) && !shown.includes(uname(T.snoop)), `review: ${shown}`);
      const act = ok(pressPm(OWNER, `a:rr:${reports[0].id}`, PANEL_MID), { callback: true });
      expect(/۷ روز محدود شد/.test(act.answer.text), JSON.stringify(act.answer));
      expect(devtools({ op: 'user', user: T.snoop }).restricted_until > nowSec() + 6 * 86400, 'restricted for 7 days');
      expect(devtools({ op: 'reports_by', user: T.rcpt })[0].status === 'restricted', 'report closed');
      // reporting also blocked them for the reporter; and the restriction stops them everywhere
      ok(sendText(T.snoop, `/start a_${(ok(sendText(T.rcpt, '/link')).text.match(/start=a_(\w{10})/) || [])[1]}`), { view: 'anon_refused' });
      const other = (ok(sendText(T.byId, '/link'), { view: 'anon_link' }).text.match(/start=a_(\w{10})/) || [])[1];
      devtools({ op: 'unflood', users: [T.snoop] });
      ok(sendText(T.snoop, `/start a_${other}`), { view: 'anon_profile' });
      ok(sendText(T.snoop, 'zz after the restriction'), { view: 'anon_spam_restricted' });
      return { detail: `report #${reports[0].id} → restricted 7 days; the reporter's block and the restriction both hold` };
    });

    await scenario('14e. image cards (Mini App): Telegram accepts the web_app buttons; cardData gives your own link; cardSend posts a real JPEG', () => {
      if (PANEL_MID) {
        const cards = ok(pressPm(OWNER, 'cd', PANEL_MID), { view: 'cards', callback: true });
        expect(cards.last.ok, `Telegram refused the card screen with Mini App buttons: ${cards.last.err}`);
        expect(cards.last.kb.flat().filter((b) => /<web_app https:\/\/app\d+\.tgcloud\.ai\/\?k=(link|q)&l=fa>$/.test(b)).length === 2, `Mini App buttons ${JSON.stringify(cards.last.kb)}`);
      }
      const d = tgcloudRun('endpoints/cardData', { k: 'link' }, { initData: { user: { id: T.byId, first_name: 'Tester3' } } });
      expect(d.exitOk && d.value && /start=a_\w{10}$/.test(d.value.link || ''), `cardData: ${d.out.slice(-500)}`);
      expect(d.value.lang === 'fa' && d.value.labels && d.value.labels.send, `labels ${JSON.stringify(d.value.labels)}`);
      if (!PANEL_MID) return { status: 'WARN', detail: `cardData ok (${d.value.link}); cardSend skipped: the owner has not started the bot, so there is no chat to post to` };
      const image = `data:image/jpeg;base64,${fs.readFileSync(CARD_JPEG).toString('base64')}`;
      const s = tgcloudRun('endpoints/cardSend', { k: 'link', image }, { initData: { user: { id: OWNER, first_name: 'Owner' } } });
      expect(s.exitOk && s.value && s.value.ok === true && s.value.bytes === fs.statSync(CARD_JPEG).size, `cardSend: ${s.out.slice(-800)}`);
      return { detail: `cardData → ${d.value.link}; cardSend → a ${s.value.bytes}-byte JPEG posted to the owner's chat` };
    });

    await scenario('14f. delete my data: inbox, profile, words and ratings erased; a fresh link', () => {
      const before = devtools({ op: 'user', user: T.rcpt });
      ok(pressPm(T.rcpt, 'dd'), { view: 'delete_ask', callback: true });
      ok(pressPm(T.rcpt, 'ddy'), { view: 'delete_done', callback: true });
      const u = devtools({ op: 'user', user: T.rcpt });
      expect(u.p_name === null && u.p_bio === null && u.inbox_size === 0 && u.rating_count === 0 && u.anon_code !== before.anon_code, `user ${JSON.stringify(u)}`);
      expect(devtools({ op: 'anon_msgs_to', user: T.rcpt }).length === 0, 'inbox emptied');
    });

    await scenario('14g. the Mini App (card maker) is served at https://app<bot id>.tgcloud.ai/', async () => {
      if (LOCAL) return { status: 'INFO', detail: 'not checked by the local stand-in' };
      const botId = Number((devtools({ op: 'kv_get', keys: ['bot_id'] })[0] || {}).value || 0);
      if (!botId) return { status: 'WARN', detail: 'bot id unknown (kv bot_id)' };
      const base = `https://app${botId}.tgcloud.ai/`;
      const checks = [];
      for (const [file, re] of [['', /telegram-web-app\.js[\s\S]*app\.js/], ['app.js', /^(?=[\s\S]*Serverless\.call\()(?=[\s\S]*call\('cardData')(?=[\s\S]*call\('cardSend')/], ['fonts/vazirmatn-arabic-700-normal.woff2', null]]) {
        const res = await fetch(base + file);
        const body = re ? await res.text() : '';
        checks.push(`${file || '/'} ${res.status}`);
        expect(res.ok && (!re || re.test(body)), `${base}${file}: ${res.status}`);
      }
      return { detail: `${base} — ${checks.join(', ')}` };
    });

    await scenario('15. lazy cleanup: an unsent draft older than 24h is deleted on a later update', () => {
      devtools({ op: 'join_cache', users: [T.third, T.sender] });
      ok(inlineQuery(T.third, 'zz draft to age @zzw_t2'));
      expect(devtools({ op: 'draft_count', user: T.third }) === 1, 'draft exists');
      devtools({ op: 'age_drafts', users: [T.third] });
      const r = ok(sendText(T.sender, '/help'), { view: 'help' });
      expect(r.value.gc && r.value.gc.drafts >= 1, `gc ${JSON.stringify(r.value.gc)}`);
      expect(devtools({ op: 'draft_count', user: T.third }) === 0, 'deleted');
      return { detail: `gc: ${JSON.stringify(r.value.gc)}` };
    });
  } finally {
    // ---------- restore ----------
    try {
      devtools({ op: 'clear_owner_state' });
      devtools({ op: 'drop_fake_channels' });
      const now = devtools({ op: 'channels' });
      for (const c of originalChannels) if (!now.some((x) => x.uname === c.uname)) devtools({ op: 'restore_channel', channel: c });
      devtools({ op: 'restore_kv', kv: startKv });
      devtools({ op: 'drop_broadcasts', after: maxBroadcast });
      devtools({ op: 'restore_owner_anon', value: ownerAnon });
      const removed = devtools({ op: 'cleanup', users: TEST_USERS });
      devtools({ op: 'restore_n_anon', value: startAnon, since: startedAt });
      console.log(`\nrestored: channels, join setting, the owner's anonymous settings; removed ${removed.removedUsers} test users and ${removed.removedWhispers} test whispers`);
    } catch (err) {
      console.log(`\n⚠ restore failed: ${err.message}`);
    }
  }
  return { joinCheckable, botUsername };
}

function webhookCheck() {
  const out = cli(['webhook'], { allowFail: true });
  log(`\n$ npx tgcloud webhook\n${out}`);
  const inSync = /in sync with your deployed handlers/.test(out);
  const updates = (out.match(/allowed updates:\s*(.*)/) || [])[1] || '';
  const needed = ['message', 'inline_query', 'chosen_inline_result', 'callback_query'];
  const missing = needed.filter((u) => !updates.split(/,\s*/).includes(u));
  results.push({
    name: '16. webhook in sync with message, inline_query, chosen_inline_result, callback_query',
    status: inSync && !missing.length ? 'PASS' : 'FAIL',
    detail: inSync && !missing.length ? updates : `${out.trim().split('\n').slice(0, 8).join(' | ')}${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`,
  });
  const r = results[results.length - 1];
  console.log(`${r.status === 'PASS' ? '✔' : '✘'} ${r.status}  ${r.name}\n         ${r.detail}`);
}

// ---------- run ----------

const started = Date.now();
fs.mkdirSync(DEVTOOLS_DIR, { recursive: true });
const createdEndpointsDir = fs.readdirSync(DEVTOOLS_DIR).length === 0;
fs.copyFileSync(DEVTOOLS_SRC, DEVTOOLS_DST);
const removeDevtools = () => {
  try {
    fs.rmSync(DEVTOOLS_DST, { force: true });
    if (createdEndpointsDir && fs.existsSync(DEVTOOLS_DIR) && !fs.readdirSync(DEVTOOLS_DIR).length) fs.rmdirSync(DEVTOOLS_DIR);
  } catch {
    // best effort
  }
};
process.on('SIGINT', () => {
  removeDevtools();
  process.exit(130);
});
let info = {};
try {
  info = await main();
} catch (err) {
  results.push({ name: 'runner', status: 'FAIL', detail: String(err.stack || err) });
  console.log(`✘ runner crashed: ${err.stack || err}`);
} finally {
  removeDevtools();
}
if (!process.env.TGCLOUD_SKIP_WEBHOOK) webhookCheck();

const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
const summary = [
  `# Cloud test run — ${new Date().toISOString()}`,
  '',
  `${runs} \`tgcloud run\` invocations, ${Math.round((Date.now() - started) / 1000)}s${rateWait ? ` (${rateWait}s of it waiting for the platform's rate limit)` : ''}. ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '),
  info.botUsername ? `Bot: @${info.botUsername}` : '',
  '',
  '| # | Scenario | Result | Detail |',
  '|---|---|---|---|',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.status} | ${String(r.detail || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>').slice(0, 400)} |`),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), summary);
console.log(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} — ${runs} runs${rateWait ? `, ${rateWait}s rate-limit waits` : ''}; log: test/cloud/output/run.log, summary: test/cloud/output/summary.md`);
process.exit(counts.FAIL ? 1 : 0);
