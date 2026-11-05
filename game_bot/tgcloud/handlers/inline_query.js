/* @bot in any chat: the five games, each a message with a button that opens the Mini App. See lib/inline.js. */
import { onInlineQuery } from '../lib/inline.js';

export default async function (inlineQuery) {
  return onInlineQuery(inlineQuery);
}
