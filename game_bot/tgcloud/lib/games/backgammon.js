/*
 * Backgammon (takhte-nard) for two seats, as a match to 3 or 5 points. No doubling cube.
 * Pure: the dice are rolled with the `rng` the server passes; the Mini App uses the same functions
 * to show legal moves.
 *
 * Board: pts[0..23] are points 1..24; > 0 = seat 0 (white) checkers, < 0 = seat 1 (black).
 * White moves 24 → 1 and bears off below 1; black moves 1 → 24 and bears off above 24.
 * bar [white, black], off [white, black] (15 each when all are borne off).
 * A move is { f, t, d }: f = point 1..24 or 'bar', t = point 1..24 or 'off', d = the die used.
 *
 * Rules: checkers on the bar enter first; a point with 2+ opposing checkers is closed; landing on
 * a single opposing checker hits it; bearing off only with every checker in the home board, with
 * the exact die or, from the highest occupied point, a larger one; doubles give four moves; a
 * player must use as many dice as possible, and if only one die can be used, the larger when
 * possible. A game won scores 1, a gammon (loser bore off nothing) 2, a backgammon (that, and a
 * loser checker on the bar or in the winner's home board) 3.
 *
 * state: pts, bar, off, turn, phase (roll / move / over), dice (left to play), rolled (the two dice
 * shown), score [white, black], target, game (number), winner, log / seq.
 * actions: { type: 'roll' }   { type: 'move', moves: [{ f, t, d }, …] } (the whole turn)
 */
import { clone, logEvent, randInt } from './util.js';

export const SEATS = 2;
export const TURN_SEC = 90;
export const TARGETS = [3, 5];

const START = (() => {
  const p = new Array(24).fill(0);
  p[23] = 2; p[12] = 5; p[7] = 3; p[5] = 5; /* white: 24, 13, 8, 6 */
  p[0] = -2; p[11] = -5; p[16] = -3; p[18] = -5; /* black: 1, 12, 17, 19 */
  return p;
})();

const die = (rng) => 1 + randInt(6, rng);

/* ---------- the board from one player's point of view ---------- */

/* me[0] = borne off, me[1..24] = own checkers by distance from home, me[25] = bar; op[1..24] = opponent's. */
function perspective(state, p) {
  const me = new Array(26).fill(0);
  const op = new Array(25).fill(0);
  me[0] = state.off[p];
  me[25] = state.bar[p];
  for (let i = 1; i <= 24; i += 1) {
    const v = state.pts[(p === 0 ? i : 25 - i) - 1];
    if (p === 0) {
      if (v > 0) me[i] = v; else if (v < 0) op[i] = -v;
    } else if (v < 0) me[i] = -v; else if (v > 0) op[i] = v;
  }
  return { me, op };
}

const toAbs = (p, i) => (p === 0 ? i : 25 - i);
const toRel = (p, point) => (p === 0 ? point : 25 - point);

/* Single moves with one die, in the player's own coordinates: { s, t } (t = 0: borne off). */
function singles(me, op, d) {
  if (me[25] > 0) {
    const t = 25 - d;
    return op[t] <= 1 ? [{ s: 25, t }] : [];
  }
  let outside = 0;
  for (let i = 7; i <= 24; i += 1) outside += me[i];
  let highest = 0;
  for (let i = 6; i >= 1; i -= 1) if (me[i] > 0) { highest = i; break; }
  const out = [];
  for (let s = 24; s >= 1; s -= 1) {
    if (!me[s]) continue;
    const t = s - d;
    if (t >= 1) {
      if (op[t] <= 1) out.push({ s, t });
    } else if (outside === 0 && (t === 0 || s === highest)) {
      out.push({ s, t: 0 });
    }
  }
  return out;
}

function step(me, op, m) {
  const me2 = me.slice();
  const op2 = op.slice();
  me2[m.s] -= 1;
  if (m.t === 0) me2[0] += 1;
  else {
    if (op2[m.t] === 1) op2[m.t] = 0;
    me2[m.t] += 1;
  }
  return [me2, op2];
}

const without = (arr, k) => arr.slice(0, k).concat(arr.slice(k + 1));

/* The most dice that can still be played from here (memoized). */
function maxDepth(me, op, rest, memo) {
  if (!rest.length) return 0;
  const key = `${me.join(',')}|${op.join(',')}|${rest.slice().sort().join('')}`;
  if (memo.has(key)) return memo.get(key);
  let best = 0;
  const tried = new Set();
  for (let k = 0; k < rest.length && best < rest.length; k += 1) {
    if (tried.has(rest[k])) continue;
    tried.add(rest[k]);
    for (const m of singles(me, op, rest[k])) {
      const [me2, op2] = step(me, op, m);
      best = Math.max(best, 1 + maxDepth(me2, op2, without(rest, k), memo));
      if (best === rest.length) break;
    }
  }
  memo.set(key, best);
  return best;
}

