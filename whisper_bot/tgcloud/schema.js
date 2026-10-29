// Database tables. Deploy with `npx tgcloud push`, then create them with `npx tgcloud migrate --safe`.
// No foreign keys (the platform forbids them): rows that belong together share an id, and
// lib/store.js keeps them consistent. Every query the bot runs is served by an index below and
// LIMITed, so no update reads a whole table. Times are unix seconds; flags are 0/1 integers.
import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

// Everyone the bot has seen: inline senders, button pressers and people who opened the bot.
export const users = table('users', {
  userId: integer('user_id').primaryKey(), // Telegram user id
  username: text('username'), // as Telegram spells it, without @
  usernameLc: text('username_lc'), // lowercase, for resolving @username → id
  firstName: text('first_name'),
  firstSeen: integer('first_seen').notNull().default(0), // 0 = placeholder row (banned before first contact)
  lastSeen: integer('last_seen').notNull().default(0),
  active: integer('active').notNull().default(1), // 0 once a message to them failed with 403 (blocked the bot)
  started: integer('started').notNull().default(0), // 1 once they opened the bot's private chat
  banned: integer('banned').notNull().default(0),
  receipts: integer('receipts').notNull().default(1), // read receipts in PM, on/off
  defExpiry: integer('def_expiry').notNull().default(0), // default whisper lifetime in seconds, 0 = none
  recent: text('recent'), // JSON: the 3 most recent recipients, for quick inline results
  joinUntil: integer('join_until').notNull().default(0), // forced-join check cached until then
  joinOk: integer('join_ok').notNull().default(0), // the cached result
  joinVer: integer('join_ver').notNull().default(0), // channel-list version the cache was made for
  anonCode: text('anon_code'), // personal anonymous-chat link: t.me/<bot>?start=a_<code>
  anonOn: integer('anon_on').notNull().default(1), // accepts new anonymous messages through the link
  anonCount: integer('anon_count').notNull().default(0), // anonymous messages received
}, (t) => ({
  byUsername: index('idx_users_username').on(t.usernameLc),
  byAnonCode: uniqueIndex('uq_users_anon_code').on(t.anonCode),
  // The broadcast queue walks this index in user_id order, so a batch reads only its own rows.
  reachable: index('idx_users_reachable').on(t.userId).where(sql`started = 1 AND active = 1 AND banned = 0`),
  banned: index('idx_users_banned').on(t.userId).where(sql`banned = 1`),
}));

// Bot-wide values: join (1/0), chv (channel-list version), seeded, bot_id, bot_username, bc (running
// broadcast id), gc_at (last lazy cleanup) and the counters n_users, n_active, n_whispers, n_anon, day.
export const kv = table('kv', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// Forced-join channels (at most 10, managed from the owner panel).
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uname: text('uname').notNull().unique(), // lowercase username, for duplicate checks
  username: text('username').notNull(), // as Telegram spells it, without @
  chatId: integer('chat_id'), // numeric id, once known
  title: text('title'),
  warnedAt: integer('warned_at').notNull().default(0), // last "membership check failed" warning to the owner
  createdAt: integer('created_at').notNull(),
});

// The whisper a sender is typing. Inline queries arrive on every keystroke, so each sender has ONE
// row that every query overwrites; its id goes into the results' callback_data. It becomes a real
// whisper on chosen_inline_result (or on the first button press, if that update never came).
export const drafts = table('drafts', {
  senderId: integer('sender_id').primaryKey(),
  id: text('id').notNull(), // changes whenever the query text changes
  q: text('q').notNull(), // the raw inline query the draft was made from
  data: text('data').notNull(), // JSON: text, once, expiry, recipients, quick recipients
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  byId: uniqueIndex('uq_drafts_id').on(t.id),
  byAge: index('idx_drafts_updated').on(t.updatedAt),
}));

export const whispers = table('whispers', {
  id: text('id').primaryKey(), // short random id, used in callback_data and deep links
  senderId: integer('sender_id').notNull(),
  body: text('body'), // the content; NULL once burned (one-time) or expired
  once: integer('once').notNull().default(0),
  expiresAt: integer('expires_at').notNull().default(0), // 0 = never
  state: integer('state').notNull().default(0), // 0 live, 1 burned, 2 expired
  rcount: integer('rcount').notNull().default(1),
  snoops: integer('snoops').notNull().default(0), // distinct non-recipients who pressed the button
  inlineId: text('inline_id'), // inline_message_id of the posted message, for status edits
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  bySender: index('idx_whispers_sender').on(t.senderId, t.createdAt),
}));

