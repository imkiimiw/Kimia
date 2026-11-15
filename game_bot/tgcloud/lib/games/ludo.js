/*
 * Ludo (mench) for 2 to 4 seats. The die is rolled with the `rng` the server passes. Pure.
 *
 * Each player has four pieces in a base. A 6 brings a piece onto the player's start cell; pieces
 * then travel the 52-cell ring (51 steps for each player), turn into their own 5-cell home column
 * and reach home with an exact roll (56 steps in all). Landing on a cell with other players' pieces
 * sends those back to their base, except on the eight safe cells (the four start cells and the four
 * stars). A 6, a capture and a piece reaching home each give another roll — but a third 6 in a row
 * ends the turn. The first player with all four pieces home wins.
 *
 * To keep a polled game quick, a roll with no legal move passes by itself and a roll with only one
 * possible move is played by itself; the player chooses only when there is a real choice.
 *
 * Positions are steps from the player's own start: -1 in the base, 0..50 on the ring, 51..55 in the
 * home column, 56 home. absCell(seat, steps) is the ring cell (0..51), shared by all players.
 * state: pos [seat][4] (null for an empty seat), active (the seats playing), turn, phase (roll /
 * move / over), die (the last roll), sixes (in a row this turn), winner, log / seq.
 * actions: { type: 'roll' }   { type: 'move', piece: 0-3 }
 */
import { clone, logEvent, randInt } from './util.js';

export const SEATS = 4;
export const MIN_SEATS = 2;
export const TURN_SEC = 30;
export const LEAVER_BECOMES_BOT = true;
export const HOME = 56;
export const RING = 52;
export const START = [0, 13, 26, 39];
export const SAFE = [0, 8, 13, 21, 26, 34, 39, 47];

export const absCell = (seat, steps) => (START[seat] + steps) % RING;

/* The moves `seat` can make with `die`: [{ piece, from, to }]. */
export function legalMoves(state, seat, die) {
  const out = [];
  state.pos[seat].forEach((p, piece) => {
    if (p === -1) {
      if (die === 6) out.push({ piece, from: -1, to: 0 });
    } else if (p < HOME && p + die <= HOME) {
      out.push({ piece, from: p, to: p + die });
    }
  });
  return out;
}

/* The pieces a move to `to` would send back: [{ seat, piece }]. */
export function captures(state, seat, to) {
  if (to > 50) return [];
  const cell = absCell(seat, to);
  if (SAFE.includes(cell)) return [];
  const out = [];
  for (const o of state.active) {
    if (o === seat) continue;
    state.pos[o].forEach((p, piece) => {
      if (p >= 0 && p <= 50 && absCell(o, p) === cell) out.push({ seat: o, piece });
    });
  }
  return out;
}

export function create(opts = {}, rng = Math.random) {
  const given = Array.isArray(opts.seats) ? opts.seats.filter((s) => Number.isInteger(s) && s >= 0 && s < SEATS) : [];
  const active = given.length >= MIN_SEATS ? given.slice().sort((a, b) => a - b) : [0, 1, 2, 3];
  const pos = [null, null, null, null];
  for (const s of active) pos[s] = [-1, -1, -1, -1];
  const s = { pos, active, turn: active[randInt(active.length, rng)], phase: 'roll', die: 0, sixes: 0, winner: null, log: [], seq: 0 };
  logEvent(s, { type: 'start', seat: s.turn });
  return s;
}

export function turn(state) {
  return state.phase === 'over' ? -1 : state.turn;
}

function nextSeat(s) {
  const i = s.active.indexOf(s.turn);
  s.turn = s.active[(i + 1) % s.active.length];
  s.phase = 'roll';
  s.sixes = 0;
}

function applyMove(s, seat, mv) {
  const taken = captures(s, seat, mv.to);
  for (const c of taken) s.pos[c.seat][c.piece] = -1;
  s.pos[seat][mv.piece] = mv.to;
  logEvent(s, { type: 'move', seat, piece: mv.piece, from: mv.from, to: mv.to, captured: taken });
  if (s.pos[seat].every((p) => p === HOME)) {
    s.phase = 'over';
    s.winner = seat;
    s.turn = -1;
    logEvent(s, { type: 'win', seat });
    return;
  }
  const bonus = s.die === 6 || taken.length > 0 || mv.to === HOME;
  const thirdSix = s.die === 6 && s.sixes >= 3;
  if (bonus && !thirdSix) s.phase = 'roll';
  else nextSeat(s);
}

export function act(state, seat, action, rng = Math.random) {
  if (state.phase === 'over') return { error: 'GAME_OVER' };
  if (seat !== state.turn) return { error: 'NOT_YOUR_TURN' };
  if (!action) return { error: 'BAD_ACTION' };
  if (action.type === 'roll') {
    if (state.phase !== 'roll') return { error: 'ALREADY_ROLLED' };
    const s = clone(state);
    s.die = 1 + randInt(6, rng);
    s.sixes = s.die === 6 ? s.sixes + 1 : 0;
    logEvent(s, { type: 'roll', seat, die: s.die });
    const moves = legalMoves(s, seat, s.die);
    const choices = new Set(moves.map((m) => m.from));
    if (!moves.length) {
      logEvent(s, { type: 'pass', seat });
      nextSeat(s);
    } else if (choices.size === 1) {
      applyMove(s, seat, moves[0]);
    } else {
      s.phase = 'move';
    }
    return { state: s };
  }
  if (action.type !== 'move' || !Number.isInteger(action.piece)) return { error: 'BAD_ACTION' };
  if (state.phase !== 'move') return { error: 'ROLL_FIRST' };
  const mv = legalMoves(state, seat, state.die).find((m) => m.piece === action.piece);
  if (!mv) return { error: 'ILLEGAL_MOVE' };
  const s = clone(state);
  applyMove(s, seat, mv);
  return { state: s };
}

/* The bot: capture, get home, leave the base, reach a safe cell, else move the piece furthest along. */
export function auto(state, seat, rng = Math.random) {
  if (state.phase === 'roll') return { type: 'roll' };
  const moves = legalMoves(state, seat, state.die);
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    let score = m.to / 10 + rng();
    if (captures(state, seat, m.to).length) score += 50;
    if (m.to === HOME) score += 40;
    if (m.from === -1) score += 30;
    if (m.to <= 50 && SAFE.includes(absCell(seat, m.to))) score += 10;
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return { type: 'move', piece: best.piece };
}

export function outcome(state) {
  return state.phase === 'over' ? { winners: [state.winner], draw: false } : null;
}

export function rematch(state, rng = Math.random) {
  return create({ seats: state.active }, rng);
}

export function view(state) {
  return state;
}
