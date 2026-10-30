/*
 * The bot's username (cached in settings) and the Direct Link Mini App links built from it:
 * https://t.me/<bot>/<APP_SHORT_NAME>?startapp=<payload>, payload ≤ 64 chars of [A-Za-z0-9_-]:
 * <game letter>_<room id> for a room, the letter alone for a solo game.
 */
import { APP_SHORT_NAME, PAYLOAD_LETTER } from './config.js';
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

export const payloadFor = (game, roomId) => (roomId ? `${PAYLOAD_LETTER[game]}_${roomId}` : PAYLOAD_LETTER[game]);

export const appLink = (username, payload) => `https://t.me/${username}/${APP_SHORT_NAME}${payload ? `?startapp=${payload}` : ''}`;

/* "b_AbC123…" → { game: 'bg', room: 'AbC123…' }; "c" → { game: 'codeword' }; anything else → null. */
export function parsePayload(p) {
  const m = /^([a-z])(?:_([A-Za-z0-9]{12}))?$/.exec(String(p || ''));
  if (!m) return null;
  const game = Object.keys(PAYLOAD_LETTER).find((g) => PAYLOAD_LETTER[g] === m[1]);
  return game ? { game, room: m[2] || null } : null;
}
