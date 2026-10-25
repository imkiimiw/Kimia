// Every incoming message. Private chats get the to-do bot; groups and channels are ignored.
// Returns a trace of the Bot API calls it made, which `npx tgcloud run` prints.
import { handleMessage } from '../lib/router.js';

export default async function (message) {
  try {
    return await handleMessage(message);
  } catch (err) {
    // handleMessage already reports errors to the user; never let one escape to the platform.
    console.error('message handler failed:', err);
    return { error: true };
  }
}
