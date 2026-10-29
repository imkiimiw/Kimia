#!/usr/bin/env node
// Runs the scenarios on Telegram Serverless itself, with `npx tgcloud run` (the platform executes the
// local handlers against the bot's real database and the real Bot API, without deploying).
//
//   cd whisper_bot && node test/cloud/run-tests.mjs     (after `npx tgcloud login` or with TGCLOUD_TOKEN,
//                                                         and after push + migrate)
//
// - Test users have fake ids 990000001-990000009, so Telegram answers "chat not found" / "query is too
//   old" to whatever the bot sends them. The handlers return a trace of every Bot API call (method,
//   view, text — whisper content is hidden — buttons, Telegram's answer), and the checks run on that
//   trace plus a read-back of the database through a temporary test endpoint (test/cloud/devtools.js,
//   copied to tgcloud/endpoints/zz_devtools.js for the run and always deleted afterwards).
// - Owner scenarios use the real owner id 5557901897, so the owner receives those screens in Telegram.
// - Everything is restored at the end: test users' rows, their whispers, fake channels, removed
//   channels, the join setting, broadcasts made by the run.
// - Raw CLI output goes to test/cloud/output/run.log; the pass/fail table to test/cloud/output/summary.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const DEVTOOLS_SRC = path.join(ROOT, 'test/cloud/devtools.js');
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
  third: 990000005, // zzw_t5
  outsider: 990000009, // never a channel member, no join cache
};
const MEMBERS = [T.sender, T.rcpt, T.byId, T.snoop, T.third];
const TEST_USERS = [...MEMBERS, T.outsider, TARGET_403];
const uname = (id) => `zzw_t${id % 10}`;
let W1 = null; // whisper to @zzw_t2
let W2 = null; // whisper to the numeric id
let PANEL_MID = null; // a real message in the owner's chat (the /admin panel), copied by the broadcast test

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

function tgcloudRun(module, args, ctx) {
  const argv = ['run', module, JSON.stringify(args)];
  if (ctx) argv.push('--ctx', JSON.stringify(ctx));
  runs += 1;
  let out;
  let exitOk = true;
  try {
    out = cli(argv);
  } catch (e) {
    exitOk = false;
    out = `${e.stdout || ''}${e.stderr || ''}`;
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
  language_code: 'fa',
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
  const screens = trace.filter((t) => (t.m === 'sendMessage' || (t.m === 'editMessageText' && !t.inline)) && t.view && !['owner_warning', 'read_receipt'].includes(t.view));
  const last = screens[screens.length - 1] || null;
  const answers = trace.filter((t) => t.m === 'answerCallbackQuery');
  const inline = trace.find((t) => t.m === 'answerInlineQuery') || null;
  const edits = trace.filter((t) => t.m === 'editMessageText' && t.inline);
  const data = last && last.kb ? last.kb.flat().map((b) => (b.match(/\[([^\]]+)\]$/) || [])[1]).filter(Boolean) : [];
  const handlerError = !r.exitOk || !(r.value && Array.isArray(r.value.trace)) || !!(r.value && r.value.error);
  return { ...r, trace, screens, last, view: last ? last.view : null, text: last ? last.text || '' : '', data, answers, answer: answers[0] || null, inline, edits, handlerError };
}

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

