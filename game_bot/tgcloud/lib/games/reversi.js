/*
 * Reversi for two seats on an 8×8 board. Seat 0 plays the dark discs. Pure.
 *
 * A move places a disc so that it encloses one or more straight lines of the opponent's discs
 * between it and another of the mover's discs; those are flipped. A player with no move passes
 * (automatically); when neither can move the game ends and the most discs win.
 *
 * state: b board (64 chars: . B W), turn seat (-1 when over), first the seat that opened this round,
 * count [dark, light], last the cell just played (-1), w winner seat / 'draw' / null, score
 * [wins0, wins1, draws], round, log / seq.
 * action: { type: 'place', cell: 0-63 }
 */
import { clone, logEvent, randInt } from './util.js';

export const SEATS = 2;
export const TURN_SEC = 60;
export const SIZE = 8;
const DISC = ['B', 'W'];
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/* The cells that flip if `seat` plays `cell` (empty: not a legal move). */
export function flips(b, cell, seat) {
  if (b[cell] !== '.') return [];
  const me = DISC[seat];
  const op = DISC[1 - seat];
  const r0 = Math.floor(cell / SIZE);
  const c0 = cell % SIZE;
  const out = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let r = r0 + dr;
    let c = c0 + dc;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && b[r * SIZE + c] === op) {
      line.push(r * SIZE + c);
      r += dr;
      c += dc;
    }
    if (line.length && r >= 0 && r < SIZE && c >= 0 && c < SIZE && b[r * SIZE + c] === me) out.push(...line);
  }
  return out;
}

export function legalMoves(b, seat) {
  const out = [];
  for (let i = 0; i < SIZE * SIZE; i += 1) if (b[i] === '.' && flips(b, i, seat).length) out.push(i);
  return out;
}

const counts = (b) => [b.split('B').length - 1, b.split('W').length - 1];

function round(first, score, n) {
  const cells = new Array(64).fill('.');
  cells[27] = 'W';
  cells[36] = 'W';
  cells[28] = 'B';
  cells[35] = 'B';
  return { b: cells.join(''), turn: first, first, count: [2, 2], last: -1, w: null, score, round: n, log: [], seq: 0 };
}

export function create() {
  return round(0, [0, 0, 0], 1);
}

export function turn(state) {
  return state.turn;
}

export function act(state, seat, action) {
  if (state.w !== null) return { error: 'GAME_OVER' };
  if (seat !== state.turn) return { error: 'NOT_YOUR_TURN' };
  if (!action || action.type !== 'place' || !Number.isInteger(action.cell) || action.cell < 0 || action.cell > 63) return { error: 'BAD_ACTION' };
  const turned = flips(state.b, action.cell, seat);
  if (!turned.length) return { error: 'ILLEGAL_MOVE' };
  const s = clone(state);
  const cells = s.b.split('');
  cells[action.cell] = DISC[seat];
  for (const i of turned) cells[i] = DISC[seat];
  s.b = cells.join('');
  s.count = counts(s.b);
  s.last = action.cell;
  logEvent(s, { type: 'place', seat, cell: action.cell, flips: turned });
  const other = 1 - seat;
  if (legalMoves(s.b, other).length) s.turn = other;
  else if (legalMoves(s.b, seat).length) logEvent(s, { type: 'pass', seat: other });
  else {
    s.turn = -1;
    s.w = s.count[0] === s.count[1] ? 'draw' : (s.count[0] > s.count[1] ? 0 : 1);
    if (s.w === 'draw') s.score[2] += 1;
    else s.score[s.w] += 1;
    logEvent(s, { type: 'end', w: s.w, count: s.count });
  }
  return { state: s };
}

/* Corners are precious, the cells next to an empty corner are dangerous, edges are good. */
function weight(b, cell) {
  const r = Math.floor(cell / SIZE);
  const c = cell % SIZE;
  const edgeR = r === 0 || r === 7;
  const edgeC = c === 0 || c === 7;
  if (edgeR && edgeC) return 30;
  const nearR = r <= 1 ? 0 : (r >= 6 ? 7 : -1);
  const nearC = c <= 1 ? 0 : (c >= 6 ? 7 : -1);
  if (nearR >= 0 && nearC >= 0 && b[nearR * SIZE + nearC] === '.') return -8;
  return edgeR || edgeC ? 4 : 0;
}

/* The bot's move (and the move made for a player out of time). */
export function auto(state, seat, rng) {
  const moves = legalMoves(state.b, seat);
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const score = flips(state.b, m, seat).length + weight(state.b, m) + rng() * 2;
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  if (rng() < 0.12) best = moves[randInt(moves.length, rng)];
  return { type: 'place', cell: best };
}

export function outcome(state) {
  if (state.w === null) return null;
  return state.w === 'draw' ? { winners: [], draw: true } : { winners: [state.w], draw: false };
}

export function rematch(state) {
  return round(1 - state.first, state.score.slice(), state.round + 1);
}

export function view(state) {
  return state;
}
