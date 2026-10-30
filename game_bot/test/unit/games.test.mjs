// Unit tests for the pure game rules in tgcloud/lib/games/ (shared by the endpoints and the Mini App).
// Run: npm run test:unit
import assert from 'node:assert/strict';
import test from 'node:test';
import * as ttt from '../../tgcloud/lib/games/tictactoe.js';
import * as bg from '../../tgcloud/lib/games/backgammon.js';
import * as hokm from '../../tgcloud/lib/games/hokm.js';
import * as cw from '../../tgcloud/lib/games/codeword.js';
import * as fusion from '../../tgcloud/lib/games/fusion.js';
import { seeded } from '../../tgcloud/lib/games/util.js';

/** A dice "rng" that yields the given die faces in order (each face f → (f - 1) / 6). */
const diceRng = (...faces) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 1) / 6 + 0.01;
};

// ---------- tic-tac-toe ----------

test('ttt: a line wins, turns alternate, taken cells and wrong turns are refused', () => {
  let s = ttt.create();
  assert.equal(ttt.turn(s), 0);
  assert.equal(ttt.act(s, 1, { type: 'mark', cell: 0 }).error, 'NOT_YOUR_TURN');
  for (const [seat, cell] of [[0, 0], [1, 3], [0, 1], [1, 4]]) s = ttt.act(s, seat, { type: 'mark', cell }).state;
  assert.equal(ttt.act(s, 0, { type: 'mark', cell: 3 }).error, 'CELL_TAKEN');
  s = ttt.act(s, 0, { type: 'mark', cell: 2 }).state;
  assert.deepEqual(ttt.outcome(s), { winners: [0], draw: false });
  assert.deepEqual(s.line, [0, 1, 2]);
  assert.equal(ttt.act(s, 1, { type: 'mark', cell: 8 }).error, 'GAME_OVER');
  const r = ttt.rematch(s);
  assert.equal(r.first, 1);
  assert.equal(ttt.turn(r), 1);
  assert.deepEqual(r.score, [1, 0, 0]);
});

test('ttt: a full board without a line is a draw', () => {
  let s = ttt.create();
  for (const [seat, cell] of [[0, 0], [1, 1], [0, 2], [1, 4], [0, 3], [1, 5], [0, 7], [1, 6], [0, 8]]) s = ttt.act(s, seat, { type: 'mark', cell }).state;
  assert.deepEqual(ttt.outcome(s), { winners: [], draw: true });
  assert.deepEqual(s.score, [0, 0, 1]);
});

// ---------- backgammon ----------

const empty = (over = {}) => ({
  pts: new Array(24).fill(0), bar: [0, 0], off: [0, 0], turn: 0, phase: 'move', dice: [], rolled: [], score: [0, 0], target: 3,
  game: 1, winner: null, log: [], seq: 0, ...over,
});
const count = (s, p) => s.bar[p] + s.off[p] + s.pts.reduce((n, v) => n + (p === 0 ? Math.max(v, 0) : Math.max(-v, 0)), 0);
const sortMoves = (ms) => ms.map((m) => `${m.f}>${m.t}/${m.d}`).sort();

test('bg: the opening position and roll', () => {
  const s = bg.create({ target: 5 }, diceRng(3, 5));
  assert.equal(count(s, 0), 15);
  assert.equal(count(s, 1), 15);
  assert.equal(s.target, 5);
  assert.equal(s.phase, 'move');
  assert.equal(s.turn, 1); // white rolled 3, black 5
  assert.deepEqual(s.dice, [3, 5]);
  assert.equal(bg.pips(s, 0), 167);
  assert.equal(bg.pips(s, 1), 167);
  assert.equal(bg.create({ target: 7 }, diceRng(1, 2)).target, 3); // only 3 or 5
});

test('bg: a checker on the bar must enter first, into an open point only', () => {
  const s = empty({ bar: [1, 0], dice: [3, 5] });
  s.pts[5] = 14; // white 6
  s.pts[21] = -2; // black closes point 22 (entry with a 3)
  s.pts[0] = -13;
  const legal = bg.nextMoves(s, []);
  assert.deepEqual(sortMoves(legal), ['bar>20/5']);
  assert.deepEqual(sortMoves(bg.nextMoves(s, [{ f: 'bar', t: 20, d: 5 }])), sortMoves(bg.nextMoves(bg.applyMove(s, { f: 'bar', t: 20, d: 5 }), [])));
});