async function main() {
  const start = devtools({ op: 'snapshot' });
  const originalChannels = start.channels;
  const startKv = start.kv;
  devtools({ op: 'cleanup', users: TEST_USERS });
  devtools({ op: 'drop_fake_channels' });
  const maxBroadcast = start.maxBroadcast;
  const ownerAnon = devtools({ op: 'owner_anon' });
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

    await scenario('1a. test users /start; channels seeded (3 defaults) only if the table was empty', () => {
      for (const id of MEMBERS) ok(sendText(id, '/start'));
      const ch = devtools({ op: 'channels' });
      expect(ch.length >= 1, 'channels table is empty (seed failed)');
      devtools({ op: 'join_cache', users: MEMBERS }); // fake ids can't be channel members: simulate it
      return { detail: `channels: ${ch.map((c) => `@${c.username}`).join(', ')}` };
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

    await scenario('1c. inline whisper to a numeric id', () => {
      const w = makeWhisper(`zz cloud by id ${T.byId}`);
      const row = devtools({ op: 'whisper', id: w.wid });
      expect(row.rcpts[0].rid === T.byId, `rid ${row.rcpts[0].rid}`);
      W2 = w;
      return { detail: `whisper ${w.wid} → rid ${T.byId} (label ${row.rcpts[0].label})` };
    });

    await scenario('2. typing many inline queries in a row keeps ONE draft row and creates no whispers', () => {
      const before = devtools({ op: 'whisper_count', user: T.sender });
      const typed = 'zz typing test @zzw_t3';
      const steps = [4, 8, 12, 15, 18, typed.length];
      const ids = new Set();
      for (const n of steps) {
        const q = ok(inlineQuery(T.sender, typed.slice(0, n)));
        const r = whisperResult(q);
        if (r) ids.add(r.wid);
      }
      const drafts = devtools({ op: 'draft_count', user: T.sender });
      const after = devtools({ op: 'whisper_count', user: T.sender });
      expect(drafts === 1, `drafts for the sender: ${drafts}`);
      expect(after === before, `whispers ${before} → ${after}`);
      return { detail: `${steps.length} queries → 1 draft row, ${after - before} new whispers` };
    });

    await scenario('3a. opening as a snooper: "این نجوا مال تو نیست 😏", counted, "👀 ۱ فضول" edit', () => {
      const p = ok(pressInline(T.snoop, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(alertIs(p, /^این نجوا مال تو نیست 😏$/), `answer ${JSON.stringify(p.answer)}`);
      expect(p.edits.some((e) => /👀 ۱ فضول/.test(e.text)), `edit ${JSON.stringify(p.edits)}`);
      const w = devtools({ op: 'whisper', id: W1.wid });
      expect(w.snoops === 1 && w.snoopers[0].user_id === T.snoop, `snoops ${w.snoops}`);
      const again = ok(pressInline(T.snoop, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(devtools({ op: 'whisper', id: W1.wid }).snoops === 1, 'counted once');
      expect(again.edits.length === 0, 'no edit for a repeat snooper');
    });

    await scenario('3b. opening as the sender: content shown (alert), nothing marked seen', () => {
      const p = ok(pressInline(T.sender, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(revealed(p, 'sender'), `answer ${JSON.stringify(p.answer)}`);
      expect(p.answer.meta.length === 'zz cloud secret one'.length, 'the whole text');
      expect(devtools({ op: 'whisper', id: W1.wid }).rcpts[0].seen_at === 0, 'not seen');
    });

    await scenario('3c/5. opening as the recipient: content shown, "👁 دیده شد" edit, read receipt to the sender', () => {
      const p = ok(pressInline(T.rcpt, `s:${W1.wid}`, W1.inlineId), { callback: true });
      expect(revealed(p, 'recipient'), `answer ${JSON.stringify(p.answer)}`);
      const edit = p.edits.find((e) => /👁 دیده شد/.test(e.text));
      expect(edit, `seen edit ${JSON.stringify(p.edits)}`);
      expect(!/zz cloud secret/.test(edit.text), 'no content in the edit');
      const receipt = byView(p, 'read_receipt');
      expect(receipt.length === 1 && receipt[0].chat === T.sender && /نجوای شما را دید/.test(receipt[0].text), `receipt ${JSON.stringify(receipt)}`);
      const w = devtools({ op: 'whisper', id: W1.wid });
      expect(w.rcpts[0].seen_at > 0 && w.rcpts[0].rid === T.rcpt, `rcpt ${JSON.stringify(w.rcpts[0])}`);
      // the numeric-id whisper: only that id
      const wrong = ok(pressInline(T.snoop, `s:${W2.wid}`, W2.inlineId), { callback: true });
      expect(alertIs(wrong, /مال تو نیست/), 'snooper on the id whisper');
      const right = ok(pressInline(T.byId, `s:${W2.wid}`, W2.inlineId), { callback: true });
      expect(revealed(right, 'recipient'), `id recipient ${JSON.stringify(right.answer)}`);
      return { detail: `edit: ${edit.text.replace(/\n/g, ' / ')}; receipt: ${receipt[0].text}` };
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
      expect(alertIs(no, /مال تو نیست/), 'snooper');
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

    await scenario('9a. history: sent (full text) and received; details; snoopers list', () => {
      const sent = ok(sendText(T.sender, '/history'), { view: 'history_sent' });
      expect(sent.last.meta && sent.last.meta.total >= 6, `sent meta ${JSON.stringify(sent.last.meta)}`);
      const recv = ok(pressPm(T.rcpt, 'h:r:0'), { view: 'history_received', callback: true });
      expect(recv.last.meta.total >= 4, `received ${JSON.stringify(recv.last.meta)}`);
      const det = ok(pressPm(T.sender, `d:${W1.wid}`), { view: 'whisper_details', callback: true });
      expect(det.last.meta.role === 'sender' && det.last.meta.snoops === 1, `details ${JSON.stringify(det.last.meta)}`);
      const sn = ok(pressPm(T.sender, `n:${W1.wid}`), { view: 'snoopers', callback: true });
      expect(/@zzw_t4/.test(sn.text), sn.text);
      const notYours = ok(pressPm(T.snoop, `d:${W1.wid}`), { callback: true });
      expect(alertIs(notYours, /مال تو نیست/), 'details refused to a stranger');
      return { detail: `sent ${sent.last.meta.total}, received ${recv.last.meta.total}` };
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

    await scenario('9d. settings: read receipt on/off, default expiry', () => {
      ok(sendText(T.sender, '/settings'), { view: 'settings' });
      const off = ok(pressPm(T.sender, 'st:r'), { view: 'settings', callback: true });
      expect(/رسید خواندن:<\/b> خاموش/.test(off.text), off.text);
      const exp = ok(pressPm(T.sender, 'st:e:3600'), { view: 'settings', callback: true });
      expect(/انقضای پیش‌فرض:<\/b> ۱ ساعت/.test(exp.text), exp.text);
      const u = devtools({ op: 'user', user: T.sender });
      expect(u.receipts === 0 && u.def_expiry === 3600, `db ${u.receipts}/${u.def_expiry}`);
      ok(pressPm(T.sender, 'st:r'), { callback: true });
      ok(pressPm(T.sender, 'st:e:0'), { callback: true });
    });

    await scenario('10. forced join for a non-member: inline → no whispers + join button; PM → lock screen', () => {
      const q = ok(inlineQuery(T.outsider, 'zz outsider @zzw_t2'));
      const checks = q.trace.filter((t) => t.m === 'getChatMember');
      const skipped = checks.filter((t) => !t.ok && /inaccessible|not enough rights|chat not found|CHAT_ADMIN_REQUIRED/i.test(t.err || ''));
      if (checks.length && skipped.length === checks.length) {
        joinCheckable = false;
        return { status: 'WARN', detail: `the bot can't check membership in any channel (${skipped.map((t) => t.err).join('; ')}). Make the bot an ADMIN in the channels, then re-run.` };
      }
      expect((q.inline.results || []).length === 0, `results ${JSON.stringify(q.inline.results)}`);
      expect(q.inline.button && q.inline.button.start_parameter === 'join', `button ${JSON.stringify(q.inline.button)}`);
      const pm = ok(sendText(T.outsider, '/start'), { view: 'join' });
      expect(/✅ عضو شدم \[j\]/.test(JSON.stringify(pm.last.kb)), `join screen ${JSON.stringify(pm.last.kb)}`);
      return { detail: `button "${q.inline.button.text}"; PM links: ${pm.last.kb.flat().filter((b) => b.includes('->')).length}` };
    });

    await scenario('11. /admin: the owner gets the panel; a normal user is refused', () => {
      const own = ok(sendText(OWNER, '/admin'), { view: 'admin_panel' });
      const user = ok(sendText(T.sender, '/admin'), { view: 'admin_refused' });
      const btn = ok(pressPm(T.sender, 'a:ch'), { callback: true });
      expect(alertIs(btn, /فقط برای مالک/), JSON.stringify(btn.answer));
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

    await scenario('14b. anonymous chat: personal link, anonymous delivery to the owner, reply, block without revealing who', () => {
      if (!PANEL_MID) return { status: 'WARN', detail: 'skipped: the owner has not started the bot, so nothing can be delivered for real. Send /start to the bot from the owner account and re-run.' };
      devtools({ op: 'join_cache', users: [T.sender] });
      const link = ok(pressPm(OWNER, 'an', PANEL_MID), { view: 'anon_link', callback: true });
      const code = (link.text.match(/start=a_([0-9A-Za-z]{10})/) || [])[1];
      expect(code, `no link in ${link.text}`);
      ok(sendText(T.sender, `/start a_${code}`), { view: 'anon_prompt' });
      const sent = ok(sendText(T.sender, 'zz anonymous cloud test'), { view: 'anon_sent' });
      const delivered = byView(sent, 'anon_deliver').find((t) => t.chat === OWNER);
      expect(delivered && delivered.ok, `delivery to the owner: ${JSON.stringify(delivered)}`);
      const seen = JSON.stringify(byView(sent, 'anon_deliver'));
      expect(!seen.includes(String(T.sender)) && !seen.includes(uname(T.sender)), `sender identity in what the owner got: ${seen}`);
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
      console.log(`\nrestored: channels, join setting; removed ${removed.removedUsers} test users and ${removed.removedWhispers} test whispers`);
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
  `${runs} \`tgcloud run\` invocations, ${Math.round((Date.now() - started) / 1000)}s. ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '),
  info.botUsername ? `Bot: @${info.botUsername}` : '',
  '',
  '| # | Scenario | Result | Detail |',
  '|---|---|---|---|',
  ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.status} | ${String(r.detail || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>').slice(0, 400)} |`),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), summary);
console.log(`\n${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} — ${runs} runs; log: test/cloud/output/run.log, summary: test/cloud/output/summary.md`);
process.exit(counts.FAIL ? 1 : 0);
