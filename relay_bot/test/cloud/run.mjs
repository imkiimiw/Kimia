// Runs the bot's code on Telegram Serverless itself, with `npx tgcloud run`: the local modules (nothing
// is deployed) against the bot's real database and the real Bot API.
// Run: npm run test:cloud   (needs a linked project: .tgcloud/ here, plus `npx tgcloud login` or TGCLOUD_TOKEN)
//
// The test sender is a made-up user (990000001) whose "messages" are the bot's own messages in the
// owner's chat, so forwardMessage / copyMessage have real messages to work on. The owner sees a few
// test messages appear; at the end they are deleted, with the test user's rows, and the temporary
// devtools endpoint is removed. What needs a second real account (the user receiving an answer or
// "seen") is covered by `npm test`; here those calls are checked to fail the expected way
// (400 chat not found), and "seen" is also sent once to the owner to check the real call.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEVTOOLS_SRC = path.join(ROOT, 'test/cloud/devtools.js');
const DEVTOOLS_DST = path.join(ROOT, 'tgcloud/endpoints/zz_devtools.js');
const CLI = path.join(ROOT, 'node_modules/@tgcloud/cli/bin/tgcloud.js');
const OWNER = Number(/OWNER_ID = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'tgcloud/lib/config.js'), 'utf8'))[1]);
const TEST = { id: 990000001, is_bot: false, first_name: '🧪 کاربر آزمایشی' };
const BOT = { id: 1, is_bot: true, first_name: 'bot' }; // only is_bot matters to the code

if (!fs.existsSync(path.join(ROOT, '.tgcloud'))) {
  console.error(`✘ ${ROOT}/.tgcloud is missing: run "mkdir -p .tgcloud && npx tgcloud login" here first (or set TGCLOUD_TOKEN and create the folder).`);
  process.exit(2);
}
if (fs.existsSync(DEVTOOLS_DST)) {
  console.error(`✘ ${path.relative(ROOT, DEVTOOLS_DST)} exists — another run in progress, or a crashed one. Delete it (never push it) and retry.`);
  process.exit(2);
}

// ---------- tgcloud run ----------

const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TGCLOUD_NO_PAGER: '1', NODE_NO_WARNINGS: '1' };
if (process.env.HTTPS_PROXY || process.env.https_proxy) env.NODE_USE_ENV_PROXY = '1'; // Node ignores the proxy otherwise
const RATE_LIMITED = /Too many requests: retry after (\d+)/;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let runs = 0;