test('bg: a fully closed board means no move; the turn passes after the roll', () => {
  const s = empty({ bar: [1, 0], phase: 'roll' });
  for (let i = 18; i < 24; i += 1) s.pts[i] = -2; // black holds 19..24
  s.pts[0] = -3;
  s.pts[5] = 14;
  const r = bg.act(s, 0, { type: 'roll' }, diceRng(2, 4)).state;
  assert.equal(r.turn, 1);
  assert.equal(r.phase, 'roll');
  assert.ok(r.log.some((e) => e.type === 'nomove' && e.seat === 0));
});

test('bg: bearing off with the exact die, or a larger one from the highest point only', () => {
  const s = empty({ dice: [5, 1], off: [13, 0] });
  s.pts[2] = 1; // white on 3
  s.pts[1] = 1; // white on 2
  s.pts[23] = -15;
  const legal = sortMoves(bg.nextMoves(s, []));
  assert.ok(legal.includes('3>off/5'), legal.join());
  assert.ok(!legal.includes('2>off/5'), 'a 5 bears off only from the highest point');
  const blocked = empty({ dice: [4, 4, 4, 4], off: [13, 0] });
  blocked.pts[5] = 1; // white on 6
  blocked.pts[1] = 1; // white on 2
  blocked.pts[23] = -15;
  assert.deepEqual(sortMoves(bg.nextMoves(blocked, [])), ['6>2/4']);
});

test('bg: no bearing off while a checker is outside the home board', () => {
  const s = empty({ dice: [6, 1], off: [10, 0] });
  s.pts[0] = 4; // white on 1
  s.pts[6] = 1; // white on 7
  s.pts[23] = -15;
  const legal = sortMoves(bg.nextMoves(s, []));
  assert.ok(!legal.some((m) => m.includes('off')), legal.join());
  assert.ok(legal.includes('7>6/1') && legal.includes('7>1/6'));
});

test('bg: doubles give four moves', () => {
  const s = empty({ dice: [2, 2, 2, 2] });
  s.pts[23] = 15;
  s.pts[0] = -15;
  assert.equal(bg.movesRequired(s), 4);
  const r = bg.act(s, 0, { type: 'move', moves: [{ f: 24, t: 22, d: 2 }, { f: 22, t: 20, d: 2 }, { f: 24, t: 22, d: 2 }, { f: 24, t: 22, d: 2 }] });
  assert.equal(r.error, undefined);
  assert.equal(r.state.pts[19], 1);
  assert.equal(r.state.pts[21], 2);
  assert.equal(bg.act(s, 0, { type: 'move', moves: [{ f: 24, t: 22, d: 2 }] }).error, 'ILLEGAL_MOVE');
});

test('bg: when only one die can be used, the larger one must be', () => {
  const s = empty({ dice: [6, 4], off: [14, 0] });
  s.pts[12] = 1; // white's last checker on 13
  s.pts[2] = -2; // black closes 3, so 13→7→3 and 13→9→3 both stop after one die
  s.pts[23] = -13;
  assert.equal(bg.movesRequired(s), 1);
  assert.deepEqual(sortMoves(bg.nextMoves(s, [])), ['13>7/6']);
  assert.equal(bg.act(s, 0, { type: 'move', moves: [{ f: 13, t: 9, d: 4 }] }).error, 'ILLEGAL_MOVE');
  assert.equal(bg.act(s, 0, { type: 'move', moves: [{ f: 13, t: 7, d: 6 }] }).error, undefined);
});

test('bg: both dice must be used when possible, even if one order blocks', () => {
  const s = empty({ dice: [6, 1] });
  s.pts[7] = 1; // white on 8
  s.pts[5] = 14;
  s.pts[0] = -2; // black holds point 1, so some single moves would strand the other die
  s.pts[23] = -13;
  assert.equal(bg.movesRequired(s), 2);
  for (const mv of bg.nextMoves(s, [])) {
    assert.equal(bg.nextMoves(s, [mv]).length > 0, true, `${mv.f}>${mv.t} leaves the other die unplayable`);
  }
});

