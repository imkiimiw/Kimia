/* A member's status changed in a chat where Aegis is an admin: admin cache, revocation, reminders. See lib/router.js. */
import { onChatMember } from '../lib/router.js';

export default async function (update, ctx) {
  return onChatMember(update, ctx);
}
