/* The buttons on the owner's "📩 new message" card: seen, write to them, block / unblock. */
import { onCallback } from '../lib/relay.js';

export default async function (callbackQuery) {
  return onCallback(callbackQuery);
}