test('bg: hitting a blot sends it to the bar', () => {
  const s = empty({ dice: [3, 1] });
  s.pts[23] = 15;
  s.pts[20] = -1; // black blot on 21
  s.pts[0] = -14;
  const r = bg.act(s, 0, { type: 'move', moves: [{ f: 24, t: 21, d: 3 }, { f: 24, t: 23, d: 1 }] });
  assert.equal(r.error, undefined);
  assert.equal(r.state.bar[1], 1);
  assert.equal(r.state.pts[20], 1);
  assert.equal(r.state.turn, 1);
  assert.equal(r.state.phase, 'roll');
});

test('bg: winning a game scores 1, a gammon 2, a backgammon 3; the match ends at the target', () => {
  const near = (blackSetup) => {
    const s = empty({ dice: [2, 1], off: [14, 0] });
    s.pts[0] = 1; // white's last checker on 1
    blackSetup(s);
    return s;
  };
  const single = near((s) => { s.pts[23] = -14; s.off[1] = 1; });
  assert.deepEqual(bg.act(single, 0, { type: 'move', moves: [{ f: 1, t: 'off', d: 2 }] }, diceRng(4, 2)).state.score, [1, 0]);
  const gammon = near((s) => { s.pts[23] = -15; });
  assert.deepEqual(bg.act(gammon, 0, { type: 'move', moves: [{ f: 1, t: 'off', d: 2 }] }, diceRng(4, 2)).state.score, [2, 0]);
  const backgammon = near((s) => { s.pts[23] = -14; s.pts[2] = -1; });
  const r = bg.act(backgammon, 0, { type: 'move', moves: [{ f: 1, t: 'off', d: 2 }] }, diceRng(4, 2)).state;
  assert.deepEqual(r.score, [3, 0]);
  assert.equal(r.phase, 'over');
  assert.deepEqual(bg.outcome(r), { winners: [0], draw: false });
  const cont = near((s) => { s.pts[23] = -14; s.off[1] = 1; });
  cont.target = 5;
  const next = bg.act(cont, 0, { type: 'move', moves: [{ f: 1, t: 'off', d: 2 }] }, diceRng(4, 2)).state;
  assert.equal(next.game, 2);
  assert.equal(count(next, 0), 15);
  assert.equal(next.off[0], 0);
  assert.equal(next.phase, 'move'); // the next game's opening roll
});

test('bg: 300 random matches end, keep 15 checkers each, and every auto turn is legal', () => {
  const rng = seeded(42);
  for (let m = 0; m < 300; m += 1) {
    let s = bg.create({ target: m % 2 ? 5 : 3 }, rng);
    let steps = 0;
    while (s.phase !== 'over') {
      const seat = bg.turn(s);
      const a = bg.auto(s, seat, rng);
      const r = bg.act(s, seat, a, rng);
      assert.equal(r.error, undefined, `auto action refused: ${r.error} ${JSON.stringify(a)}`);
      s = r.state;
      assert.equal(count(s, 0), 15);
      assert.equal(count(s, 1), 15);
      steps += 1;
      assert.ok(steps < 20000, 'match never ended');
    }
    assert.ok(Math.max(...s.score) >= s.target);
  }
});

// ---------- hokm ----------

const hk = (over) => ({
  phase: 'play', hakem: 0, trump: 'H', hands: [[], [], [], []], trick: [], lead: 0, turn: 0, tricks: [0, 0], score: [0, 0],
  target: 7, hand: 1, last: null, winner: null, log: [], seq: 0, ...over,
});

test('hokm: the first ace picks the Hakem; 13 cards each; trump is named from 5', () => {
  const s = hokm.create({}, seeded(7));
  const ev = s.log.find((e) => e.type === 'hakem');
  assert.equal(hokm.rankOf(ev.cards[ev.cards.length - 1]), 14);
  assert.equal(ev.cards.slice(0, -1).some((c) => hokm.rankOf(c) === 14), false);
  assert.equal(s.hakem, (ev.cards.length - 1) % 4);
  assert.equal(s.phase, 'trump');
  assert.equal(new Set(s.hands.flat()).size, 52);
  assert.ok(s.hands.every((h) => h.length === 13));
  const other = (s.hakem + 1) % 4;
  assert.equal(hokm.act(s, other, { type: 'trump', suit: 'S' }).error, 'NOT_YOUR_TURN');
  assert.equal(hokm.act(s, s.hakem, { type: 'play', card: s.hands[s.hakem][0] }).error, 'CHOOSE_TRUMP');
  const v = hokm.view(s, s.hakem);
  assert.equal(v.hands[s.hakem].length, 5);
  assert.deepEqual(v.hands.filter((h, i) => i !== s.hakem).map((h) => h.length), [0, 0, 0]);
  const t = hokm.act(s, s.hakem, { type: 'trump', suit: 'D' }).state;
  assert.equal(t.trump, 'D');
  assert.equal(t.turn, s.hakem);
  assert.equal(hokm.view(t, 2).hands[2].length, 13);
});

