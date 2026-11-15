// Unit tests for the rules of chess, Ludo, Reversi, dots and boxes and rock-paper-scissors
// (tgcloud/lib/games/). Run: npm run test:unit
import assert from 'node:assert/strict';
import test from 'node:test';
import * as chess from '../../tgcloud/lib/games/chess.js';
import * as dots from '../../tgcloud/lib/games/dots.js';
import * as ludo from '../../tgcloud/lib/games/ludo.js';
import * as reversi from '../../tgcloud/lib/games/reversi.js';
import * as rps from '../../tgcloud/lib/games/rps.js';
import * as ttt from '../../tgcloud/lib/games/tictactoe.js';
import { seeded } from '../../tgcloud/lib/games/util.js';

const sq = (name) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
/** Plays moves like "e2e4" (and "e7e8q") in turn; every one must be accepted. */
function play(state, ...moves) {
  let s = state;
  for (const m of moves) {
    const r = chess.act(s, s.turn, { type: 'move', from: sq(m.slice(0, 2)), to: sq(m.slice(2, 4)), promo: m[4] });
    assert.equal(r.error, undefined, `${m}: ${r.error}`);
    s = r.state;
  }
  return s;
}
const position = (fen) => ({ ...chess.create(), ...chess.fromFen(fen), hist: [] });

// ---------- chess ----------

test('chess: the move generator matches the known perft counts (pins, castling, en passant, promotions)', () => {
  const cases = [
    ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902]],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ];
  for (const [fen, counts] of cases) {
    counts.forEach((n, i) => assert.equal(chess.perft(chess.fromFen(fen), i + 1), n, `${fen} depth ${i + 1}`));
  }
});

test('chess: checkmate, turns, illegal moves', () => {
  let s = chess.create();
  assert.equal(chess.act(s, 1, { type: 'move', from: sq('e7'), to: sq('e5') }).error, 'NOT_YOUR_TURN');
  assert.equal(chess.act(s, 0, { type: 'move', from: sq('e2'), to: sq('e5') }).error, 'ILLEGAL_MOVE');
  s = play(s, 'f2f3', 'e7e5', 'g2g4');
  assert.equal(s.check, false);
  s = play(s, 'd8h4');
  assert.equal(s.result, 'mate');
  assert.equal(s.winner, 1);
  assert.deepEqual(chess.outcome(s), { winners: [1], draw: false });
  assert.equal(chess.act(s, 0, { type: 'move', from: sq('a2'), to: sq('a3') }).error, 'GAME_OVER');
});

test('chess: a pinned piece may not move; check must be answered', () => {
  const s = position('4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1');
  assert.equal(chess.act(s, 0, { type: 'move', from: sq('e2'), to: sq('c3') }).error, 'ILLEGAL_MOVE');
  assert.equal(chess.act(s, 0, { type: 'move', from: sq('e1'), to: sq('d1') }).error, undefined);
  const checked = position('4r2k/8/8/8/8/8/3N4/4K3 w - - 0 1');
  assert.equal(chess.act(checked, 0, { type: 'move', from: sq('d2'), to: sq('b3') }).error, 'ILLEGAL_MOVE');
  assert.equal(chess.act(checked, 0, { type: 'move', from: sq('d2'), to: sq('e4') }).error, undefined, 'blocking the check is fine');
});

