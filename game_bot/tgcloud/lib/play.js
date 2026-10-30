/*
 * The room endpoints' logic (createRoom, joinRoom, getState, move, roomAction): thin layers over
 * rooms.js that also edit the inline invitation when a game starts, ends or closes.
 * getState is the polling endpoint: { same: true } when nothing changed since `since`.
 */
import { ROOM_GAMES } from './config.js';
import { fail } from './endpoint.js';
import { updateInvite } from './invite.js';
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

export async function joinRoom(input, env) {
  if (!ROOM_GAMES.includes(input.game) || !validRoomId(input.room)) throw fail('BAD_ROOM');
  await ensureRoom({ id: input.room, game: input.game, chat: env.chat, lang: env.user.lang });
  const res = await mutate(input.room, joinChange(env.from, env.chat, Math.random, env.now));
  await after(env, res);
  return view(res.room, env.user.user_id, env.now);
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
