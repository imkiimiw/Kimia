// Runs for every `message` update: private chats get the todo bot; everything else is ignored.
import { handleMessage } from '../lib/bot.js';

export default async function (message) {
  try {
    await handleMessage(message);
  } catch (err) {
    // Logged instead of rethrown, so one bad update can't make Telegram redeliver it over and over.
    console.error('message handler failed:', err);
  }
}
