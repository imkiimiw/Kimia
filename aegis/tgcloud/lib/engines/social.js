/*
 * Data of the social features (Phase 8), one section per kind of record: stats (messages, points,
 * days and hours), badges, contests, polls, questions, appeals (with reviews). Each section is an object
 * with the functions it had as a module of its own (merged to stay under the platform's module cap).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BADGE_DEFS_MAX, CONTEST_ENTRIES_MAX, STATS_DAYS, TOP_N } from '../config.js';
import { nowSec, parseJson } from '../core/util.js';

/* ========== stats (was engines/stats.js) ========== */
/*
 * Group activity (Phase 8): per member (aegis_member_stats: messages, points, thanks, streak), per day
 * (aegis_stats_day) and per hour of the day (aegis_stats_hour). Written once per counted message.
 */
export const stats = (() => {
const today = (now = nowSec()) => Math.floor(now / 86400);

const member = (chatId, userId) => db.get(sql`SELECT * FROM aegis_member_stats WHERE chat_id = ${chatId} AND user_id = ${userId}`);

/* Counts a message. Gives the member's row after it. */
async function count(chatId, userId, { media = false, hour = 0, now = nowSec() } = {}) {
  const d = today(now);
  const before = await member(chatId, userId);
  const newDay = !before || Number(before.last_day) !== d;
  let streak = 1;
  if (before && Number(before.last_day) === d) streak = Number(before.streak) || 1;
  else if (before && Number(before.last_day) === d - 1) streak = (Number(before.streak) || 0) + 1;
  await db.run(sql`INSERT INTO aegis_member_stats (chat_id, user_id, messages, streak, last_day, first_at, last_at) VALUES (${chatId}, ${userId}, 1, ${streak}, ${d}, ${now}, ${now})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET messages = aegis_member_stats.messages + 1, streak = ${streak}, last_day = ${d}, last_at = ${now},
      first_at = CASE WHEN aegis_member_stats.first_at = 0 THEN ${now} ELSE aegis_member_stats.first_at END`);
  await db.run(sql`INSERT INTO aegis_stats_day (chat_id, day, messages, media, active) VALUES (${chatId}, ${d}, 1, ${media ? 1 : 0}, 1)
    ON CONFLICT(chat_id, day) DO UPDATE SET messages = aegis_stats_day.messages + 1, media = aegis_stats_day.media + ${media ? 1 : 0},
      active = aegis_stats_day.active + ${newDay ? 1 : 0}`);
  await db.run(sql`INSERT INTO aegis_stats_hour (chat_id, hour, messages) VALUES (${chatId}, ${hour}, 1)
    ON CONFLICT(chat_id, hour) DO UPDATE SET messages = aegis_stats_hour.messages + 1`);
  return member(chatId, userId);
}

async function bump(chatId, field, now = nowSec()) {
  const d = today(now);
  if (field === 'joins') {
    await db.run(sql`INSERT INTO aegis_stats_day (chat_id, day, joins) VALUES (${chatId}, ${d}, 1) ON CONFLICT(chat_id, day) DO UPDATE SET joins = aegis_stats_day.joins + 1`);
  } else {
    await db.run(sql`INSERT INTO aegis_stats_day (chat_id, day, leaves) VALUES (${chatId}, ${d}, 1) ON CONFLICT(chat_id, day) DO UPDATE SET leaves = aegis_stats_day.leaves + 1`);
  }
}

/* Points for a message, at most once per `gap` seconds. Gives { before, after } or null (too soon). */
async function earn(chatId, userId, n, gap, now = nowSec()) {
  const m = await member(chatId, userId);
  if (!m) return null;
  const r = await db.run(sql`UPDATE aegis_member_stats SET points = points + ${n}, point_at = ${now}
    WHERE chat_id = ${chatId} AND user_id = ${userId} AND point_at <= ${now - gap}`);
  if (!r.rowsAffected) return null;
  return { before: Number(m.points), after: Number(m.points) + n };
}

/* Admins give or take points (never below 0). Gives { before, after }. */
async function adjust(chatId, userId, n) {
  await db.run(sql`INSERT INTO aegis_member_stats (chat_id, user_id) VALUES (${chatId}, ${userId}) ON CONFLICT(chat_id, user_id) DO NOTHING`);
  const m = await member(chatId, userId);
  const after = Math.max(0, Number(m.points) + n);
  await db.run(sql`UPDATE aegis_member_stats SET points = ${after} WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  return { before: Number(m.points), after };
}

/* A thanks from one member to another: the giver at most once a minute. Gives the receiver's { before, after } points or null. */
async function thank(chatId, fromId, toId, points, now = nowSec()) {
  const r = await db.run(sql`UPDATE aegis_member_stats SET thanks_given = thanks_given + 1, thank_at = ${now}
    WHERE chat_id = ${chatId} AND user_id = ${fromId} AND thank_at <= ${now - 60}`);
  if (!r.rowsAffected) return null;
  await db.run(sql`INSERT INTO aegis_member_stats (chat_id, user_id) VALUES (${chatId}, ${toId}) ON CONFLICT(chat_id, user_id) DO NOTHING`);
  const m = await member(chatId, toId);
  await db.run(sql`UPDATE aegis_member_stats SET thanks_got = thanks_got + 1, points = points + ${points} WHERE chat_id = ${chatId} AND user_id = ${toId}`);
  return { before: Number(m.points), after: Number(m.points) + points };
}

async function top(chatId, by = 'points', limit = TOP_N) {
  if (by === 'messages') return db.all(sql`SELECT * FROM aegis_member_stats WHERE chat_id = ${chatId} AND messages > 0 ORDER BY messages DESC LIMIT ${limit}`);
  return db.all(sql`SELECT * FROM aegis_member_stats WHERE chat_id = ${chatId} AND points > 0 ORDER BY points DESC LIMIT ${limit}`);
}

async function rank(chatId, points) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_member_stats WHERE chat_id = ${chatId} AND points > ${points}`)).n) + 1;
}

