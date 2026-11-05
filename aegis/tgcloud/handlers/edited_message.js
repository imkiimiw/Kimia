/* Edited messages: the group locks look at the new text again (and the edit lock). See lib/router.js. */
import { onEditedMessage } from '../lib/router.js';

export default async function (message, ctx) {
  return onEditedMessage(message, ctx);
}
