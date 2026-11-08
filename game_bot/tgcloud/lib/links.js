/*
 * The bot's username (cached in settings) and the links that open the Mini App with a payload:
 * https://t.me/<bot>?startapp=<payload> (the Main Mini App), or https://t.me/<bot>/<APP_SHORT_NAME>?…
 * when config names a /newapp app (payloads: payload.js).
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

export function appLink(username, payload) {
  const base = APP_SHORT_NAME ? `https://t.me/${username}/${APP_SHORT_NAME}` : `https://t.me/${username}`;
  if (payload) return `${base}?startapp=${payload}`;
  return APP_SHORT_NAME ? base : `${base}?startapp`;
}

export { parsePayload, payloadFor } from './payload.js';
