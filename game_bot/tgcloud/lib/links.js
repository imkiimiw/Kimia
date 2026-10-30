/*
 * The bot's username (cached in settings) and the Direct Link Mini App links built from it:
 * https://t.me/<bot>/<APP_SHORT_NAME>?startapp=<payload> (payloads: payload.js).
 */
import { APP_SHORT_NAME } from './config.js';
import * as store from './store.js';
import { call } from './tg.js';

let cached = null;

export async function botUsername(ctx) {
  if (cached) return cached;
  const s = await store.getSettings();
  if (s.bot_username) {
    cached = s.bot_username;
    return cached;
  }
  const me = await call(ctx, 'getMe', {}, 'me');
  cached = me.username;
  await store.setSetting('bot_username', cached);
  return cached;
}

export const appLink = (username, payload) => `https://t.me/${username}/${APP_SHORT_NAME}${payload ? `?startapp=${payload}` : ''}`;

export { parsePayload, payloadFor } from './payload.js';
