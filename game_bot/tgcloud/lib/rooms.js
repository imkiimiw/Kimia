/*
 * Multiplayer rooms (tic-tac-toe, backgammon, Hokm). The server is the authority: the Mini App
 * sends intended moves, the rules in lib/games/* validate them, and every write checks `ver`
 * (compare-and-set), so two players acting at once can't both change the same version.
 *
 * There is no scheduler, so time is handled when a request comes in: advance() plays the bot seats,
 * applies turn timeouts (the server moves for a player who ran out of time; MAX_TIMEOUTS in a row
 * forfeits), and finishes the game. getState() is what the Mini App polls.
 * Life of a room: waiting (seats filling) → playing → finished (rematch → playing again);
 * a game idle for ROOM_IDLE_TTL becomes expired; old rooms are swept when a new one is created.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as bg from './games/backgammon.js';
import * as hokm from './games/hokm.js';
import * as ttt from './games/tictactoe.js';
import { GRACE_SEC, HOKM_BOTS_AFTER_SEC, MAX_TIMEOUTS, POINTS, ROOM_IDLE_TTL, ROOM_KEEP_TTL, ROOM_WAIT_TTL } from './config.js';
import { bumpCounter, nowSec, recordResult } from './store.js';

export const MODS = { ttt, bg, hokm };

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function newRoomId(rng = Math.random) {
  let s = '';
  for (let i = 0; i < 12; i += 1) s += ID_CHARS[Math.floor(rng() * ID_CHARS.length)];
  return s;
}
export const validRoomId = (id) => typeof id === 'string' && /^[A-Za-z0-9]{12}$/.test(id);

export class RoomError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parse(row) {
  if (!row) return null;
  return {
    id: row.id, game: row.game, status: row.status, creator: Number(row.creator), seats: JSON.parse(row.seats),
    state: row.state ? JSON.parse(row.state) : null, opts: JSON.parse(row.opts), meta: JSON.parse(row.meta), ver: Number(row.ver),
    chat: row.chat || null, inlineId: row.inline_id || null, lang: row.lang, deadline: Number(row.deadline),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export async function loadRoom(id) {
  if (!validRoomId(id)) return null;
  return parse(await db.get(sql`SELECT * FROM rooms WHERE id = ${id}`));
}

/* Deletes or closes a few old rooms (called when a room is created). */
async function sweep(t) {
  await db.run(sql`DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE status = 'waiting' AND updated_at < ${t - ROOM_WAIT_TTL} LIMIT 20)`);
  await db.run(sql`DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE status IN ('finished', 'expired') AND updated_at < ${t - ROOM_KEEP_TTL} LIMIT 20)`);
  await db.run(sql`UPDATE rooms SET status = 'expired', ver = ver + 1 WHERE id IN (SELECT id FROM rooms WHERE status = 'playing' AND updated_at < ${t - ROOM_IDLE_TTL} LIMIT 20)`);
}

/*
 * Creates the room if it doesn't exist yet (ids come from inline results, so the first one to use
 * an id creates it). Gives the room either way; an existing room gets the inline message id if it
 * had none.
 */
export async function ensureRoom({ id, game, creator = 0, chat = null, inlineId = null, lang = 'en' }) {
  if (!validRoomId(id) || !MODS[game]) throw new RoomError('BAD_ROOM');
  const t = nowSec();
  await sweep(t);
  const seats = JSON.stringify(new Array(MODS[game].SEATS).fill(null));
  await db.run(sql`INSERT INTO rooms (id, game, status, creator, seats, opts, meta, chat, inline_id, lang, created_at, updated_at)
    VALUES (${id}, ${game}, 'waiting', ${creator}, ${seats}, '{}', '{}', ${chat}, ${inlineId}, ${lang}, ${t}, ${t})
    ON CONFLICT(id) DO NOTHING`);
  if (inlineId) await db.run(sql`UPDATE rooms SET inline_id = ${inlineId} WHERE id = ${id} AND inline_id IS NULL`);
  const room = await loadRoom(id);
  if (room.game !== game) throw new RoomError('BAD_ROOM');
  return room;
}

/* Writes the room if nobody changed it since it was read; false = someone was faster. */
async function save(room) {
  const t = nowSec();
  const r = await db.run(sql`UPDATE rooms SET status = ${room.status}, creator = ${room.creator}, seats = ${JSON.stringify(room.seats)},
    state = ${room.state ? JSON.stringify(room.state) : null}, opts = ${JSON.stringify(room.opts)}, meta = ${JSON.stringify(room.meta)},
    chat = ${room.chat}, deadline = ${room.deadline}, ver = ver + 1, updated_at = ${t}
    WHERE id = ${room.id} AND ver = ${room.ver}`);
  if (!r.rowsAffected) return false;
  room.ver += 1;
  room.updatedAt = t;
  return true;
}

