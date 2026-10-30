/*
 * Fusion: a solo placement puzzle on a 5×5 board. Each turn the player places the current tile
 * (the next one is shown) on any empty cell. When the placed tile touches others of the same value
 * so that 3 or more are connected (up, down, left, right), they fuse into one tile of the next
 * value on the placed cell, and the new tile may fuse again (a chain; each link scores more).
 * Fusing tiles of the top value (9) clears them all for a bonus. The game ends when the board is
 * full.
 *
 * The tiles come from a generator seeded by the server, so the server can replay the moves the
 * Mini App submits (cell indexes in order) and check the score: replay() is the anti-cheat.
 */
import { seeded } from './util.js';

export const SIZE = 5;
export const CELLS = SIZE * SIZE;
export const TOP = 9;
export const MAX_MOVES = 4000;

function draw(rng) {
  const r = rng();
  if (r < 0.55) return 1;
  if (r < 0.85) return 2;
  return 3;
}

export function neighbours(i) {
  const out = [];
  const x = i % SIZE;
  const y = Math.floor(i / SIZE);
  if (x > 0) out.push(i - 1);
  if (x < SIZE - 1) out.push(i + 1);
  if (y > 0) out.push(i - SIZE);
  if (y < SIZE - 1) out.push(i + SIZE);
  return out;
}

function group(board, start) {
  const v = board[start];
  const seen = new Set([start]);
  const todo = [start];
  while (todo.length) {
    const i = todo.pop();
    for (const n of neighbours(i)) {
      if (!seen.has(n) && board[n] === v) {
        seen.add(n);
        todo.push(n);
      }
    }
  }
  return Array.from(seen);
}

/* A new game. `rng` is kept on the object (not serializable); replay() rebuilds it from the seed. */
export function start(seed) {
  const rng = seeded(seed);
  return { seed, board: new Array(CELLS).fill(0), queue: [draw(rng), draw(rng)], score: 0, moves: 0, best: 1, over: false, rng };
}

/*
 * Places the current tile on `cell`. Gives the fusions that happened, in order:
 * [{ cells, value (of the tiles that fused), into (the new value, 0 = cleared), at, combo, gain }]
 * or null if the move isn't allowed.
 */
export function place(game, cell) {
  if (game.over || !Number.isInteger(cell) || cell < 0 || cell >= CELLS || game.board[cell] !== 0) return null;
  game.board[cell] = game.queue[0];
  game.queue = [game.queue[1], draw(game.rng)];
  game.moves += 1;
  const fusions = [];
  let combo = 1;
  for (;;) {
    const v = game.board[cell];
    if (!v) break;
    const g = group(game.board, cell);
    if (g.length < 3) break;
    for (const c of g) game.board[c] = 0;
    const into = v >= TOP ? 0 : v + 1;
    const gain = into ? into * g.length * 5 * combo : 500 * combo;
    game.board[cell] = into;
    game.score += gain;
    if (into > game.best) game.best = into;
    fusions.push({ cells: g, value: v, into, at: cell, combo, gain });
    combo += 1;
  }
  game.over = game.board.every((v) => v !== 0);
  return fusions;
}

/* Replays a submitted game: { score, moves, over, best } or { error }. */
export function replay(seed, moves) {
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) return { error: 'BAD_MOVES' };
  const game = start(seed);
  for (const m of moves) {
    if (place(game, m) === null) return { error: 'ILLEGAL_MOVE' };
  }
  return { score: game.score, moves: game.moves, over: game.over, best: game.best };
}
