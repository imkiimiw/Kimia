// Telegram `my_chat_member` updates (the bot added/removed/blocked) → lib/router.js.
import { onMyChatMember } from '../lib/router.js';

export default function (update, ctx) {
  return onMyChatMember(update, ctx);
}