async function members(chatId, limit = 5000) {
  return db.all(sql`SELECT * FROM aegis_member_stats WHERE chat_id = ${chatId} ORDER BY messages DESC LIMIT ${limit}`);
}

async function days(chatId, n = STATS_DAYS, now = nowSec()) {
  return db.all(sql`SELECT * FROM aegis_stats_day WHERE chat_id = ${chatId} AND day > ${today(now) - n} ORDER BY day DESC LIMIT ${n}`);
}

async function sum(chatId, n, now = nowSec()) {
  const r = await db.get(sql`SELECT coalesce(sum(messages), 0) AS m, coalesce(sum(media), 0) AS md, coalesce(sum(joins), 0) AS j, coalesce(sum(leaves), 0) AS l,
    coalesce(max(active), 0) AS a FROM aegis_stats_day WHERE chat_id = ${chatId} AND day > ${today(now) - n}`);
  return { messages: Number(r.m), media: Number(r.md), joins: Number(r.j), leaves: Number(r.l), peakActive: Number(r.a) };
}

/* Members who wrote in the last n days. */
async function activeSince(chatId, n, now = nowSec()) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_member_stats WHERE chat_id = ${chatId} AND last_day > ${today(now) - n}`)).n);
}

async function hours(chatId) {
  return db.all(sql`SELECT hour, messages FROM aegis_stats_hour WHERE chat_id = ${chatId} ORDER BY messages DESC LIMIT 24`);
}

async function resetPoints(chatId) {
  const r = await db.run(sql`UPDATE aegis_member_stats SET points = 0, point_at = 0 WHERE chat_id = ${chatId} AND points > 0`);
  return r.rowsAffected;
}

async function migrate(oldId, newId) {
  for (const t of ['aegis_member_stats', 'aegis_stats_day', 'aegis_stats_hour']) {
    await db.run(sql`DELETE FROM ${sql.raw(t)} WHERE chat_id = ${newId}`);
    await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  }
}

async function sweep(now) {
  const r = await db.run(sql`DELETE FROM aegis_stats_day WHERE rowid IN (SELECT rowid FROM aegis_stats_day WHERE day < ${today(now) - 400} LIMIT 500)`);
  return r.rowsAffected;
}

  return { today, member, count, bump, earn, adjust, thank, top, rank, members, days, sum, activeSince, hours, resetPoints, migrate, sweep };
})();

/* ========== badges (was engines/badges.js) ========== */
/*
 * Badges (Phase 8): automatic ones (codes in lib/core/levels.js) and a group's own (aegis_badge_defs,
 * awarded as code c<def id>).
 */
export const badges = (() => {
async function of(chatId, userId) {
  return db.all(sql`SELECT * FROM aegis_badges WHERE chat_id = ${chatId} AND user_id = ${userId} ORDER BY at LIMIT 50`);
}

/* Gives a badge once. Gives true when it is new. */
async function award(chatId, userId, code, byId = 0) {
  const r = await db.run(sql`INSERT INTO aegis_badges (chat_id, user_id, code, given_by, at) VALUES (${chatId}, ${userId}, ${code}, ${byId}, ${nowSec()})
    ON CONFLICT(chat_id, user_id, code) DO NOTHING`);
  return r.rowsAffected > 0;
}

async function take(chatId, userId, code) {
  const r = await db.run(sql`DELETE FROM aegis_badges WHERE chat_id = ${chatId} AND user_id = ${userId} AND code = ${code}`);
  return r.rowsAffected > 0;
}

const defs = (chatId) => db.all(sql`SELECT * FROM aegis_badge_defs WHERE chat_id = ${chatId} ORDER BY id LIMIT ${BADGE_DEFS_MAX}`);
const def = (id) => db.get(sql`SELECT * FROM aegis_badge_defs WHERE id = ${id}`);

async function addDef(chatId, emoji, name, byId) {
  if ((await defs(chatId)).length >= BADGE_DEFS_MAX) return 0;
  const r = await db.run(sql`INSERT INTO aegis_badge_defs (chat_id, emoji, name, created_by, at) VALUES (${chatId}, ${emoji}, ${name}, ${byId}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

async function removeDef(chatId, id) {
  await db.run(sql`DELETE FROM aegis_badges WHERE chat_id = ${chatId} AND code = ${`c${id}`}`);
  await db.run(sql`DELETE FROM aegis_badge_defs WHERE chat_id = ${chatId} AND id = ${id}`);
}

async function holders(chatId, code) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_badges WHERE chat_id = ${chatId} AND code = ${code}`)).n);
}

async function migrate(oldId, newId) {
  for (const t of ['aegis_badges', 'aegis_badge_defs']) await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

  return { of, award, take, defs, def, addDef, removeDef, holders, migrate };
})();

/* ========== contests (was engines/contests.js) ========== */
/*
 * Contests (Phase 8): raffle (members join with a button; winners drawn at random), activity (the
 * members who write most until the end), quiz (the first right answer wins). Entries in
 * aegis_contest_entries. They end lazily (no scheduler): at the first update after their time.
 */
export const contests = (() => {
const KINDS = ['raffle', 'activity', 'quiz'];

async function create(chatId, c, byId) {
  const r = await db.run(sql`INSERT INTO aegis_contests (chat_id, kind, title, winners, ends_at, status, question, answer, created_by, at)
    VALUES (${chatId}, ${c.kind}, ${c.title}, ${c.winners}, ${c.endsAt}, 'draft', ${c.question || null}, ${c.answer || null}, ${byId}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

const get = (id) => db.get(sql`SELECT * FROM aegis_contests WHERE id = ${id}`);

async function update(id, fields) {
  const cur = await get(id);
  const next = { ...cur, ...fields };
  await db.run(sql`UPDATE aegis_contests SET title = ${next.title}, winners = ${next.winners}, ends_at = ${next.ends_at}, question = ${next.question},
    answer = ${next.answer} WHERE id = ${id}`);
}

async function start(id, msgId) {
  const r = await db.run(sql`UPDATE aegis_contests SET status = 'running', msg_id = ${msgId} WHERE id = ${id} AND status = 'draft'`);
  return r.rowsAffected > 0;
}

async function list(chatId, limit = 10) {
  /* discarded drafts are left out; contests cancelled after they started stay */
  return db.all(sql`SELECT * FROM aegis_contests WHERE chat_id = ${chatId} AND (status != 'cancelled' OR msg_id > 0) ORDER BY id DESC LIMIT ${limit}`);
}

/* Running activity and quiz contests of a chat (looked at for every message). */
async function live(chatId) {
  return db.all(sql`SELECT * FROM aegis_contests WHERE chat_id = ${chatId} AND status = 'running' AND kind IN ('activity', 'quiz') LIMIT 5`);
}

/* Joins a raffle. Gives 'joined', 'already' or 'full'. */
async function enter(contestId, userId) {
  if (await db.get(sql`SELECT 1 AS x FROM aegis_contest_entries WHERE contest_id = ${contestId} AND user_id = ${userId}`)) return 'already';
  if (await entries(contestId) >= CONTEST_ENTRIES_MAX) return 'full';
  await db.run(sql`INSERT INTO aegis_contest_entries (contest_id, user_id, n, at) VALUES (${contestId}, ${userId}, 1, ${nowSec()})
    ON CONFLICT(contest_id, user_id) DO NOTHING`);
  return 'joined';
}

async function tally(contestId, userId) {
  await db.run(sql`INSERT INTO aegis_contest_entries (contest_id, user_id, n, at) VALUES (${contestId}, ${userId}, 1, ${nowSec()})
    ON CONFLICT(contest_id, user_id) DO UPDATE SET n = aegis_contest_entries.n + 1`);
}

async function entries(contestId) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_contest_entries WHERE contest_id = ${contestId}`)).n);
}

async function leaders(contestId, limit) {
  return db.all(sql`SELECT user_id, n FROM aegis_contest_entries WHERE contest_id = ${contestId} ORDER BY n DESC, at LIMIT ${limit}`);
}

async function allEntries(contestId) {
  return db.all(sql`SELECT user_id FROM aegis_contest_entries WHERE contest_id = ${contestId} LIMIT ${CONTEST_ENTRIES_MAX}`);
}

/* Ends a running contest once with its winners. Gives true if this call ended it. */
async function finish(id, winners, status = 'ended') {
  const r = await db.run(sql`UPDATE aegis_contests SET status = ${status}, result = ${JSON.stringify(winners)}, ended_at = ${nowSec()}
    WHERE id = ${id} AND status IN ('running', 'draft')`);
  return r.rowsAffected > 0;
}

const winnersOf = (row) => parseJson(row && row.result, []) || [];

async function due(now, limit = 5) {
  return db.all(sql`SELECT * FROM aegis_contests WHERE status = 'running' AND ends_at <= ${now} ORDER BY ends_at LIMIT ${limit}`);
}

/* `n` different winners from `ids`, chosen at random (Math.random: fair enough for a group game, not a lottery). */
function draw(ids, n, rnd = Math.random) {
  const pool = [...ids];
  const out = [];
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

async function migrate(oldId, newId) {
  await db.run(sql`UPDATE aegis_contests SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

  return { KINDS, create, get, update, start, list, live, enter, tally, entries, leaders, allEntries, finish, winnersOf, due, draw, migrate };
})();