// One row per recipient (1-3 per whisper). A recipient given by numeric id has rid from the start;
// one given by @username has runame and gets rid when they first open it (matched by from.username).
export const whisperRcpts = table('whisper_rcpts', {
  whisperId: text('whisper_id').notNull(),
  slot: integer('slot').notNull(),
  rid: integer('rid'),
  runame: text('runame'), // lowercase username, without @
  label: text('label').notNull(), // how the recipient is shown: @username, a name or the id
  seenAt: integer('seen_at').notNull().default(0),
  senderId: integer('sender_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  bySlot: uniqueIndex('uq_rcpts').on(t.whisperId, t.slot),
  byRid: index('idx_rcpts_rid').on(t.rid, t.createdAt),
  byUname: index('idx_rcpts_uname').on(t.runame, t.createdAt),
}));

// People who pressed a whisper's button although it wasn't for them. Only the sender sees this list.
export const snoops = table('snoops', {
  whisperId: text('whisper_id').notNull(),
  userId: integer('user_id').notNull(),
  username: text('username'),
  firstName: text('first_name'),
  at: integer('at').notNull(),
}, (t) => ({
  once: uniqueIndex('uq_snoops').on(t.whisperId, t.userId),
  byWhisper: index('idx_snoops_whisper').on(t.whisperId, t.at),
}));

// user_id does not accept whispers from blocked_id.
export const blocks = table('blocks', {
  userId: integer('user_id').notNull(),
  blockedId: integer('blocked_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('uq_blocks').on(t.userId, t.blockedId),
  byUser: index('idx_blocks_user').on(t.userId, t.createdAt),
}));

// Anonymous chat: one row per relayed message, so the "↩️ پاسخ" / "🚫 بلاک" buttons under it carry an
// opaque id instead of a user id. The content is never stored — it goes straight to the other person.
export const anonMsgs = table('anon_msgs', {
  id: text('id').primaryKey(), // random, in callback_data
  fromId: integer('from_id').notNull(),
  toId: integer('to_id').notNull(),
  anon: integer('anon').notNull().default(1), // 1 = the sender is the anonymous side of this chat
  fromMsg: integer('from_msg'), // the message in the sender's chat (a reply quotes it)
  toMsg: integer('to_msg'), // the delivered copy in the recipient's chat
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  bySender: index('idx_anon_msgs_from').on(t.fromId, t.createdAt), // rate limit
  byAge: index('idx_anon_msgs_created').on(t.createdAt), // lazy cleanup
}));

// owner_id no longer receives anonymous messages from blocked_id. Shown to the owner only by ref,
// never by id or name, so blocking doesn't reveal who the anonymous sender was.
export const anonBlocks = table('anon_blocks', {
  ownerId: integer('owner_id').notNull(),
  blockedId: integer('blocked_id').notNull(),
  ref: text('ref').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('uq_anon_blocks').on(t.ownerId, t.blockedId),
  byRef: uniqueIndex('uq_anon_blocks_ref').on(t.ref),
  byOwner: index('idx_anon_blocks_owner').on(t.ownerId, t.createdAt),
}));

// What the bot is waiting for from a user (a channel to add, an id to ban, a broadcast message, ...).
export const userState = table('user_state', {
  userId: integer('user_id').primaryKey(),
  state: text('state').notNull(),
  data: text('data'), // JSON
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  byAge: index('idx_user_state_updated').on(t.updatedAt),
}));

// Owner broadcasts. There is no scheduler, so a broadcast is a queue: the users after last_user in
// idx_users_reachable order are still to do, and each invocation sends one batch and moves last_user.
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromChat: integer('from_chat').notNull(), // where the message to copy is
  messageId: integer('message_id').notNull(),
  status: text('status').notNull().default('draft'), // draft / running / done / stopped / cancelled
  total: integer('total').notNull().default(0), // reachable users when it started, owner excluded
  lastUser: integer('last_user').notNull().default(0), // last user id handled
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0), // 403: the user blocked the bot (marked inactive)
  nextAt: integer('next_at').notNull().default(0), // after a 429: not before this time
  lockedUntil: integer('locked_until').notNull().default(0), // a batch is being sent until then
  progressChat: integer('progress_chat'),
  progressMsg: integer('progress_msg'),
  progressAt: integer('progress_at').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_broadcasts_status').on(t.status),
}));
