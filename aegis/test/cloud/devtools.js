/*
 * Test-only endpoint for test/cloud/smoke.mjs. The script copies it to
 * tgcloud/endpoints/zz_devtools.js for the run (`tgcloud run` executes local files without
 * deploying them) and always deletes it afterwards, so it is never pushed. It reads bot-wide state
 * and reads/deletes ONLY the fake smoke-test users (ids 990000100-990000199) and the fake chat
 * FAKE_CHAT (lists, admin actions, locks, lock hits, join times, security memory, message log,
 * schedules, member flags, reports, topics, anonymous commands, join requests, channel stats, invite
 * links, posts and their versions, the post queue, crises; member stats, badges, contests, polls,
 * questions, appeals and reviews). It never touches the
 * audit log (federations are not created here for that reason).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { csv, utf8Bytes as bytesOf, utf8Bytes, utf8Text } from '../lib/core/util.js';
import { adminActions } from '../lib/engines/betrayal.js';
import * as lists from '../lib/engines/lists.js';
import * as locks from '../lib/engines/locks.js';
import * as members from '../lib/engines/members.js';
import * as feds from '../lib/engines/feds.js';
import * as guards from '../lib/engines/guards.js';
import { deobfuscate, invisible, mixedScriptWords, score } from '../lib/core/signals.js';
import { hostsOf, linksOf, scan } from '../lib/core/msgscan.js';
import * as punish from '../lib/engines/punish.js';
import * as settings from '../lib/engines/settings.js';
import * as msglog from '../lib/engines/msglog.js';
import * as schedules from '../lib/engines/schedules.js';
import * as gd from '../lib/engines/groupdata.js';
import { localMinutes, nextTime, parseTimes } from '../lib/core/clock.js';
import { parseCommand as memberCommand } from '../lib/ui/advanced.js';
import * as channels from '../lib/engines/channels.js';
import * as invites from '../lib/engines/invites.js';
import * as posts from '../lib/engines/posts.js';
import * as crisis from '../lib/engines/crisis.js';
import * as backup from '../lib/engines/backup.js';
import { contentOf, withFooter } from '../lib/core/content.js';
import { parseWhen } from '../lib/ui/panel_posts.js';
import { appeals, badges, contests, polls, questions, stats } from '../lib/engines/social.js';
import { healthScore, isThanks, levelOf } from '../lib/core/levels.js';
import { parseCommand as socialCommand, qa as qaUi } from '../lib/ui/social.js';

const LO = 990000100;
const HI = 990000199;
const FAKE_CHAT = -990000100;

export default async function (input) {
  const action = input && input.action;
  if (action === 'read') {
    return {
      kv: await db.all(sql`SELECT key, value FROM aegis_kv WHERE key IN ('data_version', 'join_enabled', 'join_rev', 'cmd_rev', 'bot_id', 'bot_username', 'shutdown') LIMIT 20`),
      channels: await db.all(sql`SELECT id, username, chat_id, title, bot_admin, last_error, position FROM aegis_join_channels ORDER BY position LIMIT 20`),
      users: await db.all(sql`SELECT user_id, lang, lang_set, started, blocked FROM aegis_users WHERE user_id BETWEEN ${LO} AND ${HI} LIMIT 50`),
      tables: await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aegis_%' ORDER BY name LIMIT 200`),
      indexes: await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_aegis_%' ORDER BY name LIMIT 200`),
    };
  }
  if (action === 'p3') {
    /* The Phase 3 SQL on the real database, without Telegram and without the audit log. */
    const ctx = {};
    const out = {};
    out.added = await lists.upsert(FAKE_CHAT, 'bwd', { ekey: 'spam', value: 'Spam' }, LO);
    out.again = await lists.upsert(FAKE_CHAT, 'bwd', { ekey: 'spam', value: 'SPAM', note: 'n' }, LO);
    await lists.upsert(FAKE_CHAT, 'mut', { ekey: String(LO), value: 'Smoke', userId: LO, expiresAt: 1 }, LO);
    out.page = (await lists.page(FAKE_CHAT, 'bwd', 0)).total;
    out.expiredHidden = (await lists.page(FAKE_CHAT, 'mut', 0)).total === 0 && !(await lists.has(FAKE_CHAT, 'mut', String(LO)));
    out.counts = await lists.counts(FAKE_CHAT);
    out.search = (await lists.search(FAKE_CHAT, 'bwd', 'spa')).length;
    out.history = (await lists.historyOf(FAKE_CHAT, 'bwd', 'spam')).map((h) => h.action);
    out.removed = await lists.remove(FAKE_CHAT, 'bwd', 'spam', LO);
    await adminActions.record(FAKE_CHAT, LO, LO + 1, 'ban');
    out.actions = (await adminActions.since(FAKE_CHAT, LO, 0)).length;
    out.settings = (await settings.all(ctx, FAKE_CHAT)).steps;
    out.warnCount = await punish.warnCount(ctx, FAKE_CHAT, LO);
    out.warned = (await punish.warned(ctx, FAKE_CHAT, 10, 0)).total;
    out.punishments = await punish.countAll(FAKE_CHAT);
    out.csvBytes = utf8Bytes(csv([['a', 'سلام']])).length;
    return out;
  }
  if (action === 'p4') {
    /* The Phase 4 SQL and the message scanner on the real platform (regex Unicode properties). */
    await db.run(sql`INSERT INTO aegis_locks (chat_id, code, enabled, config, updated_by, updated_at) VALUES (${FAKE_CHAT}, 'link', 1, ${JSON.stringify({ on: 1, s: 'high' })}, 0, 0)
      ON CONFLICT(chat_id, code) DO UPDATE SET enabled = 1, config = excluded.config`);
    const on = await locks.active(FAKE_CHAT);
    const env = locks.listEnv(FAKE_CHAT);
    const bot = { id: 1, username: 'x' };
    const own = new Set();
    const hit = await locks.evaluate(scan({ text: 'visit spam . com', entities: [] }), on, { env, bot, own });
    const mixed = await locks.evaluate(scan({ text: 'سلام دوستان Hello خوبید', entities: [] }),
      new Map([['lang_latin', locks.normalize({ on: 1, s: 'high' })]]), { env, bot, own });
    await locks.recordHit(FAKE_CHAT, 'link', LO, 'deleted', null);
    await members.joined(FAKE_CHAT, LO);
    return {
      active: [...on.keys()],
      hit: hit.map((m) => m.code),
      mixed: mixed.map((m) => m.code),
      hits: (await locks.hits(FAKE_CHAT, 'link')).length,
      hitCount: await locks.hitCount(FAKE_CHAT, 'link', 0),
      joined: (await members.joinedAt(FAKE_CHAT, LO)) > 0,
      counts: await locks.countOn(FAKE_CHAT),
    };
  }
  if (action === 'p5') {
    /* Phase 5: the security SQL (upsert with RETURNING, conditional updates) and signals in the isolate. */
    const ctx = {};
    const g = await guards.all(ctx, FAKE_CHAT);
    const c1 = await guards.countMessage(FAKE_CHAT, LO, 'h1', 5);
    const c2 = await guards.countMessage(FAKE_CHAT, LO, 'h1', 5);
    const claimed = await guards.claimFloodPunish(FAKE_CHAT, LO, 5);
    const again = await guards.claimFloodPunish(FAKE_CHAT, LO, 5);
    const seen1 = await guards.seenMedia('smoke-media', FAKE_CHAT, LO);
    const seen2 = await guards.seenMedia('smoke-media', FAKE_CHAT, LO);
    const ad = await guards.seenAd(LO, 'smokehash', FAKE_CHAT, 3600);
    const capId = await guards.newCaptcha(FAKE_CHAT, LO, 'group', { answer: 1, options: ['a', 'b'] }, 'x', 1);
    const expired = (await guards.expiredCaptchas(Math.floor(Date.now() / 1000), FAKE_CHAT)).map((r) => Number(r.id));
    const finished = await guards.finishCaptcha(capId, 'expired');
    const ldId = await guards.startLockdown(FAKE_CHAT, 'readonly', { can_send_messages: true }, null, LO, 1);
    const due = (await guards.dueLockdowns(Math.floor(Date.now() / 1000), FAKE_CHAT)).map((r) => Number(r.id));
    const ended = await guards.endLockdown(ldId, LO);
    const riskId = await guards.addRisk(FAKE_CHAT, LO, 50, [['no_username', 10]], 'alert', 0);
    const fb = await guards.riskFeedback(riskId, 'wrong', LO);
    return {
      modules: Object.keys(g).length, anyOn: guards.anyOn(g), flood: [c1.n, c2.n, c2.dup, c2.msgs], claimed, again, seen: [seen1.here, seen2.here], ad,
      captcha: expired.includes(capId) && finished, lockdown: due.includes(ldId) && ended, feedback: fb,
      signals: [hostsOf(linksOf({ text: deobfuscate('ｓｐａｍ．ｃｏｍ'), urls: [], entities: [] }, 'high')).join(), invisible('a\u202Eb').suspicious, mixedScriptWords('раypal'),
        score(['xgroup', 'new_link']).score],
      fedNone: (await feds.ofChat(FAKE_CHAT)) === null,
    };
  }
  if (action === 'p6') {
    /* Phase 6: message log with self-destruct times, schedules claimed once, member flags, reports,
       topics, anonymous commands; times of day and member commands (Unicode) in the isolate. */
    const now = Math.floor(Date.now() / 1000);
    await msglog.add(FAKE_CHAT, 11, LO, 'text', 0);
    await msglog.add(FAKE_CHAT, 12, LO, 'media', now - 1);
    const since = (await msglog.since(FAKE_CHAT, now - 60, ['text', 'media'], 10)).map((r) => Number(r.msg_id)).sort((a, b) => a - b);
    /* only read: rows of real chats stay for the real sweep */
    const dueHere = (await msglog.due(now, 100)).byChat.get(FAKE_CHAT) || [];
    await schedules.set(FAKE_CHAT, 'cleanup', now - 5);
    const row = await schedules.get(FAKE_CHAT, 'cleanup');
    const first = await schedules.claim(row, now + 3600);
    const second = await schedules.claim(row, now + 7200);
    await gd.setFjOk(FAKE_CHAT, LO);
    await gd.addAdds(FAKE_CHAT, LO, 2);
    const prev = await gd.touchLast(FAKE_CHAT, LO);
    const fl = await gd.flags(FAKE_CHAT, LO);
    const rid = await gd.addReport(FAKE_CHAT, LO, LO + 1, 5, 'snippet', 'reason');
    const handled = await gd.handleReport(rid, 'deleted', LO);
    const handledTwice = await gd.handleReport(rid, 'banned', LO);
    await gd.saveTopic(FAKE_CHAT, 77, { name: 'Smoke topic' });
    await gd.saveTopic(FAKE_CHAT, 77, { closed: true });
    await gd.setTopicReadonly(FAKE_CHAT, 77, true);
    const tp = await gd.topic(FAKE_CHAT, 77);
    const aid = await gd.addAnon(FAKE_CHAT, { text: '/ban' });
    const took = await gd.takeAnon(aid, LO);
    const tookAgain = await gd.takeAnon(aid, LO);
    return {
      since, dueHere: dueHere.length, claim: [!!first, !!second], flags: [Number(fl.fj_ok_at) > 0, Number(fl.adds), prev === 0, Number(fl.last_at) > 0],
      report: [!!handled, !!handledTwice, (await gd.report(rid)).status], topic: [tp.name, Number(tp.closed), Number(tp.readonly)],
      anon: [!!took, !!tookAgain], times: parseTimes('۳:۰۰ و 15:30').times, next: nextTime([0], 0, 210) === 86400 - 210 * 60, local: localMinutes(3600, 210),
      member: [memberCommand('قوانین').cmd, memberCommand('/report@x spam').cmd, memberCommand('hello') === null],
    };
  }
  if (action === 'p7') {
    /* Phase 7: join requests decided once, subscribers per day, invite link counts, the post archive with
       versions, the queue claimed once and due by time, a crisis started once, a backup checked; pure helpers in the isolate. */
    const now = Math.floor(Date.now() / 1000);
    const rid = await channels.addRequest(FAKE_CHAT, { id: LO, first_name: 'Smoke' }, 'bio', 'Aegis 1', null);
    const d1 = await channels.decide(rid, 'approved', 'mode', 0);
    const d2 = await channels.decide(rid, 'declined', 'mode', 0);
    await channels.bump(FAKE_CHAT, 'joins');
    await channels.bump(FAKE_CHAT, 'joins');
    await channels.bump(FAKE_CHAT, 'leaves');
    await channels.setMembers(FAKE_CHAT, 42);
    const flow = await channels.flow(FAKE_CHAT, 1);
    const lid = await invites.add(FAKE_CHAT, { invite_link: 'https://t.me/+smoke990000100', name: 'Smoke' }, LO);
    await invites.count(FAKE_CHAT, { invite_link: 'https://t.me/+smoke990000100' }, 'joins');
    const link = await invites.get(lid);
    const pid = await posts.save(FAKE_CHAT, 5, 'text', { t: 'one' }, { at: now });
    await posts.newVersion(await posts.get(pid), { t: 'two' }, 'edit');
    const vs = await posts.versions(pid);
    const qid = await posts.enqueue(FAKE_CHAT, 'text', { t: 'q' }, { status: 'scheduled', publishAt: now - 1 });
    const due = (await posts.due(now, 50)).some((r) => Number(r.id) === qid);
    const c1 = await posts.claim(qid, 'scheduled', 'publishing');
    const c2 = await posts.claim(qid, 'scheduled', 'publishing');
    const k1 = await crisis.start(FAKE_CHAT, LO, { settings: {} });
    const k2 = await crisis.start(FAKE_CHAT, LO, { settings: {} });
    const ended = await crisis.end(k1, LO);
    const file = JSON.stringify(await backup.make({ chat_id: FAKE_CHAT, type: 'channel', title: 'Smoke' }));
    return {
      request: [!!d1, !!d2, (await channels.request(rid)).status], flow: [flow.joins, flow.leaves], members: await channels.membersAgo(FAKE_CHAT, 0),
      link: [Number(link.joins), link.name], post: [Number((await posts.get(pid)).versions), vs.length, posts.unpack(await posts.get(pid)).t],
      queue: [due, c1, c2], crisis: [k1 > 0, k2 === 0, !!ended], backup: JSON.parse(file).aegis,
      pure: [contentOf({ photo: [{ file_id: 'a' }, { file_id: 'b' }] }).c.f, withFooter('text', 'x', 'f'), utf8Text(bytesOf('سلام')), parseWhen('2026-01-02 00:00', 1767225600, 0) > 0],
    };
  }
  if (action === 'p8') {
    /* Phase 8: messages and points (gap, thanks once a minute), badges once, a contest started and finished
       once with entries counted once, poll votes replaced, a question settled once, a sender blocked, an appeal
       and a review once per punishment; levels, thanks, the health score and command words in the isolate. */
    const now = Math.floor(Date.now() / 1000);
    const FAKE_PUNISH = -990000150;
    await stats.count(FAKE_CHAT, LO, { media: true, hour: 9, now });
    await stats.count(FAKE_CHAT, LO + 1, { hour: 9, now });
    const e1 = await stats.earn(FAKE_CHAT, LO, 5, 60, now);
    const e2 = await stats.earn(FAKE_CHAT, LO, 5, 60, now);
    const th1 = await stats.thank(FAKE_CHAT, LO + 1, LO, 5, now);
    const th2 = await stats.thank(FAKE_CHAT, LO + 1, LO, 5, now);
    const day = await stats.sum(FAKE_CHAT, 1, now);
    const top = await stats.top(FAKE_CHAT, 'points', 3);
    const b1 = await badges.award(FAKE_CHAT, LO, 'first');
    const b2 = await badges.award(FAKE_CHAT, LO, 'first');
    const did = await badges.addDef(FAKE_CHAT, '🦉', 'Smoke owl', LO);
    const cid = await contests.create(FAKE_CHAT, { kind: 'raffle', title: 'Smoke', winners: 1, endsAt: now + 60 }, LO);
    const s1 = await contests.start(cid, 1);
    const s2 = await contests.start(cid, 1);
    const j1 = await contests.enter(cid, LO);
    const j2 = await contests.enter(cid, LO);
    const f1 = await contests.finish(cid, [LO]);
    const f2 = await contests.finish(cid, [LO]);
    const pid = await polls.create(FAKE_CHAT, { question: 'Smoke?', options: ['a', 'b'], anonymous: false, msgId: 1, pollId: 'smoke990000100' }, LO);
    await polls.vote(pid, LO, [0]);
    await polls.vote(pid, LO, [1]);
    await polls.setCounts('smoke990000100', [0, 1], 1, true);
    const poll = await polls.byPollId('smoke990000100');
    const qid = await questions.add(FAKE_CHAT, LO, 'smoke question', true);
    const q1 = await questions.settle(qid, 'published', LO, null, 2);
    const q2 = await questions.settle(qid, 'rejected', LO);
    await questions.block(FAKE_CHAT, LO, LO + 1);
    const aid = await appeals.add(FAKE_CHAT, FAKE_PUNISH, LO, 'smoke appeal');
    const a2 = await appeals.add(FAKE_CHAT, FAKE_PUNISH, LO, 'again');
    const d1 = await appeals.decide(aid, 'accepted', LO + 1);
    const d2 = await appeals.decide(aid, 'rejected', LO + 1);
    const r1 = await appeals.review(FAKE_CHAT, FAKE_PUNISH, LO + 1, 'upheld');
    const r2 = await appeals.review(FAKE_CHAT, FAKE_PUNISH, LO + 1, 'overturned');
    return {
      points: [!!e1, e2 === null, !!th1, th2 === null, Number((await stats.member(FAKE_CHAT, LO)).points), Number(top[0].user_id) === LO],
      day: [day.messages, day.media, await stats.activeSince(FAKE_CHAT, 1, now)],
      badges: [b1, b2, did > 0, await badges.holders(FAKE_CHAT, 'first')],
      contest: [s1, s2, j1, j2, f1, f2, (await contests.get(cid)).status],
      poll: [poll.status, Number(poll.total), (await polls.votes(pid)).length, (await polls.votes(pid))[0].options],
      question: [q1, q2, (await questions.get(qid)).status, await questions.blocked(FAKE_CHAT, LO)],
      appeal: [aid > 0, a2, d1, d2, r1, r2],
      pure: [levelOf(30), isThanks('ممنون!'), healthScore({ members: 1000, net7: 0, posts14: 0, postDays14: 0, rightsOk: true }).grade,
        (socialCommand('امتیاز من') || {}).cmd, (qaUi.parseCommand('سوال ناشناس') || {}).cmd, socialCommand('my points are low')],
    };
  }
  if (action === 'cleanup') {
    for (const c of await db.all(sql`SELECT id FROM aegis_contests WHERE chat_id = ${FAKE_CHAT} LIMIT 50`)) await db.run(sql`DELETE FROM aegis_contest_entries WHERE contest_id = ${c.id}`);
    for (const p of await db.all(sql`SELECT id FROM aegis_polls WHERE chat_id = ${FAKE_CHAT} LIMIT 50`)) await db.run(sql`DELETE FROM aegis_poll_votes WHERE poll_id = ${p.id}`);
    for (const t of ['aegis_member_stats', 'aegis_stats_day', 'aegis_stats_hour', 'aegis_badges', 'aegis_badge_defs', 'aegis_contests', 'aegis_polls', 'aegis_questions',
      'aegis_qa_blocks', 'aegis_appeals', 'aegis_reviews']) {
      await db.run(sql`DELETE FROM ${sql.raw(t)} WHERE chat_id = ${FAKE_CHAT}`);
    }
    for (const t of ['aegis_join_requests', 'aegis_channel_stats', 'aegis_invite_links', 'aegis_post_queue', 'aegis_crises']) {
      await db.run(sql`DELETE FROM ${sql.raw(t)} WHERE chat_id = ${FAKE_CHAT}`);
    }
    for (const p of await db.all(sql`SELECT id FROM aegis_posts WHERE chat_id = ${FAKE_CHAT} LIMIT 50`)) await db.run(sql`DELETE FROM aegis_post_versions WHERE post_id = ${p.id}`);
    await db.run(sql`DELETE FROM aegis_posts WHERE chat_id = ${FAKE_CHAT}`);
    for (const t of ['aegis_msg_log', 'aegis_schedules', 'aegis_member_flags', 'aegis_reports', 'aegis_topics', 'aegis_anon_cmds']) {
      await db.run(sql`DELETE FROM ${sql.raw(t)} WHERE chat_id = ${FAKE_CHAT}`);
    }
    for (const t of ['aegis_flood', 'aegis_captchas', 'aegis_lockdowns', 'aegis_risk_events', 'aegis_guards']) await db.run(sql`DELETE FROM ${sql.raw(t)} WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_media_seen WHERE file_uid = 'smoke-media'`);
    await db.run(sql`DELETE FROM aegis_msg_hashes WHERE user_id = ${LO}`);
    await db.run(sql`DELETE FROM aegis_locks WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_lock_hits WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_members WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_list_entries WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_list_history WHERE chat_id = ${FAKE_CHAT}`);
    await db.run(sql`DELETE FROM aegis_admin_actions WHERE chat_id = ${FAKE_CHAT}`);
    const u = await db.run(sql`DELETE FROM aegis_users WHERE user_id BETWEEN ${LO} AND ${HI}`);
    const s = await db.run(sql`DELETE FROM aegis_states WHERE user_id BETWEEN ${LO} AND ${HI}`);
    const e = await db.run(sql`DELETE FROM aegis_errors WHERE user_id BETWEEN ${LO} AND ${HI}`);
    return { users: u.rowsAffected, states: s.rowsAffected, errors: e.rowsAffected };
  }
  return { error: 'unknown action' };
}
