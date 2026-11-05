/*
 * Database schema. No media is stored: only Telegram's file_id / file_unique_id and metadata.
 * No foreign keys on this platform: memes.uploader_id, meme_words.meme_id and recent_uses.* are
 * kept consistent by lib/store.js. Apply changes with `npm run deploy` (migrate --safe).
 */
import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

/* One row per person who wrote to the bot in private. */
export const users = table('users', {
  id: integer('id').primaryKey(),
  lang: text('lang'),
  firstName: text('first_name'),
  username: text('username'),
  state: text('state'),
  stateData: text('state_data'),
  stateAt: integer('state_at').notNull().default(0),
  upDay: integer('up_day').notNull().default(0),
  upCount: integer('up_count').notNull().default(0),
  spamWin: integer('spam_win').notNull().default(0),
  spamN: integer('spam_n').notNull().default(0),
  muteUntil: integer('mute_until').notNull().default(0),
  albumId: text('album_id'),
  createdAt: integer('created_at').notNull().default(0),
  seenAt: integer('seen_at').notNull().default(0),
  /* Phase 4: hide this user's name from the leaderboards */
  lbHidden: integer('lb_hidden').notNull().default(0),
  /* Phase 2 */
  uname: text('uname'),
  banned: integer('banned').notNull().default(0),
  banToldAt: integer('ban_told_at').notNull().default(0),
  approvedN: integer('approved_n').notNull().default(0),
  joinOk: integer('join_ok').notNull().default(0),
  joinUntil: integer('join_until').notNull().default(0),
  joinVer: integer('join_ver').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  repDay: integer('rep_day').notNull().default(0),
  repN: integer('rep_n').notNull().default(0),
}, (t) => ({
  byUname: index('idx_users_uname').on(t.uname),
  byBanned: index('idx_users_banned').on(t.id).where(sql`banned = 1`),
  /* Phase 5: new and active users per period */
  byCreated: index('idx_users_created').on(t.createdAt),
  bySeen: index('idx_users_seen').on(t.seenAt),
}));

/* The memes. kind: photo | animation | video | sticker | voice.
   status: pending (only the uploader sees it) | approved (public) | hidden (by reports, until reviewed) |
   rejected | private (Phase 3: the uploader's private collection, never public, no approval).
   file_unique_id is UNIQUE: a private meme stores "p<uploader id>:<file_unique_id>" there, so a
   private copy never blocks a public upload of the same file (lib/store.js privateKey).
   The status default is a Phase 1 leftover (changing it would rebuild the table): inserts always set it. */
export const memes = table('memes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileId: text('file_id').notNull(),
  fileUniqueId: text('file_unique_id').notNull().unique(),
  kind: text('kind').notNull(),
  keywords: text('keywords').notNull(),
  uploaderId: integer('uploader_id').notNull(),
  status: text('status').notNull().default('approved'),
  uses: integer('uses').notNull().default(0),
  backupChatId: integer('backup_chat_id'),
  backupMsgId: integer('backup_msg_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /* Phase 2 */
  reviewedBy: integer('reviewed_by'),
  reviewedAt: integer('reviewed_at'),
  reports: integer('reports').notNull().default(0),
  /* Phase 4: likes, and the ranking score = uses + LIKE_WEIGHT × likes (kept up to date by lib/store.js) */
  likes: integer('likes').notNull().default(0),
  score: integer('score').notNull().default(0),
  /* Phase 6: AI — text read from the image (searchable), and a "may be inappropriate" flag for admins */
  ocr: text('ocr'),
  aiFlag: integer('ai_flag').notNull().default(0),
  aiReason: text('ai_reason'),
}, (t) => ({
  byUploader: index('idx_memes_uploader').on(t.uploaderId, t.id),
  byPopular: index('idx_memes_popular').on(t.status, t.uses, t.id),
  noBackup: index('idx_memes_no_backup').on(t.id).where(sql`backup_msg_id IS NULL`),
  byStatus: index('idx_memes_status').on(t.status, t.id),
  reported: index('idx_memes_reported').on(t.reports, t.id).where(sql`reports > 0`),
  byKind: index('idx_memes_kind').on(t.status, t.kind, t.uses, t.id),
  byScore: index('idx_memes_score').on(t.status, t.score, t.id),
  byKindScore: index('idx_memes_kind_score').on(t.status, t.kind, t.score, t.id),
}));

/* Search index: one row per normalised keyword word per meme (lib/normalize.js). */
export const memeWords = table('meme_words', {
  word: text('word').notNull(),
  memeId: integer('meme_id').notNull(),
}, (t) => ({
  wordMeme: uniqueIndex('uidx_meme_words').on(t.word, t.memeId),
  byMeme: index('idx_meme_words_meme').on(t.memeId),
}));

/* Memes a user sent through inline mode (from chosen_inline_result), newest kept per user. */
export const recentUses = table('recent_uses', {
  userId: integer('user_id').notNull(),
  memeId: integer('meme_id').notNull(),
  usedAt: integer('used_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('uidx_recent_uses').on(t.userId, t.memeId),
  byTime: index('idx_recent_uses_time').on(t.userId, t.usedAt),
}));

/* Small key/value store: cached bot username, alert throttles. */
export const kv = table('kv', {
  key: text('key').primaryKey(),
  value: text('value'),
  n: integer('n').notNull().default(0),
});

