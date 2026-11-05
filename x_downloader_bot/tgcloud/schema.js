// Database tables. Deploy with `npx tgcloud push`, then create them with `npx tgcloud migrate`.
// No foreign keys (the platform forbids them): rows that belong to a user carry user_id, and
// lib/store.js filters every user query by it. Times are unix seconds; days are Iran-time dates
// (YYYY-MM-DD). X status ids are TEXT: they are larger than 2^53 and would lose digits as numbers.
import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

// Everyone who has talked to the bot (including /start). first_seen = 0 marks a row that exists
// only because the owner banned that id before the person ever used the bot.
export const users = table('users', {
  id: integer('id').primaryKey(), // Telegram user id
  firstName: text('first_name'),
  username: text('username'),
  firstSeen: integer('first_seen').notNull(),
  lastSeen: integer('last_seen').notNull(),
  active: integer('active').notNull().default(1), // 0 once a message to them failed with 403 (blocked the bot)
  banned: integer('banned').notNull().default(0),
  quality: text('quality').notNull().default('auto'), // auto / best / low
  capText: integer('cap_text').notNull().default(1), // caption: the post's text
  capAuthor: integer('cap_author').notNull().default(1), // caption: @author
  capLink: integer('cap_link').notNull().default(1), // caption: link to the post
  day: text('day'), // the day day_count belongs to
  dayCount: integer('day_count').notNull().default(0), // downloads on `day`
  total: integer('total').notNull().default(0), // downloads, all time
  seenDay: text('seen_day'), // last day the user was active (for "active today")
  lastReq: integer('last_req').notNull().default(0), // last download request (cooldown)
  busyUntil: integer('busy_until').notNull().default(0), // a download job holds the user until then
}, (t) => ({
  banned: index('idx_users_banned').on(t.id).where(sql`banned = 1`),
}));

// Parsed posts (media list with every quality and its probed size), so a repeat request needs no API call.
export const posts = table('posts', {
  id: text('id').primaryKey(), // status id
  author: text('author'), // screen name, without @
  authorName: text('author_name'),
  text: text('text'),
  sensitive: integer('sensitive').notNull().default(0),
  fromQuote: integer('from_quote').notNull().default(0), // the media came from the quoted post
  media: text('media').notNull(), // JSON: see lib/x_api.js
  source: text('source').notNull(), // fx / vx — which API answered
  fetchedAt: integer('fetched_at').notNull(),
});

// Telegram file_id per post, media item and quality: a repeat request is resent without downloading.
export const fileCache = table('file_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: text('post_id').notNull(),
  item: integer('item').notNull(), // index into posts.media
  q: text('q').notNull(), // quality key: 720x1280 / gif / orig / large / doc
  fileId: text('file_id').notNull(),
  kind: text('kind').notNull(), // video / animation / photo / document
  size: integer('size'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  key: uniqueIndex('uq_file_cache').on(t.postId, t.item, t.q),
}));

// Download history: the last 20 are shown with resend buttons; older rows are pruned per user.
export const downloads = table('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  postId: text('post_id').notNull(),
  author: text('author'),
  kind: text('kind'), // video / photo / gif / mixed
  snippet: text('snippet'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  byUser: index('idx_downloads_user').on(t.userId, t.id),
}));

// Mandatory-join channels (at most 10, managed from the owner panel).
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uname: text('uname').notNull().unique(), // lowercase username, for duplicate checks
  username: text('username').notNull(), // as Telegram spells it, without @
  chatId: integer('chat_id'), // numeric id, once known
  title: text('title'),
  warnedAt: integer('warned_at').notNull().default(0), // last "membership check failed" warning to the owner
  createdAt: integer('created_at').notNull(),
});

// Bot-wide switches: join (1/0), seeded (1 once the default channels were inserted).
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// Running totals, so the stats screen never counts a whole table:
// users_total, users_active (not blocked), downloads_total.
export const counters = table('counters', {
  key: text('key').primaryKey(),
  value: integer('value').notNull().default(0),
});

// Per-day numbers for the owner's stats screen.
export const daily = table('daily', {
  day: text('day').primaryKey(),
  downloads: integer('downloads').notNull().default(0),
  cacheHits: integer('cache_hits').notNull().default(0), // downloads served entirely from file_id cache
  newUsers: integer('new_users').notNull().default(0),
  activeUsers: integer('active_users').notNull().default(0),
  fxFail: integer('fx_fail').notNull().default(0), // FxTwitter failed (after its retry)
  vxFail: integer('vx_fail').notNull().default(0), // vxTwitter failed too / when it was needed
  fallback: integer('fallback').notNull().default(0), // posts that vxTwitter answered instead of FxTwitter
});

// What the bot is waiting for from the owner (a channel, a user id to ban, the broadcast message).
export const userState = table('user_state', {
  userId: integer('user_id').primaryKey(),
  state: text('state').notNull(),
  data: text('data'), // JSON
  updatedAt: integer('updated_at').notNull(),
});

// Owner broadcasts: a queue walked in user-id order (cursor = last user handled). There is no
// scheduler, so batches are sent when the owner presses "continue" and, a few at a time, whenever
// any other update wakes the bot.
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromChat: integer('from_chat').notNull(), // where the message to copy is
  messageId: integer('message_id').notNull(),
  status: text('status').notNull().default('draft'), // draft / running / done / stopped
  total: integer('total').notNull().default(0), // reachable users when it started
  cursor: integer('cursor').notNull().default(0), // last user id handled
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0), // includes blocked
  blocked: integer('blocked').notNull().default(0), // 403: marked inactive, never retried
  progressChat: integer('progress_chat'),
  progressMsg: integer('progress_msg'), // the owner's progress message, edited after each batch
  lockedUntil: integer('locked_until').notNull().default(0), // a batch is being sent until then
  retryAt: integer('retry_at').notNull().default(0), // after a 429: nothing is sent before this
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at').notNull().default(0),
  finishedAt: integer('finished_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_broadcasts_status').on(t.status, t.id),
}));
