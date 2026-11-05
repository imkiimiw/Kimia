/*
 * Every message. Private chats get the bot; groups and channels are ignored.
 * The work is in lib/router.js. Returns the trace of Bot API calls (shown by `npx tgcloud run`).
 */
import { onMessage } from '../lib/router.js';

export default async function (message) {
  try {
    return await onMessage(message);
  } catch (err) {
    console.error('message handler failed:', err);
    return { error: String((err && err.message) || err) };
  }
}
