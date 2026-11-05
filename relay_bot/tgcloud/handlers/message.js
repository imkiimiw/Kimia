/*
 * Every incoming message. For a user's message the owner gets a "📩 new message" card, the forward
 * and the copy; the owner's reply to one of those goes back to that user. lib/relay.js has the
 * details and never throws; it returns the trace of Bot API calls, which `npx tgcloud run` prints.
 */
import { onMessage } from '../lib/relay.js';

export default async function (message) {
  return onMessage(message);
}
