/*
 * Dots and boxes for two seats on a grid of N×N boxes. Pure.
 *
 * Players take turns drawing one line between two neighbouring dots. Whoever draws the fourth side
 * of a box owns it and must move again. When every box is owned, the most boxes win (N is odd, so
 * there is no draw).
 *
 * Lines: h[r * N + c] is the horizontal line above box (r, c) (r = 0..N: N + 1 rows of lines);
 * v[r * (N + 1) + c] is the vertical line left of box (r, c) (c = 0..N). '0' free, '1' drawn.
 * state: h, v, own (N×N chars: . 0 1), turn (-1 when over), first, count [boxes0, boxes1],
 * last { o, i } the line just drawn, w winner seat or null, score [wins0, wins1], round, log / seq.
 * action: { type: 'line', o: 'h' | 'v', i }
 */
import { clone, logEvent, randInt } from './util.js';

export const SEATS = 2;
export const TURN_SEC = 45;
export const N = 5;
export const H_LINES = (N + 1) * N;
export const V_LINES = N * (N + 1);

/* The boxes [r, c] a line belongs to (one or two). */
export function boxesOf(o, i) {
  const out = [];
  if (o === 'h') {
    const r = Math.floor(i / N);
    const c = i % N;
    if (r > 0) out.push([r - 1, c]);
    if (r < N) out.push([r, c]);
  } else {
    const r = Math.floor(i / (N + 1));
    const c = i % (N + 1);
    if (c > 0) out.push([r, c - 1]);
    if (c < N) out.push([r, c]);
  }
  return out;
}

/* How many sides of box (r, c) are drawn. */
export function sides(state, r, c) {
  return Number(state.h[r * N + c]) + Number(state.h[(r + 1) * N + c]) + Number(state.v[r * (N + 1) + c]) + Number(state.v[r * (N + 1) + c + 1]);
}

function round(first, score, n) {
  return { h: '0'.repeat(H_LINES), v: '0'.repeat(V_LINES), own: '.'.repeat(N * N), turn: first, first, count: [0, 0], last: null, w: null, score, round: n, log: [], seq: 0 };
}

export function create() {
  return round(0, [0, 0], 1);
}

export function turn(state) {
  return state.turn;
}

const valid = (a) => a && a.type === 'line' && (a.o === 'h' || a.o === 'v') && Number.isInteger(a.i) && a.i >= 0 && a.i < (a.o === 'h' ? H_LINES : V_LINES);

export function act(state, seat, action) {
  if (state.w !== null) return { error: 'GAME_OVER' };
  if (seat !== state.turn) return { error: 'NOT_YOUR_TURN' };
  if (!valid(action)) return { error: 'BAD_ACTION' };
  const { o, i } = action;
  if (state[o][i] !== '0') return { error: 'LINE_TAKEN' };
  const s = clone(state);
  s[o] = s[o].slice(0, i) + '1' + s[o].slice(i + 1);
  s.last = { o, i };
  const won = [];
  for (const [r, c] of boxesOf(o, i)) {
    if (sides(s, r, c) === 4) {
      const k = r * N + c;
      s.own = s.own.slice(0, k) + String(seat) + s.own.slice(k + 1);
      won.push(k);
    }
  }
  s.count[seat] += won.length;
  logEvent(s, { type: 'line', seat, o, i, boxes: won });
  if (s.count[0] + s.count[1] === N * N) {
    s.turn = -1;
    s.w = s.count[0] > s.count[1] ? 0 : 1;
    s.score[s.w] += 1;
    logEvent(s, { type: 'end', w: s.w, count: s.count });
  } else if (!won.length) {
    s.turn = 1 - seat;
  }
  return { state: s };
}

/* The bot: take a box if one can be closed, else a line that gives nothing away, else anything. */
export function auto(state, seat, rng) {
  const free = [];
  for (let i = 0; i < H_LINES; i += 1) if (state.h[i] === '0') free.push({ o: 'h', i });
  for (let i = 0; i < V_LINES; i += 1) if (state.v[i] === '0') free.push({ o: 'v', i });
  const after = (m) => boxesOf(m.o, m.i).map(([r, c]) => sides(state, r, c) + 1);
  const closing = free.filter((m) => after(m).includes(4));
  const safe = free.filter((m) => !after(m).includes(3));
  const pool = closing.length ? closing : (safe.length ? safe : free);
  const pick = pool[randInt(pool.length, rng)];
  return { type: 'line', o: pick.o, i: pick.i };
}

export function outcome(state) {
  return state.w === null ? null : { winners: [state.w], draw: false };
}

export function rematch(state) {
  return round(1 - state.first, state.score.slice(), state.round + 1);
}

export function view(state) {
  return state;
}
