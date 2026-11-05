/*
 * Helpers shared by the game modules (server and Mini App). Pure: no sdk, no I/O.
 * A `rng` is a function giving a float in [0, 1); the server passes Math.random, tests a seeded one.
 */

export function randInt(n, rng) {
  return Math.floor(rng() * n);
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1, rng);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/* mulberry32: a small seeded generator; the same seed gives the same sequence on server and client. */
export function seeded(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Appends an event to state.log (keeps the last 40) and gives it a sequence number. */
export function logEvent(state, ev) {
  const seq = (state.seq || 0) + 1;
  state.seq = seq;
  const log = (state.log || []).concat([{ ...ev, n: seq }]);
  state.log = log.length > 40 ? log.slice(log.length - 40) : log;
}

export const clone = (x) => JSON.parse(JSON.stringify(x));
