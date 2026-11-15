/*
 * Chess for two seats (seat 0 plays White). Pure: full legal-move generation (pins, checks,
 * castling, en passant, promotion) and the usual endings — checkmate, stalemate, the fifty-move
 * rule, threefold repetition and insufficient material.
 *
 * The board is a 64-character string, index 0 = a8 … 63 = h1 (row 0 is rank 8); upper case is
 * White (PNBRQK), lower case Black, '.' empty.
 * state: b, t (side to move: w / b), c (castling rights, a subset of "KQkq"), ep (the square a pawn
 * just skipped, or -1), half (half-moves since a capture or pawn move), full (move number), hist
 * (hashes of the positions since the last capture or pawn move, for repetition), turn (seat, -1
 * when over), check (the side to move is in check), last { from, to }, result (null / mate /
 * stalemate / fifty / repetition / material), winner (seat or null), log / seq.
 * action: { type: 'move', from, to, promo } (promo: q / r / b / n, default q)
 */
import { clone, logEvent } from './util.js';

export const SEATS = 2;
export const TURN_SEC = 180;
export const START = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const ROOK = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ALL = ROOK.concat(BISHOP);
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const colorOf = (p) => (p === '.' ? null : (p < 'a' ? 'w' : 'b'));
const other = (c) => (c === 'w' ? 'b' : 'w');
const on = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

/* Whether square `sq` is attacked by a piece of colour `by`. */
export function attacked(b, sq, by) {
  const r = sq >> 3;
  const c = sq & 7;
  const pawnRow = by === 'w' ? r + 1 : r - 1;
  const pawn = by === 'w' ? 'P' : 'p';
  if (pawnRow >= 0 && pawnRow < 8) {
    if (c > 0 && b[pawnRow * 8 + c - 1] === pawn) return true;
    if (c < 7 && b[pawnRow * 8 + c + 1] === pawn) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [dr, dc] of KNIGHT) if (on(r + dr, c + dc) && b[(r + dr) * 8 + c + dc] === knight) return true;
  const king = by === 'w' ? 'K' : 'k';
  for (const [dr, dc] of ALL) if (on(r + dr, c + dc) && b[(r + dr) * 8 + c + dc] === king) return true;
  const rook = by === 'w' ? 'R' : 'r';
  const bishop = by === 'w' ? 'B' : 'b';
  const queen = by === 'w' ? 'Q' : 'q';
  for (let d = 0; d < 8; d += 1) {
    const [dr, dc] = ALL[d];
    const slider = d < 4 ? rook : bishop;
    let rr = r + dr;
    let cc = c + dc;
    while (on(rr, cc)) {
      const p = b[rr * 8 + cc];
      if (p !== '.') {
        if (p === slider || p === queen) return true;
        break;
      }
      rr += dr;
      cc += dc;
    }
  }
  return false;
}

export function inCheck(b, color) {
  const k = b.indexOf(color === 'w' ? 'K' : 'k');
  return k >= 0 && attacked(b, k, other(color));
}

