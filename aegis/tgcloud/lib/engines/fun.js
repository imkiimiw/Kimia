/*
 * Fun features (Phase 9, fortune telling and fonts added after the release): the 36 features and their settings, the anti-abuse limits (a cooldown and a
 * daily limit per member and feature, a limit per minute for the whole chat), running games,
 * birthdays, the picks of the day, and the media tools' jobs and sticker packs.
 *
 * Every feature has one setting fx_<code> = "on,who,cooldown,daily,reward":
 *   on 0|1 · who a (everyone) | d (admins) · cooldown seconds · daily uses per member (0 = no limit)
 *   · reward points for a win (games only; needs points on in the group).
 * Pure helpers at the end: hashes for the stable picks, math questions, scrambled words, the typing
 * test's anti-paste marks, rock-paper-scissors and tic-tac-toe rules, birthday input; then the font
 * styles (fonts) and the fortune-telling helpers (fal: Hafez, tarot, zodiac, numerology, coffee).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { inflateRaw, unbase64 } from '../core/files.js';
import { nowSec, parseJson, utf8Text } from '../core/util.js';
import { HAFEZ, HAFEZ_COUNT, HAFEZ_PER, TAROT_IMG } from '../data/fal.js';

/* cat: dice (Telegram's animated dice) · luck · fal (fortune telling) · social · daily · games · duel · text */
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
  { code: 'hafez', cat: 'fal', emoji: '📜', cmds: ['hafez'], def: '1,a,30,10,0', args: true },
  { code: 'tarot', cat: 'fal', emoji: '🃏', cmds: ['tarot'], def: '1,a,30,10,0', args: true },
  { code: 'horo', cat: 'fal', emoji: '✨', cmds: ['horoscope', 'horo'], def: '1,a,30,10,0', args: true },
  { code: 'abjad', cat: 'fal', emoji: '🧮', cmds: ['abjad', 'numerology'], def: '1,a,30,10,0', args: true },
  { code: 'coffee', cat: 'fal', emoji: '☕', cmds: ['coffee'], def: '1,a,60,5,0' },
  { code: 'fortune', cat: 'fal', emoji: '🥠', cmds: ['fortune'], def: '1,a,60,5,0' },
  { code: 'font', cat: 'text', emoji: '🔠', cmds: ['font', 'fonts'], def: '1,a,10,20,0', args: true },
];
export const CATS = ['dice', 'luck', 'fal', 'social', 'daily', 'games', 'duel', 'text'];
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

/* ---------- fonts (the «font» feature) ---------- */

/*
 * Telegram has no fonts to choose from. What a bot can give is (1) Telegram's own text styles —
 * entities, rendered by every client in every language — and (2) Unicode letters that look like other
 * fonts (mathematical alphanumerics and friends), which exist only for Latin letters and digits. For
 * other scripts there are decorations: Persian/Arabic stretched with kashida, spaced letters, frames.
 */
