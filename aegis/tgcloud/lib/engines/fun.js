/*
 * Fun features (Phase 9): the 30 features and their settings, the anti-abuse limits (a cooldown and a
 * daily limit per member and feature, a limit per minute for the whole chat), running games,
 * birthdays, the picks of the day, and the media tools' jobs and sticker packs.
 *
 * Every feature has one setting fx_<code> = "on,who,cooldown,daily,reward":
 *   on 0|1 · who a (everyone) | d (admins) · cooldown seconds · daily uses per member (0 = no limit)
 *   · reward points for a win (games only; needs points on in the group).
 * Pure helpers at the end: hashes for the stable picks, math questions, scrambled words, the typing
 * test's anti-paste marks, rock-paper-scissors and tic-tac-toe rules, birthday input.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { nowSec, parseJson } from '../core/util.js';

/* cat: dice (Telegram's animated dice) · luck · social · daily · games · duel */
export const FEATURES = [
  { code: 'dice', cat: 'dice', emoji: '🎲', cmds: ['dice'], def: '1,a,30,20,0', dice: '🎲', win: (v) => v === 6 },
  { code: 'darts', cat: 'dice', emoji: '🎯', cmds: ['darts'], def: '1,a,30,20,0', dice: '🎯', win: (v) => v === 6 },
  { code: 'basket', cat: 'dice', emoji: '🏀', cmds: ['basket'], def: '1,a,30,20,0', dice: '🏀', win: (v) => v >= 4 },
  { code: 'football', cat: 'dice', emoji: '⚽', cmds: ['football'], def: '1,a,30,20,0', dice: '⚽', win: (v) => v >= 3 },
  { code: 'bowling', cat: 'dice', emoji: '🎳', cmds: ['bowling'], def: '1,a,30,20,0', dice: '🎳', win: (v) => v === 6 },
  { code: 'slot', cat: 'dice', emoji: '🎰', cmds: ['slot'], def: '1,a,60,10,0', dice: '🎰', win: (v) => [1, 22, 43, 64].includes(v) },
  { code: 'coin', cat: 'luck', emoji: '🪙', cmds: ['coin'], def: '1,a,10,30,0' },
  { code: 'rand', cat: 'luck', emoji: '🔢', cmds: ['rand'], def: '1,a,10,30,0', args: true },
  { code: 'choose', cat: 'luck', emoji: '🤔', cmds: ['choose'], def: '1,a,10,30,0', args: true },
  { code: 'ball8', cat: 'luck', emoji: '🎱', cmds: ['ball'], def: '1,a,10,30,0', args: true },
  { code: 'fortune', cat: 'luck', emoji: '🥠', cmds: ['fortune'], def: '1,a,60,5,0' },
  { code: 'love', cat: 'social', emoji: '💞', cmds: ['love'], def: '1,a,30,10,0' },
  { code: 'rate', cat: 'social', emoji: '🌡', cmds: ['rate'], def: '1,a,30,10,0', args: true },
  { code: 'truth', cat: 'social', emoji: '🗣', cmds: ['truth'], def: '1,a,30,10,0' },
  { code: 'dare', cat: 'social', emoji: '🔥', cmds: ['dare'], def: '1,a,30,10,0' },
  { code: 'wyr', cat: 'social', emoji: '⚖\uFE0F', cmds: ['wyr'], def: '1,a,120,5,0' },
  { code: 'act', cat: 'social', emoji: '🤗', cmds: ['hug', 'pat', 'highfive', 'wave', 'cheer'], def: '1,a,10,30,0' },
  { code: 'couple', cat: 'social', emoji: '💑', cmds: ['couple'], def: '1,a,60,5,0' },
  { code: 'motd', cat: 'daily', emoji: '👑', cmds: ['motd'], def: '1,a,60,5,0' },
  { code: 'bday', cat: 'daily', emoji: '🎂', cmds: ['birthday', 'birthdays'], def: '1,a,10,10,0', args: true },
  { code: 'daily', cat: 'daily', emoji: '🎁', cmds: ['daily'], def: '1,a,0,0,0' },
  { code: 'quote', cat: 'daily', emoji: '💬', cmds: ['quote'], def: '1,a,60,5,0' },
  { code: 'guess', cat: 'games', emoji: '🔢', cmds: ['guess'], def: '1,a,60,10,5', game: true },
  { code: 'math', cat: 'games', emoji: '➗', cmds: ['math'], def: '1,a,30,20,2', game: true },
  { code: 'scramble', cat: 'games', emoji: '🔤', cmds: ['scramble'], def: '1,a,30,20,2', game: true },
  { code: 'typing', cat: 'games', emoji: '⌨\uFE0F', cmds: ['typing'], def: '1,a,60,10,2', game: true },
  { code: 'trivia', cat: 'games', emoji: '🧠', cmds: ['trivia'], def: '1,a,60,10,2', game: true },
  { code: 'click', cat: 'games', emoji: '⚡', cmds: ['click'], def: '1,a,60,10,1', game: true },
  { code: 'rps', cat: 'duel', emoji: '✊', cmds: ['rps'], def: '1,a,30,20,1', game: true },
  { code: 'ttt', cat: 'duel', emoji: '❌', cmds: ['ttt'], def: '1,a,60,10,2', game: true },
];
export const CATS = ['dice', 'luck', 'social', 'daily', 'games', 'duel'];
export const CODES = FEATURES.map((f) => f.code);
export const byCode = (code) => FEATURES.find((f) => f.code === code) || null;
export const SLASH = Object.fromEntries(FEATURES.flatMap((f) => f.cmds.map((c) => [c, f.code])));
export const ACTS = ['hug', 'pat', 'highfive', 'wave', 'cheer'];
export const COOLDOWNS = [0, 10, 30, 60, 120, 300];
export const DAILIES = [0, 3, 5, 10, 20, 30, 50];
export const REWARDS = [0, 1, 2, 5, 10];
export const DEFAULTS = Object.fromEntries(FEATURES.map((f) => [`fx_${f.code}`, f.def]));
/* how long a game waits for its answer (seconds) */
export const GAME_TIME = { guess: 600, math: 180, scramble: 180, typing: 180, trivia: 600, click: 120, rps: 600, ttt: 600 };

