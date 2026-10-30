/*
 * The solo games' server side.
 * Codeword: the answer never leaves the server until the game ends; each guess is checked against
 * the word lists (lib/words/*) and scored here. Daily: one word per language per UTC day.
 * Fusion: the server hands out a seed, the Mini App plays, then submits its moves; the server
 * replays them (lib/games/fusion.js) and only the replayed score counts. Too-fast games are refused.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as cw from './games/codeword.js';
import * as fusion from './games/fusion.js';
import { fail } from './endpoint.js';
import { bumpCounter, leaderboard, recordResult } from './store.js';
import * as en from './words/en.js';
import * as fa from './words/fa.js';
import * as fr from './words/fr.js';
import * as ru from './words/ru.js';

const LISTS = { en, fr, ru, fa };
const cache = {};

function words(lang) {
  if (!cache[lang]) {
    const answers = LISTS[lang].ANSWERS.split(' ');
    const all = new Set(answers);
    for (const w of LISTS[lang].GUESSES.split(' ')) all.add(w);
    cache[lang] = { answers, all };
  }
  return cache[lang];
}

/* ---------- Codeword ---------- */

function cwView(row) {
  const guesses = JSON.parse(row.guesses);
  return {
    mode: row.mode, lang: row.lang, day: Number(row.day), status: row.status, guesses, max: cw.MAX_GUESSES,
    answer: row.status === 'play' ? null : row.answer,
    points: row.status === 'won' ? cw.pointsFor(guesses.length) : 0,
  };
}

async function cwRow(userId, lang, mode, day) {
  return db.get(sql`SELECT * FROM codeword WHERE user_id = ${userId} AND lang = ${lang} AND mode = ${mode} AND day = ${day}`);
}

async function cwNew(userId, lang, mode, day, answer, chat, t) {
  await db.run(sql`INSERT INTO codeword (user_id, lang, mode, day, answer, guesses, status, chat, updated_at)
    VALUES (${userId}, ${lang}, ${mode}, ${day}, ${answer}, '[]', 'play', ${chat}, ${t})
    ON CONFLICT(user_id, lang, mode, day) DO UPDATE SET answer = excluded.answer, guesses = '[]', status = 'play', chat = excluded.chat, updated_at = excluded.updated_at`);
  return cwRow(userId, lang, mode, day);
}

/* input: { action: state | new | guess, mode: daily | free, lang, word } */
export async function codeword(input, env) {
  const lang = cw.LANGS.includes(input.lang) ? input.lang : env.user.lang;
  const mode = input.mode === 'free' ? 'free' : 'daily';
  const userId = env.user.user_id;
  const day = mode === 'daily' ? cw.dayKey(env.now * 1000) : 0;
  const list = words(lang);
  let row = await cwRow(userId, lang, mode, day);
  if (!row && mode === 'daily') {
    row = await cwNew(userId, lang, mode, day, list.answers[cw.dailyIndex(day, lang, list.answers.length)], env.chat, env.now);
  }
  if (mode === 'free' && (!row || input.action === 'new')) {
    row = await cwNew(userId, lang, mode, 0, list.answers[Math.floor(Math.random() * list.answers.length)], env.chat, env.now);
  }
  if (input.action !== 'guess') return cwView(row);
  if (row.status !== 'play') throw fail('GAME_OVER');
  const word = cw.normalize(lang, input.word);
  if (!cw.wellFormed(lang, word)) throw fail('BAD_WORD');
  if (!list.all.has(word)) throw fail('NOT_A_WORD');
  const guesses = JSON.parse(row.guesses);
  const s = cw.score(word, row.answer);
  guesses.push({ w: word, exact: s.exact, near: s.near });
  const status = s.exact === cw.LENGTH ? 'won' : (guesses.length >= cw.MAX_GUESSES ? 'lost' : 'play');
  const r = await db.run(sql`UPDATE codeword SET guesses = ${JSON.stringify(guesses)}, status = ${status}, updated_at = ${env.now}
    WHERE id = ${row.id} AND guesses = ${row.guesses}`);
  if (!r.rowsAffected) throw fail('STALE');
  if (status !== 'play') {
    const won = status === 'won';
    await recordResult(userId, 'codeword', { played: 1, wins: won ? 1 : 0, losses: won ? 0 : 1, score: won ? cw.pointsFor(guesses.length) : 0 }, row.chat);
    await bumpCounter('played_codeword');
  }
  return cwView({ ...row, guesses: JSON.stringify(guesses), status });
}

/* ---------- Fusion ---------- */

const MIN_MS_PER_MOVE = 120; /* faster than this is not a person tapping */

/* input: { action: start } or { action: submit, run, moves } */
export async function fusionGame(input, env) {
  const userId = env.user.user_id;
  if (input.action === 'start') {
    await db.run(sql`DELETE FROM fusion_runs WHERE id IN (SELECT id FROM fusion_runs WHERE created_at < ${env.now - 86400} LIMIT 20)`);
    const seed = Math.floor(Math.random() * 2147483647);
    const r = await db.run(sql`INSERT INTO fusion_runs (user_id, seed, chat, created_at) VALUES (${userId}, ${seed}, ${env.chat}, ${env.now}) RETURNING id`);
    return { run: Number(r.rows[0].id), seed };
  }
  if (input.action !== 'submit' || !Number.isInteger(input.run)) throw fail('BAD_ACTION');
  const run = await db.get(sql`SELECT * FROM fusion_runs WHERE id = ${input.run} AND user_id = ${userId}`);
  if (!run || run.status !== 'play') throw fail('NO_RUN');
  const result = fusion.replay(Number(run.seed), input.moves);
  if (result.error) throw fail(result.error);
  if (result.moves && (env.now - Number(run.created_at)) * 1000 < result.moves * MIN_MS_PER_MOVE) throw fail('TOO_FAST');
  const done = await db.run(sql`UPDATE fusion_runs SET status = 'done', score = ${result.score} WHERE id = ${run.id} AND status = 'play'`);
  if (!done.rowsAffected) throw fail('NO_RUN');
  await recordResult(userId, 'fusion', { played: 1, score: result.score }, run.chat, true);
  await bumpCounter('played_fusion');
  const board = await leaderboard('fusion', userId, null);
  return { score: result.score, best: board.me, rank: board.rank };
}
