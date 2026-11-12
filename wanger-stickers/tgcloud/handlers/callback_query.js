// handlers/callback_query — inline button presses (always answered exactly once).
import { runHandler } from '../lib/boundary.js';
import { onCallback } from '../lib/bot/router.js';

export default function (callbackQuery, ctx) {
  return runHandler('callback_query', callbackQuery, ctx, (app) => onCallback(app, callbackQuery));
}
