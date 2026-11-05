// Rate-limit and backoff math shared by every bulk sender (pure). No sleeping anywhere:
// a sender that is over its limit stops and the next tick continues.

export const BULK = Object.freeze({
  /** Bot FAQ: ~30 messages/s overall for bulk sends; stay a little below. */
  perSecond: 25,
  /** at least 1 s between two messages to the same chat */
  perChatGapSeconds: 1,
});

/** True while a global cooldown (after a 429) is active. @param {number} now @param {number} until */
export const cooldownActive = (now, until) => Number(until) > now;

/** End of the cooldown after a 429: never earlier than retry_after. @param {number} now @param {number} retryAfter */
export const cooldownAfter429 = (now, retryAfter) => now + Math.max(1, Math.ceil(Number(retryAfter) || 1));

/** May the next bulk message go now? `sent` messages went out in `elapsedMs` so far. */
export function bulkPaceAllows(sent, elapsedMs, perSecond = BULK.perSecond) {
  return sent < perSecond * (Math.floor(Math.max(0, elapsedMs) / 1000) + 1);
}

/** May a message go to a chat that last got one at `lastAt`? */
export const chatGapAllows = (lastAt, now, gap = BULK.perChatGapSeconds) => !lastAt || now - lastAt >= gap;

/**
 * Exponential backoff with jitter for transient failures: 1, 2, 4, 8, 16… minutes, capped at 60.
 * @param {number} attempt 1-based @param {() => number} [rand]
 */
export function backoffSeconds(attempt, rand = Math.random) {
  const minutes = Math.min(60, 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + rand() * 0.4;
  return Math.round(Math.min(3600, minutes * 60 * jitter));
}

/**
 * Fixed-window counter for per-channel limits (Telegram: ~20 posts a minute per channel).
 * Pure: returns whether one more event fits and the state to store.
 * @param {{start: number, count: number}|null} state @param {number} now @param {number} max @param {number} windowSec
 */
export function windowAllows(state, now, max, windowSec) {
  const s = state && typeof state === 'object' && now - state.start < windowSec ? state : { start: now, count: 0 };
  if (s.count >= max) return { allowed: false, state: s };
  return { allowed: true, state: { start: s.start, count: s.count + 1 } };
}
