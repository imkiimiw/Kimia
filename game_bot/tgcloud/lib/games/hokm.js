/*
 * Hokm: four seats in two teams (seats 0 + 2 against 1 + 3). Pure; the room layer stores the state.
 *
 * The first hand's Hakem is whoever is dealt the first ace (cards dealt one at a time from seat 0).
 * Each hand: 5 cards each, the Hakem names trump from his 5, then 4 + 4 more (13 each). The Hakem
 * leads; players must follow the led suit when they can; the highest trump, else the highest card
 * of the led suit, takes the trick and leads next. A hand ends as soon as a team has 7 tricks.
 * Scoring: 1 hand; a 7–0 hand (kot) 2; a kot against the Hakem's team 3. The Hakem stays while his
 * team wins hands, else it passes to the next seat. First team to `target` (7) hands wins.
 *
 * Cards are strings: suit (S H D C) + rank (2–14, 14 = ace): 'H14', 'S10', 'C2'.
 * state: phase (trump / play / over), hakem, trump, hands [4][], trick [{ seat, card }], lead,
 * turn, tricks [team0, team1] this hand, score [team0, team1] hands, target, hand (number),
 * last (the previous trick, with its winner), winner (team), log / seq.
 * actions: { type: 'trump', suit }   { type: 'play', card }
 */
import { clone, logEvent, shuffle } from './util.js';

export const SEATS = 4;
export const TURN_SEC = 45;
export const SUITS = ['S', 'H', 'D', 'C'];
export const TARGET = 7;

export const suitOf = (card) => card[0];
export const rankOf = (card) => Number(card.slice(1));
export const teamOf = (seat) => seat % 2;

export function deck() {
  const out = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r += 1) out.push(`${s}${r}`);
  return out;
}

/* Cards the player may play now: the led suit if they have it, else anything. */
export function legalCards(hand, trick) {
  if (!trick.length) return hand.slice();
  const led = suitOf(trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

/* The seat that takes a complete (or partial) trick. */
export function trickWinner(trick, trump) {
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const bs = suitOf(best.card);
    const ps = suitOf(p.card);
    if (ps === bs) {
      if (rankOf(p.card) > rankOf(best.card)) best = p;
    } else if (ps === trump && bs !== trump) {
      best = p;
    }
  }
  return best.seat;
}

function deal(s, rng) {
  const d = shuffle(deck(), rng);
  const hands = [[], [], [], []];
  let k = 0;
  for (const n of [5, 4, 4]) {
    for (let i = 0; i < 4; i += 1) {
      const seat = (s.hakem + i) % 4;
      for (let j = 0; j < n; j += 1) hands[seat].push(d[k++]);
    }
  }
  s.hands = hands;
  s.trump = null;
  s.trick = [];
  s.tricks = [0, 0];
  s.phase = 'trump';
  s.turn = s.hakem;
  s.lead = s.hakem;
  logEvent(s, { type: 'deal', hakem: s.hakem, hand: s.hand });
}

export function create(opts = {}, rng = Math.random) {
  const d = shuffle(deck(), rng);
  let i = 0;
  while (rankOf(d[i]) !== 14) i += 1;
  const s = { phase: 'trump', hakem: i % 4, trump: null, hands: [], trick: [], lead: 0, turn: 0, tricks: [0, 0], score: [0, 0],
    target: opts.target || TARGET, hand: 1, last: null, winner: null, log: [], seq: 0 };
  logEvent(s, { type: 'hakem', seat: i % 4, cards: d.slice(0, i + 1) });
  deal(s, rng);
  return s;
}

export function turn(state) {
  return state.phase === 'over' ? -1 : state.turn;
}

export function act(state, seat, action, rng = Math.random) {
  if (state.phase === 'over') return { error: 'GAME_OVER' };
  if (seat !== state.turn) return { error: 'NOT_YOUR_TURN' };
  if (!action) return { error: 'BAD_ACTION' };
  if (state.phase === 'trump') {
    if (action.type !== 'trump' || !SUITS.includes(action.suit)) return { error: 'CHOOSE_TRUMP' };
    const s = clone(state);
    s.trump = action.suit;
    s.phase = 'play';
    s.turn = s.hakem;
    s.lead = s.hakem;
    logEvent(s, { type: 'trump', seat, suit: action.suit });
    return { state: s };
  }
  if (action.type !== 'play' || typeof action.card !== 'string') return { error: 'BAD_ACTION' };
  const hand = state.hands[seat];
  if (!hand.includes(action.card)) return { error: 'NOT_IN_HAND' };
  if (!legalCards(hand, state.trick).includes(action.card)) return { error: 'MUST_FOLLOW_SUIT' };
  const s = clone(state);
  s.hands[seat] = hand.filter((c) => c !== action.card);
  s.trick.push({ seat, card: action.card });
  logEvent(s, { type: 'play', seat, card: action.card });
  if (s.trick.length < 4) {
    s.turn = (seat + 1) % 4;
    return { state: s };
  }
  const w = trickWinner(s.trick, s.trump);
  const team = teamOf(w);
  s.tricks[team] += 1;
  s.last = { cards: s.trick, winner: w };
  s.trick = [];
  s.lead = w;
  s.turn = w;
  logEvent(s, { type: 'trick', seat: w, tricks: s.tricks.slice() });
  if (s.tricks[team] < 7) return { state: s };
  const other = 1 - team;
  const hakemTeam = teamOf(s.hakem);
  let points = 1;
  if (s.tricks[other] === 0) points = other === hakemTeam ? 3 : 2;
  s.score[team] += points;
  logEvent(s, { type: 'hand', team, points, kot: points > 1, score: s.score.slice() });
  if (s.score[team] >= s.target) {
    s.phase = 'over';
    s.turn = -1;
    s.winner = team;
    logEvent(s, { type: 'match', team });
    return { state: s };
  }
  if (team !== hakemTeam) s.hakem = (s.hakem + 1) % 4;
  s.hand += 1;
  deal(s, rng);
  return { state: s };
}

/* ---------- the simple AI (bot seats, and players who run out of time) ---------- */

function chooseTrump(cards) {
  let best = SUITS[0];
  let bestKey = -1;
  for (const suit of SUITS) {
    const mine = cards.filter((c) => suitOf(c) === suit);
    const key = mine.length * 100 + mine.reduce((n, c) => n + rankOf(c), 0);
    if (key > bestKey) {
      best = suit;
      bestKey = key;
    }
  }
  return best;
}

const lowest = (cards) => cards.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
const highest = (cards) => cards.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));

