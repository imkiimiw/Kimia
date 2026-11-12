// handlers/my_chat_member — the bot was blocked/unblocked, or its rights changed in a channel
// (gate channels and the publish channel alert the owner). Exempt from the gate.
import { runHandler } from '../lib/boundary.js';
import { onMyChatMember } from '../lib/bot/router.js';

export default function (update, ctx) {
  return runHandler('my_chat_member', update, ctx, (app) => onMyChatMember(app, update), { tick: false });
}