test('hokm: players must follow the led suit when they can', () => {
  const s = hk({ hands: [['S2'], ['S9', 'H3'], ['D4'], ['C5']], trick: [{ seat: 0, card: 'S5' }], turn: 1 });
  assert.equal(hokm.act(s, 1, { type: 'play', card: 'H3' }).error, 'MUST_FOLLOW_SUIT');
  assert.equal(hokm.act(s, 1, { type: 'play', card: 'S9' }).error, undefined);
  const void_ = hk({ hands: [['S2'], ['D9', 'H3'], ['D4'], ['C5']], trick: [{ seat: 0, card: 'S5' }], turn: 1 });
  assert.equal(hokm.act(void_, 1, { type: 'play', card: 'H3' }).error, undefined);
  assert.equal(hokm.act(void_, 1, { type: 'play', card: 'C5' }).error, 'NOT_IN_HAND');
  assert.deepEqual(hokm.legalCards(['S9', 'H3', 'S2'], [{ seat: 0, card: 'S5' }]).sort(), ['S2', 'S9']);
});

test('hokm: the highest trump wins, else the highest card of the led suit', () => {
  const t = (...cards) => cards.map((card, i) => ({ seat: i, card }));
  assert.equal(hokm.trickWinner(t('S5', 'S14', 'D14', 'S2'), 'H'), 1);
  assert.equal(hokm.trickWinner(t('S5', 'S14', 'H2', 'S2'), 'H'), 2);
  assert.equal(hokm.trickWinner(t('S5', 'H9', 'H2', 'H12'), 'H'), 3);
  assert.equal(hokm.trickWinner(t('C3', 'D14', 'S14', 'C4'), 'H'), 3);
});

function finishTrick(state, cards) {
  let s = state;
  for (const card of cards) s = hokm.act(s, s.turn, { type: 'play', card }).state;
  return s;
}

test('hokm: a hand ends at 7 tricks; kot scores 2, kot against the Hakem 3; the Hakem passes on a loss', () => {
  const base = { hands: [['S14', 'S3'], ['S2', 'S4'], ['S5', 'S6'], ['S7', 'S8']], turn: 0, lead: 0 };
  const plain = finishTrick(hk({ ...base, tricks: [6, 2] }), ['S14', 'S2', 'S5', 'S7']);
  assert.deepEqual(plain.score, [1, 0]);
  assert.equal(plain.hakem, 0);
  assert.equal(plain.phase, 'trump');
  assert.equal(plain.hand, 2);
  const kot = finishTrick(hk({ ...base, tricks: [6, 0] }), ['S14', 'S2', 'S5', 'S7']);
  assert.deepEqual(kot.score, [2, 0]);
  const hakemKot = finishTrick(hk({ ...base, hakem: 1, tricks: [6, 0] }), ['S14', 'S2', 'S5', 'S7']);
  assert.deepEqual(hakemKot.score, [3, 0]);
  assert.equal(hakemKot.hakem, 2, 'the Hakem passes to the next seat when his team loses');
  const match = finishTrick(hk({ ...base, tricks: [6, 1], score: [6, 3] }), ['S14', 'S2', 'S5', 'S7']);
  assert.equal(match.phase, 'over');
  assert.deepEqual(hokm.outcome(match), { winners: [0, 2], draw: false });
});

test('hokm: 300 matches played by the AI are always legal and reach 7', () => {
  const rng = seeded(9);
  for (let m = 0; m < 300; m += 1) {
    let s = hokm.create({}, rng);
    let steps = 0;
    while (s.phase !== 'over') {
      const seat = hokm.turn(s);
      const a = hokm.auto(s, seat);
      const r = hokm.act(s, seat, a, rng);
      assert.equal(r.error, undefined, `AI action refused: ${r.error}`);
      s = r.state;
      if (s.phase === 'play') {
        const inPlay = s.hands.flat().length + s.trick.length;
        assert.equal((52 - inPlay) % 4, 0, 'cards went missing');
      }
      steps += 1;
      assert.ok(steps < 5000);
    }
    assert.ok(Math.max(...s.score) >= 7);
  }
});

