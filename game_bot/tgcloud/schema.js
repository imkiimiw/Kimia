/*
 * Database tables. Deploy with `npx tgcloud push`, then create them with `npx tgcloud migrate --safe`.
 * No foreign keys (the platform forbids them). Times are unix seconds unless a name says _ms.
 * JSON lives in TEXT columns. Every query is keyed or LIMITed (see lib/store.js and lib/rooms.js).
 * Only block comments in this project's modules: a paste that loses the line breaks still works.
 */
import { table, integer, text, index, uniqueIndex } from 'sdk/db';

/* Everyone who has started the bot, opened the Mini App or used inline mode. */
export const users = table('users', {
  userId: integer('user_id').primaryKey(),
  firstName: text('first_name'),
  username: text('username'),
  lang: text('lang').notNull().default('en'),
  langSet: integer('lang_set').notNull().default(0), /* 1 = chosen by the user (not just detected) */
  started: integer('started').notNull().default(0), /* 1 = has a private chat with the bot (can be messaged) */
  blocked: integer('blocked').notNull().default(0), /* 1 = blocked the bot */
  joinOkAt: integer('join_ok_at').notNull().default(0), /* last time every forced-join channel checked out */
  joinRev: integer('join_rev').notNull().default(0), /* the channel list's revision at that time */
  firstSeen: integer('first_seen').notNull().default(0),
  lastSeen: integer('last_seen').notNull().default(0),
}, (t) => ({
  byLastSeen: index('idx_users_last_seen').on(t.lastSeen),
}));

/* Per user and game: the personal stats; `score` is what the leaderboard ranks. */
export const stats = table('stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  game: text('game').notNull(), /* ttt, bg, hokm, codeword, fusion */
  played: integer('played').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  draws: integer('draws').notNull().default(0),
  score: integer('score').notNull().default(0), /* points (fusion: best score) */
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byUserGame: uniqueIndex('uq_stats_user_game').on(t.userId, t.game),
  byGameScore: index('idx_stats_game_score').on(t.game, t.score),
}));

/* The same, per chat the game was played in (chat_instance from a direct-link Mini App launch). */
export const chatStats = table('chat_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat: text('chat').notNull(),
  userId: integer('user_id').notNull(),
  game: text('game').notNull(),
  played: integer('played').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  score: integer('score').notNull().default(0),
}, (t) => ({
  byChatUserGame: uniqueIndex('uq_chat_stats').on(t.chat, t.userId, t.game),
  byChatGameScore: index('idx_chat_stats_score').on(t.chat, t.game, t.score),
}));

/*
 * A multiplayer room. `ver` goes up on every change and every write checks it, so two players acting
 * at once can't both change the same version. `state` is the game's state (lib/games/*), `seats`
 * [{ id, name, bot }] or null for an empty seat.
 */
export const rooms = table('rooms', {
  id: text('id').primaryKey(), /* 12 random letters/digits, part of the startapp payload */
  game: text('game').notNull(), /* ttt, bg, hokm */
  status: text('status').notNull().default('waiting'), /* waiting, playing, finished, expired */
  creator: integer('creator').notNull().default(0),
  seats: text('seats').notNull().default('[]'),
  state: text('state'),
  opts: text('opts').notNull().default('{}'),
  meta: text('meta').notNull().default('{}'), /* timeouts per seat, rematch votes, result, forfeit */
  ver: integer('ver').notNull().default(0),
  chat: text('chat'), /* chat_instance the room was opened from */
  inlineId: text('inline_id'), /* the inline message inviting to it, edited with the result */
  lang: text('lang').notNull().default('en'), /* the inviter's language, for that message */
  deadline: integer('deadline').notNull().default(0), /* when the current turn times out */
  createdAt: integer('created_at').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_rooms_status').on(t.status, t.updatedAt),
}));

/* Codeword games: one row per user, language and mode (free play reuses its row; daily: per day). */
export const codeword = table('codeword', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  lang: text('lang').notNull(),
  mode: text('mode').notNull(), /* daily, free */
  day: integer('day').notNull().default(0), /* YYYYMMDD for daily, 0 for free play */
  answer: text('answer').notNull(),
  guesses: text('guesses').notNull().default('[]'), /* [{ w, exact, near }] */
  status: text('status').notNull().default('play'), /* play, won, lost */
  chat: text('chat'),
  updatedAt: integer('updated_at').notNull().default(0),
}, (t) => ({
  byUserGame: uniqueIndex('uq_codeword').on(t.userId, t.lang, t.mode, t.day),
}));

/* Fusion runs: the seed the server handed out, so a submitted score can be replayed. */
export const fusionRuns = table('fusion_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  seed: integer('seed').notNull(),
  status: text('status').notNull().default('play'), /* play, done */
  score: integer('score').notNull().default(0),
  chat: text('chat'),
  createdAt: integer('created_at').notNull().default(0),
}, (t) => ({
  byCreated: index('idx_fusion_created').on(t.status, t.createdAt),
}));

/* Forced-join channels (at most 10, managed from /admin). */
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uname: text('uname').unique(), /* lowercase username, when it has one */
  username: text('username'),
  chatId: integer('chat_id'),
  title: text('title'),
  link: text('link'), /* invite link, for a channel without a public username */
  warnedAt: integer('warned_at').notNull().default(0), /* last "check failed" warning to the owner */
  createdAt: integer('created_at').notNull().default(0),
});

/* Bot-wide key/value settings: join (1/0), join_rev, seeded, owner_state, bot_username. */
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/* Counters: games played per game (played_ttt, …). */
export const counters = table('counters', {
  key: text('key').primaryKey(),
  n: integer('n').notNull().default(0),
});

/*
 * Broadcasts from the owner panel. Sending advances `cursor` (the last user id handled) one message
 * at a time, under a short lock, so it resumes exactly where it stopped across invocations.
 */
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromChat: integer('from_chat').notNull(),
  messageId: integer('message_id').notNull(),
  markup: text('markup'), /* the original reply_markup (buttons), JSON */
  status: text('status').notNull().default('draft'), /* draft, running, done, cancelled */
  cursor: integer('cursor').notNull().default(0),
  total: integer('total').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  lockUntilMs: integer('lock_until_ms').notNull().default(0),
  panelMsg: integer('panel_msg').notNull().default(0), /* the progress message in the owner's chat */
  createdAt: integer('created_at').notNull().default(0),
  finishedAt: integer('finished_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_broadcasts_status').on(t.status),
}));
