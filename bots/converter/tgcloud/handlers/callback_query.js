// `callback_query` updates (button presses) → lib/router.js.
import { handleCallback } from '../lib/router.js';

export default function (callbackQuery, ctx) {
  return handleCallback(callbackQuery, ctx && ctx.update);
}
