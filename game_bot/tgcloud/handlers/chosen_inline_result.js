/* A game invitation was sent (inline feedback must be on in BotFather): create its room. See lib/inline.js. */
import { onChosenInlineResult } from '../lib/inline.js';

export default async function (chosen) {
  return onChosenInlineResult(chosen);
}
