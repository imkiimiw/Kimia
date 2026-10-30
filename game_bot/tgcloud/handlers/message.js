/* Private messages: /start, /language, /help, /admin and the owner's panel inputs. See lib/bot.js. */
import { onMessage } from '../lib/bot.js';

export default async function (message) {
  return onMessage(message);
}