export const seatOf = (room, userId) => room.seats.findIndex((s) => s && !s.bot && s.id === userId);
const humans = (room) => room.seats.map((s, i) => (s && !s.bot ? i : -1)).filter((i) => i >= 0);

function start(room, rng, t) {
  const mod = MODS[room.game];
  room.state = mod.create(room.opts, rng);
  room.status = 'playing';
  room.meta = { timeouts: new Array(mod.SEATS).fill(0), rematch: [], result: null, started: t };
  room.deadline = t + mod.TURN_SEC;
}

function finish(room, result) {
  room.status = 'finished';
  room.deadline = 0;
  room.meta.result = result;
  room.meta.rematch = [];
  room.meta.recorded = false;
}

/* The winners when `seat` leaves or times out once too often: the other side. */
function forfeit(room, seat) {
  const winners = room.game === 'hokm'
    ? [0, 1, 2, 3].filter((i) => i % 2 !== seat % 2)
    : [1 - seat];
  finish(room, { winners, draw: false, forfeit: seat });
}

/* Bots, timeouts and the end of the game, as of now. Mutates `room`; true if anything changed. */
export function advance(room, t, rng = Math.random) {
  if (room.status !== 'playing') return false;
  const mod = MODS[room.game];
  let changed = false;
  for (let i = 0; i < 300; i += 1) {
    const out = mod.outcome(room.state);
    if (out) {
      finish(room, out);
      return true;
    }
    const seat = mod.turn(room.state);
    if (seat < 0) break;
    const occupant = room.seats[seat];
    let action;
    if (occupant && occupant.bot) {
      action = mod.auto(room.state, seat, rng);
    } else if (room.deadline && t > room.deadline + GRACE_SEC) {
      room.meta.timeouts[seat] = (room.meta.timeouts[seat] || 0) + 1;
      if (room.meta.timeouts[seat] >= MAX_TIMEOUTS) {
        forfeit(room, seat);
        return true;
      }
      action = mod.auto(room.state, seat, rng);
    } else {
      break;
    }
    const r = mod.act(room.state, seat, action, rng);
    if (r.error) {
      console.error(`advance: ${room.game} auto action refused: ${r.error}`);
      break;
    }
    room.state = r.state;
    room.deadline = t + mod.TURN_SEC;
    changed = true;
  }
  return changed;
}

/* Stats, counters and leaderboard points for a finished game (once: only the save that finished it calls this). */
async function record(room) {
  const res = room.meta.result;
  if (!res) return;
  for (const i of humans(room)) {
    const won = res.winners.includes(i);
    const add = { played: 1, wins: won ? 1 : 0, losses: !won && !res.draw ? 1 : 0, draws: res.draw ? 1 : 0, score: won ? POINTS.win : (res.draw ? POINTS.draw : 0) };
    await recordResult(room.seats[i].id, room.game, add, room.chat);
  }
  await bumpCounter(`played_${room.game}`);
}

/*
 * Applies `change` (a function that mutates the room and gives true if it changed it) with up to
 * three tries against concurrent writers. Gives { room, changed, finished } — finished: this call
 * finished the game (stats were recorded).
 */
export async function mutate(id, change) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await loadRoom(id);
    if (!room) throw new RoomError('NO_ROOM');
    const before = room.status;
    if (!change(room)) return { room, changed: false, finished: false };
    if (await save(room)) {
      const finished = before !== 'finished' && room.status === 'finished';
      if (finished) await record(room);
      return { room, changed: true, finished, started: before === 'waiting' && room.status === 'playing', expired: before !== 'expired' && room.status === 'expired' };
    }
  }
  throw new RoomError('BUSY');
}

/* The view a user gets: seats, their seat, the game state as their seat may see it, timers. */
export function view(room, userId, t) {
  const mod = MODS[room.game];
  const seat = seatOf(room, userId);
  const meta = room.meta || {};
  const out = {
    id: room.id, game: room.game, status: room.status, ver: room.ver, you: seat, creator: room.creator === userId,
    seats: room.seats.map((s) => (s ? { name: s.name, bot: !!s.bot, me: !s.bot && s.id === userId } : null)),
    opts: room.opts, left: room.deadline ? Math.max(0, room.deadline - t) : 0, turnSec: mod.TURN_SEC,
    result: meta.result || null, inChat: !!room.chat,
    rematch: { votes: (meta.rematch || []).length, needed: humans(room).length, mine: (meta.rematch || []).includes(userId) },
    state: room.state ? mod.view(room.state, seat) : null,
  };
  if (room.game === 'hokm' && room.status === 'waiting') out.botsIn = Math.max(0, room.createdAt + HOKM_BOTS_AFTER_SEC - t);
  return out;
}

