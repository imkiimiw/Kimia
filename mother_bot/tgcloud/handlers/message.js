// A private message (or a command in a group): lib/router.js onMessage.
import { onMessage } from '../lib/router.js';

export default async function (message) {
  try {
    return await onMessage(message);
  } catch (err) {
    console.error('message handler failed:', err);
    return { error: true };
  }
}
