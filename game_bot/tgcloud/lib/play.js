/*
 * The room endpoints' logic (createRoom, joinRoom, getState, move, roomAction): thin layers over
 * rooms.js that also edit the inline invitation when a game starts, ends or closes.
 * getState is the polling endpoint: { same: true } when nothing changed since `since`.
 */
import { ROOM_GAMES } from './config.js';
import { fail } from './endpoint.js';
import { t } from './i18n/index.js';
import { updateInvite } from './invite.js';
import { article } from './inline.js';
import { appLink, botUsername, payloadFor } from './links.js';
import { getUser } from './store.js';
import { esc, send, tryCall } from './tg.js';
import { actionChange, ensureRoom, joinChange, loadRoom, moveChange, mutate, newRoomId, tickChange, validRoomId, view } from './rooms.js';

async function after(env, res) {
  if (res.started || res.finished || res.expired) await updateInvite(env.tg, res.room);
}

export async function createRoom(input, env) {
  if (!ROOM_GAMES.includes(input.game)) throw fail('BAD_GAME');
  const id = newRoomId();
  await ensureRoom({ id, game: input.game, creator: env.user.user_id, chat: env.chat, lang: env.user.lang });
  const res = await mutate(id, joinChange(env.from, env.chat, Math.random, env.now));
  return view(res.room, env.user.user_id, env.now);
}

/* Tells invited players who haven't opened the room yet that someone is waiting for them there. */
async function pingAbsent(env, room, out) {
  const username = await botUsername(env.tg);
  for (const id of out.ping) {
    const u = await getUser(id);
    if (!u || !u.started || u.blocked) continue;
    const text = t(u.lang, 'invite_ping', { name: esc(out.by), game: t(u.lang, `game_${room.game}`) });
    await send(env.tg, id, text, [[{ text: t(u.lang, 'inline_play'), url: appLink(username, payloadFor(room.game, room.id)) }]], 'invite-ping');
  }
}

export async function joinRoom(input, env) {
  if (!ROOM_GAMES.includes(input.game) || !validRoomId(input.room)) throw fail('BAD_ROOM');
  await ensureRoom({ id: input.room, game: input.game, chat: env.chat, lang: env.user.lang });
  const out = {};
  const res = await mutate(input.room, joinChange(env.from, env.chat, Math.random, env.now, out));
  await after(env, res);
  if (res.changed && out.ping) await pingAbsent(env, res.room, out);
  return view(res.room, env.user.user_id, env.now);
}

/*
 * The lobby's "Invite friends": the invitation card (the same one inline mode sends) prepared for
 * this user with savePreparedInlineMessage, for the Mini App's shareMessage dialog. Also gives the
 * plain link, for clients where that dialog isn't available.
 */
export async function prepareInvite(input, env) {
  const room = await loadRoom(input.room);
  if (!room) throw fail('NO_ROOM');
  const username = await botUsername(env.tg);
  const link = appLink(username, payloadFor(room.game, room.id));
  const result = article(env.user.lang, username, room.game, room.id, env.from);
  const prepared = await tryCall(env.tg, 'savePreparedInlineMessage', {
    user_id: env.user.user_id, result, allow_user_chats: true, allow_group_chats: true, allow_bot_chats: false, allow_channel_chats: false,
  }, 'prepare-invite');
  return { id: prepared ? prepared.id : null, link, text: t(env.user.lang, 'share_text', { game: t(env.user.lang, `game_${room.game}`) }) };
}

export async function getState(input, env) {
  const room = await loadRoom(input.room);
  if (!room) throw fail('NO_ROOM');
  const res = await mutate(room.id, tickChange(Math.random, env.now));
  await after(env, res);
  if (Number.isInteger(input.since) && input.since === res.room.ver) return { same: true, ver: res.room.ver };
  return view(res.room, env.user.user_id, env.now);
}

export async function move(input, env) {
  if (!validRoomId(input.room) || !input.action || typeof input.action !== 'object') throw fail('BAD_ACTION');
  const out = {};
  const res = await mutate(input.room, moveChange(env.user.user_id, input.action, input.ver, Math.random, env.now, out));
  await after(env, res);
  const v = view(res.room, env.user.user_id, env.now);
  if (out.stale) throw fail('STALE', { room: v });
  return v;
}

export async function roomAction(input, env) {
  if (!validRoomId(input.room)) throw fail('BAD_ROOM');
  const res = await mutate(input.room, actionChange(env.user.user_id, input, Math.random, env.now));
  await after(env, res);
  return view(res.room, env.user.user_id, env.now);
}