/* ---------- what players do ---------- */

const nameOf = (u) => String(u.first_name || u.username || 'Player').slice(0, 32);

export function joinChange(user, chat, rng, t) {
  return (room) => {
    if (seatOf(room, user.id) >= 0 || room.status !== 'waiting') {
      if (chat && !room.chat && seatOf(room, user.id) >= 0) {
        room.chat = chat;
        return true;
      }
      return false;
    }
    const free = room.seats.findIndex((s) => s === null);
    if (free < 0) return false;
    room.seats[free] = { id: user.id, name: nameOf(user) };
    if (!room.creator) room.creator = user.id;
    if (chat && !room.chat) room.chat = chat;
    if (room.seats.every((s) => s !== null)) {
      start(room, rng, t);
      advance(room, t, rng);
    }
    return true;
  };
}

export function moveChange(userId, action, clientVer, rng, t, out) {
  return (room) => {
    const seat = seatOf(room, userId);
    if (seat < 0) throw new RoomError('NOT_SEATED');
    if (clientVer !== undefined && clientVer !== room.ver) throw new RoomError('STALE');
    if (advance(room, t, rng)) {
      /* a timeout or a bot moved first: save that, and let the player see it before moving */
      out.stale = true;
      return true;
    }
    if (room.status !== 'playing') throw new RoomError('NOT_PLAYING');
    const mod = MODS[room.game];
    const r = mod.act(room.state, seat, action, rng);
    if (r.error) {
      out.error = r.error;
      throw new RoomError(r.error);
    }
    room.state = r.state;
    room.meta.timeouts[seat] = 0;
    room.deadline = t + mod.TURN_SEC;
    advance(room, t, rng);
    return true;
  };
}

export function tickChange(rng, t) {
  return (room) => {
    if (room.status === 'playing' && room.updatedAt < t - ROOM_IDLE_TTL) {
      room.status = 'expired';
      room.deadline = 0;
      return true;
    }
    return advance(room, t, rng);
  };
}

/* Lobby and end-of-game actions: leave, seat, opts, bots, rematch. */
export function actionChange(userId, input, rng, t) {
  return (room) => {
    const seat = seatOf(room, userId);
    const mod = MODS[room.game];
    switch (input.action) {
      case 'leave':
        if (seat < 0) return false;
        if (room.status === 'waiting') {
          room.seats[seat] = null;
          if (room.creator === userId) {
            const next = room.seats.find((s) => s && !s.bot);
            room.creator = next ? next.id : 0;
          }
          return true;
        }
        if (room.status === 'playing') {
          forfeit(room, seat);
          return true;
        }
        return false;
      case 'seat': {
        const to = input.seat;
        if (room.status !== 'waiting' || seat < 0 || !Number.isInteger(to) || to < 0 || to >= mod.SEATS || room.seats[to] !== null) throw new RoomError('BAD_SEAT');
        room.seats[to] = room.seats[seat];
        room.seats[seat] = null;
        return true;
      }
      case 'opts': {
        if (room.status !== 'waiting' || room.creator !== userId) throw new RoomError('NOT_CREATOR');
        if (room.game !== 'bg' || !bg.TARGETS.includes(input.target)) throw new RoomError('BAD_OPTS');
        if (room.opts.target === input.target) return false;
        room.opts = { ...room.opts, target: input.target };
        return true;
      }
      case 'bots': {
        if (room.game !== 'hokm' || room.status !== 'waiting') throw new RoomError('BAD_ACTION');
        if (room.creator !== userId || seat < 0) throw new RoomError('NOT_CREATOR');
        if (t < room.createdAt + HOKM_BOTS_AFTER_SEC) throw new RoomError('TOO_EARLY');
        let k = 0;
        room.seats = room.seats.map((s) => {
          if (s) return s;
          k += 1;
          return { id: -k, name: `🤖 ${k}`, bot: true };
        });
        start(room, rng, t);
        advance(room, t, rng);
        return true;
      }
      case 'rematch': {
        if (room.status !== 'finished' || seat < 0) throw new RoomError('NOT_FINISHED');
        const votes = room.meta.rematch || [];
        if (votes.includes(userId)) return false;
        room.meta.rematch = votes.concat([userId]);
        if (room.meta.rematch.length >= humans(room).length) {
          room.state = mod.rematch(room.state, rng);
          room.status = 'playing';
          room.meta = { timeouts: new Array(mod.SEATS).fill(0), rematch: [], result: null, started: t };
          room.deadline = t + mod.TURN_SEC;
          advance(room, t, rng);
        }
        return true;
      }
      default:
        throw new RoomError('BAD_ACTION');
    }
  };
}
