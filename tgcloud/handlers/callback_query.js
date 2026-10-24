// Runs for every inline-button press.
import { handleCallback } from '../lib/bot.js';

export default async function (callbackQuery) {
  try {
    await handleCallback(callbackQuery);
  } catch (err) {
    console.error('callback_query handler failed:', err);
  }
}
