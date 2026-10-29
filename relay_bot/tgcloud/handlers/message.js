// Every incoming message. A user's message is forwarded and copied to the owner; the owner's reply
// to one of those goes back to that user. lib/relay.js has the details and never throws; it returns
// the trace of Bot API calls, which `npx tgcloud run` prints.
import { onMessage } from '../lib/relay.js';

export default async function (message) {
  return onMessage(message);
}