function choosePlay(state, seat) {
  const hand = state.hands[seat];
  const legal = legalCards(hand, state.trick);
  const trump = state.trump;
  if (!state.trick.length) {
    const aces = legal.filter((c) => rankOf(c) === 14 && suitOf(c) !== trump);
    if (aces.length) return aces[0];
    const plain = legal.filter((c) => suitOf(c) !== trump);
    return lowest(plain.length ? plain : legal);
  }
  const winnerNow = trickWinner(state.trick, trump);
  const partnerWins = teamOf(winnerNow) === teamOf(seat);
  if (partnerWins) {
    const plain = legal.filter((c) => suitOf(c) !== trump);
    return lowest(plain.length ? plain : legal);
  }
  const winning = legal.filter((c) => trickWinner(state.trick.concat([{ seat, card: c }]), trump) === seat);
  if (winning.length) {
    const lastToPlay = state.trick.length === 3;
    return lastToPlay ? lowest(winning) : (winning.some((c) => suitOf(c) !== trump) ? highest(winning.filter((c) => suitOf(c) !== trump)) : lowest(winning));
  }
  const plain = legal.filter((c) => suitOf(c) !== trump);
  return lowest(plain.length ? plain : legal);
}

export function auto(state, seat) {
  if (state.phase === 'trump') return { type: 'trump', suit: chooseTrump(state.hands[seat].slice(0, 5)) };
  return { type: 'play', card: choosePlay(state, seat) };
}

export function outcome(state) {
  if (state.phase !== 'over') return null;
  return { winners: [state.winner, state.winner + 2], draw: false };
}

export function rematch(state, rng = Math.random) {
  return create({ target: state.target }, rng);
}

/*
 * What `seat` may see: their own hand (only the first 5 cards while trump is being chosen), the
 * other hands as counts. seat = -1 (a spectator) sees no hand.
 */
export function view(state, seat) {
  const v = clone(state);
  v.counts = state.hands.map((h) => (state.phase === 'trump' ? Math.min(5, h.length) : h.length));
  v.hands = state.hands.map((h, i) => {
    if (i !== seat) return [];
    return state.phase === 'trump' ? h.slice(0, 5) : h.slice();
  });
  return v;
}
