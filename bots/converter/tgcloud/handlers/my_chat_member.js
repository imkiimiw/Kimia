// `my_chat_member` updates (the bot blocked/unblocked by a user, its status in a channel) → lib/router.js.
import { handleMyChatMember } from '../lib/router.js';

export default function (update, ctx) {
  return handleMyChatMember(update, ctx && ctx.update);
}