/* ---------- turn planning (shared with the Mini App) ---------- */

/*
 * The legal next single moves after `path` (moves already chosen this turn), in board terms, or
 * null when `path` itself isn't legal. A move is offered only if the whole turn can still use the
 * most dice possible; when only one die can be used at all, only the larger one if it can be.
 */
export function nextMoves(state, path = []) {
  if (state.phase !== 'move') return null;
  const p = state.turn;
  let { me, op } = perspective(state, p);
  const memo = new Map();
  const total = maxDepth(me, op, state.dice, memo);
  let rest = state.dice.slice();
  const allowed = (cands, restNow, done) => {
    let list = cands.filter((c) => 1 + maxDepth(c.me2, c.op2, c.rest2, memo) === total - done);
    if (total === 1 && state.dice.length === 2 && state.dice[0] !== state.dice[1]) {
      const hi = Math.max(state.dice[0], state.dice[1]);
      if (list.some((c) => c.d === hi)) list = list.filter((c) => c.d === hi);
    }
    return list;
  };
  const candidates = (meNow, opNow, restNow) => {
    const out = [];
    const tried = new Set();
    for (let k = 0; k < restNow.length; k += 1) {
      const d = restNow[k];
      if (tried.has(d)) continue;
      tried.add(d);
      for (const m of singles(meNow, opNow, d)) {
        const [me2, op2] = step(meNow, opNow, m);
        out.push({ ...m, d, me2, op2, rest2: without(restNow, k) });
      }
    }
    return out;
  };
  for (let i = 0; i < path.length; i += 1) {
    if (i >= total) return null;
    const mv = path[i];
    const s = mv.f === 'bar' ? 25 : toRel(p, mv.f);
    const t = mv.t === 'off' ? 0 : toRel(p, mv.t);
    const hit = allowed(candidates(me, op, rest), rest, i).find((c) => c.s === s && c.t === t && c.d === mv.d);
    if (!hit) return null;
    me = hit.me2;
    op = hit.op2;
    rest = hit.rest2;
  }
  if (path.length >= total) return [];
  return allowed(candidates(me, op, rest), rest, path.length).map((c) => ({
    f: c.s === 25 ? 'bar' : toAbs(p, c.s),
    t: c.t === 0 ? 'off' : toAbs(p, c.t),
    d: c.d,
  }));
}

/* How many dice the current turn must use. */
export function movesRequired(state) {
  if (state.phase !== 'move') return 0;
  const { me, op } = perspective(state, state.turn);
  return maxDepth(me, op, state.dice, new Map());
}

/* Applies one move for the player to move (no checks), on a copy. */
export function applyMove(state, mv) {
  const s = clone(state);
  const p = s.turn;
  const sign = p === 0 ? 1 : -1;
  if (mv.f === 'bar') s.bar[p] -= 1;
  else s.pts[mv.f - 1] -= sign;
  if (mv.t === 'off') s.off[p] += 1;
  else {
    const v = s.pts[mv.t - 1];
    if (v === -sign) {
      s.pts[mv.t - 1] = 0;
      s.bar[1 - p] += 1;
    }
    s.pts[mv.t - 1] += sign;
  }
  const k = s.dice.indexOf(mv.d);
  if (k >= 0) s.dice.splice(k, 1);
  return s;
}

/* Pip count: how far a player's checkers still have to go. */
export function pips(state, p) {
  const { me } = perspective(state, p);
  let n = me[25] * 25;
  for (let i = 1; i <= 24; i += 1) n += me[i] * i;
  return n;
}

/* ---------- game flow ---------- */

function board(state) {
  state.pts = START.slice();
  state.bar = [0, 0];
  state.off = [0, 0];
}

/* Opening roll: each side rolls one die until they differ; the higher starts with both. */
function opening(s, rng) {
  let a = die(rng);
  let b = die(rng);
  while (a === b) {
    a = die(rng);
    b = die(rng);
  }
  s.turn = a > b ? 0 : 1;
  s.phase = 'move';
  s.rolled = [a, b];
  s.dice = [a, b];
  logEvent(s, { type: 'opening', seat: s.turn, dice: [a, b], game: s.game });
}

