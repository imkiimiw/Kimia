/*
 * The inline message that invited people to a room (rooms.inline_id, known from chosen_inline_result)
 * is edited when the game starts, ends or closes, in the inviter's language. Its button keeps
 * opening the room (where the players can rematch); once the room has closed, a new room.
 */
import { GAME_ICONS, t } from './i18n/index.js';
import { appLink, botUsername, payloadFor } from './links.js';
import { newRoomId } from './rooms.js';
import { edit, esc } from './tg.js';

const names = (room, seats) => seats.map((i) => room.seats[i]).filter(Boolean).map((s) => esc(s.name)).join(', ');

export async function updateInvite(ctx, room) {
  if (!room.inlineId) return;
  const lang = room.lang;
  const base = { icon: GAME_ICONS[room.game], game: t(lang, `game_${room.game}`), players: names(room, room.seats.map((_, i) => i)) };
  let text;
  let payload = payloadFor(room.game, room.id);
  let label = t(lang, 'inline_play');
  if (room.status === 'playing') text = t(lang, 'inline_playing', base);
  else if (room.status === 'finished') {
    const res = room.meta.result || { winners: [], draw: true };
    text = res.draw ? t(lang, 'inline_draw', base) : t(lang, 'inline_won', { ...base, winners: names(room, res.winners) });
    label = t(lang, 'inline_play_again'); /* same room: a rematch there edits this message again */
  } else if (room.status === 'expired') {
    text = t(lang, 'inline_expired', base);
    payload = payloadFor(room.game, newRoomId());
    label = t(lang, 'inline_play_again');
  } else return;
  const username = await botUsername(ctx);
  await edit(ctx, { inline_message_id: room.inlineId }, text, [[{ text: label, url: appLink(username, payload) }]], `invite-${room.status}`);
}