test('chess: castling moves the rook and is refused through check; en passant; promotion', () => {
  let s = position('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  s = play(s, 'e1g1');
  assert.equal(s.b[sq('g1')] + s.b[sq('f1')] + s.b[sq('h1')], 'KR.');
  assert.equal(s.c, 'kq');
  s = play(s, 'e8c8');
  assert.equal(s.b[sq('c8')] + s.b[sq('d8')] + s.b[sq('a8')], 'kr.');
  const through = position('4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert.equal(chess.act(through, 0, { type: 'move', from: sq('e1'), to: sq('g1') }).error, 'ILLEGAL_MOVE', 'f1 is attacked');
  assert.equal(chess.act(through, 0, { type: 'move', from: sq('e1'), to: sq('c1') }).error, undefined);
  let e = play(chess.create(), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
  assert.equal(e.ep, sq('d6'));
  e = play(e, 'e5d6');
  assert.equal(e.b[sq('d5')], '.', 'the pawn that was passed is gone');
  assert.equal(e.log[e.log.length - 1].captured, 'p');
  let p = position('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  p = play(p, 'a7a8n');
  assert.equal(p.b[sq('a8')], 'N');
  assert.equal(play(position('8/P6k/8/8/8/8/8/K7 w - - 0 1'), 'a7a8').b[sq('a8')], 'Q', 'a queen by default');
});

test('chess: stalemate, bare kings, the fifty-move rule and threefold repetition are draws', () => {
  const stale = play(position('7k/5Q2/8/8/8/8/8/K7 w - - 0 1'), 'f7g6');
  assert.equal(stale.result, 'stalemate');
  assert.deepEqual(chess.outcome(stale), { winners: [], draw: true });
  assert.equal(play(position('8/8/8/8/8/8/1p6/K6k w - - 0 1'), 'a1b2').result, 'material');
  const fifty = position('8/8/8/8/8/2k5/1r6/K7 b - - 99 80');
  assert.equal(play(fifty, 'b2b8').result, 'fifty');
  let s = chess.create();
  s = play(s, 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1');
  assert.equal(s.result, null);
  s = play(s, 'f6g8');
  assert.equal(s.result, 'repetition');
});

test('chess: 40 games between two bots never produce an illegal move; the bot takes a free queen and mates in one', () => {
  const rng = seeded(11);
  let finished = 0;
  for (let g = 0; g < 40; g += 1) {
    let s = chess.create();
    for (let ply = 0; ply < 200 && !s.result; ply += 1) {
      const r = chess.act(s, s.turn, chess.auto(s, s.turn, rng));
      assert.equal(r.error, undefined);
      s = r.state;
      assert.equal(s.b.split('K').length, 2);
      assert.equal(s.b.split('k').length, 2);
    }
    if (s.result) finished += 1;
  }
  assert.ok(finished > 5, `${finished} games reached an ending`);
  const free = position('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
  assert.deepEqual([chess.auto(free, 0, rng).from, chess.auto(free, 0, rng).to], [sq('e4'), sq('d5')]);
  const mate = position('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
  assert.equal(chess.auto(mate, 0, rng).to, sq('a8'));
});

// ---------- ludo ----------

const die = (...faces) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 1) / 6 + 0.01;
};
const ludoState = (over = {}) => ({ pos: [[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], active: [0, 1], turn: 0, phase: 'roll', die: 0, sixes: 0, winner: null, log: [], seq: 0, ...over });

test('ludo: only a 6 leaves the base; with no move the turn passes; a 6 rolls again', () => {
  let s = ludoState();
  s = ludo.act(s, 0, { type: 'roll' }, die(3)).state;
  assert.deepEqual([s.turn, s.phase], [1, 'roll']);
  assert.ok(s.log.some((e) => e.type === 'pass' && e.seat === 0));
  s = ludo.act(s, 1, { type: 'roll' }, die(6)).state;
  assert.deepEqual(s.pos[1], [0, -1, -1, -1], 'the only possible move is made by itself');
  assert.deepEqual([s.turn, s.phase], [1, 'roll'], 'a 6 gives another roll');
  assert.equal(ludo.act(s, 0, { type: 'roll' }).error, 'NOT_YOUR_TURN');
});

test('ludo: a real choice is left to the player; captures send pieces home and roll again; safe cells protect', () => {
  let s = ludoState({ pos: [[5, 20, -1, -1], [-1, -1, -1, -1], null, null] });
  s.pos[1][0] = ludo.RING - 13 + 9; /* black piece on ring cell 9 (its own step 48) */
  assert.equal(ludo.absCell(1, s.pos[1][0]), 9);
  s = ludo.act(s, 0, { type: 'roll' }, die(4)).state;
  assert.equal(s.phase, 'move');
  assert.equal(ludo.act(s, 0, { type: 'move', piece: 2 }).error, 'ILLEGAL_MOVE', 'a piece in the base needs a 6');
  const hit = ludo.act(s, 0, { type: 'move', piece: 0 }).state;
  assert.equal(hit.pos[1][0], -1, 'captured');
  assert.deepEqual([hit.turn, hit.phase], [0, 'roll'], 'a capture rolls again');
  const safe = ludoState({ pos: [[4, 20, -1, -1], [-1, -1, -1, -1], null, null] });
  safe.pos[1][0] = ludo.RING - 13 + 8; /* on the star at ring cell 8 */
  const kept = ludo.act(ludo.act(safe, 0, { type: 'roll' }, die(4)).state, 0, { type: 'move', piece: 0 }).state;
  assert.equal(kept.pos[1][0], ludo.RING - 13 + 8, 'a star is safe');
  assert.equal(kept.turn, 1);
});

test('ludo: home needs the exact roll; a third 6 ends the turn; all four home wins', () => {
  let s = ludoState({ pos: [[54, 56, 56, 56], [3, -1, -1, -1], null, null] });
  s = ludo.act(s, 0, { type: 'roll' }, die(5)).state;
  assert.deepEqual([s.pos[0][0], s.turn], [54, 1], '5 is too many: no move');
  s = ludoState({ pos: [[54, 56, 56, 56], [3, -1, -1, -1], null, null] });
  s = ludo.act(s, 0, { type: 'roll' }, die(2)).state;
  assert.equal(s.phase, 'over');
  assert.deepEqual(ludo.outcome(s), { winners: [0], draw: false });
  let six = ludoState({ pos: [[0, -1, -1, -1], [3, -1, -1, -1], null, null] });
  const always6 = die(6);
  for (let i = 0; i < 3; i += 1) {
    six = ludo.act(six, 0, { type: 'roll' }, always6).state;
    if (six.phase === 'move') six = ludo.act(six, 0, { type: 'move', piece: 0 }).state;
  }
  assert.equal(six.turn, 1, 'the third 6 in a row passes the turn');
});

test('ludo: 200 bot games with 2, 3 and 4 players end with a winner and lose no piece', () => {
  const rng = seeded(4);
  for (let g = 0; g < 200; g += 1) {
    const seats = [[0, 2], [0, 1, 3], [0, 1, 2, 3]][g % 3];
    let s = ludo.create({ seats }, rng);
    assert.deepEqual(s.active, seats);
    let steps = 0;
    while (s.phase !== 'over') {
      const seat = ludo.turn(s);
      assert.ok(seats.includes(seat));
      const r = ludo.act(s, seat, ludo.auto(s, seat, rng), rng);
      assert.equal(r.error, undefined);
      s = r.state;
      for (const a of seats) assert.ok(s.pos[a].every((p) => p >= -1 && p <= ludo.HOME));
      steps += 1;
      assert.ok(steps < 20000, 'never ended');
    }
    assert.ok(s.pos[s.winner].every((p) => p === ludo.HOME));
  }
});

// ---------- reversi ----------

test('reversi: opening moves, flips, and a full game', () => {
  let s = reversi.create();
  assert.deepEqual(reversi.legalMoves(s.b, 0), [19, 26, 37, 44]);
  assert.equal(reversi.act(s, 0, { type: 'place', cell: 0 }).error, 'ILLEGAL_MOVE');
  s = reversi.act(s, 0, { type: 'place', cell: 19 }).state;
  assert.equal(s.b[27], 'B', 'the disc between was flipped');
  assert.deepEqual(s.count, [4, 1]);
  assert.equal(s.turn, 1);
  const rng = seeded(8);
  for (let g = 0; g < 60; g += 1) {
    let t = reversi.create();
    while (t.w === null) {
      const r = reversi.act(t, t.turn, reversi.auto(t, t.turn, rng));
      assert.equal(r.error, undefined);
      t = r.state;
    }
    assert.ok(t.count[0] + t.count[1] <= 64);
    assert.equal(reversi.legalMoves(t.b, 0).length + reversi.legalMoves(t.b, 1).length, 0, 'ends only when neither can move');
    const expected = t.count[0] === t.count[1] ? 'draw' : (t.count[0] > t.count[1] ? 0 : 1);
    assert.equal(t.w, expected);
  }
});

test('reversi: a player without a move passes', () => {
  const s = reversi.create();
  const cells = new Array(64).fill('.');
  cells[0] = 'W';
  cells[1] = 'B';
  cells[9] = 'B'; /* dark to move at 2 would... set up: light can capture at 2; after that dark has no move */
  s.b = cells.join('');
  s.turn = 1;
  const r = reversi.act(s, 1, { type: 'place', cell: 2 }).state;
  assert.equal(r.b.slice(0, 3), 'WWW');
  assert.equal(r.turn, 1, 'dark has no move, light plays again');
  assert.ok(r.log.some((e) => e.type === 'pass' && e.seat === 0));
});

// ---------- dots and boxes ----------

test('dots: closing a box scores and moves again; the game ends when all boxes are owned', () => {
  let s = dots.create();
  for (const [seat, o, i] of [[0, 'h', 0], [1, 'h', dots.N], [0, 'v', 0]]) s = dots.act(s, seat, { type: 'line', o, i }).state;
  assert.equal(s.turn, 1);
  assert.equal(dots.act(s, 1, { type: 'line', o: 'v', i: 0 }).error, 'LINE_TAKEN');
  s = dots.act(s, 1, { type: 'line', o: 'v', i: 1 }).state;
  assert.equal(s.own[0], '1');
  assert.deepEqual(s.count, [0, 1]);
  assert.equal(s.turn, 1, 'the scorer moves again');
  const rng = seeded(2);
  for (let g = 0; g < 60; g += 1) {
    let t = dots.create();
    let moves = 0;
    while (t.w === null) {
      const r = dots.act(t, t.turn, dots.auto(t, t.turn, rng));
      assert.equal(r.error, undefined);
      t = r.state;
      moves += 1;
    }
    assert.equal(moves, dots.H_LINES + dots.V_LINES);
    assert.equal(t.count[0] + t.count[1], dots.N * dots.N);
    assert.equal(t.w, t.count[0] > t.count[1] ? 0 : 1);
  }
});

test('dots: the bot takes a box that can be closed', () => {
  let s = dots.create();
  for (const [seat, o, i] of [[0, 'h', 0], [1, 'h', dots.N], [0, 'v', 0]]) s = dots.act(s, seat, { type: 'line', o, i }).state;
  assert.deepEqual(dots.auto(s, 1, seeded(1)), { type: 'line', o: 'v', i: 1 });
});

// ---------- rock paper scissors ----------

test('rps: choices stay hidden until both are in; first to three wins; a tie replays', () => {
  let s = rps.create();
  assert.deepEqual(rps.waiting(s), [0, 1]);
  s = rps.act(s, 1, { type: 'pick', pick: 'r' }).state;
  assert.deepEqual(rps.waiting(s), [0]);
  assert.equal(rps.act(s, 1, { type: 'pick', pick: 'p' }).error, 'ALREADY_PICKED');
  assert.deepEqual(rps.view(s, 0).picks, [null, '?'], 'the opponent sees only that a choice was made');
  assert.equal(rps.view(s, 0).turn, 0);
  assert.equal(rps.view(s, 1).turn, 0, 'the one who chose waits for the other');
  assert.ok(!JSON.stringify(rps.view(s, 0)).includes('"r"'));
  s = rps.act(s, 0, { type: 'pick', pick: 'r' }).state;
  assert.deepEqual([s.last.winner, s.score], [-1, [0, 0]], 'a tie');
  for (let i = 0; i < 3; i += 1) {
    s = rps.act(s, 0, { type: 'pick', pick: 'p' }).state;
    s = rps.act(s, 1, { type: 'pick', pick: 'r' }).state;
  }
  assert.deepEqual(s.score, [3, 0]);
  assert.deepEqual(rps.outcome(s), { winners: [0], draw: false });
  assert.deepEqual(rps.waiting(s), []);
  assert.equal(rps.act(s, 0, { type: 'pick', pick: 'p' }).error, 'GAME_OVER');
});

// ---------- tic-tac-toe bot ----------

test('ttt: the bot wins when it can and blocks when it must', () => {
  const never = () => 0.99;
  const s = ttt.create();
  assert.equal(ttt.auto({ ...s, b: 'OO.XX....', turn: 1 }, 1, never).cell, 2, 'takes the win');
  assert.equal(ttt.auto({ ...s, b: 'XX.O.....', turn: 1 }, 1, never).cell, 2, 'blocks');
  assert.equal(ttt.auto(s, 0, never).cell, 4, 'opens in the centre');
});

// ---------- strings ----------

test('i18n: every language has every key, and no string breaks Telegram HTML (a bare &, < or >)', async () => {
  const en = (await import('../../tgcloud/lib/i18n/en.js')).default;
  for (const lang of ['en', 'fa', 'fr', 'ru']) {
    const dict = (await import(`../../tgcloud/lib/i18n/${lang}.js`)).default;
    assert.deepEqual(Object.keys(en).filter((k) => !(k in dict)), [], `${lang} lacks keys`);
    for (const [key, value] of Object.entries(dict)) {
      const rest = value.replace(/<\/?(b|i|code)>/g, '');
      assert.ok(!/[<>&]/.test(rest), `${lang}.${key} has a character that must be escaped in HTML: ${value}`);
    }
  }
});
