/*
 * startapp payloads (≤ 64 chars of [A-Za-z0-9_-]): <game letter>_<room id> for a room, the letter
 * alone for a solo game. Pure, so the Mini App uses the same parser.
 */
import { PAYLOAD_LETTER } from './config.js';

export const payloadFor = (game, roomId) => (roomId ? `${PAYLOAD_LETTER[game]}_${roomId}` : PAYLOAD_LETTER[game]);

/* "b_AbC123…" → { game: 'bg', room: 'AbC123…' }; "c" → { game: 'codeword', room: null }; else null. */
export function parsePayload(p) {
  const m = /^([a-z])(?:_([A-Za-z0-9]{12}))?$/.exec(String(p || ''));
  if (!m) return null;
  const game = Object.keys(PAYLOAD_LETTER).find((g) => PAYLOAD_LETTER[g] === m[1]);
  return game ? { game, room: m[2] || null } : null;
}
