/* Buttons in the bot's chat: language, "I've joined", the owner panel. See lib/bot.js. */
import { onCallback } from '../lib/bot.js';

export default async function (callbackQuery) {
  return onCallback(callbackQuery);
}