export function create(opts = {}, rng = Math.random) {
  const target = TARGETS.includes(opts.target) ? opts.target : 3;
  const s = { turn: 0, phase: 'roll', dice: [], rolled: [], score: [0, 0], target, game: 1, winner: null, log: [], seq: 0 };
  board(s);
  opening(s, rng);
  return s;
}

export function turn(state) {
  return state.phase === 'over' ? -1 : state.turn;
}

function endTurn(s) {
  s.turn = 1 - s.turn;
  s.phase = 'roll';
  s.dice = [];
}

function gamePoints(s, w) {
  const l = 1 - w;
  if (s.off[l] > 0) return 1;
  let inHome = s.bar[l] > 0;
  for (let point = 1; point <= 24 && !inHome; point += 1) {
    const rel = toRel(w, point);
    const v = s.pts[point - 1];
    if (rel <= 6 && (l === 0 ? v > 0 : v < 0)) inHome = true;
  }
  return inHome ? 3 : 2;
}

const validMove = (m) => m && (m.f === 'bar' || (Number.isInteger(m.f) && m.f >= 1 && m.f <= 24))
  && (m.t === 'off' || (Number.isInteger(m.t) && m.t >= 1 && m.t <= 24)) && Number.isInteger(m.d) && m.d >= 1 && m.d <= 6;

export function act(state, seat, action, rng = Math.random) {
  if (state.phase === 'over') return { error: 'GAME_OVER' };
  if (seat !== state.turn) return { error: 'NOT_YOUR_TURN' };
  if (!action) return { error: 'BAD_ACTION' };
  if (action.type === 'roll') {
    if (state.phase !== 'roll') return { error: 'ALREADY_ROLLED' };
    const s = clone(state);
    const a = die(rng);
    const b = die(rng);
    s.rolled = [a, b];
    s.dice = a === b ? [a, a, a, a] : [a, b];
    s.phase = 'move';
    logEvent(s, { type: 'roll', seat, dice: [a, b] });
    if (movesRequired(s) === 0) {
      logEvent(s, { type: 'nomove', seat });
      endTurn(s);
    }
    return { state: s };
  }
  if (action.type !== 'move') return { error: 'BAD_ACTION' };
  if (state.phase !== 'move') return { error: 'ROLL_FIRST' };
  const moves = action.moves;
  if (!Array.isArray(moves) || moves.length > 4 || !moves.every(validMove)) return { error: 'BAD_ACTION' };
  if (moves.length !== movesRequired(state)) return { error: 'ILLEGAL_MOVE' };
  let s = state;
  for (let i = 0; i < moves.length; i += 1) {
    const legal = nextMoves(s, []);
    if (!legal || !legal.some((m) => m.f === moves[i].f && m.t === moves[i].t && m.d === moves[i].d)) return { error: 'ILLEGAL_MOVE' };
    s = applyMove(s, moves[i]);
  }
  s = clone(s);
  s.dice = [];
  logEvent(s, { type: 'move', seat, moves });
  if (s.off[seat] === 15) {
    const points = gamePoints(s, seat);
    s.score[seat] += points;
    logEvent(s, { type: 'game', seat, points, game: s.game });
    if (s.score[seat] >= s.target) {
      s.phase = 'over';
      s.turn = -1;
      s.winner = seat;
      logEvent(s, { type: 'match', seat });
    } else {
      s.game += 1;
      board(s);
      opening(s, rng);
    }
    return { state: s };
  }
  endTurn(s);
  return { state: s };
}

/*
 * nextMoves() keeps a move only if the rest of the turn can still use the most dice, so it must be
 * judged against the remaining turn, not the original one: plan with a running copy.
 */
function planTurn(state, rng) {
  const moves = [];
  let s = state;
  const total = movesRequired(state);
  while (moves.length < total) {
    const options = nextMoves(s, []);
    if (!options || !options.length) break;
    const mv = options[randInt(options.length, rng)];
    moves.push(mv);
    s = applyMove(s, mv);
    s.phase = 'move';
  }
  return moves;
}

/* For a player who ran out of time: roll, or play a random legal turn. */
export function auto(state, seat, rng = Math.random) {
  if (state.phase === 'roll') return { type: 'roll' };
  return { type: 'move', moves: planTurn(state, rng) };
}

export function outcome(state) {
  if (state.phase !== 'over') return null;
  return { winners: [state.winner], draw: false };
}

export function rematch(state, rng = Math.random) {
  return create({ target: state.target }, rng);
}

export function view(state) {
  return state;
}
