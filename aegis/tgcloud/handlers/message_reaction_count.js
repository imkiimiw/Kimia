/* Reactions on a channel post changed (anonymous counts): kept for the channel's analytics. See lib/ui/social.js. */
import { onReactionCount } from '../lib/router.js';

export default async function (update, ctx) {
  return onReactionCount(update, ctx);
}
