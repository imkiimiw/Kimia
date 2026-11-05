// Every inline-button press. Each one is answered (answerCallbackQuery) exactly once.
import { handleCallback } from '../lib/router.js';

export default async function (callbackQuery, ctx) {
  try {
    return await handleCallback(callbackQuery, ctx || {});
  } catch (err) {
    console.error('callback_query handler failed:', err);
    return { error: true };
  }
}
