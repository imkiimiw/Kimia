// Every incoming message. Private chats get the bot's menus; groups and channels are ignored
// (whispers are sent in inline mode and need nothing from the group). Returns the trace of
// Bot API calls, which `npx tgcloud run` prints.
import { onMessage } from '../lib/router.js';

export default async function (message) {
  try {
    return await onMessage(message);
  } catch (err) {
    console.error('message handler failed:', err);
    return { error: true };
  }
}
