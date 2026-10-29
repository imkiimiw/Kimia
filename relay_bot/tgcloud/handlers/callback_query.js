// The buttons under each copied message in the owner's chat: user info, block, unblock.
import { onCallback } from '../lib/relay.js';

export default async function (callbackQuery) {
  return onCallback(callbackQuery);
}