/* Moves that obey how the pieces move, not yet checked for leaving the king attacked. */
function pseudoMoves(pos) {
  const { b, t } = pos;
  const out = [];
  const add = (from, to, extra) => out.push(extra ? { from, to, ...extra } : { from, to });
  for (let from = 0; from < 64; from += 1) {
    const p = b[from];
    if (p === '.' || colorOf(p) !== t) continue;
    const r = from >> 3;
    const c = from & 7;
    const kind = p.toLowerCase();
    if (kind === 'p') {
      const dir = t === 'w' ? -1 : 1;
      const startRow = t === 'w' ? 6 : 1;
      const lastRow = t === 'w' ? 0 : 7;
      const push = (to) => {
        if ((to >> 3) === lastRow) for (const promo of ['q', 'r', 'b', 'n']) add(from, to, { promo });
        else add(from, to);
      };
      const one = (r + dir) * 8 + c;
      if (on(r + dir, c) && b[one] === '.') {
        push(one);
        const two = (r + 2 * dir) * 8 + c;
        if (r === startRow && b[two] === '.') add(from, two, { double: true });
      }
      for (const dc of [-1, 1]) {
        if (!on(r + dir, c + dc)) continue;
        const to = (r + dir) * 8 + c + dc;
        if (b[to] !== '.' && colorOf(b[to]) !== t) push(to);
        else if (to === pos.ep) add(from, to, { ep: true });
      }
    } else if (kind === 'n' || kind === 'k') {
      for (const [dr, dc] of kind === 'n' ? KNIGHT : ALL) {
        if (!on(r + dr, c + dc)) continue;
        const to = (r + dr) * 8 + c + dc;
        if (colorOf(b[to]) !== t) add(from, to);
      }
      if (kind === 'k') {
        const home = t === 'w' ? 60 : 4;
        const enemy = other(t);
        if (from === home && !attacked(b, home, enemy)) {
          if (pos.c.includes(t === 'w' ? 'K' : 'k') && b[home + 1] === '.' && b[home + 2] === '.'
            && !attacked(b, home + 1, enemy) && !attacked(b, home + 2, enemy)) add(from, home + 2, { castle: 'k' });
          if (pos.c.includes(t === 'w' ? 'Q' : 'q') && b[home - 1] === '.' && b[home - 2] === '.' && b[home - 3] === '.'
            && !attacked(b, home - 1, enemy) && !attacked(b, home - 2, enemy)) add(from, home - 2, { castle: 'q' });
        }
      }
    } else {
      const dirs = kind === 'r' ? ROOK : (kind === 'b' ? BISHOP : ALL);
      for (const [dr, dc] of dirs) {
        let rr = r + dr;
        let cc = c + dc;
        while (on(rr, cc)) {
          const to = rr * 8 + cc;
          if (b[to] === '.') add(from, to);
          else {
            if (colorOf(b[to]) !== t) add(from, to);
            break;
          }
          rr += dr;
          cc += dc;
        }
      }
    }
  }
  return out;
}

const CORNER_RIGHT = { 0: 'q', 7: 'k', 56: 'Q', 63: 'K' };

/* The position after move `m` (a move from pseudoMoves): { b, t, c, ep, half, full }. */
export function make(pos, m) {
  const cells = pos.b.split('');
  const p = cells[m.from];
  const target = cells[m.to];
  cells[m.from] = '.';
  cells[m.to] = m.promo ? (pos.t === 'w' ? m.promo.toUpperCase() : m.promo) : p;
  if (m.ep) cells[m.to + (pos.t === 'w' ? 8 : -8)] = '.';
  if (m.castle === 'k') {
    cells[m.to - 1] = cells[m.to + 1];
    cells[m.to + 1] = '.';
  } else if (m.castle === 'q') {
    cells[m.to + 1] = cells[m.to - 2];
    cells[m.to - 2] = '.';
  }
  let c = pos.c;
  if (p === 'K') c = c.replace('K', '').replace('Q', '');
  if (p === 'k') c = c.replace('k', '').replace('q', '');
  for (const sq of [m.from, m.to]) if (CORNER_RIGHT[sq]) c = c.replace(CORNER_RIGHT[sq], '');
  return {
    b: cells.join(''), t: other(pos.t), c,
    ep: m.double ? (m.from + m.to) / 2 : -1,
    half: p.toLowerCase() === 'p' || target !== '.' ? 0 : pos.half + 1,
    full: pos.full + (pos.t === 'b' ? 1 : 0),
  };
}

/* Every legal move of the side to move. */
export function legalMoves(pos) {
  return pseudoMoves(pos).filter((m) => !inCheck(make(pos, m).b, pos.t));
}

/* A position from the first four fields of a FEN string (for tests and analysis). */
export function fromFen(fen) {
  const [rows, t, c, ep, half, full] = fen.split(' ');
  const b = rows.split('/').map((row) => row.replace(/\d/g, (d) => '.'.repeat(Number(d)))).join('');
  const epSq = ep && ep !== '-' ? (8 - Number(ep[1])) * 8 + (ep.charCodeAt(0) - 97) : -1;
  return { b, t: t || 'w', c: c && c !== '-' ? c : '', ep: epSq, half: Number(half || 0), full: Number(full || 1) };
}

/* The number of move sequences of length `depth`: the standard check of a move generator. */
export function perft(pos, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(pos)) n += depth === 1 ? 1 : perft(make(pos, m), depth - 1);
  return n;
}

