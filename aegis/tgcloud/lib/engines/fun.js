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
import { db, fetch } from 'sdk';
import { sql } from 'sdk/db';
import { inflateRaw, unbase64 } from '../core/files.js';
import { nowSec, parseJson, utf8Text } from '../core/util.js';
import * as lists from './lists.js';
import { HAFEZ, HAFEZ_COUNT, HAFEZ_PER, TAROT_IMG } from '../data/fal.js';
import { BABATAHER, BABATAHER_COUNT, CULTURE, KHAYYAM, KHAYYAM_COUNT, POEMS_PER, QURAN, SURAH_AR, SURAH_EN, SURAH_FA } from '../data/fal2.js';

/* cat: dice (Telegram's animated dice) · luck · fal (fortune telling) · hours (symbolic hours) · numbers · social · daily · games · duel · text */
export const FEATURES = [
  { code: 'dice', cat: 'dice', emoji: '🎲', cmds: ['dice'], def: '1,a,30,20,0', dice: '🎲', win: (v) => v === 6 },
  { code: 'darts', cat: 'dice', emoji: '🎯', cmds: ['darts'], def: '1,a,30,20,0', dice: '🎯', win: (v) => v === 6 },
  { code: 'basket', cat: 'dice', emoji: '🏀', cmds: ['basket'], def: '1,a,30,20,0', dice: '🏀', win: (v) => v >= 4 },
  { code: 'football', cat: 'dice', emoji: '⚽', cmds: ['football'], def: '1,a,30,20,0', dice: '⚽', win: (v) => v >= 3 },
  { code: 'bowling', cat: 'dice', emoji: '🎳', cmds: ['bowling'], def: '1,a,30,20,0', dice: '🎳', win: (v) => v === 6 },
  { code: 'slot', cat: 'dice', emoji: '🎰', cmds: ['slot'], def: '1,a,60,10,0', dice: '🎰', win: (v) => [1, 22, 43, 64].includes(v) },
  { code: 'coin', cat: 'luck', emoji: '🪙', cmds: ['coin'], def: '1,a,10,30,0', args: true },
  { code: 'rand', cat: 'luck', emoji: '🔢', cmds: ['rand'], def: '1,a,10,30,0', args: true },
  { code: 'choose', cat: 'luck', emoji: '🤔', cmds: ['choose', 'wheel'], def: '1,a,10,30,0', args: true },
  { code: 'ball8', cat: 'luck', emoji: '🎱', cmds: ['ball'], def: '1,a,10,30,0', args: true },
  { code: 'shuffle', cat: 'luck', emoji: '🔀', cmds: ['order', 'shuffle'], def: '1,a,10,30,0', args: true },
  { code: 'lottery', cat: 'luck', emoji: '🎉', cmds: ['lottery'], def: '1,a,60,10,0', args: true },
  { code: 'vote', cat: 'luck', emoji: '📊', cmds: ['vote'], def: '1,a,60,10,0', args: true },
  { code: 'decide', cat: 'luck', emoji: '⚖️', cmds: ['decide'], def: '1,a,30,10,0', args: true },
  { code: 'love', cat: 'social', emoji: '💞', cmds: ['love'], def: '1,a,30,10,0' },
  { code: 'rate', cat: 'social', emoji: '🌡', cmds: ['rate'], def: '1,a,30,10,0', args: true },
  { code: 'truth', cat: 'social', emoji: '🗣', cmds: ['truth'], def: '1,a,30,10,0' },
  { code: 'dare', cat: 'social', emoji: '🔥', cmds: ['dare'], def: '1,a,30,10,0' },
  { code: 'wyr', cat: 'social', emoji: '⚖\uFE0F', cmds: ['wyr'], def: '1,a,120,5,0' },
  { code: 'act', cat: 'social', emoji: '🤗', cmds: ['hug', 'pat', 'highfive', 'wave', 'cheer'], def: '1,a,10,30,0' },
  { code: 'couple', cat: 'social', emoji: '💑', cmds: ['couple'], def: '1,a,60,5,0' },
  { code: 'deepq', cat: 'social', emoji: '💬', cmds: ['deepq'], def: '1,a,30,10,0' },
  { code: 'dateidea', cat: 'social', emoji: '💑', cmds: ['dateidea'], def: '1,a,30,10,0' },
  { code: 'likely', cat: 'social', emoji: '🤔', cmds: ['likely'], def: '1,a,60,10,0' },
  { code: 'lie', cat: 'social', emoji: '🤥', cmds: ['lie'], def: '1,a,60,5,0', args: true },
  { code: 'motd', cat: 'daily', emoji: '👑', cmds: ['motd'], def: '1,a,60,5,0' },
  { code: 'bday', cat: 'daily', emoji: '🎂', cmds: ['birthday', 'birthdays'], def: '1,a,10,10,0', args: true },
  { code: 'daily', cat: 'daily', emoji: '🎁', cmds: ['daily'], def: '1,a,0,0,0' },
  { code: 'quote', cat: 'daily', emoji: '💬', cmds: ['quote'], def: '1,a,60,5,0' },
  { code: 'challenge', cat: 'daily', emoji: '🏅', cmds: ['challenge'], def: '1,a,60,5,0' },
  { code: 'guess', cat: 'games', emoji: '🔢', cmds: ['guess'], def: '1,a,60,10,5', game: true },
  { code: 'math', cat: 'games', emoji: '➗', cmds: ['math'], def: '1,a,30,20,2', game: true },
  { code: 'scramble', cat: 'games', emoji: '🔤', cmds: ['scramble'], def: '1,a,30,20,2', game: true },
  { code: 'typing', cat: 'games', emoji: '⌨\uFE0F', cmds: ['typing'], def: '1,a,60,10,2', game: true },
  { code: 'trivia', cat: 'games', emoji: '🧠', cmds: ['trivia'], def: '1,a,60,10,2', game: true },
  { code: 'click', cat: 'games', emoji: '⚡', cmds: ['click'], def: '1,a,60,10,1', game: true },
  { code: 'rps', cat: 'duel', emoji: '✊', cmds: ['rps'], def: '1,a,30,20,1', game: true },
  { code: 'ttt', cat: 'duel', emoji: '❌', cmds: ['ttt'], def: '1,a,60,10,2', game: true },
  { code: 'hafez', cat: 'fal', emoji: '📜', cmds: ['hafez'], def: '1,a,30,10,0', args: true },
  { code: 'khayyam', cat: 'fal', emoji: '🍷', cmds: ['khayyam'], def: '1,a,30,10,0', args: true },
  { code: 'babataher', cat: 'fal', emoji: '🏔', cmds: ['babataher'], def: '1,a,30,10,0', args: true },
  { code: 'tarot', cat: 'fal', emoji: '🃏', cmds: ['tarot'], def: '1,a,30,10,0', args: true },
  { code: 'horo', cat: 'fal', emoji: '✨', cmds: ['horoscope', 'horo'], def: '1,a,30,10,0', args: true },
  { code: 'abjad', cat: 'fal', emoji: '🧮', cmds: ['abjad', 'numerology'], def: '1,a,30,10,0', args: true },
  { code: 'coffee', cat: 'fal', emoji: '☕', cmds: ['coffee'], def: '1,a,60,5,0' },
  { code: 'fortune', cat: 'fal', emoji: '🥠', cmds: ['fortune'], def: '1,a,60,5,0' },
  { code: 'weekly', cat: 'fal', emoji: '📅', cmds: ['weekly'], def: '1,a,30,10,0', args: true },
  { code: 'universe', cat: 'fal', emoji: '🌌', cmds: ['universe'], def: '1,a,60,5,0' },
  { code: 'lovefal', cat: 'fal', emoji: '💘', cmds: ['lovefal'], def: '1,a,30,10,0' },
  { code: 'jobfal', cat: 'fal', emoji: '💼', cmds: ['jobfal'], def: '1,a,30,10,0' },
  { code: 'birthmonth', cat: 'fal', emoji: '🗓', cmds: ['birthmonth'], def: '1,a,30,10,0', args: true },
  { code: 'chinese', cat: 'fal', emoji: '🐉', cmds: ['chinese'], def: '1,a,30,10,0', args: true },
  { code: 'lifepath', cat: 'fal', emoji: '🧭', cmds: ['lifepath'], def: '1,a,30,10,0', args: true },
  { code: 'weekday', cat: 'fal', emoji: '📆', cmds: ['weekday'], def: '1,a,30,10,0', args: true },
  { code: 'cards', cat: 'fal', emoji: '♠️', cmds: ['cards'], def: '1,a,30,10,0', args: true },
  { code: 'runes', cat: 'fal', emoji: '🪨', cmds: ['runes', 'rune'], def: '1,a,30,10,0', args: true },
  { code: 'iching', cat: 'fal', emoji: '☯️', cmds: ['iching'], def: '1,a,30,10,0', args: true },
  { code: 'tas', cat: 'fal', emoji: '⚄', cmds: ['dicefortune'], def: '1,a,30,10,0' },
  { code: 'lenormand', cat: 'fal', emoji: '🌹', cmds: ['lenormand'], def: '1,a,30,10,0', args: true },
  { code: 'quran', cat: 'fal', emoji: '📖', cmds: ['istikhara'], def: '1,a,60,5,0' },
  { code: 'tasbih', cat: 'fal', emoji: '📿', cmds: ['tasbih'], def: '1,a,60,5,0' },
  { code: 'anbia', cat: 'fal', emoji: '🌟', cmds: ['prophets'], def: '1,a,60,5,0' },
  { code: 'font', cat: 'text', emoji: '🔠', cmds: ['font', 'fonts'], def: '1,a,10,20,0', args: true },
  { code: 'echo', cat: 'text', emoji: '🗣', cmds: ['echo', 'say'], def: '1,d,10,20,0', args: true },
  { code: 'ptest', cat: 'mind', emoji: '🧠', cmds: ['ptest', 'test'], def: '1,a,30,10,0', args: true },
  { code: 'spirit', cat: 'mind', emoji: '🪬', cmds: ['spirit'], def: '1,a,30,10,0', args: true },
  { code: 'match', cat: 'mind', emoji: '💞', cmds: ['match'], def: '1,a,60,10,0' },
  { code: 'knowme', cat: 'mind', emoji: '🎯', cmds: ['knowme'], def: '1,a,60,10,0' },
  { code: 'parallel', cat: 'mind', emoji: '🌌', cmds: ['parallel'], def: '1,a,60,5,0' },
  { code: 'cipher', cat: 'puzzle', emoji: '🔐', cmds: ['cipher'], def: '1,a,30,20,2', game: true },
  { code: 'hangman', cat: 'puzzle', emoji: '🪢', cmds: ['hangman'], def: '1,a,60,10,2', game: true },
  { code: 'emojimovie', cat: 'puzzle', emoji: '🍿', cmds: ['emojimovie'], def: '1,a,30,20,2', game: true },
  { code: 'flags', cat: 'puzzle', emoji: '🚩', cmds: ['flags', 'flag'], def: '1,a,30,20,1', game: true },
  { code: 'riddle', cat: 'puzzle', emoji: '❓', cmds: ['riddle'], def: '1,a,30,20,2', game: true },
  { code: 'story', cat: 'puzzle', emoji: '🧵', cmds: ['story'], def: '1,a,60,5,0', game: true, args: true },
  { code: 'memory', cat: 'puzzle', emoji: '💭', cmds: ['memory'], def: '1,a,30,10,0' },
  { code: 'genie', cat: 'puzzle', emoji: '🧞', cmds: ['genie'], def: '1,a,30,10,0' },
  { code: 'escape', cat: 'puzzle', emoji: '🗝', cmds: ['escape'], def: '1,a,30,10,0' },
  { code: 'case', cat: 'puzzle', emoji: '🕵️', cmds: ['case', 'detective'], def: '1,a,60,10,2', game: true },
  { code: 'whoami', cat: 'puzzle', emoji: '🎭', cmds: ['whoami'], def: '1,a,30,20,2', game: true },
  { code: 'treasure', cat: 'puzzle', emoji: '\u{1F3F4}\u200D\u2620\uFE0F', cmds: ['treasure'], def: '1,a,60,10,2', game: true },
  { code: 'codebreak', cat: 'puzzle', emoji: '🔢', cmds: ['codebreak'], def: '1,a,60,10,2', game: true },
  { code: 'dream', cat: 'dream', emoji: '🌙', cmds: ['dream'], def: '1,a,30,10,0', args: true },
  { code: 'lucid', cat: 'dream', emoji: '🌌', cmds: ['lucid'], def: '1,a,60,5,0' },
  { code: 'dreamlog', cat: 'dream', emoji: '📔', cmds: ['dreamlog'], def: '1,a,10,30,0', args: true },
  { code: 'dialogue', cat: 'culture', emoji: '🎬', cmds: ['dialogue'], def: '1,a,30,10,0', args: true },
  { code: 'bookquote', cat: 'culture', emoji: '🔖', cmds: ['bookquote', 'excerpt'], def: '1,a,30,10,0', args: true },
  { code: 'movie', cat: 'culture', emoji: '🎞', cmds: ['movie', 'film'], def: '1,a,30,10,0', args: true },
  { code: 'music', cat: 'culture', emoji: '🎵', cmds: ['music', 'song'], def: '1,a,30,10,0', args: true },
  { code: 'book', cat: 'culture', emoji: '📚', cmds: ['book'], def: '1,a,30,10,0', args: true },
  { code: 'poem', cat: 'culture', emoji: '📜', cmds: ['poem'], def: '1,a,30,10,0', args: true },
  { code: 'travel', cat: 'culture', emoji: '✈️', cmds: ['travel'], def: '1,a,30,10,0', args: true },
  { code: 'clock', cat: 'hours', emoji: '🕰', cmds: ['clock', 'hour'], def: '1,a,10,20,0', args: true },
  { code: 'mirror', cat: 'hours', emoji: '🪞', cmds: ['mirror'], def: '1,a,10,20,0', args: true },
  { code: 'reversed', cat: 'hours', emoji: '🔁', cmds: ['reversed'], def: '1,a,10,20,0', args: true },
  { code: 'triple', cat: 'hours', emoji: '🔱', cmds: ['triple'], def: '1,a,10,20,0', args: true },
  { code: 'angel', cat: 'hours', emoji: '👼', cmds: ['angel'], def: '1,a,10,20,0', args: true },
  { code: 'sequence', cat: 'hours', emoji: '📈', cmds: ['sequence'], def: '1,a,10,20,0', args: true },
  { code: 'repeat', cat: 'hours', emoji: '🔂', cmds: ['repeat'], def: '1,a,10,20,0', args: true },
  { code: 'number', cat: 'numbers', emoji: '🔢', cmds: ['number', 'num'], def: '1,a,10,20,0', args: true },
];
export const CATS = ['dice', 'luck', 'fal', 'hours', 'numbers', 'social', 'daily', 'games', 'puzzle', 'duel', 'text', 'culture', 'mind', 'dream'];
export const CODES = FEATURES.map((f) => f.code);
export const byCode = (code) => FEATURES.find((f) => f.code === code) || null;
export const SLASH = Object.fromEntries(FEATURES.flatMap((f) => f.cmds.map((c) => [c, f.code])));
export const ACTS = ['hug', 'pat', 'highfive', 'wave', 'cheer'];
export const COOLDOWNS = [0, 10, 30, 60, 120, 300];
export const DAILIES = [0, 3, 5, 10, 20, 30, 50];
export const REWARDS = [0, 1, 2, 5, 10];
/* Who may use a whole group of features: a everyone · s the chat's special members (list «fun») and its admins · d its owner and admins */
export const CAT_MODES = ['a', 's', 'd'];
export const DEFAULTS = Object.fromEntries([...FEATURES.map((f) => [`fx_${f.code}`, f.def]), ...CATS.map((cat) => [`fcat_${cat}`, 'a'])]);
export function catMode(s, cat) {
  const v = String((s && s[`fcat_${cat}`]) || 'a');
  return CAT_MODES.includes(v) ? v : 'a';
}
export const isSpecial = (chatId, userId) => lists.has(chatId, 'fun', String(userId));
/* how long a game waits for its answer (seconds) */
export const GAME_TIME = { guess: 600, math: 180, scramble: 180, typing: 180, trivia: 600, click: 120, rps: 600, ttt: 600, cipher: 180, hangman: 600, emojimovie: 300,
  flags: 120, riddle: 300, story: 3600, case: 900, whoami: 300, treasure: 600, codebreak: 900 };

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
 * entities, rendered by every client in every language — also over the fonts below; (2) Unicode letters
 * that look like other fonts (the 13 mathematical alphabets, enclosed, wide, small and turned letters),
 * which exist only for Latin letters and digits, and look-alike letters from other scripts; (3) marks
 * drawn on each letter and signs between letters; (4) for Persian: kashida with or without marks and
 * signs, harakat and other marks on each letter, disconnected or spaced letters; (5) frames; and
 * (6) chosen combinations of these. Pages: combo, tg, uni, look, mark, fa, frame, and extra (🎨 Special:
 * a folding quote and a code block with a language, accented letters, Braille, four more look-alike
 * sets, glitch text, enclosing marks, more combinations and Persian styles).
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
  /* a character table: from (a string) → to (a string of the same length, or a list) */
  const table = (from, to, { lower = false } = {}) => {
    const src = [...from];
    const dst = Array.isArray(to) ? to : [...to];
    const m = new Map(src.map((c, i) => [c, dst[i]]));
    return (ch) => m.get(lower ? ch.toLowerCase() : ch) || ch;
  };
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  /* a look-alike set: 26 capitals and (optionally) 26 small letters */
  const alike = (caps, small = caps) => table(AZ + AZ.toLowerCase(), [...[...caps], ...[...small]]);
  const upper = (fn) => (ch) => fn(ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch);
  const digits = (zero, one) => (ch) => (ch === '0' ? (zero ? cp(zero) : ch) : (ch >= '1' && ch <= '9' ? cp(one + Number(ch) - 1) : null));
  const both = (letters, nums) => (ch) => nums(ch) || letters(ch);
  const SCRIPT = { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' };
  const FRAKTUR = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };
  const DOUBLE = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
  const wide = (ch) => (ch === ' ' ? '\u3000' : (ch > ' ' && ch <= '~' ? cp(ch.charCodeAt(0) + 0xFEE0) : ch));
  const SUB = table('aehijklmnoprstuvx0123456789+-=()', 'ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎', { lower: true });
  const UPSIDE = table('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?!\'"()[]{}<>_&',
    'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz∀ᗺƆᗡƎℲ⅁HIſʞ˥WNOԀΌᴚS⊥∩ΛMX⅄Z0ƖᄅƐㄣϛ9ㄥ86˙\'¿¡,„)(][}{><‾⅋');
  const MIRROR = alike('AᗺƆᗡƎꟻᎮHIႱꓘ⅃MИOꟼỌЯꙄTUVWXYƸ', 'ɒdɔbɘʇǫʜiꞁʞlmnoqpɿꙅƚuvwxʏƹ');
  /* one character at a time; whole words (upside down, mirrored, flags) are done in `styled` */
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
    ['smallcaps', table('abcdefghijklmnopqrstuvwxyz', 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ', { lower: true })],
    ['super', table('abcdefghijklmnopqrstuvwxyz0123456789+-=()', 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖᑫʳˢᵗᵘᵛʷˣʸᶻ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾', { lower: true })],
    ['sub', SUB],
    ['circled', both(math(0x24B6, 0x24D0, null), digits(0x24EA, 0x2460))],
    ['circledneg', both(upper(math(0x1F150, null, null)), digits(0x24FF, 0x2776))],
    ['squared', upper(math(0x1F130, null, null))],
    ['squaredneg', upper(math(0x1F170, null, null))],
    ['paren', both(table('abcdefghijklmnopqrstuvwxyz', '⒜⒝⒞⒟⒠⒡⒢⒣⒤⒥⒦⒧⒨⒩⒪⒫⒬⒭⒮⒯⒰⒱⒲⒳⒴⒵', { lower: true }), digits(0, 0x2474))],
    ['flags', null], ['upside', null], ['mirror', null],
  ];
  /* look-alike letters from other scripts (all written left to right) */
  const LOOK = [
    ['currency', alike('₳฿₵ĐɆ₣₲ⱧłJ₭Ⱡ₥₦Ø₱QⱤ₴₮ɄV₩ӾɎⱫ')],
    ['cyrillic', alike('ДБСDЄFGНЇЈКŁМИФРQЯЅТЦVШЖЧZ', 'дбсdєfgнїјкłмифрqяѕтцvшжчz')],
    ['asian', alike('卂乃匚ᗪ乇千Ꮆ卄丨ﾌҜㄥ爪几ㄖ卩Ɋ尺丂ㄒㄩᐯ山乂ㄚ乙')],
    ['greek', alike('ΛßϾÐΞŦGΉΊJҠĹϺΠΘΡϘЯΣͲЦVШΧΨΖ', 'αв¢∂єƒgнιјкℓмησρqяѕтυνωχуz')],
    ['runic', alike('ᚨᛒᚲᛞᛖᚠᚷᚺᛁᛃᚲᛚᛗᚾᛟᛈᚲᚱᛋᛏᚢᚡᚹᛪᛃᛉ')],
    ['thai', alike('ค๒ς๔єŦງђเʝкɭ๓ภ๏ρợгรՇยงฬϰฯչ')],
  ];
  /* the 🎨 Special page: more letter sets (Braille is written in `styled`) */
  const XLATIN = [
    ['accented', alike('ÁḂĆḊÉḞǴḦÍĴḰĹḾŃŐṔQŔŚŤŰṼẂẌŸŹ', 'áḃćḋéḟǵḧíĵḱĺḿńőṕqŕśťúṽẃẍÿź')], ['braille', null],
    ['cherokee', alike('ᏗᏰፈᎴᏋᎦᎶᏂᎥᏠᏦᏝᎷᏁᎧᎮᎤᏒᏕᏖᏬᏉᏇጀᎩፚ')], ['ethiopic', alike('ልጌርዕቿቻኗዘጎጋጕረጠክዐየዒዪነፕሁሀሠሸሃጊ')],
    ['yi', alike('ꍏꌃꉓꀸꍟꎇꁅꃅꀤꀭꀘ꒒ꂵꈤꂦꉣꆰꋪꌗ꓄ꀎꃴꅏꊼꌩꁴ')], ['canadian', alike('ᗩᗷᑕᗪEᖴGᕼIᒍKᒪᗰᑎOᑭᑫᖇᔕTᑌᐯᗯ᙭Yᘔ')],
  ];
  const BRAILLE = [...'⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵'];
  /* English Braille, letter by letter; digits after the number sign ⠼ (1–9, 0 as a–j) */
  function braille(s) {
    let out = '';
    let digit = false;
    for (const ch of s) {
      const c = ch.toLowerCase();
      if (c >= 'a' && c <= 'z') out += BRAILLE[c.charCodeAt(0) - 97];
      else if (c >= '0' && c <= '9') out += (digit ? '' : '⠼') + BRAILLE[c === '0' ? 9 : Number(c) - 1];
      else out += ch;
      digit = c >= '0' && c <= '9';
    }
    return out;
  }
  const ALL = new Map([...LATIN, ...LOOK, ...XLATIN]);
  const ARABIC = /[؀-ۿ]/;
  const ARABIC_LETTER = /[ء-يٱ-ۓۺ-ۿ]/;
  const LATIN_CHAR = /[A-Za-z0-9]/;
  const OTHER_LETTER = /[À-ɏͰ-ϿЀ-ӿ]/;
  /* a style over a text: Persian/Arabic letters are left as they are */
  function styled(s, code) {
    const chars = [...s];
    if (code === 'upside') return chars.map(UPSIDE).reverse().join('');
    if (code === 'mirror') return chars.map(MIRROR).reverse().join('');
    if (code === 'braille') return braille(s);
    if (code === 'flags') {
      return s.split(' ').map((w) => [...w].map((ch) => (/[A-Za-z]/.test(ch) ? cp(0x1F1E6 + ch.toUpperCase().charCodeAt(0) - 65) : ch)).join(' ')).join('   ');
    }
    const fn = ALL.get(code);
    return fn ? chars.map((ch) => (ARABIC.test(ch) ? ch : fn(ch))).join('') : s;
  }
  /* marks drawn on each character (not on spaces or Persian letters) */
  const MARKS = [['strike', '\u0336'], ['short', '\u0335'], ['slash', '\u0338'], ['underline', '\u0332'], ['dunderline', '\u0333'], ['overline', '\u0305'],
    ['doubleover', '\u033F'], ['tilde', '\u0330'], ['dots', '\u0324'], ['arrow', '\u034E'], ['cross', '\u033D'], ['seagull', '\u033C'], ['circle', '\u20DD'],
    ['square', '\u20DE'], ['glitch', '\u0337\u0322']];
  /* the 🎨 Special page's marks: enclosing ones and a few below the letter */
  const XMARKS = [['keycap', '\u20E3'], ['diamond', '\u20DF'], ['banned', '\u20E0'], ['asterisk', '\u0359'], ['xbelow', '\u0353'], ['bridge', '\u032A']];
  const MARK = new Map([...MARKS, ...XMARKS]);
  /* glitch text: marks above, through and below each letter, the same every time for the same text */
  const ZUP = [...'\u030D\u030E\u0304\u0305\u033F\u0311\u0306\u0310\u0352\u0357\u0351\u0307\u0308\u030A\u0342\u0343\u0344\u034A\u034B\u034C\u0303\u0302\u030C\u0350\u0300\u0301\u030B\u030F\u0312\u0313\u0314\u033D\u0309\u0363\u0364\u0365\u0366\u0367\u0368\u0369\u036A\u036B\u036C\u036D\u036E\u036F\u033E\u035B\u0346\u031A'];
  const ZMID = [...'\u0315\u031B\u0340\u0341\u0358\u0321\u0322\u0327\u0328\u0334\u0335\u0336\u035C\u035D\u035E\u035F\u0360\u0362\u0338\u0337\u0361'];
  const ZDOWN = [...'\u0316\u0317\u0318\u0319\u031C\u031D\u031E\u031F\u0320\u0324\u0325\u0326\u0329\u032A\u032B\u032C\u032D\u032E\u032F\u0330\u0331\u0339\u033A\u033B\u033C\u0345\u0347\u0348\u0349\u034D\u034E\u0353\u0354\u0355\u0356\u0359\u035A\u0323'];
  function zalgo(s, n) {
    let seed = (hash(s) % 2147483646) + 1;
    const rnd = (list) => {
      seed = (seed * 48271) % 2147483647;
      return list[seed % list.length];
    };
    const marks = () => [...Array(n)].map(() => rnd(ZUP)).join('') + rnd(ZMID) + [...Array(n)].map(() => rnd(ZDOWN)).join('');
    return [...s].map((ch) => (ch === ' ' || ARABIC.test(ch) ? ch : ch + marks())).join('');
  }
  const XGLITCH = [['zalgo1', 1], ['zalgo2', 3]];
  const marked = (s, code) => [...s].map((ch) => (ch === ' ' || ARABIC.test(ch) ? ch : ch + MARK.get(code))).join('');
  /* a sign between the letters of each word */
  const SEPS = [['hearts', '♥'], ['stars', '★'], ['dots', '·'], ['sparkle', '✦'], ['flower', '❀'], ['spaced', ' ']];
  const SEP = new Map(SEPS);
  const between = (s, sign) => s.split(' ').map((w) => [...w].join(sign)).join(sign === ' ' ? '   ' : ' ');

  /* Persian: letters that join to the next one (a kashida can follow them) and those that don't */
  const DUAL = new Set([...'بپتثجچحخسشصضطظعغفقکكگلمنهیيئـ']);
  const RIGHT = new Set([...'اآأإدذرزژوؤة']);
  const joins = (ch) => DUAL.has(ch) || RIGHT.has(ch);
  /* `fill` (n kashidas by default) between two letters that join */
  function kashida(s, n, fill = 'ـ'.repeat(n)) {
    const chars = [...s];
    return chars.map((ch, i) => (DUAL.has(ch) && i + 1 < chars.length && joins(chars[i + 1]) ? ch + fill : ch)).join('');
  }
  const onLetters = (s, marks) => [...s].map((ch) => (ARABIC_LETTER.test(ch) ? ch + marks : ch)).join('');
  const PERSIAN = [
    ['kashida', (s) => kashida(s, 1)], ['kashida3', (s) => kashida(s, 3)],
    ['apart', (s) => s.split(' ').map((w) => [...w].join('\u200C')).join(' ')], ['spaced', (s) => between(s, ' ')],
    ['crown', (s) => onLetters(s, '\u0670\u0656')], ['harakat', (s) => onLetters(s, '\u064E\u0650')], ['madd', (s) => onLetters(s, '\u0653')],
    ['sukun', (s) => onLetters(s, '\u0652')], ['shadda', (s) => onLetters(s, '\u0651')], ['tanwin', (s) => onLetters(s, '\u064D\u0651')],
    ['kmarks', (s) => kashida(s, 1, 'ـ\u064E\u0650ـ')], ['kwave', (s) => kashida(s, 1, 'ـ\u035C\u0361ـ')], ['kflower', (s) => kashida(s, 1, 'ـ\u06EA\u065Cـ')],
    ['kcrown', (s) => kashida(s, 1, 'ـ\u0670ـ')], ['kheart', (s) => kashida(s, 1, 'ـ♡ـ')], ['kstar', (s) => kashida(s, 1, 'ـ★ـ')],
  ];
  /* the 🎨 Special page's Persian styles */
  const PERSIAN_EXTRA = [
    ['apartmarks', (s) => s.split(' ').map((w) => [...w].map((ch) => (ARABIC_LETTER.test(ch) ? `${ch}\u064E` : ch)).join('\u200C')).join(' ')],
    ['k3marks', (s) => kashida(s, 1, 'ــ\u064E\u0650ــ')], ['kshadda', (s) => kashida(s, 1, 'ـ\u0651ـ')], ['kdiamond', (s) => kashida(s, 1, 'ـ◈ـ')],
    ['kflower2', (s) => kashida(s, 1, 'ـ❀ـ')], ['ksparkle', (s) => kashida(s, 1, 'ـ✧ـ')], ['kwavy2', (s) => kashida(s, 1, 'ـ\u0360ـ')],
  ];
  const PERSIAN_FN = new Map([...PERSIAN, ...PERSIAN_EXTRA]);

  const FRAMES = [['꧁ ', ' ꧂'], ['꧁༺ ', ' ༻꧂'], ['✿ ', ' ✿'], ['❀ ', ' ❀'], ['★彡 ', ' 彡★'], ['【', '】'], ['『', '』'], ['「', '」'], ['《', '》'],
    ['〖', '〗'], ['♡ ', ' ♡'], ['❥ ', ' ❥'], ['─═ ', ' ═─'], ['⊱ ', ' ⊰'], ['•°¯`•• ', ' ••´¯°•'], ['༺ ', ' ༻'], ['✧･ﾟ: ', ' :･ﾟ✧'], ['⋆｡°✩ ', ' ✩°｡⋆'],
    ['☾ ', ' ☽'], ['⸙ ', ' ⸙'], ['𓆩♡𓆪 ', ' 𓆩♡𓆪'], ['♔ ', ' ♔'], ['⫷ ', ' ⫸'], ['◦•●◉✿ ', ' ✿◉●•◦'], ['▁ ▂ ▄ ▅ ▆ ▇ █ ', ' █ ▇ ▆ ▅ ▄ ▂ ▁'],
    ['¸.·´¯`·.¸ ', ' ¸.·´¯`·.¸'], ['ღ ', ' ღ'], ['☆ﾟ.*･｡ﾟ ', ' ﾟ｡･*.ﾟ☆'], ['▓▒░ ', ' ░▒▓'], ['⟬ ', ' ⟭']];
  const frame = (s, i) => `${FRAMES[i][0]}${s}${FRAMES[i][1]}`;
  /* The combinations: a style, then marks or a sign between letters, then a frame (or its own ends) */
  const COMBOS = [
    ['boldscript', null, 1], ['sansbolditalic', null, 4], ['double', null, ['✦ ', ' ✦']], ['boldfraktur', null, 21], ['circled', null, 10],
    ['wide', null, 5], ['mono', null, 6], ['script', null, 14], ['smallcaps', null, ['✧ ', ' ✧']], ['bolditalic', null, 17],
    ['bold', 'm:underline', ['➶ ', '']], ['fraktur', null, 13], ['boldscript', null, 20], ['sansitalic', null, 18], ['double', null, 23],
    ['squaredneg', null, ['➤ ', '']], ['script', 'm:underline', null], ['sansbold', 'm:strike', null], ['smallcaps', 's:sparkle', null],
    ['wide', 's:spaced', 28], ['bolditalic', 's:hearts', null], ['circledneg', null, ['★ ', ' ★']], ['super', null, ['˚₊‧ ', ' ‧₊˚']],
    ['thai', null, 0], ['asian', null, 5], ['mono', 'm:dunderline', null], ['boldfraktur', 'm:glitch', null], ['sans', 'm:dots', 19],
    ['script', null, 25], ['runic', null, ['᛭ ', ' ᛭']], ['currency', null, 22], ['sansbold', null, 24], ['italic', 'm:underline', 26],
    ['greek', null, 29], ['bold', null, 16], ['squared', null, ['⚡ ', ' ⚡']]];
  const PERSIAN_COMBOS = [['kmarks', 0], ['crown', 5], ['kashida', 2], ['kashida3', ['★ ', ' ★']], ['kheart', 11], ['harakat', 21], ['apart', 19],
    ['kwave', ['◥ ', ' ◤']], ['sukun', 18], ['madd', 1], ['kflower', 14], ['kcrown', 17], ['kstar', 6], ['shadda', 23], ['tanwin', 28], ['kashida', 20]];
  const ends = (s, f) => (f === null ? s : (Array.isArray(f) ? `${f[0]}${s}${f[1]}` : frame(s, f)));
  /* more frames and combinations, for the 🎨 Special page */
  const XCOMBOS = [['accented', null, ['꒰ ', ' ꒱']], ['cherokee', null, ['ᯓ★ ', ' ★ᯓ']], ['ethiopic', null, ['꧁⎝ ', ' ⎠꧂']],
    ['yi', null, ['⋆ ˚｡⋆୨୧˚ ', ' ˚୨୧⋆｡˚ ⋆']], ['canadian', null, ['ʚ ', ' ɞ']], ['boldfraktur', 'z:1', ['▓▒░ ', ' ░▒▓']],
    ['boldscript', null, ['✩₊˚.⋆☾⋆⁺₊✧ ', ' ✧₊⁺⋆☾⋆.˚₊✩']], ['smallcaps', null, ['⋆⭒˚.⋆ ', ' ⋆.˚⭒⋆']], ['double', null, ['𖤐 ', ' 𖤐']],
    ['script', null, ['⌜ ', ' ⌟']], ['sansitalic', null, ['✮⋆˙ ', ' ˙⋆✮']], ['bold', null, ['╰┈➤ ', '']], ['braille', null, ['⠿ ', ' ⠿']],
    ['mono', 'm:keycap', null]];
  const PERSIAN_XCOMBOS = [['apartmarks', ['꒰ ', ' ꒱']], ['k3marks', ['꧁⎝ ', ' ⎠꧂']], ['kshadda', ['ʚ ', ' ɞ']], ['kdiamond', ['⋆ ˚｡⋆୨୧˚ ', ' ˚୨୧⋆｡˚ ⋆']],
    ['kflower2', ['✿ ', ' ✿']], ['ksparkle', ['✮⋆˙ ', ' ˙⋆✮']], ['kwavy2', ['ᯓ★ ', ' ★ᯓ']], ['crown', ['𖤐 ', ' 𖤐']], ['kmarks', ['⋆⭒˚.⋆ ', ' ⋆.˚⭒⋆']],
    ['kheart', ['ʚ ', ' ɞ']], ['harakat', ['⌜ ', ' ⌟']], ['kflower', ['꒰ ', ' ꒱']], ['kashida3', ['✩₊˚.⋆☾⋆⁺₊✧ ', ' ✧₊⁺⋆☾⋆.˚₊✩']], ['kstar', ['╰┈➤ ', '']],
    ['madd', ['⊹ ', ' ⊹']], ['kcrown', ['꧁⎝ ', ' ⎠꧂']]];
  function combo([style, extra, f]) {
    let s = styled(this, style);
    if (extra && extra.startsWith('m:')) s = marked(s, extra.slice(2));
    if (extra && extra.startsWith('s:')) s = between(s, SEP.get(extra.slice(2)));
    if (extra && extra.startsWith('z:')) s = zalgo(s, Number(extra.slice(2)));
    return ends(s, f);
  }

  /*
   * The 🧬 Combined Unicode page: letters from two sets in one word — Greek capitals of the same mathematical style in
   * place of the Latin ones that look alike (𝜜𝒓𝒂𝒛), a display initial on a text font, two fonts by turns, vowels apart.
   */
  const GREEK_START = { b: 0x1D6A8, i: 0x1D6E2, bi: 0x1D71C, sb: 0x1D756, sbi: 0x1D790 }; /* capital Alpha; small alpha is 26 further */
  const GREEK_CAP = { A: 0, B: 1, E: 4, Z: 5, H: 6, I: 8, K: 9, M: 11, N: 12, O: 14, P: 16, T: 19, Y: 20, X: 22 };
  const GREEK_SMALL = { a: 0, e: 4, i: 8, k: 9, n: 6, o: 14, p: 16, u: 20, v: 12, w: 24, x: 22, y: 2 };
  const one = (code) => (ch) => (ARABIC.test(ch) ? ch : (ALL.get(code) || ((c) => c))(ch));
  const GREEK_DIGITS = { bi: 'bold', sbi: 'sansbold' }; /* the italic styles have no digits of their own */
  const greekOf = (base, g, small = false) => (ch) => {
    if (GREEK_CAP[ch] !== undefined) return cp(GREEK_START[g] + GREEK_CAP[ch]);
    if (small && GREEK_SMALL[ch] !== undefined) return cp(GREEK_START[g] + 26 + GREEK_SMALL[ch]);
    if (ch >= '0' && ch <= '9' && GREEK_DIGITS[g]) return one(GREEK_DIGITS[g])(ch);
    return one(base)(ch);
  };
  /* each word starts with a capital (the Greek capitals and the initials need one) */
  const cap1 = (s) => s.split(' ').map((w) => w.replace(/^([^A-Za-z0-9]*)([a-z])/, (m, p, c) => p + c.toUpperCase())).join(' ');
  const isLetter = (ch) => /[A-Za-z0-9]/.test(ch);
  /* f(ch, i) on each Latin letter or digit, i counting them across the text (spaces and Persian left as they are) */
  const each = (s, f) => {
    let i = -1;
    return [...s].map((ch) => (isLetter(ch) ? f(ch, (i += 1)) : ch)).join('');
  };
  /* the first letter of each word in one style, the rest in another */
  const initial = (s, first, rest) => cap1(s).split(' ').map((w) => {
    let done = false;
    return [...w].map((ch) => {
      if (!isLetter(ch)) return ch;
      const f = done || !/[A-Za-z]/.test(ch) ? rest : first;
      done = true;
      return f(ch);
    }).join('');
  }).join(' ');
  const VOWEL = /[aeiouAEIOU]/;
  const MIX = [
    ['g_bi', (s) => each(cap1(s), greekOf('bolditalic', 'bi'))], ['g_b', (s) => each(cap1(s), greekOf('bold', 'b'))], ['g_i', (s) => each(cap1(s), greekOf('italic', 'i'))],
    ['g_sb', (s) => each(cap1(s), greekOf('sansbold', 'sb'))], ['g_sbi', (s) => each(cap1(s), greekOf('sansbolditalic', 'sbi'))],
    ['g_bi2', (s) => each(cap1(s), greekOf('bolditalic', 'bi', true))], ['g_sb2', (s) => each(cap1(s), greekOf('sansbold', 'sb', true))],
    ['i_script_sc', (s) => initial(s, one('boldscript'), one('smallcaps'))], ['i_double_sans', (s) => initial(s, one('double'), one('sans'))],
    ['i_fraktur_bi', (s) => initial(s, one('boldfraktur'), one('bolditalic'))], ['i_script_i', (s) => initial(s, one('script'), one('italic'))],
    ['i_circle_b', (s) => initial(s, one('circledneg'), one('bold'))], ['i_square_m', (s) => initial(s, one('squaredneg'), one('mono'))],
    ['i_greek_sc', (s) => initial(s, greekOf('bolditalic', 'bi'), one('smallcaps'))],
    ['a_b_i', (s) => each(s, (ch, i) => one(i % 2 ? 'italic' : 'bold')(ch))], ['a_script_fraktur', (s) => each(s, (ch, i) => one(i % 2 ? 'boldfraktur' : 'boldscript')(ch))],
    ['a_serif_sans', (s) => each(s, (ch, i) => one(i % 2 ? 'sansbold' : 'bold')(ch))], ['a_double_mono', (s) => each(s, (ch, i) => one(i % 2 ? 'mono' : 'double')(ch))],
    ['a_case', (s) => each(s, (ch, i) => (i % 2 ? one('smallcaps')(ch) : ch.toUpperCase()))],
    ['v_double_sb', (s) => each(s, (ch) => one(VOWEL.test(ch) ? 'double' : 'sansbold')(ch))], ['v_circle_b', (s) => each(s, (ch) => one(VOWEL.test(ch) ? 'circled' : 'bold')(ch))],
    ['w_super', (s) => each(s, (ch, i) => (i % 2 ? one('super')(ch) : ch))],
  ];

  /* Telegram's own styles: [code, opening tags, closing tags]; then Telegram's styles over a font */
  const TELEGRAM = [['bold', '<b>', '</b>'], ['italic', '<i>', '</i>'], ['underline', '<u>', '</u>'], ['strike', '<s>', '</s>'], ['spoiler', '<tg-spoiler>', '</tg-spoiler>'],
    ['mono', '<code>', '</code>'], ['bolditalic', '<b><i>', '</i></b>'], ['boldunderline', '<b><u>', '</u></b>'], ['italicunderline', '<i><u>', '</u></i>'],
    ['bolditalicunderline', '<b><i><u>', '</u></i></b>'], ['pre', '<pre>', '</pre>'], ['quote', '<blockquote>', '</blockquote>']];
  const TG_COMBOS = [['script_u', '<u>', '</u>', 'script'], ['double_spoiler', '<tg-spoiler>', '</tg-spoiler>', 'double'], ['sans_s', '<s>', '</s>', 'sansbolditalic'],
    ['circled_u', '<u>', '</u>', 'circled'], ['smallcaps_b', '<b>', '</b>', 'smallcaps'], ['fraktur_quote', '<blockquote>', '</blockquote>', 'boldfraktur']];
  /* the 🎨 Special page's Telegram styles: a quote that folds, a code block with a language */
  const TG_EXTRA = [['expand', '<blockquote expandable>', '</blockquote>'], ['codelang', '<pre><code class="language-python">', '</code></pre>']];
  const TG_PERSIAN = [['fa_bu', '<b><u>', '</u></b>', 'kashida'], ['fa_i', '<i>', '</i>', 'kmarks'], ['fa_spoiler', '<tg-spoiler>', '</tg-spoiler>', 'kheart'],
    ['fa_quote', '<blockquote>', '</blockquote>', 'crown']];

  /*
   * Everything for `text`, by page: tg [[code, open, close, text]] (Telegram's styles, then over fonts),
   * uni / look / mark / fa [[code, styled]], combo / frame [styled]. Pages that don't apply are left out.
   */
  function render(text) {
    const s = String(text || '');
    const hasLatin = LATIN_CHAR.test(s);
    const hasArabic = ARABIC.test(s);
    const letters = hasLatin || OTHER_LETTER.test(s);
    const pages = { tg: TELEGRAM.map(([code, open, close]) => [code, open, close, s]) };
    if (hasLatin) pages.tg.push(...TG_COMBOS.map(([code, open, close, style]) => [code, open, close, styled(s, style)]));
    if (hasArabic) pages.tg.push(...TG_PERSIAN.map(([code, open, close, style]) => [code, open, close, PERSIAN_FN.get(style)(s)]));
    if (hasLatin) {
      pages.uni = LATIN.filter(([code]) => !(hasArabic && (code === 'upside' || code === 'mirror'))).map(([code]) => [code, styled(s, code)]);
      pages.look = LOOK.map(([code]) => [code, styled(s, code)]);
      pages.mix = MIX.map(([code, fn]) => [code, fn(s)]);
    }
    if (letters) pages.mark = [...MARKS.map(([code]) => [code, marked(s, code)]), ...SEPS.map(([code, sign]) => [`s_${code}`, between(s, sign)])];
    if (hasArabic) pages.fa = PERSIAN.map(([code, fn]) => [code, fn(s)]);
    pages.combo = [...(hasArabic ? PERSIAN_COMBOS.map(([p, f]) => ends(PERSIAN_FN.get(p)(s), f)) : []), ...(hasLatin ? COMBOS.map(combo, s) : [])];
    if (!pages.combo.length) pages.combo = FRAMES.slice(0, 12).map((f, i) => frame(between(s, i % 2 ? '✦' : ' '), i));
    pages.frame = FRAMES.map((f, i) => frame(s, i));
    /* 🎨 Special: [type, code, text, open, close] — h a heading · tg a Telegram style · u m p a labelled line · n a numbered one */
    const x = [['h', 'tg'], ...TG_EXTRA.map(([code, open, close]) => ['tg', code, s, open, close])];
    if (hasLatin) {
      x.push(['h', 'fonts'], ...XLATIN.map(([code]) => ['u', code, styled(s, code)]));
      x.push(['h', 'combo'], ...XCOMBOS.map((c, i) => ['n', i + 1, combo.call(s, c)]));
    }
    if (letters) x.push(['h', 'marks'], ...XGLITCH.map(([code, n]) => ['m', code, zalgo(s, n)]), ...XMARKS.map(([code]) => ['m', code, marked(s, code)]));
    if (hasArabic) {
      x.push(['h', 'fa'], ...PERSIAN_EXTRA.map(([code, fn]) => ['p', code, fn(s)]));
      x.push(['h', 'facombo'], ...PERSIAN_XCOMBOS.map(([p, f], i) => ['n', i + 1, ends(PERSIAN_FN.get(p)(s), f)]));
    }
    pages.extra = x;
    return { pages, hasLatin, hasArabic };
  }

  return {
    render, styled, marked, between, kashida, zalgo, PAGES: ['combo', 'mix', 'tg', 'uni', 'look', 'mark', 'fa', 'frame', 'extra'], MIX: MIX.map(([c]) => c),
    TG_EXTRA: TG_EXTRA.map(([c]) => c), XLATIN: XLATIN.map(([c]) => c), XMARKS: [...XGLITCH, ...XMARKS].map(([c]) => c), PERSIAN_EXTRA: PERSIAN_EXTRA.map(([c]) => c),
    XCOMBOS: XCOMBOS.length, PERSIAN_XCOMBOS: PERSIAN_XCOMBOS.length, XHEADS: ['tg', 'fonts', 'combo', 'marks', 'fa', 'facombo'],
    TELEGRAM: TELEGRAM.map(([c]) => c), TG_COMBOS: [...TG_COMBOS, ...TG_PERSIAN].map(([c]) => c), LATIN: LATIN.map(([c]) => c), LOOK: LOOK.map(([c]) => c),
    MARKS: [...MARKS.map(([c]) => c), ...SEPS.map(([c]) => `s_${c}`)], PERSIAN: PERSIAN.map(([c]) => c), FRAMES: FRAMES.length,
    COMBOS: COMBOS.length, PERSIAN_COMBOS: PERSIAN_COMBOS.length,
  };
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

/* ---------- symbolic hours and the meaning of numbers ---------- */

export const numbers = (() => {
  const pad2 = (n) => String(n).padStart(2, '0');
  const rev = (s) => [...s].reverse().join('');
  /* mirror hh:hh · reversed hh:(hh backwards) · triple: the minutes repeat the hour's last digit */
  function timeType(h, m) {
    const hh = pad2(h);
    const mm = pad2(m);
    if (hh === mm) return 'mirror';
    if (mm === rev(hh)) return 'reversed';
    if (mm[0] === mm[1] && mm[0] === hh[1]) return 'triple';
    return null;
  }
  const ALL_TIMES = [];
  for (let h = 0; h < 24; h += 1) for (let m = 0; m < 60; m += 1) if (timeType(h, m)) ALL_TIMES.push([h, m, timeType(h, m)]);
  const listOf = (type) => ALL_TIMES.filter((x) => x[2] === type).map(([h, m]) => `${pad2(h)}:${pad2(m)}`);
  const MIRROR = listOf('mirror');
  const REVERSED = listOf('reversed');
  const TRIPLE = listOf('triple');
  /* the symbolic times after hh:mm today (at most n) */
  const next = (h, m, n = 3) => ALL_TIMES.filter(([a, b]) => a * 60 + b > h * 60 + m).slice(0, n).map(([a, b, type]) => ({ time: `${pad2(a)}:${pad2(b)}`, type }));
  /* «11:11», «۱۱:۱۱», «11.11», «1111» → { h, m } (digits already ASCII) */
  function parseTime(text) {
    const s = String(text || '').trim();
    const x = /^(\d{1,2})\s*[:.٫,]\s*(\d{2})$/.exec(s) || /^(\d{2})(\d{2})$/.exec(s);
    if (!x) return null;
    const h = Number(x[1]);
    const m = Number(x[2]);
    return h < 24 && m < 60 ? { h, m } : null;
  }
  /* the meaning key of a time: index in its list */
  function timeKey(h, m) {
    const type = timeType(h, m);
    if (!type) return null;
    const at = `${pad2(h)}:${pad2(m)}`;
    return { type, i: { mirror: MIRROR, reversed: REVERSED, triple: TRIPLE }[type].indexOf(at), digit: Number(pad2(m)[1]) };
  }

  /* Numbers (digits as typed, leading zeros kept): their kinds, and which list holds their own meaning */
  const ANGEL_X = ['1010', '1212', '1122', '1221'];
  const SEQ_X = ['123', '1234', '2345', '3456', '4567', '5678', '6789', '12345', '4321', '12321'];
  function kinds(d) {
    const out = [];
    const same = d.length >= 2 && [...d].every((c) => c === d[0]);
    if (same) out.push('repeat');
    if (d.length === 3 && same) out.push('angel');
    const diffs = [...d].slice(1).map((c, i) => Number(c) - Number(d[i]));
    if (d.length >= 3 && diffs.every((x) => x === 1)) out.push('asc');
    if (d.length >= 3 && diffs.every((x) => x === -1)) out.push('desc');
    const half = Math.floor(d.length / 2);
    if (d.length >= 5 && d.length % 2 === 1 && diffs.slice(0, half).every((x) => x === 1) && diffs.slice(half).every((x) => x === -1)) out.push('peak');
    if (!same && d.length >= 3 && d === rev(d)) out.push('palin');
    if (d.length === 4 && d[0] === d[2] && d[1] === d[3] && d[0] !== d[1]) out.push('pair');
    if (ANGEL_X.includes(d) && !out.includes('angel')) out.push('angel');
    return out;
  }
  /* { list, i } of a number's own meaning, or null: rep2 (00–99), angel3 (000–999), rep4 (0000–9999), angelx, seqx */
  function own(d) {
    const same = [...d].every((c) => c === d[0]);
    if (same && d.length === 2) return { list: 'rep2', i: Number(d[0]) };
    if (same && d.length === 3) return { list: 'angel3', i: Number(d[0]) };
    if (same && d.length === 4) return { list: 'rep4', i: Number(d[0]) };
    if (ANGEL_X.includes(d)) return { list: 'angelx', i: ANGEL_X.indexOf(d) };
    if (SEQ_X.includes(d)) return { list: 'seqx', i: SEQ_X.indexOf(d) };
    return null;
  }
  /* the digits by how often they appear (most first), and the root number (1–9, or 11 / 22) */
  function digits(d) {
    const count = new Map();
    for (const c of d) count.set(c, (count.get(c) || 0) + 1);
    const order = [...count.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).map(([c, n]) => ({ digit: Number(c), n }));
    const sum = [...d].reduce((s, c) => s + Number(c), 0);
    return { order, sum, root: sum ? fal.reduce(sum) : 0 };
  }
  /* a number as typed: 1–6 digits */
  const parseNumber = (text) => (/^\d{1,6}$/.test(String(text || '').trim()) ? String(text).trim() : null);

  return { timeType, timeKey, parseTime, next, MIRROR, REVERSED, TRIPLE, ANGEL_X, SEQ_X, kinds, own, digits, parseNumber, pad2 };
})();

/* ---------- birth readings: birth month, Chinese zodiac, life path number, weekday ---------- */

export const birth = (() => {
  /* Persian (Jalali) → Gregorian, the usual arithmetic method: [year, month, day] */
  function toGregorian(jy0, jm, jd) {
    const div = (a, b) => Math.floor(a / b);
    const jy = jy0 + 1595;
    let days = -355668 + 365 * jy + div(jy, 33) * 8 + div((jy % 33) + 3, 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
    let gy = 400 * div(days, 146097);
    days %= 146097;
    if (days > 36524) {
      days -= 1;
      gy += 100 * div(days, 36524);
      days %= 36524;
      if (days >= 365) days += 1;
    }
    gy += 4 * div(days, 1461);
    days %= 1461;
    if (days > 365) {
      gy += div(days - 1, 365);
      days = (days - 1) % 365;
    }
    let gd = days + 1;
    const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
    const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm = 0;
    while (gm < 12 && gd > months[gm]) {
      gd -= months[gm];
      gm += 1;
    }
    return [gy, gm + 1, gd];
  }
  const valid = (y, m, d) => {
    const x = new Date(Date.UTC(y, m - 1, d));
    return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
  };
  /* A birth date as typed (y/m/d or d.m.y; a year below 1700 is Persian): { gy, gm, gd, cal, y, m, d } or null */
  function parseDate(text) {
    const raw = String(text || '').trim();
    if (!/^\d{1,4}([/.-]\d{1,4}){2}$/.test(raw)) return null;
    const n = raw.split(/[/.-]/).map(Number);
    let [y, m, d] = n[0] > 31 ? n : [n[2], n[1], n[0]];
    if (m > 12 && d <= 12) [m, d] = [d, m];
    if (y < 1000) return null;
    const cal = y < 1700 ? 'j' : 'g';
    if (m < 1 || m > 12 || d < 1 || d > 31 || (cal === 'j' && m > 6 && d > 30)) return null;
    const [gy, gm, gd] = cal === 'j' ? toGregorian(y, m, d) : [y, m, d];
    if (!valid(gy, gm, gd) || gy < 1900 || gy > 2100) return null;
    return { gy, gm, gd, cal, y, m, d };
  }
  /* 0 Sunday … 6 Saturday */
  const weekday = (gy, gm, gd) => new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay();
  /* every digit of the date added up, then reduced — 11, 22 and 33 are kept: { number, steps } */
  function lifePath(gy, gm, gd) {
    const all = `${gy}${String(gm).padStart(2, '0')}${String(gd).padStart(2, '0')}`;
    let x = [...all].reduce((sum, c) => sum + Number(c), 0);
    const steps = [x];
    while (x > 9 && ![11, 22, 33].includes(x)) {
      x = [...String(x)].reduce((sum, c) => sum + Number(c), 0);
      steps.push(x);
    }
    return { number: x, steps };
  }
  /* The Chinese year (from 4 February, Lichun): 0 Rat … 11 Pig; element 0 wood, fire, earth, metal, 4 water */
  const ANIMALS = ['🐀', '🐂', '🐅', '🐇', '🐉', '🐍', '🐎', '🐐', '🐒', '🐓', '🐕', '🐖'];
  function chinese(gy, gm = 6, gd = 1) {
    const year = gm < 2 || (gm === 2 && gd < 4) ? gy - 1 : gy;
    return { year, animal: (((year - 4) % 12) + 12) % 12, element: Math.floor(((((year - 4) % 10) + 10) % 10) / 2), yang: year % 2 === 0 };
  }
  /* how an animal fares in another animal's year: same (its own year) · clash (opposite) · best (secret friend) · good (same trio) · neutral */
  const SECRET = [[0, 1], [2, 11], [3, 10], [4, 9], [5, 8], [6, 7]];
  function relation(a, b) {
    if (a === b) return 'same';
    if (Math.abs(a - b) === 6) return 'clash';
    if (SECRET.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return 'best';
    return a % 4 === b % 4 ? 'good' : 'neutral';
  }
  const trio = (a) => [0, 1, 2].map((k) => (a % 4) + 4 * k).filter((x) => x !== a);
  return { toGregorian, parseDate, weekday, lifePath, chinese, relation, trio, ANIMALS };
})();

/* ---------- drawn readings: playing cards, runes, the I Ching, dice, Lenormand ---------- */

export const draw = (() => {
  /* n different picks out of `size` */
  function picks(size, n, rnd = Math.random) {
    const out = [];
    while (out.length < Math.min(n, size)) {
      const i = Math.floor(rnd() * size);
      if (!out.includes(i)) out.push(i);
    }
    return out;
  }
  /* Playing cards 0–51: suit × 13 + rank (suits ♥ ♦ ♣ ♠, ranks A, 2–10, J, Q, K) */
  const SUITS = ['♥️', '♦️', '♣️', '♠️'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const cardGlyph = (i) => `${RANKS[i % 13]}${SUITS[Math.floor(i / 13)]}`;
  /* The 24 runes of the Elder Futhark; eight look the same upside down and are never reversed */
  const RUNES = [...'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ'];
  const SAME_REVERSED = new Set([6, 8, 10, 11, 12, 15, 21, 22]);
  const runes = (n, rnd = Math.random) => picks(24, n, rnd).map((rune) => ({ rune, reversed: !SAME_REVERSED.has(rune) && rnd() < 0.3 }));
  /*
   * The I Ching by three coins: six throws from the bottom line up; heads 3, tails 2 — 6 old yin (changing),
   * 7 young yang, 8 young yin, 9 old yang (changing). The King Wen number comes from the two trigrams.
   */
  const TRIGRAM = { 111: 0, 100: 1, '010': 2, '001': 3, '000': 4, '011': 5, 101: 6, 110: 7 }; /* qian zhen kan gen kun xun li dui (lines bottom → top) */
  const KING_WEN = [[1, 25, 6, 33, 12, 44, 13, 10], [34, 51, 40, 62, 16, 32, 55, 54], [5, 3, 29, 39, 8, 48, 63, 60], [26, 27, 4, 52, 23, 18, 22, 41],
    [11, 24, 7, 15, 2, 46, 36, 19], [9, 42, 59, 53, 20, 57, 37, 61], [14, 21, 64, 56, 35, 50, 30, 38], [43, 17, 47, 31, 45, 28, 49, 58]]; /* [upper][lower] */
  const hexOf = (lines) => KING_WEN[TRIGRAM[lines.slice(3).join('')]][TRIGRAM[lines.slice(0, 3).join('')]];
  function iching(rnd = Math.random) {
    const throws = [...Array(6)].map(() => [0, 1, 2].reduce((sum) => sum + (rnd() < 0.5 ? 3 : 2), 0));
    const lines = throws.map((v) => (v % 2 ? 1 : 0));
    const changing = throws.map((v, i) => (v === 6 || v === 9 ? i + 1 : 0)).filter(Boolean);
    const moved = lines.map((l, i) => (changing.includes(i + 1) ? 1 - l : l));
    return { throws, lines, changing, hex: hexOf(lines), to: changing.length ? hexOf(moved) : 0 };
  }
  const hexGlyph = (n) => String.fromCodePoint(0x4DC0 + n - 1);
  /* Three dice: 3–18 */
  const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const dice = (rnd = Math.random) => [0, 1, 2].map(() => 1 + Math.floor(rnd() * 6));
  /* The 36 Lenormand cards (1 Rider … 36 Cross) */
  const LENORMAND = ['🏇', '☘️', '⛵', '🏠', '🌳', '☁️', '🐍', '⚰️', '💐', '🌾', '〰️', '🐦', '👶', '🦊', '🐻', '⭐', '🦢', '🐕', '🗼', '🌷', '⛰️', '🔀', '🐁', '❤️', '💍', '📖',
    '✉️', '👨', '👩', '⚜️', '☀️', '🌙', '🔑', '🐟', '⚓', '✝️'];
  return { picks, SUITS, RANKS, cardGlyph, RUNES, SAME_REVERSED, runes, hexOf, iching, hexGlyph, FACES, dice, LENORMAND };
})();

/* ---------- religious readings: istikhara with the Quran, istikhara with prayer beads, the prophets' fortune ---------- */

export const faith = (() => {
  let pages = null;
  const quran = () => pages || (pages = JSON.parse(utf8Text(inflateRaw(unbase64(QURAN)).data)));
  /* Opened at random: the first verse of a right-hand (odd) page of the Medina mushaf */
  function istikhara(rnd = Math.random) {
    const page = 1 + 2 * Math.floor(rnd() * 302);
    const [surah, ayah, text] = quran()[page - 1];
    return { page, surah, ayah, text };
  }
  const verse = (page) => {
    const [surah, ayah, text] = quran()[page - 1];
    return { page, surah, ayah, text };
  };
  const surahName = (n, lang) => (lang === 'fa' ? SURAH_FA : SURAH_EN)[n - 1];
  const surahArabic = (n) => SURAH_AR[n - 1];
  /* A translation of the verse in the language, fetched from the free api.alquran.cloud; null when it can't be had */
  const EDITION = { fa: 'fa.makarem', en: 'en.sahih', ru: 'ru.kuliev', fr: 'fr.hamidullah', zh: 'zh.jian' };
  async function translation(surah, ayah, lang) {
    try {
      const res = await fetch(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/${EDITION[lang] || EDITION.en}`);
      if (!res || !res.ok) return null;
      const j = await res.json();
      const text = j && j.data && j.data.text;
      return typeof text === 'string' && text.trim() ? text.trim().slice(0, 1200) : null;
    } catch {
      return null;
    }
  }
  /* Prayer beads: a handful (1–99) counted two by two — one left over is good, two left over is not */
  const tasbih = (rnd = Math.random) => {
    const beads = 1 + Math.floor(rnd() * 99);
    return { beads, good: beads % 2 === 1 };
  };
  const PROPHETS = 24;
  return { istikhara, verse, surahName, surahArabic, translation, EDITION, tasbih, PROPHETS };
})();

/* ---------- poetry readings: a quatrain of Khayyam or a dobeyti of Baba Taher, with its interpretation ---------- */

export const poems = (() => {
  const BOOKS = {
    khayyam: { chunks: KHAYYAM, count: KHAYYAM_COUNT, url: (n) => `https://ganjoor.net/khayyam/robaee/sh${n}` },
    babataher: { chunks: BABATAHER, count: BABATAHER_COUNT, url: (n) => `https://ganjoor.net/babataher/2beytiha/sh${n}` },
  };
  const cache = new Map();
  /* poem n (1-based, clamped) of a book: { n, v: [[line, line], [line, line]], f: interpretation, url } */
  function poem(book, n) {
    const b = BOOKS[book];
    const k = Math.max(1, Math.min(b.count, Math.floor(Number(n)) || 1));
    const i = Math.floor((k - 1) / POEMS_PER);
    const key = `${book}:${i}`;
    if (!cache.has(key)) cache.set(key, JSON.parse(utf8Text(inflateRaw(unbase64(b.chunks[i])).data)));
    const p = cache.get(key)[(k - 1) % POEMS_PER];
    return { n: k, v: p.v, f: p.f, url: b.url(k) };
  }
  const count = (book) => BOOKS[book].count;
  return { poem, count, BOOKS: Object.keys(BOOKS) };
})();

/* ---------- films, books and music: famous film lines, public-domain excerpts, recommendations ---------- */

export const culture = (() => {
  let data = null;
  const all = () => data || (data = JSON.parse(utf8Text(inflateRaw(unbase64(CULTURE)).data)));
  /* m films · u music · b books */
  const KINDS = { m: 'movies', u: 'music', b: 'books' };
  const items = (k) => all()[KINDS[k]];
  /* most common first, then by name — stable, so a button's index always means the same thing */
  const ranked = (values) => {
    const n = new Map();
    for (const v of values) n.set(v, (n.get(v) || 0) + 1);
    return [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  };
  const memo = new Map();
  const cached = (key, fn) => (memo.has(key) ? memo.get(key) : memo.set(key, fn()).get(key));
  const genres = (k) => cached(`g${k}`, () => ranked(items(k).flatMap((x) => x.g)));
  const langs = (k) => cached(`l${k}`, () => ranked(items(k).map((x) => x.l)));
  /* artists (music) and authors (books), by their name as credited */
  const people = (k) => (k === 'm' ? [] : cached(`a${k}`, () => ranked(items(k).map((x) => x.a))));
  /* the items a filter keeps: r everything · g<i> a genre · l<i> a language · a<i> an artist or author */
  function select(k, spec) {
    const m = /^([rgla])(\d*)$/.exec(String(spec || ''));
    if (!m || !KINDS[k]) return [];
    const i = Number(m[2]);
    if (m[1] === 'r') return items(k);
    if (m[1] === 'g') return genres(k)[i] ? items(k).filter((x) => x.g.includes(genres(k)[i])) : [];
    if (m[1] === 'l') return langs(k)[i] ? items(k).filter((x) => x.l === langs(k)[i]) : [];
    return people(k)[i] ? items(k).filter((x) => x.a === people(k)[i]) : [];
  }
  const dialogue = (n) => all().dialogues[Math.max(1, Math.min(all().dialogues.length, Math.floor(Number(n)) || 1)) - 1];
  const excerpt = (n) => all().excerpts[Math.max(1, Math.min(all().excerpts.length, Math.floor(Number(n)) || 1)) - 1];
  const verse = (n) => all().verses[Math.max(1, Math.min(all().verses.length, Math.floor(Number(n)) || 1)) - 1];
  const count = (what) => all()[what].length;
  return { all, KINDS, items, genres, langs, people, select, dialogue, excerpt, verse, count };
})();

/* ---------- questionnaires: personality tests, spiritual games, the two-person tests ---------- */

/*
 * Each test: its group, icon, number of questions (n), and either a scale (3 or 4 answers to a statement) or a number of options.
 * Answers are digits (the answer's index), carried in callback_data, so nothing is stored. The texts are in the locales (ptest).
 * kinds: axes (four letters) · top (the dimension most agreed with; dim(i) gives a statement's dimension) · choice (each option counts
 * for one dimension, map[i][j]) · band (a total cut into three; rev: statements counted backwards) · pts (points per option) ·
 * attach (two totals) · chakra (strongest and weakest) · story (each answer is a piece of a story).
 */
export const tests = (() => {
  const T = {
    type: { g: 'self', icon: '🧩', n: 12, opts: 2, kind: 'axes' },
    ennea: { g: 'self', icon: '🔢', n: 9, scale: 3, kind: 'top', dims: 9, dim: (i) => i },
    attach: { g: 'self', icon: '🤝', n: 8, scale: 3, kind: 'attach' },
    esteem: { g: 'self', icon: '🌟', n: 8, scale: 4, kind: 'band', rev: [4, 5, 6, 7], cuts: [12, 19] },
    intro: { g: 'self', icon: '🌗', n: 8, scale: 3, kind: 'band', rev: [0, 1, 2, 3], cuts: [6, 11] },
    eq: { g: 'self', icon: '💗', n: 8, opts: 3, kind: 'pts', pts: [[2, 1, 0], [2, 0, 1], [0, 2, 1], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 2, 0], [2, 0, 1]], cuts: [7, 12] },
    love: { g: 'self', icon: '💝', n: 10, opts: 2, kind: 'choice', dims: 5, map: [[0, 1], [2, 3], [4, 0], [1, 2], [3, 4], [0, 2], [1, 3], [4, 1], [2, 0], [3, 4]] },
    risk: { g: 'self', icon: '🎲', n: 6, opts: 3, kind: 'pts', pts: Array(6).fill([0, 1, 2]), cuts: [5, 9] },
    dstyle: { g: 'self', icon: '🧭', n: 8, scale: 3, kind: 'top', dims: 4, dim: (i) => Math.floor(i / 2) },
    jealous: { g: 'self', icon: '💚', n: 6, scale: 3, kind: 'band', rev: [], cuts: [4, 8] },
    life: { g: 'self', icon: '🌍', n: 8, scale: 3, kind: 'top', dims: 4, dim: (i) => Math.floor(i / 2) },
    recall: { g: 'self', icon: '🌙', n: 6, scale: 3, kind: 'band', rev: [], cuts: [4, 8] },
    animal: { g: 'spirit', icon: '🐾', n: 6, opts: 4, kind: 'choice', dims: 8, map: [[0, 1, 2, 3], [4, 5, 6, 7], [1, 5, 6, 4], [0, 3, 7, 2], [3, 1, 5, 4], [2, 6, 7, 0]] },
    aura: { g: 'spirit', icon: '🌈', n: 6, opts: 4, kind: 'choice', dims: 7, map: [[0, 2, 4, 6], [1, 3, 4, 5], [0, 1, 3, 5], [2, 3, 5, 6], [0, 2, 6, 4], [1, 3, 5, 2]] },
    chakra: { g: 'spirit', icon: '🌀', n: 7, scale: 3, kind: 'chakra' },
    past: { g: 'spirit', icon: '⏳', n: 5, opts: 4, kind: 'story' },
    energy: { g: 'spirit', icon: '🔋', n: 6, scale: 3, kind: 'band', rev: [], cuts: [5, 9] },
    match: { g: 'two', icon: '💞', n: 8, opts: 3, kind: 'pair' },
    knowme: { g: 'two', icon: '🎯', n: 6, opts: 4, kind: 'pair' },
  };
  const CODES = Object.keys(T);
  const of = (code) => T[code] || null;
  const inGroup = (g) => CODES.filter((c) => T[c].g === g);
  const choices = (q) => q.scale || q.opts;
  /* true when `answers` is a valid (possibly unfinished) answer string for the test */
  const valid = (q, answers) => !!q && typeof answers === 'string' && answers.length <= q.n && [...answers].every((c) => /^\d$/.test(c) && Number(c) < choices(q));
  const band = (score, cuts) => (score < cuts[0] ? 0 : score < cuts[1] ? 1 : 2);
  const AXES = ['EI', 'SN', 'TF', 'JP'];
  /* the result of a finished test (null when unfinished or invalid) */
  function result(code, answers) {
    const q = of(code);
    if (!valid(q, answers) || answers.length !== q.n) return null;
    const a = [...answers].map(Number);
    if (q.kind === 'axes') {
      const letters = AXES.map((pair, x) => {
        const firsts = a.filter((v, i) => i % 4 === x && v === 0).length;
        return firsts * 2 > a.filter((v, i) => i % 4 === x).length ? pair[0] : pair[1];
      });
      return { kind: 'axes', type: letters.join('') };
    }
    if (q.kind === 'top' || q.kind === 'choice') {
      const counts = Array(q.dims).fill(0);
      a.forEach((v, i) => { if (q.kind === 'top') counts[q.dim(i)] += v; else counts[q.map[i][v]] += 1; });
      const order = counts.map((c, i) => [c, i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
      return { kind: 'top', top: order[0][1], second: order[1][0] === order[0][0] ? order[1][1] : null, counts };
    }
    if (q.kind === 'band') {
      const score = a.reduce((sum, v, i) => sum + ((q.rev || []).includes(i) ? (q.scale - 1) - v : v), 0);
      return { kind: 'band', band: band(score, q.cuts), score };
    }
    if (q.kind === 'pts') {
      const score = a.reduce((sum, v, i) => sum + q.pts[i][v], 0);
      return { kind: 'band', band: band(score, q.cuts), score };
    }
    if (q.kind === 'attach') {
      const anx = a.slice(0, 4).reduce((x, y) => x + y, 0);
      const avo = a.slice(4).reduce((x, y) => x + y, 0);
      return { kind: 'band', band: (anx >= 5 ? 1 : 0) + (avo >= 5 ? 2 : 0), anx, avo };
    }
    if (q.kind === 'chakra') {
      const order = a.map((v, i) => [v, i]);
      const strong = [...order].sort((x, y) => y[0] - x[0] || x[1] - y[1])[0][1];
      const weak = [...order].filter(([, i]) => i !== strong).sort((x, y) => x[0] - y[0] || x[1] - y[1])[0][1];
      return { kind: 'chakra', strong, weak };
    }
    if (q.kind === 'story') return { kind: 'story', parts: a };
    return { kind: 'pair', answers: a };
  }
  /* the two-person tests: how many answers are the same */
  const same = (a, b) => [...a].filter((c, i) => c === b[i]).length;
  return { CODES, of, inGroup, choices, valid, result, same, AXES };
})();

/* ---------- dreams: the dictionary of symbols (texts in the locales, dreamlist) and the private dream journal ---------- */

export const DREAMS = [
  ['water', '💧'], ['sea', '🌊'], ['river', '🏞'], ['rain', '🌧'], ['fire', '🔥'], ['snake', '🐍'],
  ['dog', '🐕'], ['cat', '🐈'], ['horse', '🐎'], ['bird', '🐦'], ['fish', '🐟'], ['spider', '🕷'],
  ['lion', '🦁'], ['wolf', '🐺'], ['baby', '👶'], ['wedding', '💍'], ['death', '🕯'], ['funeral', '⚱️'],
  ['flying', '🕊'], ['falling', '⬇️'], ['chased', '🏃'], ['teeth', '🦷'], ['hair', '💇'], ['blood', '🩸'],
  ['money', '💰'], ['gold', '🥇'], ['house', '🏠'], ['door', '🚪'], ['key', '🔑'], ['car', '🚗'],
  ['train', '🚆'], ['airplane', '✈️'], ['road', '🛣'], ['bridge', '🌉'], ['mountain', '⛰'], ['tree', '🌳'],
  ['flower', '🌸'], ['garden', '🌷'], ['moon', '🌙'], ['sun', '☀️'], ['star', '⭐'], ['light', '💡'],
  ['dark', '🌑'], ['exam', '📝'], ['naked', '🫣'], ['mirror', '🪞'], ['phone', '📱'], ['letter', '✉️'],
  ['food', '🍲'], ['bread', '🍞'], ['fruit', '🍎'], ['egg', '🥚'], ['milk', '🥛'], ['shoes', '👟'],
  ['clothes', '👗'], ['ring', '💎'], ['king', '👑'], ['police', '👮'], ['thief', '🦹'], ['war', '⚔️'],
  ['knife', '🔪'], ['ghost', '👻'], ['angel', '😇'], ['mother', '👩'], ['father', '👨'], ['ex', '💔'],
  ['friend', '🤝'], ['stranger', '🕴'], ['doctor', '🏥'], ['sick', '🤒'], ['pregnant', '🤰'], ['kiss', '💋'],
  ['crying', '😢'], ['laughing', '😂'], ['earthquake', '🌋'], ['storm', '⛈'], ['snow', '❄️'], ['flood', '🌊'],
  ['forest', '🌲'], ['desert', '🏜'], ['island', '🏝'], ['ship', '🚢'], ['swimming', '🏊'], ['stairs', '🪜'],
  ['prison', '⛓'], ['lost', '🧭'], ['late', '⏰'], ['book', '📚'], ['gift', '🎁'], ['mouse', '🐭'],
  ['bee', '🐝'], ['butterfly', '🦋'],
];
export const DREAM_KEEP = 50;
export const DREAM_MAX = 1000;
export const dreamlog = {
  async add(userId, body, now = nowSec()) {
    await db.run(sql`INSERT INTO aegis_dreams (user_id, at, text) VALUES (${userId}, ${now}, ${String(body).slice(0, DREAM_MAX)})`);
    const n = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_dreams WHERE user_id = ${userId}`)).n);
    if (n > DREAM_KEEP) {
      await db.run(sql`DELETE FROM aegis_dreams WHERE id IN (SELECT id FROM aegis_dreams WHERE user_id = ${userId} ORDER BY id LIMIT ${n - DREAM_KEEP})`);
      return { n: DREAM_KEEP, trimmed: true };
    }
    return { n, trimmed: false };
  },
  recent: (userId, limit = 5) => db.all(sql`SELECT id, at, text FROM aegis_dreams WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`),
  count: async (userId) => Number((await db.get(sql`SELECT count(*) AS n FROM aegis_dreams WHERE user_id = ${userId}`)).n),
  clear: (userId) => db.run(sql`DELETE FROM aegis_dreams WHERE user_id = ${userId}`),
};

/* ---------- puzzles: secret code, hangman, films from emojis, flags, riddles, the genie, the escape room, the memory test ---------- */

export const puzzles = (() => {
  const ALPHABET = { en: 'abcdefghijklmnopqrstuvwxyz', fr: 'abcdefghijklmnopqrstuvwxyz', ru: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', fa: 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی' };
  /* the ways a word can be hidden in a language (Chinese idioms are only turned around) */
  const methods = (lang) => (ALPHABET[lang] ? ['rev', 'shift', 'num'] : ['rev']);
  function cipher(word, method, lang) {
    const abc = [...(ALPHABET[lang] || '')];
    const chars = [...String(word).toLowerCase()];
    if (method === 'rev') return chars.reverse().join('');
    if (method === 'shift') return chars.map((ch) => (abc.includes(ch) ? abc[(abc.indexOf(ch) + 1) % abc.length] : ch)).join('');
    return String(word).toLowerCase().split(/\s+/).map((w) => [...w].map((ch) => (abc.includes(ch) ? abc.indexOf(ch) + 1 : ch)).join('-')).join(' / ');
  }
  /* hangman: the buttons — the word's letters and others of the language, at most 21, shuffled */
  function letters(word, lang, others, rnd = Math.random) {
    const own = [...new Set([...String(word).toLowerCase()].filter((ch) => ch.trim()))];
    const pool = ALPHABET[lang] ? [...ALPHABET[lang]] : [...new Set(others.join(''))];
    const extra = pool.filter((ch) => !own.includes(ch)).sort(() => rnd() - 0.5).slice(0, Math.max(0, 21 - own.length));
    return [...own, ...extra].slice(0, 21).sort(() => rnd() - 0.5);
  }
  const mask = (word, guessed) => [...String(word).toLowerCase()].map((ch) => (!ch.trim() ? ' ' : guessed.includes(ch) ? ch : '_')).join(' ');
  const solved = (word, guessed) => [...String(word).toLowerCase()].every((ch) => !ch.trim() || guessed.includes(ch));
  /* films from emojis: [emojis, the film's original title in the culture data] */
  const FILMS = [
  ['🚢🧊💔', 'Titanic'], ['🦁👑', 'The Lion King'], ['🐠🔍', 'Finding Nemo'],
  ['🦈🌊🏊', 'Jaws'], ['🦖🏞🚙', 'Jurassic Park'], ['⭐⚔🌌', 'Star Wars'],
  ['🧙⚡🪄', "Harry Potter and the Philosopher's Stone"], ['🤠🚀🧸', 'Toy Story'], ['🎈🏠👴', 'Up'],
  ['💊🕶💻', 'The Matrix'], ['🏠👦🎄', 'Home Alone'], ['👽🚲🌕', 'E.T. the Extra-Terrestrial'],
  ['🚗⚡⏰', 'Back to the Future'], ['👠🌪🦁', 'The Wizard of Oz'], ['🟢👹🐴', 'Shrek'],
  ['🍝🔫🌹', 'The Godfather'], ['💭🌀🏙', 'Inception'], ['🚀🌌⏳', 'Interstellar'],
  ['🏃🍫🍤', 'Forrest Gump'], ['🏨🪓❄', 'The Shining'], ['💀🎸🌼', 'Coco'],
  ['😀😢😡', 'Inside Out'], ['🤖🌱🚀', 'WALL-E'], ['🐉👧🛁', '千と千尋の神隠し'],
  ['🚿🔪🏨', 'Psycho'], ['👽🚀😱', 'Alien'], ['🥊🏃🎶', 'Rocky'],
  ['👟👦👧', 'بچه\u200cهای آسمان'], ['🐄👨', 'گاو'], ['🏜🪱', 'Dune'],
  ['🎹💃🌃', 'La La Land'], ['📺🏝👨', 'The Truman Show'], ['⏱🪖🏃', '1917'],
  ['🚤🪖🏖', 'Dunkirk'], ['🤡🪜🃏', 'Joker'], ['🦇🃏🌃', 'The Dark Knight'],
  ['⛓🔨🕳', 'The Shawshank Redemption'], ['📜👧🔴', "Schindler's List"], ['💼🍔💃', 'Pulp Fiction'],
  ['📸🖊🧠', 'Memento'], ['🗡🏛🦁', 'Gladiator'], ['🤖🕶⏳', 'The Terminator'],
  ['✈🎹🥂', 'Casablanca'], ['🪖🏖🔍', 'Saving Private Ryan'], ['💍🌋🧙', 'The Lord of the Rings: The Fellowship of the Ring'],
  ['🐑🤫🍷', 'The Silence of the Lambs'], ['🐭⚡🟢', 'The Green Mile'], ['🐿🔁⏰', 'Groundhog Day'],
  ['⚙🎩🏭', 'Modern Times'], ['☔🎤💃', "Singin' in the Rain"], ['🏡🍑🪨', 'Parasite'],
  ['🚆🧟😱', 'Train to Busan'], ['🐱🚌🌳', 'となりのトトロ'], ['🐺👸🌲', 'もののけ姫'],
  ['🚂🎲😄', 'La vita è bella'], ['🧚🌀🌿', 'El laberinto del fauno'], ['🥄🍮📸', "Le Fabuleux Destin d'Amélie Poulain"],
  ['♿🚗😂', 'Intouchables'], ['🚲🔎👦', 'Ladri di biciclette'], ['🐯🐉⚔', '臥虎藏龍'],
  ['💔⚖👴', 'جدایی نادر از سیمین'], ['🎈🐟💵', 'بادکنک سفید'], ['👦🦯🌈', 'رنگ خدا'],
  ['🐢🕊📡', 'لاک\u200Cپشت\u200Cها هم پرواز می\u200Cکنند'], ['⚽👧🏟', 'آفساید'], ['🦎👳🕌', 'مارمولک'],
  ['🎓🤓🤪', '3 Idiots'], ['🏏🌧💰', 'Lagaan'], ['🤼👧🥇', 'Dangal'],
  ['🥁⏱😤', 'Whiplash'], ['💻👍🎓', 'The Social Network'], ['💰❓🇮🇳', 'Slumdog Millionaire'],
  ['🤫👂👽', 'A Quiet Place'], ['🦴🚀🔴', '2001: A Space Odyssey'], ['👸🛵🍦', 'Roman Holiday'],
  ['⛓🤠🐎', 'Django Unchained'],
  ];
  /* riddles: their questions and answers are in the locales (gamelist.rq_<i>, gamelist.ra_<i>) */
  const RIDDLES = 48;
  /* flags: ISO codes; the flag is the two regional indicator letters */
  const COUNTRIES = ['ir', 'af', 'tj', 'tr', 'iq', 'sa', 'ae', 'eg', 'ma', 'dz', 'us', 'ca', 'mx', 'br', 'ar', 'cl', 'co', 'gb', 'ie', 'fr', 'de', 'it', 'es', 'pt', 'nl', 'be', 'ch', 'at', 'se', 'no', 'fi', 'dk', 'pl', 'ua', 'ru', 'gr', 'cn', 'jp', 'kr', 'in', 'pk', 'id', 'th', 'vn', 'au', 'nz', 'za', 'ng', 'ke', 'az'];
  const flagOf = (code) => [...code.toUpperCase()].map((ch) => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join('');
  /*
   * The genie: animals and their answers to the 12 questions (mammal, flies, water, bigger than a person, eats meat, a pet, a farm
   * animal, stripes or spots, Africa, four legs, insect, fast). Each next question is the one that best splits the animals still
   * possible, so the questions follow from the answers alone: y yes · n no · d not sure; then guesses: Y right · N wrong.
   */
  const ANIMALS = {
  dog: '100011000101', cat: '100011000101', horse: '100100100101', cow: '100100110100',
  sheep: '100000100100', chicken: '000000100000', lion: '100110001101', tiger: '100110010101',
  elephant: '100100001100', giraffe: '100100011100', zebra: '100100011101', bear: '100110000100',
  wolf: '100010000101', rabbit: '100001000101', mouse: '100000000100', monkey: '100000001000',
  eagle: '010010000001', owl: '010010010000', parrot: '010001000000', penguin: '001010000000',
  shark: '001110000001', dolphin: '101110000001', whale: '101110000000', goldfish: '001001000000',
  snake: '000010010000', frog: '001010010000', butterfly: '010000010010', bee: '010000010010',
  camel: '100100101100', kangaroo: '100100000001', cheetah: '100010011101', crocodile: '001110001100',
  };
  const NAMES = Object.keys(ANIMALS);
  const GUESSES = 3;
  function genie(answers) {
    let cands = NAMES;
    const asked = [];
    let i = 0;
    const qs = [...answers].filter((c) => 'ynd'.includes(c));
    const gs = [...answers].filter((c) => 'YN'.includes(c));
    for (;;) {
      const free = [...Array(12).keys()].filter((q) => !asked.includes(q));
      const best = free.map((q) => [q, Math.abs(cands.filter((a) => ANIMALS[a][q] === '1').length * 2 - cands.length)])
        .filter(([q]) => { const yes = cands.filter((a) => ANIMALS[a][q] === '1').length; return yes > 0 && yes < cands.length; })
        .sort((x, y) => x[1] - y[1] || x[0] - y[0])[0];
      if (cands.length <= 1 || !best) break;
      if (i >= qs.length) return { ask: best[0], n: asked.length + 1 };
      const a = qs[i];
      asked.push(best[0]);
      if (a !== 'd') cands = cands.filter((x) => ANIMALS[x][best[0]] === (a === 'y' ? '1' : '0'));
      i += 1;
      if (!cands.length) return { lost: true };
    }
    const guesses = cands.slice(0, GUESSES);
    if (gs.includes('Y')) return { won: guesses[gs.indexOf('Y')], n: asked.length };
    if (gs.length >= guesses.length) return { lost: true };
    return { guess: guesses[gs.length], n: asked.length };
  }
  /* the escape room: node → the nodes its choices lead to; 7 is the way out, 8 the wrong end */
  const ESCAPE = { 0: [1, 2, 3], 1: [4, 3], 2: [5, 1], 3: [1, 2], 4: [6, 3], 5: [0], 6: [7, 8], 7: [], 8: [] };
  /* the memory test: nine emojis; a sequence is six of their indices */
  const MEMO = ['🍎', '🚗', '🐶', '⭐', '🎈', '🌙', '🔑', '🎵', '🌵'];
  const sequence = (n = 6, rnd = Math.random) => [...Array(n)].map(() => Math.floor(rnd() * MEMO.length)).join('');
  /* crime cases: the guilty suspect of each (its texts are in the locales: gamelist.cs_*) */
  const CASES = [0, 1, 2, 1, 2, 1, 1, 0, 2, 0, 1, 2, 0, 1, 2, 0];
  /* «who am I?»: famous people, four clues each (gamelist.wa_*) */
  const PEOPLE = ['ferdowsi', 'avicenna', 'rumi', 'cyrus', 'khayyam', 'einstein', 'curie', 'newton', 'davinci', 'shakespeare',
    'mozart', 'gandhi', 'napoleon', 'cleopatra', 'confucius', 'tolstoy', 'gagarin', 'armstrong', 'chaplin', 'edison',
    'hafez', 'saadi', 'razi', 'khwarizmi', 'darius', 'beethoven', 'picasso', 'vangogh', 'galileo', 'darwin',
    'columbus', 'marcopolo', 'tesla', 'hugo', 'pushkin', 'lincoln', 'mandela', 'caesar', 'verne', 'nightingale'];
  /* virtual travel: [code, country for the flag, latitude, longitude] (gamelist.tp_*) */
  const PLACES = [['uyuni', 'bo', -20.13, -67.49], ['pamukkale', 'tr', 37.92, 29.12], ['socotra', 'ye', 12.46, 53.82], ['danakil', 'et', 14.24, 40.3],
    ['zhangjiajie', 'cn', 29.32, 110.43], ['antelope', 'us', 36.86, -111.37], ['lut', 'ir', 30.38, 58.32], ['hormuz', 'ir', 27.06, 56.46],
    ['badab', 'ir', 36.06, 53.2], ['kandovan', 'ir', 37.79, 46.25], ['cappadocia', 'tr', 38.64, 34.83], ['petra', 'jo', 30.33, 35.44],
    ['causeway', 'gb', 55.24, -6.51], ['plitvice', 'hr', 44.88, 15.62], ['halong', 'vn', 20.91, 107.18], ['hillier', 'au', -34.09, 123.2],
    ['whitedesert', 'eg', 27.32, 28.13], ['bluehole', 'bz', 17.32, -87.53], ['crooked', 'pl', 53.21, 14.48], ['waitomo', 'nz', -38.26, 175.1],
    ['darvaza', 'tm', 40.25, 58.44], ['spotted', 'ca', 49.08, -119.57], ['meteora', 'gr', 39.72, 21.63], ['easter', 'cl', -27.12, -109.37],
    ['naqshejahan', 'ir', 32.66, 51.68], ['shushtar', 'ir', 32.05, 48.85], ['qeshm', 'ir', 26.82, 55.9], ['masuleh', 'ir', 37.15, 48.99],
    ['iguazu', 'ar', -25.69, -54.44], ['victoria', 'zm', -17.92, 25.86], ['grandcanyon', 'us', 36.1, -112.11], ['jokulsarlon', 'is', 64.05, -16.18],
    ['redbeach', 'cn', 40.87, 121.86], ['tianmen', 'cn', 29.05, 110.48], ['moraine', 'ca', 51.32, -116.19], ['marblecaves', 'cl', -46.65, -72.62],
    ['deadvlei', 'na', -24.76, 15.29], ['santorini', 'gr', 36.4, 25.43], ['machupicchu', 'pe', -13.16, -72.55], ['angkor', 'kh', 13.41, 103.87]];
  const mapUrl = ([, , lat, lon]) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=11/${lat}/${lon}`;
  /* the parallel world: one of the 12 items of each list (gamelist.pw_*) */
  const PARALLEL = ['job', 'place', 'power', 'pet', 'twist'];
  /* the treasure hunt: a 5 × 5 field; how close a square is to the treasure (squares around it count as 1) */
  const FIELD = 5;
  const DIGS = 3;
  const away = (a, b) => Math.max(Math.abs((a % FIELD) - (b % FIELD)), Math.abs(Math.floor(a / FIELD) - Math.floor(b / FIELD)));
  const HEAT = ['💎', '🔥', '♨️', '🌫', '🧊'];
  /* the code hunt: four different digits; a guess scores the digits in the right place and the right digits elsewhere */
  const secret = (rnd = Math.random) => [...'0123456789'].sort(() => rnd() - 0.5).slice(0, 4).join('');
  function score(guess, code) {
    const g = [...String(guess)];
    const a = g.filter((d, i) => d === code[i]).length;
    const b = [...new Set(g)].filter((d) => code.includes(d)).length - a;
    return { a, b: Math.max(0, b) };
  }
  return { ALPHABET, methods, cipher, letters, mask, solved, FILMS, RIDDLES, COUNTRIES, flagOf, ANIMALS, NAMES, genie, ESCAPE, MEMO, sequence,
    CASES, PEOPLE, PLACES, mapUrl, PARALLEL, FIELD, DIGS, away, HEAT, secret, score };
})();
