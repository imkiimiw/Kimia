// handlers/pre_checkout_query — a listener confirmed a ⭐ Stars donation; Telegram waits for the answer
// (≤ 10 s), so no piggyback tick runs first.
import { runHandler } from '../lib/core/boundary.js';
import { onPreCheckoutQuery } from '../lib/bot/router.js';

export default function (query, ctx) {
  return runHandler('pre_checkout_query', query, ctx, (app) => onPreCheckoutQuery(app, query), { tick: false });
}