export function conf(s, code) {
  const [on, who, cd, daily, reward] = String((s && s[`fx_${code}`]) || DEFAULTS[`fx_${code}`] || '0,a,0,0,0').split(',');
  return { on: on === '1', who: who === 'd' ? 'd' : 'a', cd: Number(cd) || 0, daily: Number(daily) || 0, reward: Number(reward) || 0 };
}
export const encodeConf = (c) => `${c.on ? 1 : 0},${c.who},${c.cd},${c.daily},${c.reward}`;
export function validConf(v) {
  const p = String(v).split(',');
  return p.length === 5 && (p[0] === '0' || p[0] === '1') && (p[1] === 'a' || p[1] === 'd') && COOLDOWNS.includes(Number(p[2]))
    && DAILIES.includes(Number(p[3])) && REWARDS.includes(Number(p[4])) && p.every((x) => /^[0-9ad]+$/.test(x));
}

/* ---------- limits ---------- */

/*
 * A member uses a feature (claimed once): 'ok', or { wait } (cooldown), or 'daily' (the day's limit).
 * day: the local day number. Admins pass free = true when the chat exempts them.
 */
export async function claimUse(chatId, userId, feature, c, day, { free = false, now = nowSec() } = {}) {
  await db.run(sql`INSERT INTO aegis_fun_use (chat_id, user_id, feature, day, n, last_at) VALUES (${chatId}, ${userId}, ${feature}, ${day}, 0, 0)
    ON CONFLICT(chat_id, user_id, feature) DO NOTHING`);
  const row = await db.get(sql`SELECT day, n, last_at FROM aegis_fun_use WHERE chat_id = ${chatId} AND user_id = ${userId} AND feature = ${feature}`);
  const n = Number(row.day) === day ? Number(row.n) : 0;
  if (!free) {
    if (c.cd && Number(row.last_at) > now - c.cd) return { wait: Number(row.last_at) + c.cd - now };
    if (c.daily && n >= c.daily) return 'daily';
  }
  const r = await db.run(sql`UPDATE aegis_fun_use SET day = ${day}, n = ${n + 1}, last_at = ${now}
    WHERE chat_id = ${chatId} AND user_id = ${userId} AND feature = ${feature} AND last_at = ${Number(row.last_at)}`);
  if (!r.rowsAffected) return { wait: 1 };
  return 'ok';
}

