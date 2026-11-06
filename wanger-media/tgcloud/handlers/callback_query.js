// Telegram `callback_query` updates (button presses) → lib/router.js.
import { onCallback } from '../lib/router.js';

export default function (callbackQuery, ctx) {
  return onCallback(callbackQuery, ctx);
}