/* Phase 2: one open report per user per meme (rows are removed when an admin resolves the meme). */
export const reports = table('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  memeId: integer('meme_id').notNull(),
  reporterId: integer('reporter_id').notNull(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('uidx_reports_pair').on(t.memeId, t.reporterId),
}));

/* Phase 2: staff added by the owner (the owner is always staff and isn't stored here).
   role (Phase 5): admin = approval queue, reports, bans, stats | mod = approve / reject only. */
export const admins = table('admins', {
  userId: integer('user_id').primaryKey(),
  addedBy: integer('added_by').notNull(),
  addedAt: integer('added_at').notNull(),
  role: text('role').notNull().default('admin'),
});

/* Phase 2: forced-join channels. */
export const channels = table('channels', {
  chatId: integer('chat_id').primaryKey(),
  username: text('username'),
  title: text('title'),
  link: text('link'),
  addedAt: integer('added_at').notNull(),
});

/* Phase 2: broadcasts. status: draft | running | done | cancelled. cursor = the last user id handled. */
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  srcChat: integer('src_chat').notNull(),
  srcMsg: integer('src_msg').notNull(),
  createdBy: integer('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
  status: text('status').notNull(),
  cursor: integer('cursor').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  total: integer('total').notNull().default(0),
  retryAt: integer('retry_at').notNull().default(0),
}, (t) => ({
  byStatus: index('idx_broadcasts_status').on(t.status, t.id),
}));

/* Phase 3: favourites (a user's starred memes, theirs or anyone's public ones). */
export const favorites = table('favorites', {
  userId: integer('user_id').notNull(),
  memeId: integer('meme_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('uidx_favorites').on(t.userId, t.memeId),
  byTime: index('idx_favorites_time').on(t.userId, t.createdAt),
  byMeme: index('idx_favorites_meme').on(t.memeId),
}));

/* Phase 4: one like per user per meme. */
export const likes = table('likes', {
  userId: integer('user_id').notNull(),
  memeId: integer('meme_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('uidx_likes').on(t.userId, t.memeId),
  byMeme: index('idx_likes_meme').on(t.memeId),
}));

/* Phase 4: counters per week (Saturday–Friday, Tehran) for the leaderboards, and per day for the
   meme of the day. score = uses + LIKE_WEIGHT × likes. Old rows are pruned. */
export const memeWeek = table('meme_week', {
  week: integer('week').notNull(),
  memeId: integer('meme_id').notNull(),
  uses: integer('uses').notNull().default(0),
  likes: integer('likes').notNull().default(0),
  score: integer('score').notNull().default(0),
  /* Phase 6: AI — text read from the image (searchable), and a "may be inappropriate" flag for admins */
  ocr: text('ocr'),
  aiFlag: integer('ai_flag').notNull().default(0),
  aiReason: text('ai_reason'),
}, (t) => ({
  pair: uniqueIndex('uidx_meme_week').on(t.week, t.memeId),
  byScore: index('idx_meme_week_score').on(t.week, t.score),
}));

export const userWeek = table('user_week', {
  week: integer('week').notNull(),
  userId: integer('user_id').notNull(),
  uses: integer('uses').notNull().default(0),
  likes: integer('likes').notNull().default(0),
  score: integer('score').notNull().default(0),
  /* Phase 6: AI — text read from the image (searchable), and a "may be inappropriate" flag for admins */
  ocr: text('ocr'),
  aiFlag: integer('ai_flag').notNull().default(0),
  aiReason: text('ai_reason'),
}, (t) => ({
  pair: uniqueIndex('uidx_user_week').on(t.week, t.userId),
  byScore: index('idx_user_week_score').on(t.week, t.score),
}));

export const memeDay = table('meme_day', {
  day: integer('day').notNull(),
  memeId: integer('meme_id').notNull(),
  score: integer('score').notNull().default(0),
}, (t) => ({
  pair: uniqueIndex('uidx_meme_day').on(t.day, t.memeId),
  byScore: index('idx_meme_day_score').on(t.day, t.score),
}));

/* Phase 4: memes of the day already posted (one per Tehran day). */
export const motd = table('motd', {
  day: integer('day').primaryKey(),
  memeId: integer('meme_id').notNull(),
  chatId: integer('chat_id').notNull(),
  msgId: integer('msg_id').notNull(),
  postedAt: integer('posted_at').notNull(),
});

/* Phase 5: daily counters (name: upload | search | search_miss | send | like). */
export const statDay = table('stat_day', {
  day: integer('day').notNull(),
  name: text('name').notNull(),
  n: integer('n').notNull().default(0),
}, (t) => ({
  pair: uniqueIndex('uidx_stat_day').on(t.day, t.name),
}));

/* Phase 5: searches per day by normalised query (n = searches, miss = searches with no result). */
export const searchQ = table('search_q', {
  day: integer('day').notNull(),
  q: text('q').notNull(),
  n: integer('n').notNull().default(0),
  miss: integer('miss').notNull().default(0),
}, (t) => ({
  pair: uniqueIndex('uidx_search_q').on(t.day, t.q),
}));

/* Phase 5: each user's latest query, not counted yet (inline queries arrive per keystroke: a
   query is counted once the user moves on — lib/statsstore.js). */
export const searchPending = table('search_pending', {
  userId: integer('user_id').primaryKey(),
  q: text('q').notNull(),
  hits: integer('hits').notNull().default(0),
  at: integer('at').notNull(),
});