// ---------- codeword ----------

test('codeword: exact / near counts, with repeated letters counted once each', () => {
  assert.deepEqual(cw.score('crane', 'crane'), { exact: 5, near: 0 });
  assert.deepEqual(cw.score('nacre', 'crane'), { exact: 1, near: 4 });
  assert.deepEqual(cw.score('eeeee', 'crane'), { exact: 1, near: 0 });
  assert.deepEqual(cw.score('speed', 'erase'), { exact: 0, near: 3 });
  assert.deepEqual(cw.score('abbey', 'babes'), { exact: 2, near: 2 });
});

test('codeword: normalizing per language, and the keyboards cover each alphabet', () => {
  assert.equal(cw.normalize('fr', 'Élève'), 'eleve');
  assert.equal(cw.normalize('ru', 'Ёлка'), 'елка');
  assert.equal(cw.normalize('fa', 'آسمان'), 'اسمان');
  assert.equal(cw.normalize('fa', 'كيوان'), 'کیوان');
  assert.ok(cw.wellFormed('fa', cw.normalize('fa', 'آسمان')));
  assert.ok(!cw.wellFormed('en', 'cran'));
  assert.ok(!cw.wellFormed('en', 'cran3'));
  assert.equal(new Set(cw.KEYBOARDS.fa.join('')).size, 32);
  assert.equal(new Set(cw.KEYBOARDS.ru.join('')).size, 32);
  assert.equal(new Set(cw.KEYBOARDS.en.join('')).size, 26);
  assert.equal(new Set(cw.KEYBOARDS.fr.join('')).size, 26);
});

test('codeword: the daily word is the same all day and changes between days', () => {
  const day = cw.dayKey(Date.UTC(2026, 9, 30, 23, 59));
  assert.equal(day, 20261030);
  assert.equal(cw.dailyIndex(day, 'en', 1000), cw.dailyIndex(day, 'en', 1000));
  const days = new Set(Array.from({ length: 30 }, (_, i) => cw.dailyIndex(20261001 + i, 'en', 1000)));
  assert.ok(days.size > 25);
  assert.equal(cw.pointsFor(1), 10);
  assert.equal(cw.pointsFor(10), 1);
});

// ---------- fusion ----------

test('fusion: three equal tiles fuse on the placed cell and can chain', () => {
  const g = fusion.start(1);
  g.board = new Array(25).fill(0);
  g.board[0] = 1;
  g.board[1] = 1;
  g.board[5] = 2;
  g.board[10] = 2;
  g.queue = [1, 1];
  const f = g.queue[0];
  assert.equal(f, 1);
  // placing a 1 at 6? not adjacent to both 1s; at cell 2? next to 1 only. Place at cell 6: neighbours 1,5,7,11
  const fusions = fusion.place(g, 6);
  assert.equal(fusions.length, 2, JSON.stringify(fusions));
  assert.deepEqual(fusions[0].cells.sort((a, b) => a - b), [0, 1, 6]);
  assert.equal(fusions[0].into, 2);
  assert.equal(fusions[1].into, 3);
  assert.equal(fusions[1].combo, 2);
  assert.equal(g.board[6], 3);
  assert.equal(g.board[0] + g.board[1] + g.board[5] + g.board[10], 0);
  assert.equal(fusion.place(g, 6), null, 'an occupied cell is refused');
});

test('fusion: replaying the moves gives the same score; a tampered list is refused', () => {
  const rng = seeded(5);
  for (let k = 0; k < 20; k += 1) {
    const seed = 1000 + k;
    const g = fusion.start(seed);
    const moves = [];
    while (!g.over) {
      const free = g.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      const cell = free[Math.floor(rng() * free.length)];
      fusion.place(g, cell);
      moves.push(cell);
    }
    const r = fusion.replay(seed, moves);
    assert.deepEqual(r, { score: g.score, moves: moves.length, over: true, best: g.best });
    const other = fusion.replay(seed + 1, moves);
    assert.ok(other.error || other.score !== g.score || other.moves !== moves.length, 'another seed replays differently');
    assert.equal(fusion.replay(seed, moves.concat([0])).error, 'ILLEGAL_MOVE');
  }
});
