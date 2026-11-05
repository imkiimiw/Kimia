/* Messages: private chat (start, language, help, owner panel inputs) and group migrations. See lib/router.js. */
import { onMessage } from '../lib/router.js';

export default async function (message, ctx) {
  return onMessage(message, ctx);
}
