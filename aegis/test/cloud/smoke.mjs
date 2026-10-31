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
// tables, the locks SQL and the message scanner (Unicode regexes) in the isolate, edited messages;
// Phase 5: the eleven security/federation tables, their SQL and the signals in the isolate, join requests;
// Phase 6: the six new tables (message log, schedules, member flags, reports, topics, anonymous
// commands), their SQL, times of day and member commands in the isolate; Phase 7: the nine channel
// tables and their SQL, post content and UTF-8 decoding in the isolate, the channel_post handlers and
// the guard bot's Mini App endpoint (joinGuard); Phase 8: the thirteen social tables and their SQL
// (points, badges, contests, polls, questions, appeals, reviews), levels, the health score and the
// command words in the isolate, and the poll / poll_answer / message_reaction_count handlers;
// Phase 9: the six fun/media tables, the codecs in the isolate (CPU budget), the fun tables' rules,
// the media endpoint; the forced-join channels checked live (is Aegis an admin there?).
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
  check('66 aegis_ tables exist', tables.length === 66, tables.join(', '));
  check('indexes exist', before.indexes.length >= 109, `${before.indexes.length} idx_aegis_*`);
  for (const t of ['aegis_fun_use', 'aegis_fun_games', 'aegis_birthdays', 'aegis_fun_daily', 'aegis_media_jobs', 'aegis_sticker_packs']) check(`Phase 9 table ${t}`, tables.includes(t));
  const p9 = dev('p9');
  check('media codecs in the isolate within the CPU budget: a 1280×960 photo decoded and made a sticker, a QR code made and read, a PDF checked, zlib, GIF',
    p9.codecs.join() === '1280,960,true,https://t.me/aegis,danger,50000,GIF89a,true', JSON.stringify(p9.codecs));
  check('fun on the real database: cooldown and daily limit claimed once, one game of a kind, a game ended once, birthdays greeted once, the pick of the day kept',
    p9.fun.join() === 'ok,true,ok,daily,true,0,true,false,990000100,0,true,true', JSON.stringify(p9.fun));
  let me1;
  try {
    me1 = tg(['endpoints/media', JSON5.stringify({ action: 'get', job: 1 }), '--ctx', JSON5.stringify({ initData: { user: { id: A, first_name: 'Smoke' } } })]);
  } catch (e) {
    me1 = { error: String(e.message) };
  }
  check('the media Mini App endpoint refuses a job that isn\'t the caller\'s', /GONE|no longer available|error/i.test(JSON.stringify(me1)), JSON.stringify(me1).slice(0, 200));
  for (const t of ['aegis_member_stats', 'aegis_stats_day', 'aegis_stats_hour', 'aegis_badges', 'aegis_badge_defs', 'aegis_contests', 'aegis_contest_entries',
    'aegis_polls', 'aegis_poll_votes', 'aegis_questions', 'aegis_qa_blocks', 'aegis_appeals', 'aegis_reviews']) check(`Phase 8 table ${t}`, tables.includes(t));
  const p8 = dev('p8');
  check('social features on the real platform: points with a gap, thanks once a minute, badges once, a contest started/entered/finished once, votes replaced, a question settled once, appeals and reviews once',
    p8.points.join() === 'true,true,true,true,10,true' && p8.day.join() === '2,1,2' && p8.badges.join() === 'true,false,true,1'
    && p8.contest.join() === 'true,false,joined,already,true,false,ended' && p8.poll.join() === 'closed,1,1,[1]' && p8.question.join() === 'true,false,published,true'
    && p8.appeal.join() === 'true,0,true,false,true,false', JSON.stringify(p8));
  check('levels, thanks, the health score and command words (Persian) in the isolate', p8.pure.join() === '2,true,E,me,anon,', JSON.stringify(p8.pure));
  for (const t of ['aegis_join_requests', 'aegis_invite_links', 'aegis_channel_stats', 'aegis_posts', 'aegis_post_versions', 'aegis_post_queue', 'aegis_crises',
    'aegis_backup_jobs', 'aegis_dm_chats']) check(`Phase 7 table ${t}`, tables.includes(t));
  const p7 = dev('p7');
  check('channels on the real platform: requests decided once, joins/leaves per day, link counts, post versions, queue claimed once, one crisis at a time, backup file',
    p7.request.join() === 'true,false,approved' && p7.flow.join() === '2,1' && p7.members === 42 && p7.link.join() === '1,Smoke' && p7.post.join() === '2,1,two'
    && p7.queue.join() === 'true,true,false' && p7.crisis.join() === 'true,true,true' && p7.backup === 'backup', JSON.stringify(p7));
  check('post content, footers, UTF-8 decoding and scheduled times in the isolate', p7.pure.join() === 'b,x\n\nf,سلام,true', JSON.stringify(p7.pure));
  for (const t of ['aegis_msg_log', 'aegis_schedules', 'aegis_reports', 'aegis_member_flags', 'aegis_topics', 'aegis_anon_cmds']) check(`Phase 6 table ${t}`, tables.includes(t));
  const p6 = dev('p6');
  check('advanced settings on the real platform: message log and self-destruct, schedules claimed once, member flags, reports handled once, topics, anonymous commands',
    p6.since.join() === '11,12' && p6.dueHere === 1 && p6.claim.join() === 'true,false' && p6.flags.join() === 'true,2,true,true'
    && p6.report.join() === 'true,false,deleted' && p6.topic.join() === 'Smoke topic,1,1' && p6.anon.join() === 'true,false', JSON.stringify(p6));
  check('times of day and member commands (Persian) in the isolate', p6.times.join() === '180,930' && p6.next && p6.local === 270
    && p6.member.join() === 'rules,report,true', JSON.stringify([p6.times, p6.next, p6.local, p6.member]));
  for (const t of ['aegis_guards', 'aegis_flood', 'aegis_captchas', 'aegis_lockdowns', 'aegis_risk_events', 'aegis_media_seen', 'aegis_msg_hashes', 'aegis_feds',
    'aegis_fed_chats', 'aegis_fed_admins', 'aegis_fed_bans']) check(`Phase 5 table ${t}`, tables.includes(t));
  const p5 = dev('p5');
  check('security on the real platform: flood counters, punish once, media/ad memory, captcha and lockdown expiry, risk feedback, signals in the isolate',
    p5.modules === 8 && !p5.anyOn && p5.flood.join() === '1,2,2,2' && p5.claimed && !p5.again && p5.seen.join() === '0,1' && p5.ad === 0 && p5.captcha && p5.lockdown
    && p5.feedback && p5.signals.join() === 'spam.com,true,1,75' && p5.fedNone, JSON.stringify(p5));
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
  const rev = /COMMANDS_REV = '(\d+)'/.exec(fs.readFileSync(path.join(ROOT, 'tgcloud/lib/core/commands.js'), 'utf8'))[1];
  check('command menus and default admin rights accepted by Telegram', kv.cmd_rev === rev, `cmd_rev=${kv.cmd_rev}, expected ${rev}`);
  check('the global switch is on (not shut down)', kv.shutdown === '0', `shutdown=${kv.shutdown}`);

  const cq = { id: 'smoke', from: user(A, 'fa'), chat_instance: 'x', data: 'lg:fa', message: { message_id: 1, chat: { id: A, type: 'private' }, date: 0, text: 'x' } };
  const r2 = tg(['handlers/callback_query', JSON5.stringify(cq)]);
  check('choosing a language runs without errors', !r2.error, r2.error || '');
  const checks = r2.trace.filter((e) => e.m === 'getChatMember');
  check('forced join checked against the real channels', checks.length >= 1, `${checks.length} getChatMember calls`);
  const after = dev('read');
  for (const ch of dev('fj').channels) console.log(`   · ${ch.channel}: ${ch.admin ? 'bot is admin ✅' : `bot is NOT admin ⚠️ (${ch.error || 'unknown'})`} (checked live)`);
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
  const r7 = tg(['handlers/chat_join_request', JSON5.stringify({ chat: G, from: user(B, 'en'), user_chat_id: B, date: 0 })]);
  check('a join request (new handler) in an unknown group is ignored without errors', !r7.error && !r7.trace.some((e) => e.chat === G.id), JSON.stringify(r7.trace));
  const CHN = { id: -990000102, type: 'channel', title: 'Smoke channel' };
  const r8 = tg(['handlers/channel_post', JSON5.stringify({ message_id: 9, chat: CHN, date: 0, text: 'smoke post' })]);
  check('a post in an unknown channel (new handler) is ignored without errors', !r8.error && !r8.trace.some((e) => e.chat === CHN.id), JSON.stringify(r8.trace));
  const r9 = tg(['handlers/edited_channel_post', JSON5.stringify({ message_id: 9, chat: CHN, date: 0, edit_date: 1, text: 'smoke edit' })]);
  check('an edited channel post (new handler) runs without errors', !r9.error, r9.error || '');
  const r10 = tg(['handlers/poll', JSON5.stringify({ id: 'smoke-unknown', question: 'q', options: [{ text: 'a', voter_count: 1 }], total_voter_count: 1, is_closed: false })]);
  const r11 = tg(['handlers/poll_answer', JSON5.stringify({ poll_id: 'smoke-unknown', user: user(A, 'en'), option_ids: [0] })]);
  const r12 = tg(['handlers/message_reaction_count', JSON5.stringify({ chat: CHN, message_id: 9, date: 0, reactions: [{ type: { type: 'emoji', emoji: '👍' }, total_count: 3 }] })]);
  check('poll, poll answer and reaction count updates (new handlers) run without errors', !r10.error && !r11.error && !r12.error,
    JSON.stringify([r10.error, r11.error, r12.error, ...[r10, r11, r12].map((r) => (r.trace || []).map((e) => e.view || e.m))]));
  const g1 = tg(['endpoints/joinGuard', JSON5.stringify({ action: 'get' }), '--ctx',
    JSON5.stringify({ initData: { user: { id: A, first_name: 'Smoke' }, chat: { id: CHN.id, type: 'channel', title: 'Smoke channel' }, chat_join_request_query_id: 'smoke' } })]);
  check('the guard bot\'s Mini App endpoint answers (no such request: closed)', g1.done === true && /Smoke channel/.test(g1.title), JSON.stringify(g1));
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
