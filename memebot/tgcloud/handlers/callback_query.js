/*
 * Inline keyboard buttons. Every query is answered once.
 * The work is in lib/router.js. Returns the trace of Bot API calls (shown by `npx tgcloud run`).
 */
import { onCallback } from '../lib/router.js';

export default async function (callbackQuery) {
  try {
    return await onCallback(callbackQuery);
  } catch (err) {
    console.error('callback_query handler failed:', err);
    return { error: String((err && err.message) || err) };
  }
}
