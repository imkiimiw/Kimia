/* @bot <text> in any chat: fonts, a Hafez reading, a Khayyam quatrain, a famous poem. See lib/ui/fun.js inlineQuery. */
import { onInlineQuery } from '../lib/router.js';

export default async function (query, ctx) {
  return onInlineQuery(query, ctx);
}
