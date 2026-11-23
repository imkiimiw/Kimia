// Telegram `inline_query` updates ("@Wanger_mediabot <link>" in any chat) → lib/router.js → lib/inline.js.
import { onInlineQuery } from '../lib/router.js';

export default function (query, ctx) {
  return onInlineQuery(query, ctx);
}
