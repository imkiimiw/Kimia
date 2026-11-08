// handlers/message — private-chat messages, and messages in groups where the bot is admin (source
// groups). Thin: the boundary and the router do the work. Group chatter without audio needs no
// dedupe row (it is ignored anyway), but it may run the throttled piggyback tick.
import { runHandler } from '../lib/core/boundary.js';
import { onMessage } from '../lib/bot/router.js';

export default function (message, ctx) {
  const chatType = message && message.chat ? message.chat.type : '';
  const quiet = (chatType === 'group' || chatType === 'supergroup') && !message.audio && !message.migrate_to_chat_id;
  // chatter still runs the (throttled) piggyback tick: on this platform activity is what moves the queue
  return runHandler('message', message, ctx, (app) => onMessage(app, message), quiet ? { dedupe: false } : {});
}