/* The chat's limit per minute (0 = none). Gives true when one more fun command may answer. */
export async function claimRate(chatId, perMinute, now = nowSec()) {
  if (!perMinute) return true;
  const r = await db.run(sql`UPDATE aegis_chats SET fun_n = CASE WHEN fun_at > ${now - 60} THEN fun_n + 1 ELSE 1 END,
    fun_at = CASE WHEN fun_at > ${now - 60} THEN fun_at ELSE ${now} END
    WHERE chat_id = ${chatId} AND (fun_at <= ${now - 60} OR fun_n < ${perMinute})`);
  return r.rowsAffected > 0;
}

/* ---------- games ---------- */

/* Starts a game of a kind in a chat — one of each kind at a time. Gives its id, or 0. */
export async function startGame(chatId, kind, { state = {}, answer = null, byId = 0, ttl, now = nowSec() } = {}) {
  const busy = await db.get(sql`SELECT id, ends_at FROM aegis_fun_games WHERE chat_id = ${chatId} AND status = 'running' AND kind = ${kind} LIMIT 1`);
  if (busy && Number(busy.ends_at) > now) return 0;
  if (busy) await db.run(sql`UPDATE aegis_fun_games SET status = 'expired' WHERE id = ${busy.id} AND status = 'running'`);
  const r = await db.run(sql`INSERT INTO aegis_fun_games (chat_id, kind, status, state, answer, by_id, at, ends_at)
    VALUES (${chatId}, ${kind}, 'running', ${JSON.stringify(state)}, ${answer}, ${byId}, ${now}, ${now + (ttl || GAME_TIME[kind] || 300)}) RETURNING id`);
  return Number(r.rows[0].id);
}

export const game = (id) => db.get(sql`SELECT * FROM aegis_fun_games WHERE id = ${id}`);
export const stateOf = (g) => parseJson(g && g.state, {}) || {};
export const running = (chatId, now = nowSec()) => db.all(sql`SELECT * FROM aegis_fun_games
  WHERE chat_id = ${chatId} AND status = 'running' AND ends_at > ${now} LIMIT 10`);

export async function setMsg(id, msgId) {
  await db.run(sql`UPDATE aegis_fun_games SET msg_id = ${msgId} WHERE id = ${id}`);
}

/* Saves a new state, only if nobody changed it meanwhile (the old state string must match). */
export async function saveState(g, state, { extend = 0 } = {}) {
  const r = await db.run(sql`UPDATE aegis_fun_games SET state = ${JSON.stringify(state)}, ends_at = ends_at + ${extend}
    WHERE id = ${g.id} AND status = 'running' AND state = ${g.state}`);
  return r.rowsAffected > 0;
}

/* Ends a game once. Gives true for the one call that ended it. */
export async function endGame(id, status = 'ended', winner = 0) {
  const r = await db.run(sql`UPDATE aegis_fun_games SET status = ${status}, winner = ${winner} WHERE id = ${id} AND status = 'running'`);
  return r.rowsAffected > 0;
}

export const gameByAnswer = (kind, answer) => db.get(sql`SELECT * FROM aegis_fun_games WHERE kind = ${kind} AND answer = ${String(answer)} AND status = 'running' LIMIT 1`);

/* Members who wrote in the last `days` days (from the Phase 8 counts), for the picks of the day. */
export const activeMembers = (chatId, since, limit = 300) => db.all(sql`SELECT user_id FROM aegis_member_stats WHERE chat_id = ${chatId} AND last_at > ${since}
  ORDER BY user_id LIMIT ${limit}`);

export const dueGames = (now, limit = 10) => db.all(sql`SELECT * FROM aegis_fun_games WHERE status = 'running' AND ends_at <= ${now} LIMIT ${limit}`);

/* ---------- picks of the day, birthdays ---------- */

export async function dailyPick(chatId, kind, day) {
  const r = await db.get(sql`SELECT data FROM aegis_fun_daily WHERE chat_id = ${chatId} AND kind = ${kind} AND day = ${day}`);
  return r ? parseJson(r.data, null) : null;
}

export async function setDailyPick(chatId, kind, day, data) {
  await db.run(sql`INSERT INTO aegis_fun_daily (chat_id, kind, day, data) VALUES (${chatId}, ${kind}, ${day}, ${JSON.stringify(data)})
    ON CONFLICT(chat_id, kind, day) DO NOTHING`);
  return dailyPick(chatId, kind, day);
}

