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
 *
 * Invitations: the inline results reserve a room per game with the inviter already in seat 0
 * (here: false — they haven't opened it yet). A friend who opens the link takes the next seat, and
 * the inviter gets a private message ("… is waiting for you"). The game starts once every seat is
 * taken by someone who has opened the room; a reservation nobody opens is released after RESERVE_TTL.
 * Lobby actions (options, bots) belong to the creator if present, else to the first present player.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as bg from './games/backgammon.js';
import * as hokm from './games/hokm.js';
import * as ttt from './games/tictactoe.js';
import { GRACE_SEC, HOKM_BOTS_AFTER_SEC, MAX_TIMEOUTS, POINTS, RESERVE_TTL, ROOM_IDLE_TTL, ROOM_KEEP_TTL, ROOM_WAIT_TTL } from './config.js';
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

/*
 * Inline results: one room per game, with the inviter reserved in seat 0 (one INSERT for all of
 * them). The sweep runs on a fraction of the calls: inline queries come at every keystroke.
 */
export async function reserveRooms(list, inviter, lang) {
  const t = nowSec();
  if (Math.random() < 0.25) await sweep(t);
  let values = null;
  for (const { id, game } of list) {
    const seats = new Array(MODS[game].SEATS).fill(null);
    seats[0] = { id: inviter.id, name: inviter.name, here: false, at: t };
    const v = sql`(${id}, ${game}, 'waiting', ${inviter.id}, ${JSON.stringify(seats)}, '{}', '{}', ${lang}, ${t}, ${t})`;
    values = values ? sql`${values}, ${v}` : v;
  }
  if (!values) return;
  await db.run(sql`INSERT INTO rooms (id, game, status, creator, seats, opts, meta, lang, created_at, updated_at)
    VALUES ${values} ON CONFLICT(id) DO NOTHING`);
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
/* A seat whose player has opened the room (bots always have). Seats saved before `here` existed count as here. */
const present = (s) => !!s && (s.bot || s.here !== false);
const ready = (room) => room.seats.every(present);

/* Who may set options / call bots: the creator if they are seated and here, else whoever arrived first. */
export function leader(room) {
  const c = room.seats.find((s) => s && !s.bot && s.id === room.creator);
  if (c && present(c)) return c.id;
  const here = room.seats.filter((s) => s && !s.bot && present(s)).sort((a, b) => (a.at || 0) - (b.at || 0));
  return here.length ? here[0].id : 0;
}

/* Releases reservations nobody opened within RESERVE_TTL. */
function dropStale(room, t) {
  let changed = false;
  room.seats = room.seats.map((s) => {
    if (s && !s.bot && s.here === false && t - (s.at || room.createdAt) > RESERVE_TTL) {
      changed = true;
      return null;
    }
    return s;
  });
  return changed;
}

/* Starts the game for the seats that are taken (a game with MIN_SEATS may start with some empty). */
function start(room, rng, t) {
  const mod = MODS[room.game];
  const seats = room.seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  room.state = mod.create({ ...room.opts, seats }, rng);
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

/*
 * `seat` leaves or times out once too often. In a game for several players (LEAVER_BECOMES_BOT) a
 * bot takes over and the others play on — unless nobody human is left, then the room closes.
 * Otherwise the other side wins.
 */
function forfeit(room, seat) {
  const mod = MODS[room.game];
  if (mod.LEAVER_BECOMES_BOT) {
    room.seats[seat] = { id: -(seat + 1), name: room.seats[seat].name, bot: true, left: true };
    room.meta.timeouts[seat] = 0;
    if (!humans(room).length) {
      room.status = 'expired';
      room.deadline = 0;
    }
    return;
  }
  const winners = room.game === 'hokm'
    ? [0, 1, 2, 3].filter((i) => i % 2 !== seat % 2)
    : [1 - seat];
  finish(room, { winners, draw: false, forfeit: seat });
}

/*
 * Bots, timeouts and the end of the game, as of now. Mutates `room`; true if anything changed.
 * A game where several players act at once (waiting(state): rock-paper-scissors) is handled seat
 * by seat: bots first, then — once the deadline has passed — whoever still hasn't acted.
 */
export function advance(room, t, rng = Math.random) {
  if (room.status !== 'playing') return false;
  const mod = MODS[room.game];
  let changed = false;
  for (let i = 0; i < 400; i += 1) {
    const out = mod.outcome(room.state);
    if (out) {
      finish(room, out);
      return true;
    }
    const seats = mod.waiting ? mod.waiting(room.state) : [mod.turn(room.state)].filter((x) => x >= 0);
    if (!seats.length) break;
    let seat = seats.find((x) => room.seats[x] && room.seats[x].bot);
    if (seat === undefined) {
      if (!(room.deadline && t > room.deadline + GRACE_SEC)) break;
      seat = seats[0];
      room.meta.timeouts[seat] = (room.meta.timeouts[seat] || 0) + 1;
      if (room.meta.timeouts[seat] >= MAX_TIMEOUTS) {
        forfeit(room, seat);
        if (room.status !== 'playing') return true;
        changed = true;
        continue; /* a bot sits there now */
      }
    }
    const r = mod.act(room.state, seat, mod.auto(room.state, seat, rng), rng);
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

/*
 * Stats, counters and leaderboard points for a finished game (once: only the save that finished it
 * calls this). A game counts for the players only if people played against people: a win needs a
 * human on the losing side too (so beating bots is practice, and gives no points).
 */
async function record(room) {
  const res = room.meta.result;
  if (!res) return;
  const hs = humans(room);
  const rated = res.draw
    ? hs.length >= 2
    : res.winners.some((i) => hs.includes(i)) && hs.some((i) => !res.winners.includes(i));
  if (rated) {
    for (const i of hs) {
      const won = res.winners.includes(i);
      const add = { played: 1, wins: won ? 1 : 0, losses: !won && !res.draw ? 1 : 0, draws: res.draw ? 1 : 0, score: won ? POINTS.win : (res.draw ? POINTS.draw : 0) };
      await recordResult(room.seats[i].id, room.game, add, room.chat);
    }
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
    id: room.id, game: room.game, status: room.status, ver: room.ver, you: seat, creator: leader(room) === userId,
    seats: room.seats.map((s) => (s ? { name: s.name, bot: !!s.bot, me: !s.bot && s.id === userId, here: present(s) } : null)),
    opts: room.opts, left: room.deadline ? Math.max(0, room.deadline - t) : 0, turnSec: mod.TURN_SEC,
    result: meta.result || null, inChat: !!room.chat,
    rematch: { votes: (meta.rematch || []).length, needed: humans(room).length, mine: (meta.rematch || []).includes(userId) },
    state: room.state ? mod.view(room.state, seat) : null,
  };
  if (room.status === 'waiting') {
    const here = room.seats.filter(present).length;
    out.botsIn = room.game === 'hokm' ? Math.max(0, room.createdAt + HOKM_BOTS_AFTER_SEC - t) : 0;
    out.canStart = !!mod.MIN_SEATS && here >= mod.MIN_SEATS && here < mod.SEATS;
  }
  return out;
}

/* ---------- what players do ---------- */

export const playerName = (u) => String(u.first_name || u.username || 'Player').slice(0, 32);
const nameOf = playerName;

/*
 * Opening a room: a reserved player becomes "here"; anyone else takes a free seat (in a waiting
 * room). `out.ping` lists reserved players who haven't opened it yet, to be told someone is waiting
 * (each once). Starts the game when every seat is taken by someone here.
 */
export function joinChange(user, chat, rng, t, out = {}) {
  return (room) => {
    delete out.ping;
    let changed = false;
    const mine = seatOf(room, user.id);
    if (mine >= 0) {
      if (room.seats[mine].here === false) {
        room.seats[mine] = { id: user.id, name: nameOf(user), here: true, at: t };
        changed = true;
      }
    } else if (room.status === 'waiting') {
      if (dropStale(room, t)) changed = true;
      const free = room.seats.findIndex((s) => s === null);
      if (free >= 0) {
        room.seats[free] = { id: user.id, name: nameOf(user), here: true, at: t };
        if (!room.creator) room.creator = user.id;
        const pinged = room.meta.pinged || [];
        const absent = room.seats.filter((s) => s && !s.bot && s.here === false && !pinged.includes(s.id)).map((s) => s.id);
        if (absent.length) {
          room.meta = { ...room.meta, pinged: pinged.concat(absent) };
          out.ping = absent;
          out.by = nameOf(user);
        }
        changed = true;
      }
    }
    if (chat && !room.chat && seatOf(room, user.id) >= 0) {
      room.chat = chat;
      changed = true;
    }
    if (changed && room.status === 'waiting' && ready(room)) {
      start(room, rng, t);
      advance(room, t, rng);
    }
    return changed;
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

/* Lobby and end-of-game actions: leave, seat, opts, start, bots, rematch. */
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
            const next = room.seats.find((s) => s && !s.bot && present(s));
            room.creator = next ? next.id : 0;
          }
          return true;
        }
        if (room.status === 'playing') {
          forfeit(room, seat);
          advance(room, t, rng);
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
        if (room.status !== 'waiting' || leader(room) !== userId) throw new RoomError('NOT_CREATOR');
        if (room.game !== 'bg' || !bg.TARGETS.includes(input.target)) throw new RoomError('BAD_OPTS');
        if (room.opts.target === input.target) return false;
        room.opts = { ...room.opts, target: input.target };
        return true;
      }
      case 'start': {
        /* a game for 2 to N players: start with those who are here */
        if (room.status !== 'waiting' || !mod.MIN_SEATS) throw new RoomError('BAD_ACTION');
        if (leader(room) !== userId || seat < 0) throw new RoomError('NOT_CREATOR');
        if (room.seats.filter(present).length < mod.MIN_SEATS) throw new RoomError('NEED_PLAYERS');
        room.seats = room.seats.map((s) => (present(s) ? s : null));
        start(room, rng, t);
        advance(room, t, rng);
        return true;
      }
      case 'bots': {
        /* bots take every seat nobody has opened; in Hokm only after the wait for real players */
        if (room.status !== 'waiting') throw new RoomError('BAD_ACTION');
        if (leader(room) !== userId || seat < 0) throw new RoomError('NOT_CREATOR');
        if (room.game === 'hokm' && t < room.createdAt + HOKM_BOTS_AFTER_SEC) throw new RoomError('TOO_EARLY');
        let k = 0;
        room.seats = room.seats.map((s) => {
          if (present(s)) return s; /* empty seats and reservations nobody opened get bots */
          k += 1;
          return { id: -k, name: String(k), bot: true };
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
