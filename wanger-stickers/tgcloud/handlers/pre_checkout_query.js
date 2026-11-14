// handlers/pre_checkout_query — Telegram Stars checkout (Phase 5): answered at once (≤ 10 s).
import { runHandler } from '../lib/boundary.js';

export default function (query, ctx) {
  return runHandler('pre_checkout_query', query, ctx, (app) => app.stars.preCheckout(query), { tick: false });
}