export async function setBirthday(chatId, userId, cal, month, day) {
  await db.run(sql`INSERT INTO aegis_birthdays (chat_id, user_id, cal, month, day, greeted, at) VALUES (${chatId}, ${userId}, ${cal}, ${month}, ${day}, 0, ${nowSec()})
    ON CONFLICT(chat_id, user_id) DO UPDATE SET cal = excluded.cal, month = excluded.month, day = excluded.day, greeted = 0`);
}

export async function removeBirthday(chatId, userId) {
  const r = await db.run(sql`DELETE FROM aegis_birthdays WHERE chat_id = ${chatId} AND user_id = ${userId}`);
  return r.rowsAffected > 0;
}

export const birthdayOf = (chatId, userId) => db.get(sql`SELECT * FROM aegis_birthdays WHERE chat_id = ${chatId} AND user_id = ${userId}`);

/* Today's birthdays not greeted yet this year (claimed: each is greeted once). */
export async function claimBirthdays(chatId, cal, month, day, year) {
  const rows = await db.all(sql`SELECT user_id FROM aegis_birthdays WHERE chat_id = ${chatId} AND cal = ${cal} AND month = ${month} AND day = ${day}
    AND greeted < ${year} LIMIT 20`);
  const out = [];
  for (const r of rows) {
    const c = await db.run(sql`UPDATE aegis_birthdays SET greeted = ${year} WHERE chat_id = ${chatId} AND user_id = ${r.user_id} AND greeted < ${year}`);
    if (c.rowsAffected) out.push(Number(r.user_id));
  }
  return out;
}

/* The next birthdays from (month, day), in the chat's calendar. */
export async function upcoming(chatId, cal, month, day, limit = 10) {
  const after = await db.all(sql`SELECT user_id, month, day FROM aegis_birthdays WHERE chat_id = ${chatId} AND cal = ${cal}
    AND (month > ${month} OR (month = ${month} AND day >= ${day})) ORDER BY month, day LIMIT ${limit}`);
  if (after.length >= limit) return after;
  const before = await db.all(sql`SELECT user_id, month, day FROM aegis_birthdays WHERE chat_id = ${chatId} AND cal = ${cal}
    AND (month < ${month} OR (month = ${month} AND day < ${day})) ORDER BY month, day LIMIT ${limit - after.length}`);
  return [...after, ...before];
}

/* The local day birthdays were greeted on, claimed once per day per chat. */
export async function claimGreetDay(chatId, day) {
  const r = await db.run(sql`UPDATE aegis_chats SET fun_day = ${day} WHERE chat_id = ${chatId} AND fun_day < ${day}`);
  return r.rowsAffected > 0;
}

/* ---------- media tools: jobs and sticker packs ---------- */

export async function addJob(userId, chatId, kind, fileId, data = {}) {
  const r = await db.run(sql`INSERT INTO aegis_media_jobs (user_id, chat_id, kind, file_id, data, at)
    VALUES (${userId}, ${chatId}, ${kind}, ${fileId}, ${JSON.stringify(data)}, ${nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}
export const job = (id) => db.get(sql`SELECT * FROM aegis_media_jobs WHERE id = ${id}`);
export const jobData = (j) => parseJson(j && j.data, {}) || {};
export async function setJobData(id, data) {
  await db.run(sql`UPDATE aegis_media_jobs SET data = ${JSON.stringify(data)} WHERE id = ${id}`);
}
/* A member's open slideshow (photos collected for a GIF), if any. */
export const framesJob = (userId, since) => db.get(sql`SELECT * FROM aegis_media_jobs WHERE user_id = ${userId} AND kind = 'frames' AND at > ${since}
  ORDER BY at DESC LIMIT 1`);

export const pack = (userId) => db.get(sql`SELECT * FROM aegis_sticker_packs WHERE user_id = ${userId}`);
export async function savePack(userId, name, n) {
  await db.run(sql`INSERT INTO aegis_sticker_packs (user_id, name, n, at) VALUES (${userId}, ${name}, ${n}, ${nowSec()})
    ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, n = excluded.n, at = excluded.at`);
}

/* ---------- housekeeping ---------- */

export async function migrate(oldId, newId) {
  for (const t of ['aegis_fun_use', 'aegis_birthdays', 'aegis_fun_daily']) {
    await db.run(sql`DELETE FROM ${sql.raw(t)} WHERE chat_id = ${newId}`);
    await db.run(sql`UPDATE ${sql.raw(t)} SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
  }
  await db.run(sql`UPDATE aegis_fun_games SET chat_id = ${newId} WHERE chat_id = ${oldId}`);
}

