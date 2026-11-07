// `message` updates → lib/router.js (thin: the router holds the order of checks).
import { handleMessage } from '../lib/router.js';

export default function (message, ctx) {
  return handleMessage(message, ctx && ctx.update);
}
