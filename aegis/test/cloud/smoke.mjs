#!/usr/bin/env node
// Smoke test on Telegram Serverless itself (after `npm run deploy`): runs the local handlers on the
// platform with `tgcloud run` — real database, real Bot API — using FAKE user ids 990000101-990000103
// (Telegram answers "chat not found" to anything sent to them), then reads the database back through
// a temporary endpoint (test/cloud/devtools.js → tgcloud/endpoints/zz_devtools.js, deleted in
// `finally`, never pushed) and deletes the fake users again.
//
// What it proves on the real platform: modules load in the isolate, the tables and indexes exist,
// the data migrations ran, command menus (5 languages) and the default admin rights are accepted by
// Telegram, the global switch is on, the forced-join check runs against the real default channels
// (and shows where Aegis is not an admin yet), block tracking works; Phase 3: the six new tables,
// the lists/settings/punishment SQL on the real database (fake chat -990000100, cleaned up), the
// moderation command and chat_member paths load and run in the isolate; Phase 4: the three lock
// tables, the locks SQL and the message scanner (Unicode regexes) in the isolate, edited messages.
//
//   cd aegis && npm run test:cloud      (needs Aegis_BOT_TGCLOUD_TOKEN)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEV_SRC = path.join(ROOT, 'test/cloud/devtools.js');
const DEV_DST = path.join(ROOT, 'tgcloud/endpoints/zz_devtools.js');
const A = 990000101;
const B = 990000102;

function tg(args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/tg.mjs'), 'run', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const line = out.split('\n').find((l) => l.startsWith('< '));
  if (!line) throw new Error(`no result from tgcloud run ${args[0]}:\n${out}`);
  return JSON5.parse(line.slice(2).replace(/\s+\d+ms\s*$/, ''));
}
const user = (id, lang) => ({ id, is_bot: false, first_name: `Smoke ${id % 1000}`, language_code: lang });
const message = (from, text) => ({ message_id: 1, from, chat: { id: from.id, type: 'private' }, date: 0, text });
const dev = (action) => tg(['endpoints/zz_devtools', JSON5.stringify({ action }), '--ctx', JSON5.stringify({ initData: { user: { id: A } } })]);

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

