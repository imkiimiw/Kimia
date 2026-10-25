#!/usr/bin/env node
// Runs every scenario on Telegram Serverless itself, with `npx tgcloud run` (the platform executes
// the local handlers against the bot's real database and the real Bot API, without deploying).
//
//   node test/cloud/run-tests.mjs        (needs `npx tgcloud login` or TGCLOUD_TOKEN, and a migrated DB)
//
// - Test users have fake ids 990000001-990000003, so messages to them fail with "chat not found";
//   the handlers return a trace of every Bot API call (method, view, text, buttons, Telegram's
//   answer), and the assertions run on that trace plus a read-back of the database.
// - Owner scenarios use the real owner id 5557901897, so the owner receives those screens in Telegram.
// - Everything is restored at the end: test users' rows, fake channels, removed channels, join on/off.
// - Raw CLI output of every run goes to test/cloud/output/run.log; the summary to output/summary.md.
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
const TU1 = 990000001; // main test user
const TU2 = 990000002; // the "other user"
const TU3 = 990000003; // never a channel member
const TEST_USERS = [TU1, TU2, TU3];

fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG = path.join(OUT_DIR, 'run.log');
fs.writeFileSync(LOG, `tgcloud run log — ${new Date().toISOString()}\n`);
const log = (s) => fs.appendFileSync(LOG, `${s}\n`);

// ---------- running modules on the platform ----------

let runs = 0;

// TGCLOUD_CLI_ARGS (JSON array of node arguments) replaces the real CLI; only
// test/cloud/local-harness.mjs sets it, to check this script against a local emulation.
const CLI_ARGS = process.env.TGCLOUD_CLI_ARGS ? JSON.parse(process.env.TGCLOUD_CLI_ARGS) : [CLI];

