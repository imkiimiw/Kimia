// Database schema — Phase 1 tables only (docs/SPEC.md §6). Later phases add their own tables.
// No foreign keys (the platform forbids them): services create parents first, delete children first.
// Enums are TEXT with CHECK; booleans are INTEGER 0/1 with CHECK; timestamps are unix seconds.
import { table, integer, text, index, check, sql } from 'sdk/db';

export const users = table('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: integer('telegram_id').notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  languageCode: text('language_code'),
  uiLanguage: text('ui_language'),
  role: text('role').notNull().default('user'),
  isBanned: integer('is_banned').notNull().default(0),
  isBlocked: integer('is_blocked').notNull().default(0),
  forceJoinOkUntil: integer('force_join_ok_until').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull().default(0),
}, (t) => ({
  roleChk: check('users_role_chk', sql`${t.role} IN ('user', 'admin')`),
  langChk: check('users_ui_language_chk', sql`${t.uiLanguage} IS NULL OR ${t.uiLanguage} IN ('fa', 'en')`),
  flagsChk: check('users_flags_chk', sql`${t.isBanned} IN (0, 1) AND ${t.isBlocked} IN (0, 1)`),
  lastSeenIdx: index('idx_users_last_seen').on(t.lastSeenAt),
  usernameIdx: index('idx_users_username').on(sql`lower(${t.username})`),
  adminsIdx: index('idx_users_admins').on(t.role).where(sql`${t.role} = 'admin'`),
}));

export const forceJoinChannels = table('force_join_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull().unique(),
  username: text('username'),
  title: text('title'),
  inviteLink: text('invite_link'),
  enabled: integer('enabled').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  lastCheckStatus: text('last_check_status').notNull().default('ok'),
  lastCheckedAt: integer('last_checked_at').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  statusChk: check('fjc_status_chk', sql`${t.lastCheckStatus} IN ('ok', 'bot_not_admin', 'not_found', 'error')`),
  enabledChk: check('fjc_enabled_chk', sql`${t.enabled} IN (0, 1)`),
  orderIdx: index('idx_fjc_enabled_order').on(t.enabled, t.sortOrder),
}));

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').notNull().default(0),
  updatedBy: integer('updated_by').notNull().default(0),
});

export const auditLog = table('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorId: integer('actor_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  details: text('details'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  createdIdx: index('idx_audit_created').on(t.createdAt),
}));

export const userFlows = table('user_flows', {
  userId: integer('user_id').primaryKey(),
  flow: text('flow').notNull(),
  step: text('step').notNull().default('input'),
  data: text('data'),
  expiresAt: integer('expires_at').notNull(),
}, (t) => ({
  expiresIdx: index('idx_user_flows_expires').on(t.expiresAt),
}));

export const processedUpdates = table('processed_updates', {
  updateId: integer('update_id').primaryKey(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  createdIdx: index('idx_processed_updates_created').on(t.createdAt),
}));

export const errorLog = table('error_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: integer('created_at').notNull(),
  handler: text('handler').notNull(),
  updateId: integer('update_id'),
  userId: integer('user_id'),
  code: text('code'),
  message: text('message'),
  stack: text('stack'),
  context: text('context'),
});

export const alerts = table('alerts', {
  key: text('key').primaryKey(),
  lastSentAt: integer('last_sent_at').notNull().default(0),
  count: integer('count').notNull().default(0),
});

export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdBy: integer('created_by').notNull(),
  sourceChatId: integer('source_chat_id').notNull(),
  sourceMessageId: integer('source_message_id').notNull(),
  status: text('status').notNull().default('draft'),
  cursorUserId: integer('cursor_user_id').notNull().default(0),
  total: integer('total').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  // additions to the spec's columns (docs/PLATFORM_NOTES.md): the progress message and a batch lease
  progressChatId: integer('progress_chat_id'),
  progressMessageId: integer('progress_message_id'),
  lockUntil: integer('lock_until'),
}, (t) => ({
  statusChk: check('broadcasts_status_chk', sql`${t.status} IN ('draft', 'running', 'paused', 'done', 'cancelled')`),
  statusIdx: index('idx_broadcasts_status').on(t.status),
}));
