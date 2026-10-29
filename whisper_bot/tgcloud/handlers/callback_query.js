// Every button press: "👁 نمایش نجوا" under whispers, and the menus in the bot's private chat.
import { onCallback } from '../lib/router.js';

export default async function (callbackQuery) {
  try {
    return await onCallback(callbackQuery);
  } catch (err) {
    console.error('callback_query handler failed:', err);
    return { error: true };
  }
}