/* ========== polls (was engines/polls.js) ========== */
/*
 * Polls Aegis sent (Phase 8) and their results: counts from Telegram's poll updates, votes from
 * poll_answer (polls that aren't anonymous). A poll with an end time is stopped lazily.
 */
export const polls = (() => {
async function create(chatId, p, byId) {
  const r = await db.run(sql`INSERT INTO aegis_polls (chat_id, msg_id, poll_id, question, options, counts, anonymous, multiple, correct, closes_at, created_by, at)
    VALUES (${chatId}, ${p.msgId}, ${p.pollId}, ${p.question}, ${JSON.stringify(p.options)}, ${JSON.stringify(p.options.map(() => 0))}, ${p.anonymous ? 1 : 0},
    ${p.multiple ? 1 : 0}, ${p.correct === undefined ? -1 : p.correct}, ${p.closesAt || 0}, ${byId}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

const get = (id) => db.get(sql`SELECT * FROM aegis_polls WHERE id = ${id}`);
const byPollId = (pollId) => db.get(sql`SELECT * FROM aegis_polls WHERE poll_id = ${String(pollId)}`);
const optionsOf = (row) => parseJson(row && row.options, []) || [];
const countsOf = (row) => parseJson(row && row.counts, []) || [];

async function list(chatId, limit = 8) {
  return db.all(sql`SELECT * FROM aegis_polls WHERE chat_id = ${chatId} ORDER BY at DESC LIMIT ${limit}`);
}

/* Telegram's poll update: the counts (and whether it is closed). */
async function setCounts(pollId, counts, total, closed) {
  await db.run(sql`UPDATE aegis_polls SET counts = ${JSON.stringify(counts)}, total = ${total}, status = CASE WHEN ${closed ? 1 : 0} = 1 THEN 'closed' ELSE status END
    WHERE poll_id = ${String(pollId)}`);
}

async function vote(id, userId, options) {
  if (!options.length) {
    await db.run(sql`DELETE FROM aegis_poll_votes WHERE poll_id = ${id} AND user_id = ${userId}`);
    return;
  }
  await db.run(sql`INSERT INTO aegis_poll_votes (poll_id, user_id, options, at) VALUES (${id}, ${userId}, ${JSON.stringify(options)}, ${nowSec()})
    ON CONFLICT(poll_id, user_id) DO UPDATE SET options = excluded.options, at = excluded.at`);
}

async function votes(id, limit = 5000) {
  return db.all(sql`SELECT * FROM aegis_poll_votes WHERE poll_id = ${id} ORDER BY at LIMIT ${limit}`);
}

async function close(id) {
  const r = await db.run(sql`UPDATE aegis_polls SET status = 'closed' WHERE id = ${id} AND status = 'open'`);
  return r.rowsAffected > 0;
}

async function due(now, limit = 5) {
  return db.all(sql`SELECT * FROM aegis_polls WHERE status = 'open' AND closes_at > 0 AND closes_at <= ${now} ORDER BY closes_at LIMIT ${limit}`);
}

async function migrate(oldId, newId) {
  await db.run(sql`UPDATE aegis_polls SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

  return { create, get, byPollId, optionsOf, countsOf, list, setCounts, vote, votes, close, due, migrate };
})();

/* ========== questions (was engines/questions.js) ========== */
/*
 * Members' questions to a chat's admins (Phase 8): private questions (answered privately) and
 * anonymous questions (anon = 1: moderated, then posted in the group without a name). The sender of
 * an anonymous question is kept only so an admin can block them without learning who they are.
 */
export const questions = (() => {
async function add(chatId, userId, text, anon) {
  const r = await db.run(sql`INSERT INTO aegis_questions (chat_id, user_id, anon, text, at) VALUES (${chatId}, ${userId}, ${anon ? 1 : 0}, ${text}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

const get = (id) => db.get(sql`SELECT * FROM aegis_questions WHERE id = ${id}`);

async function lastAt(chatId, userId) {
  const r = await db.get(sql`SELECT at FROM aegis_questions WHERE chat_id = ${chatId} AND user_id = ${userId} ORDER BY at DESC LIMIT 1`);
  return r ? Number(r.at) : 0;
}

/* Closes an open question once with a status (and the answer). Gives true if this call did it. */
async function settle(id, status, byId, answer = null, msgId = 0) {
  const r = await db.run(sql`UPDATE aegis_questions SET status = ${status}, answer = ${answer}, answered_by = ${byId}, answered_at = ${nowSec()}, msg_id = ${msgId}
    WHERE id = ${id} AND status = 'open'`);
  return r.rowsAffected > 0;
}

async function open(chatId, limit = 10) {
  return db.all(sql`SELECT * FROM aegis_questions WHERE chat_id = ${chatId} AND status = 'open' ORDER BY at LIMIT ${limit}`);
}

async function counts(chatId, since) {
  const rows = await db.all(sql`SELECT anon, status, count(*) AS n FROM aegis_questions WHERE chat_id = ${chatId} AND at >= ${since} GROUP BY anon, status LIMIT 20`);
  const out = { open: 0, answered: 0, published: 0, rejected: 0, closed: 0, anon: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = (out[r.status] || 0) + Number(r.n);
    out.total += Number(r.n);
    if (Number(r.anon)) out.anon += Number(r.n);
  }
  return out;
}

async function block(chatId, userId, byId) {
  await db.run(sql`INSERT INTO aegis_qa_blocks (chat_id, user_id, by_id, at) VALUES (${chatId}, ${userId}, ${byId}, ${nowSec()}) ON CONFLICT(chat_id, user_id) DO NOTHING`);
}

const blocked = async (chatId, userId) => !!(await db.get(sql`SELECT 1 AS x FROM aegis_qa_blocks WHERE chat_id = ${chatId} AND user_id = ${userId}`));

async function blocks(chatId) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_qa_blocks WHERE chat_id = ${chatId}`)).n);
}

async function unblockAll(chatId) {
  const r = await db.run(sql`DELETE FROM aegis_qa_blocks WHERE chat_id = ${chatId}`);
  return r.rowsAffected;
}

async function migrate(oldId, newId) {
  for (const t of ['aegis_questions', 'aegis_qa_blocks']) await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

  return { add, get, lastAt, settle, open, counts, block, blocked, blocks, unblockAll, migrate };
})();

/* ========== appeals (was engines/appeals.js) ========== */
/*
 * Appeals against punishments, one per punishment (Phase 8), and senior admins' reviews of
 * moderation decisions (upheld / overturned) with each moderator's record.
 */
export const appeals = (() => {
async function add(chatId, punishId, userId, text) {
  const r = await db.run(sql`INSERT INTO aegis_appeals (chat_id, punish_id, user_id, text, at) VALUES (${chatId}, ${punishId}, ${userId}, ${text}, ${nowSec()})
    ON CONFLICT(punish_id) DO NOTHING RETURNING id`);
  return r.rows.length ? Number(r.rows[0].id) : 0;
}

const get = (id) => db.get(sql`SELECT * FROM aegis_appeals WHERE id = ${id}`);
const ofPunishment = (punishId) => db.get(sql`SELECT * FROM aegis_appeals WHERE punish_id = ${punishId}`);

async function decide(id, status, byId) {
  const r = await db.run(sql`UPDATE aegis_appeals SET status = ${status}, decided_by = ${byId}, decided_at = ${nowSec()} WHERE id = ${id} AND status = 'open'`);
  return r.rowsAffected > 0;
}

async function open(chatId, limit = 10) {
  return db.all(sql`SELECT * FROM aegis_appeals WHERE chat_id = ${chatId} AND status = 'open' ORDER BY at LIMIT ${limit}`);
}

/* A member's active punishments that can still be appealed (in every chat). */
async function appealable(userId, limit = 10) {
  return db.all(sql`SELECT p.* FROM aegis_punishments p LEFT JOIN aegis_appeals a ON a.punish_id = p.id
    WHERE p.user_id = ${userId} AND p.status = 'active' AND p.kind IN ('warn', 'mute', 'restrict', 'quarantine', 'ban', 'blacklist')
    AND (p.until = 0 OR p.until > ${nowSec()}) AND a.id IS NULL ORDER BY p.created_at DESC LIMIT ${limit}`);
}

/* ---------- reviews ---------- */

async function review(chatId, punishId, byId, verdict) {
  const r = await db.run(sql`INSERT INTO aegis_reviews (chat_id, punish_id, by_id, verdict, at) VALUES (${chatId}, ${punishId}, ${byId}, ${verdict}, ${nowSec()})
    ON CONFLICT(punish_id) DO NOTHING`);
  return r.rowsAffected > 0;
}

const reviewOf = (punishId) => db.get(sql`SELECT * FROM aegis_reviews WHERE punish_id = ${punishId}`);

/* Decisions of the last days, with their appeal and review. */
async function decisions(chatId, since, limit = 15) {
  return db.all(sql`SELECT p.*, a.status AS appeal, r.verdict AS verdict FROM aegis_punishments p
    LEFT JOIN aegis_appeals a ON a.punish_id = p.id LEFT JOIN aegis_reviews r ON r.punish_id = p.id
    WHERE p.chat_id = ${chatId} AND p.created_at >= ${since} ORDER BY p.created_at DESC LIMIT ${limit}`);
}

/* Per moderator since a time: decisions, appealed, appeals accepted, overturned in review. */
async function record(chatId, since) {
  return db.all(sql`SELECT p.actor_id AS actor, count(*) AS n, sum(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS appealed,
    sum(CASE WHEN a.status = 'accepted' THEN 1 ELSE 0 END) AS accepted, sum(CASE WHEN r.verdict = 'overturned' THEN 1 ELSE 0 END) AS overturned
    FROM aegis_punishments p LEFT JOIN aegis_appeals a ON a.punish_id = p.id LEFT JOIN aegis_reviews r ON r.punish_id = p.id
    WHERE p.chat_id = ${chatId} AND p.created_at >= ${since} AND p.actor_id > 0 GROUP BY p.actor_id ORDER BY n DESC LIMIT 15`);
}

async function decisionsCount(chatId, since) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_punishments WHERE chat_id = ${chatId} AND created_at >= ${since}`)).n);
}

async function migrate(oldId, newId) {
  for (const t of ['aegis_appeals', 'aegis_reviews']) await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

  return { add, get, ofPunishment, decide, open, appealable, review, reviewOf, decisions, record, decisionsCount, migrate };
})();
