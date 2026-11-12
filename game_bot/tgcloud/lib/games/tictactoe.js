/*
 * Tic-tac-toe for two seats. Seat 0 is ❌, seat 1 is ⭕; who moves first alternates every round
 * (rematch). Pure: the room layer stores the state and enforces timers.
 *
 * state: b board (9 chars . X O), turn seat to move (-1 when the round is over), first the seat
 * that opened this round, w winner seat / 'draw' / null, line winning cells, score [wins0, wins1,
 * draws], round, log / seq events for the client's animations.
 * action: { type: 'mark', cell: 0-8 }
 */
import { clone, logEvent, randInt } from './util.js';

export const SEATS = 2;
export const TURN_SEC = 45;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const MARK = ['X', 'O'];

export function winLine(b) {
  for (const l of LINES) {
    if (b[l[0]] !== '.' && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return l;
  }
  return null;
}

function round(first, score, n) {
  return { b: '.........', turn: first, first, w: null, line: null, score, round: n, log: [], seq: 0 };
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
  if (!action || action.type !== 'mark') return { error: 'BAD_ACTION' };
  const cell = action.cell;
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { error: 'BAD_ACTION' };
  if (state.b[cell] !== '.') return { error: 'CELL_TAKEN' };
  const s = clone(state);
  s.b = s.b.slice(0, cell) + MARK[seat] + s.b.slice(cell + 1);
  logEvent(s, { type: 'mark', seat, cell });
  const line = winLine(s.b);
  if (line) {
    s.w = seat;
    s.line = line;
    s.turn = -1;
    s.score[seat] += 1;
    logEvent(s, { type: 'win', seat, line });
  } else if (!s.b.includes('.')) {
    s.w = 'draw';
    s.turn = -1;
    s.score[2] += 1;
    logEvent(s, { type: 'draw' });
  } else {
    s.turn = 1 - seat;
  }
  return { state: s };
}

/*
 * The bot's move (also made for a player who ran out of time): win if it can, else block, else the
 * centre, a corner, anything — and one move in five is random, so it can be beaten.
 */
export function auto(state, seat, rng) {
  const free = [];
  for (let i = 0; i < 9; i += 1) if (state.b[i] === '.') free.push(i);
  const completes = (mark) => free.find((i) => winLine(state.b.slice(0, i) + mark + state.b.slice(i + 1)));
  let cell = completes(MARK[seat]);
  if (cell === undefined && rng() < 0.2) cell = free[randInt(free.length, rng)];
  if (cell === undefined) cell = completes(MARK[1 - seat]);
  if (cell === undefined && state.b[4] === '.') cell = 4;
  if (cell === undefined) {
    const corners = free.filter((i) => i === 0 || i === 2 || i === 6 || i === 8);
    const pool = corners.length ? corners : free;
    cell = pool[randInt(pool.length, rng)];
  }
  return { type: 'mark', cell };
}

/* null while playing; else { winners: [seat], draw } for this round. */
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
