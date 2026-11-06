// Database schema for Wanger Media (brief §11 Phase 1). All SQL elsewhere is raw (`sql` tag) in
// lib/db/*.js; times are unix seconds unless a column name says _ms; booleans are 0/1 integers.
// No foreign keys exist on this platform: links between tables are kept by the code.
import { table, integer, text, index, uniqueIndex, primaryKey, sql } from 'sdk/db';

/** One row per Telegram user who wrote to the bot in private (id = Telegram user id). */
export const users = table('users', {
  id: integer('id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  tgLang: text('tg_lang'),
  lang: text('lang'), // null until the user picks one
  blocked: integer('blocked').notNull().default(0), // 1 = the user blocked the bot
  joinOkUntil: integer('join_ok_until').notNull().default(0), // forced-join pass cache
  disclaimerAt: integer('disclaimer_at').notNull().default(0),
  lastCb: text('last_cb'), // double-tap guard: message id + data of the last button press
  lastCbAtMs: integer('last_cb_at_ms').notNull().default(0),
  seenDay: text('seen_day'), // Tehran date of the last activity, for the "active users" counter
  dlDay: text('dl_day'), // Tehran date of dl_count (daily download quota)
  dlCount: integer('dl_count').notNull().default(0),
  lastDlAt: integer('last_dl_at').notNull().default(0), // cooldown between downloads
  quotaOverride: integer('quota_override'), // per-user daily quota set by staff; null = the global limit
  note: text('note'), // staff note (never shown to the user)
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
}, (t) => ({
  byUsername: index('idx_users_username').on(sql`lower(${t.username})`),
}));

/** Download preferences (Phase 2). */
export const userSettings = table('user_settings', {
  userId: integer('user_id').primaryKey(),
  quality: text('quality').notNull().default('auto'),
  updatedAt: integer('updated_at').notNull().default(0),
});

/** Staff roles. The owner is never stored here: the owner is lib/config.js#OWNER_ID. */
export const roles = table('roles', {
  userId: integer('user_id').primaryKey(),
  role: text('role').notNull(), // super_admin | admin | moderator | support
  perms: integer('perms'), // null = the role's default flags (lib/roles.js)
  grantedBy: integer('granted_by').notNull().default(0),
  grantedAt: integer('granted_at').notNull().default(0),
  note: text('note'),
});

/** Forced-join channels (max 10, owner only). */
export const forcedChannels = table('forced_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id'),
  username: text('username'), // without @
  title: text('title'),
  inviteLink: text('invite_link'),
  enabled: integer('enabled').notNull().default(1),
  position: integer('position').notNull().default(0),
  botStatus: text('bot_status').notNull().default('unknown'), // ok | not_admin | error | unknown
  statusDetail: text('status_detail'),
  checkedAt: integer('checked_at').notNull().default(0),
  addedBy: integer('added_by').notNull().default(0),
  addedAt: integer('added_at').notNull(),
}, (t) => ({
  byChat: uniqueIndex('uidx_fc_chat').on(t.chatId),
  byUsername: uniqueIndex('uidx_fc_username').on(sql`lower(${t.username})`),
}));

/** Groups the bot is (or was) in. */
export const groups = table('groups', {
  chatId: integer('chat_id').primaryKey(),
  type: text('type'),
  title: text('title'),
  username: text('username'),
  botStatus: text('bot_status'), // member | administrator | restricted | left | kicked
  isAdmin: integer('is_admin').notNull().default(0),
  active: integer('active').notNull().default(0),
  addedBy: integer('added_by').notNull().default(0),
  addedAt: integer('added_at').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
});