if (fs.existsSync(DEV_DST)) throw new Error('tgcloud/endpoints/zz_devtools.js already exists: a previous run did not clean up');
fs.copyFileSync(DEV_SRC, DEV_DST);
try {
  const before = dev('read');
  const tables = before.tables.map((t) => t.name);
  check('21 aegis_ tables exist', tables.length === 21, tables.join(', '));
  check('indexes exist', before.indexes.length >= 33, `${before.indexes.length} idx_aegis_*`);
  for (const t of ['aegis_locks', 'aegis_members', 'aegis_lock_hits']) check(`Phase 4 table ${t}`, tables.includes(t));
  const p4 = dev('p4');
  check('locks on the real platform: active lock read back, disguised link caught, mixed message not caught, hits and join times stored',
    p4.active.join() === 'link' && p4.hit.join() === 'link' && p4.mixed.length === 0 && p4.hits === 1 && p4.hitCount === 1 && p4.joined && p4.counts.text === 1,
    JSON.stringify(p4));
  for (const t of ['aegis_chat_settings', 'aegis_list_entries', 'aegis_list_history', 'aegis_punishments', 'aegis_admin_actions', 'aegis_incidents']) {
    check(`Phase 3 table ${t}`, tables.includes(t));
  }
  const p3 = dev('p3');
  check('lists on the real database: add, refresh, expiry, counts, search, history, remove',
    p3.added === 'added' && p3.again === 'updated' && p3.page === 1 && p3.expiredHidden && p3.search === 1 && p3.history.join() === 'edit,add' && p3.removed === true,
    JSON.stringify(p3));
  check('settings defaults, warnings, punishments and admin actions read back', p3.actions === 1 && p3.warnCount === 0 && p3.warned === 0 && p3.punishments === 0
    && p3.settings === '[{"n":3,"a":"mute","d":86400},{"n":5,"a":"ban","d":0}]');
  check('CSV bytes built in the isolate (no TextEncoder)', p3.csvBytes === 3 + 1 + 1 + 8 + 2, String(p3.csvBytes));

  const r1 = tg(['handlers/message', JSON5.stringify(message(user(A, 'fa'), '/start'))]);
  check('/start runs on the platform without errors', !r1.error, r1.error || '');
  check('first contact shows the language picker', r1.trace.some((e) => e.view === 'language'));
  const kv = Object.fromEntries(dev('read').kv.map((r) => [r.key, r.value]));
  check('data migrations applied', kv.data_version === '2', `data_version=${kv.data_version}`);
  check('command menus and default admin rights accepted by Telegram', kv.cmd_rev === '2', `cmd_rev=${kv.cmd_rev}`);
  check('the global switch is on (not shut down)', kv.shutdown === '0', `shutdown=${kv.shutdown}`);

  const cq = { id: 'smoke', from: user(A, 'fa'), chat_instance: 'x', data: 'lg:fa', message: { message_id: 1, chat: { id: A, type: 'private' }, date: 0, text: 'x' } };
  const r2 = tg(['handlers/callback_query', JSON5.stringify(cq)]);
  check('choosing a language runs without errors', !r2.error, r2.error || '');
  const checks = r2.trace.filter((e) => e.m === 'getChatMember');
  check('forced join checked against the real channels', checks.length >= 1, `${checks.length} getChatMember calls`);
  const after = dev('read');
  for (const ch of after.channels) {
    const admin = Number(ch.bot_admin) === 1;
    console.log(`   · @${ch.username || ch.chat_id}: ${admin ? 'bot is admin ✅' : `bot is NOT admin ⚠️ (${ch.last_error || 'not checked yet'})`}`);
  }
  const ua = after.users.find((u) => Number(u.user_id) === A);
  check('the user row: started, language saved', ua && Number(ua.started) === 1 && ua.lang === 'fa' && Number(ua.lang_set) === 1, JSON.stringify(ua));

  tg(['handlers/message', JSON5.stringify(message(user(B, 'en'), '/start'))]);
  const blk = { chat: { id: B, type: 'private' }, from: user(B, 'en'), date: 0, old_chat_member: { status: 'member', user: { id: 1, is_bot: true } }, new_chat_member: { status: 'kicked', user: { id: 1, is_bot: true } } };
  const r3 = tg(['handlers/my_chat_member', JSON5.stringify(blk)]);
  const G = { id: -990000101, type: 'supergroup', title: 'Smoke group' };
  const gm = { message_id: 2, from: user(A, 'fa'), chat: G, date: 0, text: '/ban 1d smoke', reply_to_message: { message_id: 1, from: user(B, 'en'), chat: G, date: 0 } };
  const r4 = tg(['handlers/message', JSON5.stringify(gm)]);
  check('a moderation command in an unknown group is handled quietly', !r4.error && !r4.trace.some((e) => e.m === 'banChatMember'), JSON.stringify(r4.trace));
  const cm = { chat: G, from: user(A, 'fa'), date: 0, old_chat_member: { status: 'member', user: user(B, 'en') }, new_chat_member: { status: 'kicked', user: user(B, 'en'), until_date: 0 } };
  const r5 = tg(['handlers/chat_member', JSON5.stringify(cm)]);
  check('a ban seen in an unknown group is ignored without errors', !r5.error, r5.error || '');
  const r6 = tg(['handlers/edited_message', JSON5.stringify({ ...gm, edit_date: 1, text: 'edited smoke' })]);
  check('an edited message (new handler) runs without errors', !r6.error, r6.error || '');
  check('blocking the bot is recorded', !r3.error && Number(dev('read').users.find((u) => Number(u.user_id) === B).blocked) === 1);
} finally {
  try {
    const c = dev('cleanup');
    console.log(`cleanup: removed ${c.users} fake users, ${c.states} states, ${c.errors} error rows`);
  } finally {
    fs.rmSync(DEV_DST, { force: true });
  }
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} cloud checks passed`);
if (passed !== results.length) process.exit(1);
