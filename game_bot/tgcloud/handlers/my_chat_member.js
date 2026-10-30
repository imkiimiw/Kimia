/* A user blocked or unblocked the bot in private: kept in users.blocked. See lib/bot.js. */
import { onMyChatMember } from '../lib/bot.js';

export default async function (update) {
  return onMyChatMember(update);
}
