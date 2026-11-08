// Database schema (spec §10). Tables are named exports; `npm run tg -- migrate` applies changes.
// All SQL lives in lib/db/*.js (raw `sql` tag). No foreign keys on this platform: integrity is kept
// in code (lib/db/users.js#deleteUserData removes a user's rows everywhere). Times are unix seconds.
import { table, integer, text, index, uniqueIndex, primaryKey, sql } from 'sdk/db';

/** Everyone who talked to the bot: identity, activity, block/ban state, forced-join pass. */
export const users = table('users', {
  id: integer('id').primaryKey(),
  firstName: text('first_name'),
  username: text('username'),
  langCode: text('lang_code'),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  lastSeenDay: text('last_seen_day'),
  blocked: integer('blocked').notNull().default(0),
  banned: integer('banned').notNull().default(0),
  bannedAt: integer('banned_at'),
  banNoticeDay: text('ban_notice_day'),
  joinOkUntil: integer('join_ok_until').notNull().default(0),
  tapKey: text('tap_key'),
  tapAt: integer('tap_at'),
}, (t) => ({
  byBanned: index('idx_users_banned').on(t.bannedAt).where(sql`banned = 1`),
}));

/** Per-user settings (spec §4); a row exists only once a setting was changed. */
export const userSettings = table('user_settings', {
  userId: integer('user_id').primaryKey(),
  lang: text('lang'),
  digits: integer('digits'),
  output: text('output'),
  ocrEngine: text('ocr_engine'),
  updatedAt: integer('updated_at').notNull(),
});

/** Files users sent: the card's state (detected type) behind a short ref in callback_data. */
export const files = table('files', {
  ref: text('ref').primaryKey(),
  userId: integer('user_id').notNull(),
  fileId: text('file_id').notNull(),
  fileUniqueId: text('file_unique_id').notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  type: text('type'),
  createdAt: integer('created_at').notNull(),
  meta: text('meta'), // C2: JSON — PDF pages, archive index, image size
  batchId: text('batch_id'), // C2: the batch (album) this file belongs to
  seq: integer('seq'),
}, (t) => ({
  byUser: index('idx_files_user').on(t.userId, t.createdAt),
  byTime: index('idx_files_created').on(t.createdAt),
  byBatch: index('idx_files_batch').on(t.batchId, t.seq),
}));

/** C2: batches — albums and files collected together (one status message, then batch actions). */
export const batches = table('batches', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  status: text('status').notNull(), // collecting | ready | cancelled
  slots: integer('slots').notNull().default(0),
  statusMid: integer('status_mid'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  oneOpen: uniqueIndex('uidx_batches_open').on(t.userId).where(sql`status = 'collecting'`),
  byUser: index('idx_batches_user').on(t.userId, t.updatedAt),
  byTime: index('idx_batches_time').on(t.updatedAt),
}));

/** Jobs (spec §10): never file contents; input file_id + params only to retry. */
export const jobs = table('jobs', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  userId: integer('user_id').notNull(),
  operation: text('operation').notNull(),
  status: text('status').notNull(),
  engine: text('engine').notNull(),
  inputType: text('input_type'),
  inputSize: integer('input_size'),
  inputFileId: text('input_file_id'),
  inputRef: text('input_ref'),
  params: text('params'),
  outputType: text('output_type'),
  outputSize: integer('output_size'),
  outputFileId: text('output_file_id'),
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
}, (t) => ({
  byUser: index('idx_jobs_user').on(t.userId, t.createdAt),
  byStatus: index('idx_jobs_status').on(t.status, t.createdAt),
  byTime: index('idx_jobs_created').on(t.createdAt),
}));

/** Per-user pending state: slot 'input' (a typed answer is awaited) and 'resume' (forced-join resume). */
export const pendingActions = table('pending_actions', {
  userId: integer('user_id').notNull(),
  slot: text('slot').notNull(),
  kind: text('kind').notNull(),
  payload: text('payload'),
  expiresAt: integer('expires_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.slot] }),
  byExpiry: index('idx_pending_expires').on(t.expiresAt),
})).withoutRowid();

/** Rate limits (atomic upserts): one row per user and time bucket. */
export const rateCounters = table('rate_counters', {
  userId: integer('user_id').notNull(),
  bucket: text('bucket').notNull(),
  n: integer('n').notNull().default(0),
  expiresAt: integer('expires_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.bucket] }),
  byExpiry: index('idx_rate_expires').on(t.expiresAt),
})).withoutRowid();

/** An identical request (input + operation + params) is answered from here for 24 h. */
export const resultCache = table('result_cache', {
  key: text('key').primaryKey(),
  userId: integer('user_id').notNull(),
  fileId: text('file_id').notNull(),
  name: text('name'),
  outputType: text('output_type'),
  outputSize: integer('output_size'),
  expiresAt: integer('expires_at').notNull(),
}, (t) => ({
  byUser: index('idx_cache_user').on(t.userId),
  byExpiry: index('idx_cache_expires').on(t.expiresAt),
}));

/** Bot secrets set by the owner with /secret (spec §2); values are never shown again. */
export const secrets = table('secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: integer('updated_by').notNull(),
});

/** Sanitized recent errors for /panel (no file names, no user text). */
export const errors = table('errors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  source: text('source').notNull(),
  code: text('code').notNull(),
  detail: text('detail'),
  jobCode: text('job_code'),
});

/** Forced-join channels (local gate until the Wanger Hub exists). */
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username'),
  chatId: integer('chat_id'),
  title: text('title'),
  enabled: integer('enabled').notNull().default(1),
  botStatus: text('bot_status').notNull().default('unknown'),
  botDetail: text('bot_detail'),
  checkedAt: integer('checked_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  byUsername: uniqueIndex('uidx_channels_username').on(sql`lower(${t.username})`),
}));

/** Admins next to the owner (managed by the owner in /panel). */
export const staff = table('staff', {
  userId: integer('user_id').primaryKey(),
  role: text('role').notNull(),
  addedBy: integer('added_by').notNull(),
  addedAt: integer('added_at').notNull(),
});

/** Key/value settings: switches, limits override, alert throttles, seed flags. */
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: integer('updated_by'),
});

/** Running counters per Tehran day (statistics without scanning big tables). */
export const counters = table('counters', {
  day: text('day').notNull(),
  key: text('key').notNull(),
  n: integer('n').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.day, t.key] }),
})).withoutRowid();

/** update_ids already handled (Telegram may deliver an update twice). */
export const processedUpdates = table('processed_updates', {
  updateId: integer('update_id').primaryKey(),
  at: integer('at').notNull(),
}, (t) => ({
  byTime: index('idx_updates_at').on(t.at),
}));

/** Owner broadcasts, sent in resumable batches (no scheduler on this platform). */
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromChatId: integer('from_chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  status: text('status').notNull(),
  cursor: integer('cursor').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blockedCount: integer('blocked_count').notNull().default(0),
  leaseUntil: integer('lease_until').notNull().default(0),
  createdBy: integer('created_by').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