/** Per-group settings (Phase 5); changed only by that group's admins. */
export const groupSettings = table('group_settings', {
  chatId: integer('chat_id').primaryKey(),
  autoDownload: integer('auto_download').notNull().default(1),
  platforms: text('platforms'), // JSON list of allowed platform ids; null = all enabled ones
  adminOnly: integer('admin_only').notNull().default(0),
  maxMb: integer('max_mb').notNull().default(20),
  userCooldownS: integer('user_cooldown_s').notNull().default(30),
  groupCooldownS: integer('group_cooldown_s').notNull().default(5),
  silent: integer('silent').notNull().default(0),
  lang: text('lang'),
  maxLinks: integer('max_links').notNull().default(3),
  forceJoin: integer('force_join').notNull().default(0),
  updatedBy: integer('updated_by').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(0),
});

/** Download history (Phase 3 writes it; "My downloads" pages it by user). */
export const downloads = table('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  platform: text('platform'),
  method: text('method'),
  url: text('url'),
  status: text('status').notNull(), // ok | failed | denied
  reason: text('reason'),
  bytes: integer('bytes').notNull().default(0),
  items: integer('items').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  byUser: index('idx_downloads_user').on(t.userId, t.id),
  byPlatformStatus: index('idx_downloads_platform_status').on(t.platform, t.status, t.id),
}));

/** (normalized URL, variant) → Telegram file_ids, so a repeated link is re-sent without fetching. */
export const fileCache = table('file_cache', {
  urlKey: text('url_key').notNull(),
  variant: text('variant').notNull(),
  platform: text('platform'),
  items: text('items').notNull(), // JSON [{ type, file_id }]
  title: text('title'),
  bytes: integer('bytes').notNull().default(0),
  hits: integer('hits').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastHitAt: integer('last_hit_at').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.urlKey, t.variant] }),
}));

/** Running counters for statistics (day = '' for all-time totals, else a Tehran date). */
export const counters = table('counters', {
  name: text('name').notNull(),
  day: text('day').notNull().default(''),
  value: integer('value').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.name, t.day] }),
}));

/** Owner's blocklist (brief §6): kind url (value = platform:id), account (platform:name), domain. */
export const blocklist = table('blocklist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  reason: text('reason'),
  byId: integer('by_id').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  byValue: uniqueIndex('uidx_blocklist_kind_value').on(t.kind, t.value),
}));

/**
 * Broadcasts (Phase 4): one copy of the staff member's message per user, sent in small resumable
 * batches (button presses + piggybacked on updates). cursor = the last user id handled.
 */
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdBy: integer('created_by').notNull(),
  sourceChat: integer('source_chat').notNull(),
  sourceMessage: integer('source_message').notNull(),
  status: text('status').notNull().default('draft'), // draft | running | done | cancelled
  cursor: integer('cursor').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  leaseUntil: integer('lease_until').notNull().default(0),
  resumeAt: integer('resume_at').notNull().default(0),
  progressChat: integer('progress_chat'),
  progressMessage: integer('progress_message'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull().default(0),
  finishedAt: integer('finished_at').notNull().default(0),
});

/** Banned users (until = 0 means permanent). */
export const bans = table('bans', {
  userId: integer('user_id').primaryKey(),
  until: integer('until').notNull().default(0),
  reason: text('reason'),
  byId: integer('by_id').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

/** Sensitive actions (actor 0 = the bot itself). */
export const auditLog = table('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  actorId: integer('actor_id').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  details: text('details'), // JSON, never secrets
});

/** System settings and small state: switches, seeds, throttles, leases (value = JSON text). */
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').notNull().default(0),
  updatedBy: integer('updated_by').notNull().default(0),
});

/** Recently handled update_ids, so a redelivered update is skipped. */
export const processedUpdates = table('processed_updates', {
  updateId: integer('update_id').primaryKey(),
  at: integer('at').notNull(),
}, (t) => ({
  byAt: index('idx_processed_updates_at').on(t.at),
}));

/** Errors caught by the error boundary (the platform shows no logs for webhook invocations). */
export const errorLog = table('error_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  source: text('source'),
  message: text('message'),
  detail: text('detail'),
});
