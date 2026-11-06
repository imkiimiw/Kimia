// handlers/message — private-chat messages, and messages in groups where the bot is admin (source
// groups). Thin: the boundary and the router do the work. Group chatter without audio needs no
// dedupe row and no piggyback tick (it is ignored anyway).
import { runHandler } from '../lib/core/boundary.js';
import { onMessage } from '../lib/bot/router.js';

export default function (message, ctx) {
  const chatType = message && message.chat ? message.chat.type : '';
  const quiet = (chatType === 'group' || chatType === 'supergroup') && !message.audio && !message.migrate_to_chat_id;
  return runHandler('message', message, ctx, (app) => onMessage(app, message), quiet ? { dedupe: false, tick: false } : {});
}
