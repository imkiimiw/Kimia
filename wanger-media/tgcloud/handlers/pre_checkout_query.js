// Telegram `pre_checkout_query` updates (Stars payments for VIP) → lib/router.js → lib/vip.js.
import { onPreCheckout } from '../lib/router.js';

export default function (query, ctx) {
  return onPreCheckout(query, ctx);
}
