/*
 * Rock, paper, scissors for two seats: both choose in secret, then both are shown. Rock beats
 * scissors, scissors beat paper, paper beats rock; the same choice replays the round. First to
 * `target` (3) rounds wins. Pure.
 *
 * Both players act at the same time, so this module has waiting(state) (who still has to choose)
 * besides turn(state), and view() hides a choice until the round is revealed.
 *
 * state: picks [a, b] (null / r / p / s), score [0, 1], round, target, w winner seat or null,
 * last { picks, winner (-1: a tie), round } the round just revealed, log / seq.
 * action: { type: 'pick', pick: 'r' | 'p' | 's' }
 */
import { clone, logEvent, randInt } from './util.js';

export const SEATS = 2;
export const TURN_SEC = 20;
export const TARGET = 3;
export const PICKS = ['r', 'p', 's'];
const BEATS = { r: 's', s: 'p', p: 'r' };

export function create() {
  return { picks: [null, null], score: [0, 0], round: 1, target: TARGET, w: null, last: null, log: [], seq: 0 };
}

export function waiting(state) {
  if (state.w !== null) return [];
  return [0, 1].filter((s) => state.picks[s] === null);
}

export function turn(state) {
  const w = waiting(state);
  return w.length ? w[0] : -1;
}

export function act(state, seat, action) {
  if (state.w !== null) return { error: 'GAME_OVER' };
  if (seat !== 0 && seat !== 1) return { error: 'NOT_YOUR_TURN' };
  if (!action || action.type !== 'pick' || !PICKS.includes(action.pick)) return { error: 'BAD_ACTION' };
  if (state.picks[seat] !== null) return { error: 'ALREADY_PICKED' };
  const s = clone(state);
  s.picks[seat] = action.pick;
  logEvent(s, { type: 'pick', seat });
  const [a, b] = s.picks;
  if (a === null || b === null) return { state: s };
  const winner = a === b ? -1 : (BEATS[a] === b ? 0 : 1);
  if (winner >= 0) s.score[winner] += 1;
  s.last = { picks: [a, b], winner, round: s.round };
  logEvent(s, { type: 'reveal', picks: [a, b], winner, round: s.round, score: s.score.slice() });
  s.picks = [null, null];
  s.round += 1;
  if (winner >= 0 && s.score[winner] >= s.target) {
    s.w = winner;
    logEvent(s, { type: 'end', w: winner });
  }
  return { state: s };
}

export function auto(state, seat, rng) {
  return { type: 'pick', pick: PICKS[randInt(3, rng)] };
}

export function outcome(state) {
  return state.w === null ? null : { winners: [state.w], draw: false };
}

export function rematch() {
  return create();
}

/*
 * What `seat` may see: their own choice, and only whether the other has chosen ('?').
 * `turn` is who the viewer is waiting for: themselves if they haven't chosen, else the other seat.
 */
export function view(state, seat) {
  const v = clone(state);
  v.picks = state.picks.map((p, i) => (p === null ? null : (i === seat ? p : '?')));
  const w = waiting(state);
  v.turn = w.includes(seat) ? seat : (w.length ? w[0] : -1);
  return v;
}