function tgcloudRun(module, args, ctx) {
  const argv = [...CLI_ARGS, 'run', module, JSON.stringify(args)];
  if (ctx) argv.push('--ctx', JSON.stringify(ctx));
  runs += 1;
  let out;
  let exitOk = true;
  try {
    out = execFileSync(process.execPath, argv, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  if (!r.exitOk) throw new Error(`devtools ${input.op} failed:\n${r.out}`);
  return r.value;
}

// ---------- realistic update payloads ----------

let seq = 1;
const nowSec = () => Math.floor(Date.now() / 1000);
const person = (id) => ({ id, is_bot: false, first_name: id === OWNER ? 'Owner' : `Tester${id % 1000}`, language_code: 'fa' });
const privateChat = (id) => ({ id, first_name: person(id).first_name, type: 'private' });

function sendText(uid, text) {
  const n = seq++;
  const message = { message_id: 100000 + n, from: person(uid), chat: privateChat(uid), date: nowSec(), text };
  const cmd = /^\/[A-Za-z0-9_]+/.exec(text);
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  const r = tgcloudRun('handlers/message', message, { update: { update_id: 700000000 + n, message } });
  return analyse(r);
}

function press(uid, data) {
  const n = seq++;
  const callbackQuery = {
    id: `${4000000000000 + n}`,
    from: person(uid),
    message: {
      message_id: 200000 + n,
      from: { id: 1, is_bot: true, first_name: 'Bot' },
      chat: privateChat(uid),
      date: nowSec() - 30,
      text: '…',
    },
    chat_instance: '-5170000000000000000',
    data,
  };
  const r = tgcloudRun('handlers/callback_query', callbackQuery, { update: { update_id: 700000000 + n, callback_query: callbackQuery } });
  return analyse(r);
}

function analyse(r) {
  const trace = (r.value && Array.isArray(r.value.trace)) ? r.value.trace : [];
  const screens = trace.filter((t) => (t.m === 'sendMessage' || t.m === 'editMessageText') && t.view !== 'owner_warning');
  const last = screens[screens.length - 1] || null;
  const answers = trace.filter((t) => t.m === 'answerCallbackQuery');
  const data = last && last.kb ? last.kb.flat().map((b) => (b.match(/\[([^\]]+)\]$/) || [])[1]).filter(Boolean) : [];
  const urls = last && last.kb ? last.kb.flat().map((b) => (b.match(/ -> (https:\S+)$/) || [])[1]).filter(Boolean) : [];
  const handlerError = !r.exitOk || trace.some((t) => t.view === 'error') || !(r.value && r.value.trace);
  return { ...r, trace, screens, last, view: last ? last.view : null, text: last ? last.text || '' : '', data, urls, answers, handlerError };
}

const memberChecks = (res) => res.trace.filter((t) => t.m === 'getChatMember');
const sentTo = (res, chat) => res.trace.filter((t) => (t.m === 'sendMessage' || t.m === 'editMessageText') && Number(t.chat) === chat);

// ---------- scenario bookkeeping ----------

const results = [];

class Fail extends Error {}
function expect(cond, message) {
  if (!cond) throw new Fail(message);
}

function brief(res) {
  if (!res) return '';
  const parts = [];
  if (res.view) parts.push(`view=${res.view}`);
  if (res.answers.length) parts.push(`answer=${JSON.stringify(res.answers[0].text || '')}`);
  const sent = res.last;
  if (sent) parts.push(sent.ok ? 'sent' : `telegram: ${sent.err}`);
  if (res.ms != null) parts.push(`${res.ms}ms`);
  return parts.join(' | ');
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

/** A step that must be a normal screen with no handler error and exactly one answer for callbacks. */
function screenOk(res, view, { callback = false } = {}) {
  expect(!res.handlerError, `handler error or no trace:\n${res.out.slice(-1500)}`);
  if (callback) expect(res.answers.length === 1, `answerCallbackQuery called ${res.answers.length} times`);
  if (view) expect(res.view === view, `expected view "${view}", got "${res.view}" (${res.text.slice(0, 200)})`);
  return res;
}

// ---------- the scenarios ----------

async function main() {
  // Preconditions
  const start = devtools({ op: 'snapshot' });
  const originalChannels = start.channels;
  const originalJoin = (start.settings.find((s) => s.key === 'join') || {}).value ?? '1';
  devtools({ op: 'cleanup', users: TEST_USERS });
  devtools({ op: 'drop_fake_channels' });
  devtools({ op: 'set_join', value: '1' });
  console.log(`channels at start: ${originalChannels.map((c) => `@${c.username}`).join(', ') || '(none yet — first update seeds them)'}; join=${originalJoin}\n`);

  let joinWorks = true; // false when no channel can be checked (bot not admin anywhere)
  const botAdminIn = new Set();

  try {
    // ===== A. Forced join and access control (join ON) =====
    await scenario('A1 /start from a non-member user → join screen with a button per channel', () => {
      const r = screenOk(sendText(TU3, '/start'));
      const checks = memberChecks(r);
      const snap = devtools({ op: 'snapshot' });
      expect(snap.channels.length >= 1, 'channels table is empty (seed failed)');
      expect(checks.length === snap.channels.length, `getChatMember called ${checks.length}× for ${snap.channels.length} channels`);
      const lines = checks.map((c) => `${c.chat}: ${c.ok ? c.status : c.err}`).join('; ');
      if (r.view === 'join') {
        expect(r.data.includes('j'), 'no "✅ عضو شدم" button');
        expect(r.urls.length >= 1, 'no channel link buttons');
        return { detail: `getChatMember → ${lines}\nlinks: ${r.urls.join(' ')}` };
      }
      joinWorks = false;
      expect(r.view === 'menu', `unexpected view ${r.view}`);
      return { status: 'WARN', detail: `every channel check failed on the channel side, so they were all skipped and the user got in (owner warned):\n${lines}` };
    });

    await scenario('A2 "✅ عضو شدم" from the non-member → still locked, alert shown', () => {
      const r = screenOk(press(TU3, 'j'), joinWorks ? 'join' : 'menu', { callback: true });
      if (joinWorks) expect(r.answers[0].text && r.answers[0].text.includes('عضو نشده'), 'no alert text');
      return { detail: brief(r) };
    });

    await scenario('A3 a non-member cannot add a task (text) or open the list (button)', () => {
      const r1 = screenOk(sendText(TU3, 'خرید نان'));
      const r2 = screenOk(press(TU3, 'l:0:0'), null, { callback: true });
      const tasks = devtools({ op: 'tasks', user: TU3 });
      if (!joinWorks) return { status: 'WARN', detail: 'join cannot be enforced (see A1)' };
      expect(r1.view === 'join' && r2.view === 'join', `views ${r1.view}, ${r2.view}`);
      expect(tasks.length === 0, 'a task was saved for a non-member');
      return { detail: `${brief(r1)}\n${brief(r2)}` };
    });

    await scenario('A4 /start from the owner (5557901897) → no join check, menu with 👑 button', () => {
      const r = screenOk(sendText(OWNER, '/start'), 'menu');
      expect(memberChecks(r).length === 0, 'owner was checked for membership');
      expect(r.data.includes('a'), 'no admin button');
      return { detail: brief(r) };
    });

    await scenario('A5 /admin from a normal user → refused', () => {
      const r = screenOk(sendText(TU3, '/admin'));
      expect(r.view !== 'admin_panel' && !r.text.includes('پنل مدیریت'), 'admin panel shown to a normal user!');
      expect(['join', 'unknown_command', 'menu'].includes(r.view), `view ${r.view}`);
      return { detail: brief(r) };
    });

    await scenario('A6 owner-panel buttons pressed by a normal user → "⛔️ دسترسی ندارید", nothing changes', () => {
      const before = devtools({ op: 'snapshot' });
      for (const data of ['a', 'al', 'aa', 'at', `ary:${before.channels[0] ? before.channels[0].id : 1}`]) {
        const r = press(TU3, data);
        expect(!r.handlerError, `${data}: handler error`);
        expect(r.answers.length === 1 && (r.answers[0].text || '').includes('دسترسی ندارید'), `${data}: not refused`);
        expect(r.trace.length === 1, `${data}: made other API calls: ${r.trace.map((t) => t.m).join(',')}`);
      }
      const after = devtools({ op: 'snapshot' });
      expect(JSON.stringify(after.channels) === JSON.stringify(before.channels), 'channels changed');
      expect(JSON.stringify(after.settings.find((s) => s.key === 'join')) === JSON.stringify(before.settings.find((s) => s.key === 'join')), 'join setting changed');
    });

    await scenario('A7 /admin from the owner → panel', () => {
      const r = screenOk(sendText(OWNER, '/admin'), 'admin_panel');
      expect(r.text.includes('پنل مدیریت'), 'no panel title');
      expect(['al', 'aa', 'at'].every((d) => r.data.includes(d)), `buttons: ${r.data}`);
      return { detail: r.text.replace(/\n+/g, ' / ') };
    });

    await scenario('A8 owner: channel list with bot-admin status per channel', () => {
      const r = screenOk(press(OWNER, 'al'), 'admin_channels', { callback: true });
      const snap = devtools({ op: 'snapshot' });
      for (const c of memberChecks(r)) {
        if (c.ok && (c.status === 'administrator' || c.status === 'creator')) {
          const ch = snap.channels.find((x) => String(x.chat_id) === String(c.chat) || `@${x.username}` === String(c.chat));
          if (ch) botAdminIn.add(ch.uname);
        }
      }
      return { detail: `${r.text.split('\n').filter((l) => /^[۰-۹]/.test(l)).join(' / ')}` };
    });

    // ===== B. Owner turns forced join off, so fake test users can use the features =====
    await scenario('B1 owner: turn forced join OFF', () => {
      const r = screenOk(press(OWNER, 'at'), 'admin_panel', { callback: true });
      expect((r.answers[0].text || '').includes('خاموش'), `answer: ${r.answers[0].text}`);
      const join = devtools({ op: 'snapshot' }).settings.find((s) => s.key === 'join');
      expect(join && join.value === '0', 'join setting is not 0');
    });

    // ===== C. The 10 to-do features =====
    const ids = {};
    const tasksOf = (u) => devtools({ op: 'tasks', user: u });
    const byText = (u, text) => tasksOf(u).find((t) => t.text === text);

    await scenario('C1 /start (feature user) → welcome + main menu', () => {
      const r = screenOk(sendText(TU1, '/start'), 'menu');
      expect(['add', 'l:0:0', 'cats', 's', 'st', 'h'].every((d) => r.data.includes(d)), `menu buttons: ${r.data}`);
      expect(!r.data.includes('a'), 'admin button shown to a normal user');
    });

    await scenario('C2 [1. add] plain text → task saved', () => {
      const r = screenOk(sendText(TU1, 'خرید نان'), 'task');
      expect(r.text.includes('کار جدید اضافه شد'), r.text);
      const t = byText(TU1, 'خرید نان');
      expect(t && t.done === 0 && t.priority === 2, JSON.stringify(t));
      ids.bread = t.id;
      return { detail: `task id ${t.id}` };
    });

    await scenario('C3 [1. add] /add text (Arabic ي normalized to ی)', () => {
      screenOk(sendText(TU1, '/add تماس با علي'), 'task');
      const t = byText(TU1, 'تماس با علی');
      expect(t, 'task not saved/normalized');
      ids.call = t.id;
    });

    await scenario('C4 [1. add] /add alone asks for text, then the text is added', () => {
      const r = screenOk(sendText(TU1, '/add'), 'add_prompt');
      expect((devtools({ op: 'state', user: TU1 }) || {}).state === 'add', 'state not stored in user_state');
      screenOk(sendText(TU1, 'پرداخت قبض'), 'task');
      ids.bill = byText(TU1, 'پرداخت قبض').id;
      expect(!devtools({ op: 'state', user: TU1 }), 'state not cleared');
      return { detail: brief(r) };
    });

    await scenario('C5 [1. add] text over 500 characters → refused', () => {
      const r = screenOk(sendText(TU1, 'ا'.repeat(501)), 'add_too_long');
      expect(tasksOf(TU1).length === 3, 'a long task was saved');
      return { detail: r.text };
    });

    await scenario('C6 add 7 more tasks (10 total) for paging', () => {
      for (let i = 1; i <= 7; i += 1) screenOk(sendText(TU1, `کار شماره ${i}`), 'task');
      expect(tasksOf(TU1).length === 10, `have ${tasksOf(TU1).length}`);
    });

    await scenario('C7 [2. list] /list → page 1 of 2 with 8 tasks and a next button', () => {
      const r = screenOk(sendText(TU1, '/list'), 'list');
      expect(r.data.filter((d) => d.startsWith('v:')).length === 8, 'not 8 tasks on page 1');
      expect(r.data.includes('l:1:0'), 'no next button');
      expect(r.text.includes('صفحه ۱ از ۲'), r.text);
      return { detail: r.text.split('\n').slice(0, 4).join(' / ') };
    });

    await scenario('C8 [2. list] next page → 2 tasks and a previous button', () => {
      const r = screenOk(press(TU1, 'l:1:0'), 'list', { callback: true });
      expect(r.data.filter((d) => d.startsWith('v:')).length === 2, 'not 2 tasks on page 2');
      expect(r.data.includes('l:0:0'), 'no previous button');
    });

    await scenario('C9 [3. toggle] done from the list, undone from the task card', () => {
      let r = screenOk(press(TU1, `tl:${ids.bread}:l0.0`), 'list', { callback: true });
      expect((r.answers[0].text || '').includes('انجام شد'), r.answers[0].text);
      expect(byText(TU1, 'خرید نان').done === 1, 'not done');
      r = screenOk(press(TU1, `tv:${ids.bread}:l0.0`), 'task', { callback: true });
      expect(byText(TU1, 'خرید نان').done === 0, 'not undone');
    });

    await scenario('C10 [4. edit] edit text via prompt', () => {
      screenOk(press(TU1, `e:${ids.bill}:l0.0`), 'edit_prompt', { callback: true });
      expect((devtools({ op: 'state', user: TU1 }) || {}).state === 'edit', 'edit state not stored');
      const r = screenOk(sendText(TU1, 'پرداخت قبض برق'), 'task');
      expect(r.text.includes('ویرایش شد'), r.text);
      expect(tasksOf(TU1).find((t) => t.id === ids.bill).text === 'پرداخت قبض برق', 'text not updated');
    });

    await scenario('C11 [6. priority] set high/low; the list sorts by priority', () => {
      screenOk(press(TU1, `ps:${ids.call}:1:l0.0`), 'task', { callback: true });
      screenOk(press(TU1, `ps:${ids.bread}:3:l0.0`), 'task', { callback: true });
      const t = tasksOf(TU1);
      expect(t.find((x) => x.id === ids.call).priority === 1 && t.find((x) => x.id === ids.bread).priority === 3, 'priorities not saved');
      const r = screenOk(sendText(TU1, '/list'), 'list');
      const first = r.text.split('\n').find((l) => l.startsWith('۱.'));
      expect(first && first.includes('🔴') && first.includes('تماس با علی'), `first line: ${first}`);
      return { detail: `first line: ${first}` };
    });

    await scenario('C12 [7. due date] Jalali 1405/08/01 (past → ⏰), Gregorian 2026-11-01, invalid refused', () => {
      screenOk(press(TU1, `u:${ids.bread}:l0.0`), 'due_prompt', { callback: true });
      let r = screenOk(sendText(TU1, '1405/08/01'), 'task');
      expect(r.text.includes('۱۴۰۵/۰۸/۰۱') && r.text.includes('⏰'), r.text);
      expect(tasksOf(TU1).find((t) => t.id === ids.bread).due_date === '2026-10-23', 'wrong stored date');
      screenOk(press(TU1, `u:${ids.bill}:l0.0`), 'due_prompt', { callback: true });
      r = screenOk(sendText(TU1, '2026-11-01'), 'task');
      expect(r.text.includes('۱۴۰۵/۰۸/۱۰'), r.text);
      screenOk(press(TU1, `u:${ids.call}:l0.0`), 'due_prompt', { callback: true });
      r = screenOk(sendText(TU1, '1405/13/40'), 'due_invalid');
      expect(tasksOf(TU1).find((t) => t.id === ids.call).due_date === null, 'invalid date saved');
      screenOk(press(TU1, `v:${ids.call}:l0.0`), 'task', { callback: true }); // cancel
    });

    await scenario('C13 [7. due date] overdue task shows ⏰ when the list is opened', () => {
      const r1 = screenOk(sendText(TU1, '/list'), 'list');
      const r2 = screenOk(press(TU1, 'l:1:0'), 'list', { callback: true });
      const all = `${r1.text}\n${r2.text}`;
      const line = all.split('\n').find((l) => l.includes('خرید نان'));
      expect(line && line.includes('⏰'), `line: ${line}`);
      const billLine = all.split('\n').find((l) => l.includes('پرداخت قبض برق'));
      expect(billLine && !billLine.includes('⏰'), `future date marked overdue: ${billLine}`);
      return { detail: `${line} | ${billLine}` };
    });

    await scenario('C14 [8. category] create a category, assign a task, filter the list', () => {
      screenOk(press(TU1, 'cn'), 'category_prompt', { callback: true });
      let r = screenOk(sendText(TU1, 'خانه'), 'categories');
      expect(r.text.includes('ساخته شد'), r.text);
      const home = devtools({ op: 'cats', user: TU1 }).find((c) => c.name === 'خانه');
      expect(home, 'category not saved');
      ids.home = home.id;
      r = screenOk(press(TU1, `c:${ids.bread}:l0.0`), 'choose_category', { callback: true });
      expect(r.data.includes(`cs:${ids.bread}:${home.id}:l0.0`), `buttons ${r.data}`);
      r = screenOk(press(TU1, `cs:${ids.bread}:${home.id}:l0.0`), 'task', { callback: true });
      expect(r.text.includes('دسته: 🗂 خانه'), r.text);
      r = screenOk(press(TU1, `l:0:${home.id}`), 'list', { callback: true });
      expect(r.data.filter((d) => d.startsWith('v:')).length === 1 && r.text.includes('خرید نان'), r.text);
      return { detail: r.text.split('\n').slice(0, 4).join(' / ') };
    });

    await scenario('C15 [9. search] /search and the search button', () => {
      let r = screenOk(sendText(TU1, '/search نان'), 'search_results');
      expect(r.text.includes('۱ مورد') && r.text.includes('خرید نان'), r.text);
      screenOk(press(TU1, 's'), 'search_prompt', { callback: true });
      r = screenOk(sendText(TU1, 'کار شماره'), 'search_results');
      expect(r.text.includes('۷ مورد'), r.text);
      return { detail: r.text.split('\n').slice(0, 2).join(' / ') };
    });

    await scenario('C16 [10. stats] total / done / open / overdue', () => {
      const a = byText(TU1, 'کار شماره 1').id;
      const b = byText(TU1, 'کار شماره 2').id;
      screenOk(press(TU1, `tl:${a}:l0.0`), 'list', { callback: true });
      screenOk(press(TU1, `tl:${b}:l0.0`), 'list', { callback: true });
      const r = screenOk(sendText(TU1, '/stats'), 'stats');
      for (const s of ['کل کارها: ۱۰', 'انجام‌شده: ۲', 'باز: ۸', 'عقب‌افتاده: ۱']) expect(r.text.includes(s), `missing "${s}" in ${r.text}`);
      return { detail: r.text.replace(/\n+/g, ' / ') };
    });

    await scenario('C17 [10. clear completed] asks first, then deletes only completed tasks', () => {
      let r = screenOk(press(TU1, 'cc'), 'clear_confirm', { callback: true });
      expect(tasksOf(TU1).length === 10, 'deleted before confirming');
      r = screenOk(press(TU1, 'ccy'), 'stats', { callback: true });
      const t = tasksOf(TU1);
      expect(t.length === 8 && t.every((x) => x.done === 0), `left: ${t.length}`);
      return { detail: `answer: ${r.answers[0].text}` };
    });

    await scenario('C18 [5. delete] asks for confirmation, then deletes', () => {
      let r = screenOk(press(TU1, `d:${ids.call}:l0.0`), 'delete_confirm', { callback: true });
      expect(r.data.includes(`dy:${ids.call}:l0.0`), r.data.join(','));
      expect(tasksOf(TU1).some((t) => t.id === ids.call), 'deleted before confirming');
      r = screenOk(press(TU1, `dy:${ids.call}:l0.0`), 'list', { callback: true });
      expect(!tasksOf(TU1).some((t) => t.id === ids.call), 'not deleted');
      expect(r.text.includes('کار حذف شد'), r.text);
    });

    await scenario('C19 another user\'s task/category ids are blocked', () => {
      screenOk(sendText(TU2, '/start'), 'menu');
      const before = JSON.stringify(tasksOf(TU1));
      const blocked = [];
      for (const data of [`v:${ids.bread}:l0.0`, `tl:${ids.bread}:l0.0`, `tv:${ids.bread}:l0.0`, `e:${ids.bread}:l0.0`,
        `ps:${ids.bread}:1:l0.0`, `ud:${ids.bread}:x:l0.0`, `cs:${ids.bread}:0:l0.0`, `dy:${ids.bread}:l0.0`, `cdy:${ids.home}`]) {
        const r = screenOk(press(TU2, data), null, { callback: true });
        expect((r.answers[0].text || '').includes('پیدا نشد'), `${data}: answer "${r.answers[0].text}"`);
        expect(!r.text.includes('خرید نان'), `${data}: revealed the other user's task`);
        blocked.push(data.split(':')[0]);
      }
      expect(JSON.stringify(tasksOf(TU1)) === before, 'the other user\'s tasks changed');
      expect(devtools({ op: 'cats', user: TU1 }).some((c) => c.id === ids.home), 'the other user\'s category was deleted');
      expect(!devtools({ op: 'state', user: TU2 }), 'a state was set from a foreign id');
      return { detail: `blocked: ${blocked.join(', ')}` };
    });

    // ===== D. Owner: channel management =====
    await scenario('D1 owner: add channel — invalid input and duplicate are refused', () => {
      screenOk(press(OWNER, 'aa'), 'admin_add_prompt', { callback: true });
      let r = screenOk(sendText(OWNER, 'سلام'), 'admin_add_invalid');
      r = screenOk(sendText(OWNER, 'https://t.me/+AbCdEfGh'), 'admin_add_invalid');
      expect(r.text.includes('خصوصی'), r.text);
      r = screenOk(sendText(OWNER, '@wangerBots'), 'admin_channels');
      expect(r.text.includes('از قبل'), r.text);
    });

    await scenario('D2 owner: remove a channel and add it back', () => {
      const snap = devtools({ op: 'snapshot' });
      const target = snap.channels.find((c) => botAdminIn.has(c.uname)) || snap.channels[0];
      expect(target, 'no channel to remove');
      let r = screenOk(press(OWNER, `ar:${target.id}`), 'admin_remove_confirm', { callback: true });
      r = screenOk(press(OWNER, `ary:${target.id}`), 'admin_channels', { callback: true });
      expect(!devtools({ op: 'snapshot' }).channels.some((c) => c.uname === target.uname), 'not removed');
      screenOk(press(OWNER, 'aa'), 'admin_add_prompt', { callback: true });
      r = screenOk(sendText(OWNER, `https://t.me/${target.username}`));
      const readded = devtools({ op: 'snapshot' }).channels.some((c) => c.uname === target.uname);
      if (r.view === 'admin_channels' && readded) {
        const gc = r.trace.find((t) => t.m === 'getChat');
        return { detail: `@${target.username} removed and re-added (getChat ok=${gc && gc.ok}, bot admin verified)` };
      }
      // The bot isn't admin there (or the channel can't be resolved): re-adding is correctly refused.
      expect(['admin_add_not_admin', 'admin_add_not_found'].includes(r.view), `unexpected view ${r.view}: ${r.text}`);
      devtools({ op: 'restore_channel', channel: target });
      press(OWNER, 'a'); // leave the add prompt
      return { status: 'WARN', detail: `@${target.username}: removed OK, re-add refused by validation (${r.view}) — bot must be admin there. Row restored.` };
    });

    await scenario('D3 owner: the 11th channel is refused', () => {
      const added = devtools({ op: 'fill_channels', to: 10 });
      expect(devtools({ op: 'snapshot' }).channels.length === 10, 'could not fill to 10');
      let r = screenOk(press(OWNER, 'aa'), 'admin_channel_limit', { callback: true });
      expect((r.answers[0].text || '').includes('سقف'), r.answers[0].text);
      expect(!devtools({ op: 'state', user: OWNER }), 'owner left waiting for a channel');
      devtools({ op: 'set_owner_state', state: 'admin_add' }); // as if the prompt was opened before the list filled up
      r = screenOk(sendText(OWNER, '@telegram'), 'admin_channel_limit');
      expect(devtools({ op: 'snapshot' }).channels.length === 10, 'an 11th channel was saved');
      devtools({ op: 'drop_fake_channels' });
      return { detail: `filled with ${added.length} fake rows; button and typed input both refused` };
    });

    // ===== E. Forced join back on =====
    await scenario('E1 owner: turn forced join back ON; the non-member is locked again', () => {
      const r = screenOk(press(OWNER, 'at'), 'admin_panel', { callback: true });
      expect((r.answers[0].text || '').includes('روشن'), r.answers[0].text);
      const r2 = screenOk(sendText(TU3, '/list'));
      if (!joinWorks) return { status: 'WARN', detail: 'join cannot be enforced (see A1)' };
      expect(r2.view === 'join', `view ${r2.view}`);
    });

    await scenario('E2 robustness: unknown command, non-private chat, sticker', () => {
      devtools({ op: 'set_join', value: '0' });
      let r = screenOk(sendText(TU1, '/foo'), 'unknown_command');
      const n = seq++;
      const groupMsg = { message_id: 100000 + n, from: person(TU1), chat: { id: -1001234567890, title: 'g', type: 'supergroup' }, date: nowSec(), text: 'سلام' };
      const g = tgcloudRun('handlers/message', groupMsg, { update: { update_id: 700000000 + n, message: groupMsg } });
      expect(g.exitOk && g.value && g.value.ignored === true, 'group message not ignored');
      const sticker = { message_id: 100000 + seq, from: person(TU1), chat: privateChat(TU1), date: nowSec(), sticker: { file_id: 'x', file_unique_id: 'y', type: 'regular', width: 512, height: 512, is_animated: false, is_video: false } };
      r = analyse(tgcloudRun('handlers/message', sticker, { update: { update_id: 700000000 + seq++, message: sticker } }));
      screenOk(r, 'text_only');
      devtools({ op: 'set_join', value: '1' });
    });
  } finally {
    // ===== restore the starting state =====
    try {
      devtools({ op: 'drop_fake_channels' });
      const now = devtools({ op: 'snapshot' });
      for (const ch of originalChannels) {
        if (!now.channels.some((c) => c.uname === ch.uname)) devtools({ op: 'restore_channel', channel: ch });
      }
      devtools({ op: 'set_join', value: originalJoin });
      devtools({ op: 'cleanup', users: TEST_USERS });
      const end = devtools({ op: 'snapshot' });
      console.log(`\nrestored: channels ${end.channels.map((c) => `@${c.username}`).join(', ')}; join=${(end.settings.find((s) => s.key === 'join') || {}).value}`);
    } catch (err) {
      console.log(`\n!! restore failed: ${err.message}`);
    }
  }
}

// ---------- run ----------

if (!fs.existsSync(CLI)) {
  console.error('Run `npm install` first.');
  process.exit(2);
}
fs.mkdirSync(DEVTOOLS_DIR, { recursive: true });
fs.copyFileSync(DEVTOOLS_SRC, DEVTOOLS_DST);
let failed = 0;
try {
  await main();
} catch (err) {
  console.error(`aborted: ${err.message}`);
  failed += 1;
} finally {
  fs.rmSync(DEVTOOLS_DST, { force: true });
  if (fs.existsSync(DEVTOOLS_DIR) && fs.readdirSync(DEVTOOLS_DIR).length === 0) fs.rmdirSync(DEVTOOLS_DIR);
}

failed += results.filter((r) => r.status === 'FAIL').length;
const md = ['| # | Scenario | Result | Detail |', '|---|---|---|---|',
  ...results.map((r, i) => `| ${i + 1} | ${r.name.replace(/\|/g, '\\|')} | ${r.status} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`)];
fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), `${md.join('\n')}\n`);
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('PASS')} passed, ${count('WARN')} warnings, ${count('FAIL')} failed — ${runs} platform runs. Log: test/cloud/output/run.log`);
process.exit(failed ? 1 : 0);
