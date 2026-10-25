// Every inline-button press. Each one is answered with answerCallbackQuery.
// Returns a trace of the Bot API calls it made, which `npx tgcloud run` prints.
import { handleCallback } from '../lib/router.js';

export default async function (callbackQuery) {
  try {
    return await handleCallback(callbackQuery);
  } catch (err) {
    // handleCallback already answers the button and reports errors; this is a last resort.
    console.error('callback_query handler failed:', err);
    return { error: true };
  }
}