export const fonts = (() => {
  const cp = (n) => String.fromCodePoint(n);
  /* a mathematical style: starts of A–Z, a–z (null: lower → upper) and 0–9 (null: digits stay), and its holes */
  const math = (A, a, d, holes = {}) => (ch) => {
    if (holes[ch]) return holes[ch];
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) return cp(A + c - 65);
    if (c >= 97 && c <= 122) return cp((a === null ? A : a) + c - 97);
    if (c >= 48 && c <= 57 && d !== null) return cp(d + c - 48);
    return ch;
  };
  const table = (from, to, { lower = false } = {}) => {
    const src = [...from];
    const dst = [...to];
    const m = new Map(src.map((c, i) => [c, dst[i]]));
    return (ch) => m.get(lower ? ch.toLowerCase() : ch) || ch;
  };
  const upper = (fn) => (ch) => fn(ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch);
  const digits = (zero, one) => (ch) => (ch === '0' ? (zero ? cp(zero) : ch) : (ch >= '1' && ch <= '9' ? cp(one + Number(ch) - 1) : null));
  const both = (letters, nums) => (ch) => nums(ch) || letters(ch);
  const SCRIPT = { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' };
  const FRAKTUR = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };
  const DOUBLE = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
  const wide = (ch) => (ch === ' ' ? '　' : (ch > ' ' && ch <= '~' ? cp(ch.charCodeAt(0) + 0xFEE0) : ch));
  /* Latin letter styles, in the order shown */
  const LATIN = [
    ['bold', math(0x1D400, 0x1D41A, 0x1D7CE)],
    ['italic', math(0x1D434, 0x1D44E, null, { h: 'ℎ' })],
    ['bolditalic', math(0x1D468, 0x1D482, null)],
    ['script', math(0x1D49C, 0x1D4B6, null, SCRIPT)],
    ['boldscript', math(0x1D4D0, 0x1D4EA, null)],
    ['fraktur', math(0x1D504, 0x1D51E, null, FRAKTUR)],
    ['boldfraktur', math(0x1D56C, 0x1D586, null)],
    ['double', math(0x1D538, 0x1D552, 0x1D7D8, DOUBLE)],
    ['sans', math(0x1D5A0, 0x1D5BA, 0x1D7E2)],
    ['sansbold', math(0x1D5D4, 0x1D5EE, 0x1D7EC)],
    ['sansitalic', math(0x1D608, 0x1D622, null)],
    ['sansbolditalic', math(0x1D63C, 0x1D656, null)],
    ['mono', math(0x1D670, 0x1D68A, 0x1D7F6)],
    ['wide', wide],
    ['circled', both(math(0x24B6, 0x24D0, null), digits(0x24EA, 0x2460))],
    ['circledneg', both(upper(math(0x1F150, null, null)), digits(0x24FF, 0x2776))],
    ['squared', upper(math(0x1F130, null, null))],
    ['squaredneg', upper(math(0x1F170, null, null))],
    ['paren', both(table('abcdefghijklmnopqrstuvwxyz', '⒜⒝⒞⒟⒠⒡⒢⒣⒤⒥⒦⒧⒨⒩⒪⒫⒬⒭⒮⒯⒰⒱⒲⒳⒴⒵', { lower: true }), digits(0, 0x2474))],
    ['smallcaps', table('abcdefghijklmnopqrstuvwxyz', 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ', { lower: true })],
    ['super', table('abcdefghijklmnopqrstuvwxyz0123456789+-=()', 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖᑫʳˢᵗᵘᵛʷˣʸᶻ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾', { lower: true })],
  ];
  const UPSIDE = table('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?!\'"()[]{}<>_&',
    'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz∀ᗺƆᗡƎℲ⅁HIſʞ˥WNOԀΌᴚS⊥∩ΛMX⅄Z0ƖᄅƐㄣϛ9ㄥ8' + '6˙\'¿¡,„)(][}{><‾⅋');
  /* combining marks drawn over each character */
  const COMBINING = [['strike', '̶'], ['underline', '̲'], ['dunderline', '̳'], ['overline', '̅']];
  const ARABIC = /[؀-ۿ]/;
  const LATIN_CHAR = /[A-Za-z0-9]/;
  const OTHER_LETTER = /[À-ɏͰ-ϿЀ-ӿ]/;
  /* letters that join to the next one (a kashida can follow them) and those that don't */
  const DUAL = new Set([...'بپتثجچحخسشصضطظعغفقکكگلمنهیيئـ']);
  const RIGHT = new Set([...'اآأإدذرزژوؤة']);
  const joins = (ch) => DUAL.has(ch) || RIGHT.has(ch);
  function kashida(s, n) {
    const chars = [...s];
    return chars.map((ch, i) => (DUAL.has(ch) && i + 1 < chars.length && joins(chars[i + 1]) ? ch + 'ـ'.repeat(n) : ch)).join('');
  }
  const FRAMES = [['꧁ ', ' ꧂'], ['✿ ', ' ✿'], ['★彡 ', ' 彡★'], ['【', '】'], ['『', '』'], ['♡ ', ' ♡'],
    ['─═ ', ' ═─'], ['⊱ ', ' ⊰']];
  /* Telegram's own styles: [code, opening tags, closing tags] */
  const TELEGRAM = [['bold', '<b>', '</b>'], ['italic', '<i>', '</i>'], ['underline', '<u>', '</u>'], ['strike', '<s>', '</s>'], ['spoiler', '<tg-spoiler>', '</tg-spoiler>'],
    ['mono', '<code>', '</code>'], ['bolditalic', '<b><i>', '</i></b>'], ['boldunderline', '<b><u>', '</u></b>'], ['italicunderline', '<i><u>', '</u></i>'],
    ['bolditalicunderline', '<b><i><u>', '</u></i></b>'], ['pre', '<pre>', '</pre>'], ['quote', '<blockquote>', '</blockquote>']];

  /* All the styles that apply to `text`: { telegram: [[code, open, close]], latin: [[code, styled]], deco: [[code, styled]], hasLatin, hasArabic } */
  function render(text) {
    const s = String(text || '');
    const chars = [...s];
    const hasLatin = LATIN_CHAR.test(s);
    const hasArabic = ARABIC.test(s);
    const latin = [];
    if (hasLatin) {
      for (const [code, fn] of LATIN) latin.push([code, chars.map(fn).join('')]);
      if (!hasArabic) latin.push(['upside', chars.map(UPSIDE).reverse().join('')]);
    }
    if (hasLatin || OTHER_LETTER.test(s)) {
      for (const [code, mark] of COMBINING) latin.push([code, chars.map((ch) => (ch === ' ' || ARABIC.test(ch) ? ch : ch + mark)).join('')]);
    }
    const deco = [];
    if (hasArabic) {
      deco.push(['kashida', kashida(s, 1)], ['kashida3', kashida(s, 3)]);
    }
    deco.push(['spaced', chars.map((ch) => (ch === '\u200C' ? ' ' : ch)).join(' ').replace(/ {3,}/g, '  ')]);
    FRAMES.forEach(([a, b], i) => deco.push([`frame${i + 1}`, `${a}${s}${b}`]));
    return { telegram: TELEGRAM, latin, deco, hasLatin, hasArabic };
  }

  return { render, kashida, LATIN: LATIN.map(([c]) => c), COMBINING: COMBINING.map(([c]) => c), FRAMES: FRAMES.length, TELEGRAM: TELEGRAM.map(([c]) => c) };
})();

/* ---------- fal: Hafez, tarot, horoscope, numerology, coffee ---------- */

export const fal = (() => {
  /* Hafez: the 495 ghazals (lib/data/fal.js), one chunk of 50 inflated when needed and kept for the isolate's life */
  const chunks = new Map();
  function ghazal(n) {
    const k = Math.max(1, Math.min(HAFEZ_COUNT, Math.floor(Number(n)) || 1));
    const i = Math.floor((k - 1) / HAFEZ_PER);
    if (!chunks.has(i)) chunks.set(i, JSON.parse(utf8Text(inflateRaw(unbase64(HAFEZ[i])).data)));
    const g = chunks.get(i)[(k - 1) % HAFEZ_PER];
    return { n: k, v: g.v, f: g.f };
  }

  /* Tarot: 78 cards — 0–21 the major arcana, then Wands, Cups, Swords, Pentacles (ace … king) */
  const CARDS = 78;
  const MAYBE = new Set([2, 10, 12, 18]); /* High Priestess, Wheel of Fortune, Hanged Man, Moon: «maybe» in a yes/no reading */
  function draw(count, rnd = Math.random) {
    const out = [];
    while (out.length < count) {
      const card = Math.floor(rnd() * CARDS);
      if (!out.some((x) => x.card === card)) out.push({ card, reversed: rnd() < 0.3 });
    }
    return out;
  }
  const answer = (c) => (MAYBE.has(c.card) ? 'maybe' : (c.reversed ? 'no' : 'yes'));
  const image = (card) => TAROT_IMG[card];
  const suitOf = (card) => (card < 22 ? 'major' : ['wands', 'cups', 'swords', 'pentacles'][Math.floor((card - 22) / 14)]);

  /* Zodiac: 0 Aries … 11 Pisces. The Persian solar months match the signs (Farvardin = Aries). */
  const SIGNS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
  const ELEMENTS = ['fire', 'earth', 'air', 'water'];
  const GREG = [[1, 20, 10], [2, 19, 11], [3, 21, 0], [4, 20, 1], [5, 21, 2], [6, 21, 3], [7, 23, 4], [8, 23, 5], [9, 23, 6], [10, 23, 7], [11, 22, 8], [12, 22, 9]];
  /* a sign's Gregorian dates: { from: [month, day], to: [month, day] } */
  const range = (sign) => {
    const start = (i) => GREG.find((g) => g[2] === (i + 12) % 12);
    const [m1, d1] = start(sign);
    const [m2, d2] = start(sign + 1);
    return { from: [m1, d1], to: [m2, d2 - 1] };
  };
  function signOf(cal, month, day) {
    if (cal === 'j') return (Number(month) - 1 + 12) % 12;
    let sign = 9;
    for (const [m, d, s] of GREG) if (month > m || (month === m && day >= d)) sign = s;
    return sign;
  }
  /* Today's reading for a sign: the same all day (a hash of the sign and the local day). */
  function horoscope(sign, day, sizes) {
    const h = (what) => hash(`horo:${sign}:${day}:${what}`);
    const pick2 = (what, n) => h(what) % n;
    return {
      love: pick2('love', sizes.love), work: pick2('work', sizes.work), health: pick2('health', sizes.health), advice: pick2('advice', sizes.advice),
      color: pick2('color', sizes.color), number: 1 + (h('number') % 99),
      stars: { love: 1 + (h('s1') % 5), work: 1 + (h('s2') % 5), health: 1 + (h('s3') % 5) },
    };
  }

  /* Numerology: abjad for Persian/Arabic letters, the Pythagorean table for Latin, the Russian table for Cyrillic. */
  const ABJAD = new Map();
  [['اآأإء', 1], ['بپ', 2], ['جچ', 3], ['د', 4], ['هة', 5], ['وؤ', 6], ['زژ', 7],
    ['ح', 8], ['ط', 9], ['یيئى', 10], ['کكگ', 20], ['ل', 30], ['م', 40], ['ن', 50], ['س', 60],
    ['ع', 70], ['ف', 80], ['ص', 90], ['ق', 100], ['ر', 200], ['ش', 300], ['ت', 400], ['ث', 500], ['خ', 600],
    ['ذ', 700], ['ض', 800], ['ظ', 900], ['غ', 1000]].forEach(([chars, v]) => { for (const c of chars) ABJAD.set(c, v); });
  const cyr = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
  const value = (ch, system) => {
    if (system === 'abjad') return ABJAD.get(ch) || 0;
    const c = ch.toLowerCase();
    if (system === 'latin') return c >= 'a' && c <= 'z' ? ((c.charCodeAt(0) - 97) % 9) + 1 : 0;
    const i = cyr.indexOf(c);
    return i < 0 ? 0 : (i % 9) + 1;
  };
  function reduce(n) {
    let x = n;
    while (x > 9 && x !== 11 && x !== 22) x = String(x).split('').reduce((s, d) => s + Number(d), 0);
    return x;
  }
  /* { system, total, number, letters } for the script most of the name is written in, or null. */
  function numerology(text) {
    const s = String(text || '').replace(/[\u064B-\u065F\u0670\u200C\u200D\u0640]/g, '');
    const counts = { abjad: 0, latin: 0, cyrillic: 0 };
    for (const ch of s) {
      if (ABJAD.has(ch)) counts.abjad += 1;
      else if (/[A-Za-z]/.test(ch)) counts.latin += 1;
      else if (cyr.includes(ch.toLowerCase())) counts.cyrillic += 1;
    }
    const system = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (!counts[system]) return null;
    let total = 0;
    for (const ch of s) total += value(ch, system);
    return { system, total, number: reduce(total), letters: counts[system] };
  }

  /* Coffee: three different symbols out of n. */
  function symbols(n, count = 3, rnd = Math.random) {
    const out = [];
    while (out.length < Math.min(count, n)) {
      const i = Math.floor(rnd() * n);
      if (!out.includes(i)) out.push(i);
    }
    return out;
  }

  return { ghazal, HAFEZ_COUNT, CARDS, draw, answer, image, suitOf, SIGNS, ELEMENTS, signOf, range, horoscope, numerology, reduce, symbols };
})();
