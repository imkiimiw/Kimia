// Telegram `message` updates → lib/router.js (which documents the order of checks).
import { onMessage } from '../lib/router.js';

export default function (message, ctx) {
  return onMessage(message, ctx);
}
