// handlers/my_chat_member — the bot was blocked/unblocked, or its status changed in a chat.
import { runHandler } from '../lib/core/boundary.js';
import { onMyChatMember } from '../lib/bot/router.js';

export default function (update, ctx) {
  return runHandler('my_chat_member', update, ctx, (app) => onMyChatMember(app, update));
}
