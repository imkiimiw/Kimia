/* The bot's own membership: a user blocked/unblocked it, or it joined/left a group or channel. See lib/router.js. */
import { onMyChatMember } from '../lib/router.js';

export default async function (update, ctx) {
  return onMyChatMember(update, ctx);
}
