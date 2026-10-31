/*
 * A user sent an inline result (needs BotFather /setinlinefeedback): usage counts.
 * The work is in lib/router.js. Returns the trace of Bot API calls (shown by `npx tgcloud run`).
 */
import { onChosen } from '../lib/router.js';

export default async function (result) {
  try {
    return await onChosen(result);
  } catch (err) {
    console.error('chosen_inline_result handler failed:', err);
    return { error: String((err && err.message) || err) };
  }
}
