/* Inline buttons (language, forced-join re-check, menus, owner panel). See lib/router.js. */
import { onCallback } from '../lib/router.js';

export default async function (callbackQuery, ctx) {
  return onCallback(callbackQuery, ctx);
}
