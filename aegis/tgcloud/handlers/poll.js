/* A poll Aegis sent changed (votes, closed): its results are kept. See lib/ui/social.js. */
import { onPoll } from '../lib/router.js';

export default async function (poll, ctx) {
  return onPoll(poll, ctx);
}