/** Runs a module on the platform; returns its return value (parsed from the "< …" line). */
function run(module, args, ctx) {
  const argv = [CLI, 'run', module, JSON.stringify(args), ...(ctx ? ['--ctx', JSON.stringify(ctx)] : [])];
  for (let attempt = 0; ; attempt += 1) {
    runs += 1;
    let out;
    try {
      out = execFileSync(process.execPath, argv, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      const limited = RATE_LIMITED.exec(out);
      if (limited && attempt < 10) {
        pause((Math.min(Number(limited[1]), 60) + 1) * 1000); // a refused call never ran: retry it
        continue;
      }
      throw new Error(`tgcloud run ${module} failed:\n${out.trim()}`);
    }
    const line = out.split('\n').reverse().find((l) => l.startsWith('< '));
    if (!line) throw new Error(`tgcloud run ${module}: no result in\n${out.trim()}`);
    const m = line.slice(2).match(/^(.*?)\s+\d+ms\s*$/);
    return JSON5.parse(m ? m[1] : line.slice(2));
  }
}

const sent = new Set(); // ids of the bot's messages in the owner's chat, deleted at the end

/** Runs a handler; every message it put in the owner's chat is remembered for the cleanup. */
function handler(name, payload) {
  const r = run(`handlers/${name}`, payload);
  if (!r || !Array.isArray(r.trace)) throw new Error(`handlers/${name} returned no trace: ${JSON.stringify(r)}`);
  for (const t of r.trace) if (t.mid && Number(t.chat) === OWNER) sent.add(t.mid);
  return r;
}

const devtools = (input) => run('endpoints/zz_devtools', input, { initData: { user: { id: OWNER } } });

const ownerChat = { id: OWNER, type: 'private' };
let seq = 0;
const ownerMessage = (text, extra = {}) => ({ message_id: 1, from: { id: OWNER, is_bot: false, first_name: 'Owner' }, chat: ownerChat, date: 0, text, ...extra });
const botMessage = (id, extra = {}) => ({ message_id: id, from: BOT, chat: ownerChat, date: 0, ...extra });
const cardMarkup = (uid, mid, { seen = false, blocked = false } = {}) => ({
  inline_keyboard: [
    [{ text: seen ? 'seen' : 'seen?', callback_data: `${seen ? 'sd' : 's'}:${uid}:${mid}` }, { text: 'reply', callback_data: `r:${uid}:${mid}` }],
    [{ text: blocked ? 'unblock' : 'block', callback_data: `${blocked ? 'ub' : 'b'}:${uid}:${mid}` }],
  ],
});
const press = (data, message) => handler('callback_query', { id: `test-${Date.now()}-${seq += 1}`, from: { id: OWNER, is_bot: false, first_name: 'Owner' }, chat_instance: '1', data, message });

// ---------- checks ----------

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`✘ ${name}\n   ${String(err.message || err).split('\n').join('\n   ')}`);
  }
}
function expect(cond, msg, detail) {
  if (!cond) throw new Error(`${msg}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 1)}`}`);
}
const calls = (r) => r.trace.map((t) => `${t.m}${t.view ? `(${t.view})` : ''}→${t.chat ?? ''}:${t.ok ? 'ok' : t.err}`);

// ---------- scenarios ----------

const madeDir = !fs.existsSync(path.dirname(DEVTOOLS_DST));
fs.mkdirSync(path.dirname(DEVTOOLS_DST), { recursive: true });
fs.copyFileSync(DEVTOOLS_SRC, DEVTOOLS_DST);
let help;
let card;
try {
  check('owner /start: help, database ready (tables exist)', () => {
    const r = handler('message', ownerMessage('/start'));
    expect(r.trace.length === 1 && r.trace[0].ok, 'help not sent', calls(r));
    expect(/دیتابیس: ✅ آماده/.test(r.trace[0].text), 'database not ready', r.trace[0].text);
    help = r.trace[0].mid;
  });

  check('a user message → card + forward + copy in the owner\'s chat, "✅" to the sender', () => {
    const r = handler('message', { message_id: help, from: TEST, chat: ownerChat, date: 0, text: 'پیام آزمایشی' });
    expect(!r.dbError && !r.error, 'error', r);
    expect(JSON.stringify(r.trace.map((t) => `${t.m}:${t.view}:${t.ok}`)) === JSON.stringify(['sendMessage:card:true', 'forwardMessage:forward:true', 'copyMessage:copy:true', 'sendMessage:sent:true']), 'unexpected calls', calls(r));
    expect(r.trace[0].text.includes(`<a href="tg://user?id=${TEST.id}">`), 'card has no mention', r.trace[0].text);
    card = r.trace[0].mid;
    const rows = devtools({ action: 'rows', userId: TEST.id });
    expect(rows.user && rows.user.first_name === TEST.first_name && rows.user.blocked === 0, 'user row', rows);
    expect(rows.links.length === 3, 'card, forward and copy are linked', rows);
  });

  check('👁 seen for a user Telegram can\'t reach: the owner is told, the card stays unseen', () => {
    const r = press(`s:${TEST.id}:${help}`, botMessage(card, { reply_markup: cardMarkup(TEST.id, help) }));
    const seen = r.trace.find((t) => t.view === 'seen');
    expect(seen && !seen.ok && /^400 /.test(seen.err), 'seen should fail with 400 (no such chat)', calls(r));
    expect(!r.trace.some((t) => t.m === 'editMessageReplyMarkup'), 'card must not change', calls(r));
    const link = devtools({ action: 'rows', userId: TEST.id }).links.find((l) => l.owner_msg_id === card);
    expect(link && link.seen === 0, 'seen reset', link);
  });

  check('👁 seen for a reachable user (the owner stands in): "👁 پیامت دیده شد" sent as a reply, card redrawn', () => {
    const r = press(`s:${OWNER}:${help}`, botMessage(card, { reply_markup: cardMarkup(TEST.id, help) }));
    const seen = r.trace.find((t) => t.view === 'seen');
    expect(seen && seen.ok && seen.text === '👁 پیامت دیده شد.', 'seen not sent', calls(r));
    const edit = r.trace.find((t) => t.m === 'editMessageReplyMarkup');
    expect(edit && edit.ok, 'card not redrawn', calls(r));
    sent.add(seen.mid);
  });

  check('⛔️ block: database + card; the sender\'s next message stops at "⛔️"; ✅ unblock', () => {
    const b = press(`b:${TEST.id}:${help}`, botMessage(card, { reply_markup: cardMarkup(TEST.id, help, { seen: true }) }));
    expect(b.trace.some((t) => t.m === 'editMessageReplyMarkup' && t.ok && JSON.stringify(t.kb).includes(`ub:${TEST.id}`)), 'card not flipped', calls(b));
    expect(devtools({ action: 'rows', userId: TEST.id }).user.blocked === 1, 'not blocked in db');
    const m = handler('message', { message_id: help, from: TEST, chat: ownerChat, date: 0, text: 'باز هم من' });
    expect(JSON.stringify(m.trace.map((t) => `${t.m}:${t.view}:${t.ok}`)) === JSON.stringify(['sendMessage:blocked:true']), 'blocked sender got through', calls(m));
    const u = press(`ub:${TEST.id}:${help}`, botMessage(card, { reply_markup: cardMarkup(TEST.id, help, { seen: true, blocked: true }) }));
    expect(u.trace.some((t) => t.m === 'editMessageReplyMarkup' && t.ok && JSON.stringify(t.kb).includes(`b:${TEST.id}`)), 'card not flipped back', calls(u));
    expect(devtools({ action: 'rows', userId: TEST.id }).user.blocked === 0, 'not unblocked in db');
  });

  check('✉️ write: a force-reply prompt, linked; the owner\'s reply to it is routed to the sender', () => {
    const p = press(`r:${TEST.id}:${help}`, botMessage(card, { reply_markup: cardMarkup(TEST.id, help, { seen: true }) }));
    const prompt = p.trace.find((t) => t.view === 'prompt');
    expect(prompt && prompt.ok && prompt.kb === 'force_reply', 'prompt not sent', calls(p));
    expect(devtools({ action: 'rows', userId: TEST.id }).links.some((l) => l.owner_msg_id === prompt.mid), 'prompt not linked');
    const a = handler('message', ownerMessage('جواب آزمایشی', { message_id: help, reply_to_message: botMessage(prompt.mid, { text: '✍️' }) }));
    const ans = a.trace.find((t) => t.view === 'answer');
    expect(ans && Number(ans.chat) === TEST.id && /^400 /.test(ans.err), 'answer should be routed to the test user (and fail: no such chat)', calls(a));
    expect(a.trace.some((t) => t.view === 'answer_failed' && t.ok), 'owner not told', calls(a));
  });

  check('Reply on the card is routed to the sender; a message that is not a reply gets the hint', () => {
    const a = handler('message', ownerMessage('جواب', { message_id: help, reply_to_message: botMessage(card, { text: '📩', reply_markup: cardMarkup(TEST.id, help) }) }));
    expect(a.trace.some((t) => t.view === 'answer' && Number(t.chat) === TEST.id), 'not routed', calls(a));
    const h = handler('message', ownerMessage('سلام'));
    expect(h.trace.length === 1 && h.trace[0].view === 'hint' && h.trace[0].ok, 'no hint', calls(h));
  });
} finally {
  let cleanup = null;
  try {
    cleanup = devtools({ action: 'cleanup', userId: TEST.id, messageIds: [...sent] });
  } catch (err) {
    console.log(`✘ cleanup failed: ${err.message}`);
  }
  fs.rmSync(DEVTOOLS_DST, { force: true });
  if (madeDir) fs.rmSync(path.dirname(DEVTOOLS_DST), { recursive: true, force: true });
  if (cleanup) console.log(`cleanup: ${cleanup.messages} test messages deleted (${cleanup.deleted}), ${cleanup.links} links + ${cleanup.users} user row removed`);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} cloud checks passed; ${runs} tgcloud runs`);
process.exit(failed ? 1 : 0);
