/* A vote in a poll Aegis sent that isn't anonymous. See lib/ui/social.js. */
import { onPollAnswer } from '../lib/router.js';

export default async function (answer, ctx) {
  return onPollAnswer(answer, ctx);
}