export async function sweep(now = nowSec()) {
  const day = Math.floor(now / 86400);
  const a = await db.run(sql`DELETE FROM aegis_fun_use WHERE rowid IN (SELECT rowid FROM aegis_fun_use WHERE day < ${day - 3} LIMIT 500)`);
  const b = await db.run(sql`DELETE FROM aegis_media_jobs WHERE rowid IN (SELECT rowid FROM aegis_media_jobs WHERE at < ${now - 86400} LIMIT 200)`);
  const c = await db.run(sql`DELETE FROM aegis_fun_games WHERE rowid IN (SELECT rowid FROM aegis_fun_games WHERE at < ${now - 7 * 86400} AND status != 'running' LIMIT 200)`);
  const d = await db.run(sql`DELETE FROM aegis_fun_daily WHERE rowid IN (SELECT rowid FROM aegis_fun_daily WHERE day < ${day - 3} LIMIT 200)`);
  return a.rowsAffected + b.rowsAffected + c.rowsAffected + d.rowsAffected;
}

/* ---------- pure helpers ---------- */

/* FNV-1a: the same input gives the same number (the love meter, ratings, picks of the day). */
export function hash(s) {
  let h = 0x811C9DC5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const randInt = (lo, hi, rnd = Math.random) => lo + Math.floor(rnd() * (hi - lo + 1));
export const pick = (list, rnd = Math.random) => list[Math.floor(rnd() * list.length)];

/* A sum to work out: { text, answer }; harder with level 2. */
export function mathQuestion(rnd = Math.random, level = 1) {
  const kind = randInt(0, level > 1 ? 3 : 2, rnd);
  if (kind === 0) {
    const a = randInt(12, 99, rnd);
    const b = randInt(12, 99, rnd);
    return { text: `${a} + ${b}`, answer: a + b };
  }
  if (kind === 1) {
    const a = randInt(40, 150, rnd);
    const b = randInt(5, a - 1, rnd);
    return { text: `${a} − ${b}`, answer: a - b };
  }
  if (kind === 2) {
    const a = randInt(3, 15, rnd);
    const b = randInt(3, 12, rnd);
    const c = randInt(1, 30, rnd);
    return { text: `${a} × ${b} + ${c}`, answer: a * b + c };
  }
  const b = randInt(3, 12, rnd);
  const q = randInt(3, 15, rnd);
  return { text: `${b * q} ÷ ${b}`, answer: q };
}

/* The letters of a word in another order (never the word itself, when that is possible). */
export function scramble(word, rnd = Math.random) {
  const chars = [...word];
  if (new Set(chars).size < 2) return word;
  for (let tries = 0; tries < 20; tries += 1) {
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    if (chars.join('') !== word) return chars.join('');
  }
  return chars.reverse().join('');
}

/* The typing test: invisible marks between letters, so a pasted copy can be told from typing. */
export const PASTE_MARK = '\u2060';
export const marked = (s) => [...s].map((ch, i) => (i && i % 3 === 0 && ch !== ' ' ? PASTE_MARK + ch : ch)).join('');
export const pasted = (s) => String(s || '').includes(PASTE_MARK);

export const RPS = ['r', 'p', 's'];
/* 1: a wins, -1: b wins, 0: a draw. */
export const rpsWinner = (a, b) => (a === b ? 0 : (a === 'r' && b === 's') || (a === 'p' && b === 'r') || (a === 's' && b === 'p') ? 1 : -1);

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
/* board: 9 cells of '', 'x', 'o'. Gives 'x', 'o', 'draw' or null (still playing). */
export function tttWinner(board) {
  for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return board.every((v) => v) ? 'draw' : null;
}

/* A birthday as «MM-DD» (or MM/DD, MM.DD), month first, in the chat's calendar. Gives { month, day } or null. */
export function parseBirthday(text, cal) {
  const m = /^\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*$/.exec(String(text || ''));
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const max = cal === 'j' ? (month <= 6 ? 31 : 30) : [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > max) return null;
  return { month, day };
}
