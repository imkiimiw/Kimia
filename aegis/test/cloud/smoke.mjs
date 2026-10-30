#!/usr/bin/env node
// Smoke test on Telegram Serverless itself (after `npm run deploy`): runs the local handlers on the
// platform with `tgcloud run` — real database, real Bot API — using FAKE user ids 990000101-990000103
// (Telegram answers "chat not found" to anything sent to them), then reads the database back through
// a temporary endpoint (test/cloud/devtools.js → tgcloud/endpoints/zz_devtools.js, deleted in
// `finally`, never pushed) and deletes the fake users again.
//
// What it proves on the real platform: modules load in the isolate, the tables and indexes exist,
// the data migration ran, command menus are accepted in all 5 languages, the forced-join check runs
// against the real default channels (and shows where Aegis is not an admin yet), block tracking works.
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
  check('9 aegis_ tables exist', tables.length === 9, tables.join(', '));
  check('indexes exist', before.indexes.length >= 10, `${before.indexes.length} idx_aegis_*`);

  const r1 = tg(['handlers/message', JSON5.stringify(message(user(A, 'fa'), '/start'))]);
  check('/start runs on the platform without errors', !r1.error, r1.error || '');
  check('first contact shows the language picker', r1.trace.some((e) => e.view === 'language'));
  const kv = Object.fromEntries(dev('read').kv.map((r) => [r.key, r.value]));
  check('data migration applied', kv.data_version === '1', `data_version=${kv.data_version}`);
  check('command menus accepted by Telegram in all languages', kv.cmd_rev === '1');

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