function hash(pos) {
  const s = `${pos.b}${pos.t}${pos.c}${pos.ep}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/* Neither side can mate: bare kings, or a king with a single knight or bishop against a bare king. */
function deadMaterial(b) {
  const pieces = b.replace(/[.Kk]/g, '');
  return pieces.length === 0 || (pieces.length === 1 && 'NnBb'.includes(pieces));
}

function fresh(first) {
  const s = { b: START, t: 'w', c: 'KQkq', ep: -1, half: 0, full: 1, hist: [], turn: 0, check: false, last: null, result: null, winner: null, round: first, log: [], seq: 0 };
  s.hist.push(hash(s));
  return s;
}

export function create() {
  return fresh(1);
}

export function turn(state) {
  return state.turn;
}

export function act(state, seat, action) {
  if (state.result) return { error: 'GAME_OVER' };
  if (seat !== state.turn) return { error: 'NOT_YOUR_TURN' };
  if (!action || action.type !== 'move' || !Number.isInteger(action.from) || !Number.isInteger(action.to)) return { error: 'BAD_ACTION' };
  const promo = ['q', 'r', 'b', 'n'].includes(action.promo) ? action.promo : 'q';
  const m = legalMoves(state).find((x) => x.from === action.from && x.to === action.to && (!x.promo || x.promo === promo));
  if (!m) return { error: 'ILLEGAL_MOVE' };
  const piece = state.b[m.from];
  const captured = m.ep ? (state.t === 'w' ? 'p' : 'P') : (state.b[m.to] === '.' ? null : state.b[m.to]);
  const s = clone(state);
  Object.assign(s, make(state, m));
  if (s.half === 0) s.hist = [];
  const key = hash(s);
  s.hist.push(key);
  s.last = { from: m.from, to: m.to };
  s.check = inCheck(s.b, s.t);
  s.turn = 1 - seat;
  const replies = legalMoves(s);
  if (!replies.length) {
    s.result = s.check ? 'mate' : 'stalemate';
    s.winner = s.check ? seat : null;
  } else if (deadMaterial(s.b)) s.result = 'material';
  else if (s.half >= 100) s.result = 'fifty';
  else if (s.hist.filter((h) => h === key).length >= 3) s.result = 'repetition';
  if (s.result) s.turn = -1;
  logEvent(s, { type: 'move', seat, from: m.from, to: m.to, piece, captured, promo: m.promo || null, castle: m.castle || null, ep: !!m.ep, check: s.check, result: s.result });
  return { state: s };
}

function material(b, color) {
  let n = 0;
  for (const p of b) if (p !== '.' && colorOf(p) === color) n += VALUE[p.toLowerCase()];
  return n;
}

/*
 * The bot (and the move for a player out of time): takes material when it is safe, sees mate in
 * one, avoids leaving pieces to be taken, and otherwise develops towards the centre.
 */
export function auto(state, seat, rng = Math.random) {
  const me = state.t;
  const enemy = other(me);
  let best = null;
  let bestScore = -Infinity;
  for (const m of legalMoves(state)) {
    const next = make(state, m);
    let score = material(next.b, me) - material(next.b, enemy) + rng() * 0.3;
    const replies = legalMoves(next);
    if (!replies.length) score = inCheck(next.b, enemy) ? 1000 : -3;
    else {
      let loss = 0;
      for (const r of replies) {
        const taken = r.ep ? 1 : (next.b[r.to] === '.' ? 0 : VALUE[next.b[r.to].toLowerCase()]);
        loss = Math.max(loss, taken + (r.promo ? VALUE[r.promo] - 1 : 0));
      }
      score -= loss;
      if (inCheck(next.b, enemy)) score += 0.2;
      if (m.castle) score += 0.6;
      const r = m.to >> 3;
      const c = m.to & 7;
      if (r >= 2 && r <= 5 && c >= 2 && c <= 5 && 'pn'.includes(state.b[m.from].toLowerCase())) score += 0.25;
    }
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return { type: 'move', from: best.from, to: best.to, promo: best.promo || 'q' };
}

export function outcome(state) {
  if (!state.result) return null;
  return state.winner === null ? { winners: [], draw: true } : { winners: [state.winner], draw: false };
}

/* A new game; the players keep their colours (seat 0 is always White). */
export function rematch(state) {
  return fresh((state.round || 1) + 1);
}

export function view(state) {
  return state;
}
