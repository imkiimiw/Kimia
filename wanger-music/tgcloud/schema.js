// Database schema — Phase 1 tables only (docs/SPEC.md §6). Later phases add their own tables.
// No foreign keys (the platform forbids them): services create parents first, delete children first.
// Enums are TEXT with CHECK; booleans are INTEGER 0/1 with CHECK; timestamps are unix seconds.
import { table, integer, text, index, uniqueIndex, check, primaryKey, sql } from 'sdk/db';

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

// ---------------------------------------------------------------- Phase 2: the music catalog

export const tracks = table('tracks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull().unique(),
  title: text('title'),
  artist: text('artist'),
  featuredArtists: text('featured_artists'),
  album: text('album'),
  version: text('version'),
  duration: integer('duration').notNull().default(0),
  genre: text('genre'),
  language: text('language').notNull().default('unknown'),
  languageConfidence: text('language_confidence').notNull().default('low'),
  languageSource: text('language_source').notNull().default('heuristic'),
  audioFileId: text('audio_file_id').notNull(),
  audioFileUniqueId: text('audio_file_unique_id').notNull().unique(),
  mimeType: text('mime_type'),
  fileSize: integer('file_size'),
  fileName: text('file_name'),
  coverFileId: text('cover_file_id'),
  normalizedTitle: text('normalized_title').notNull().default(''),
  normalizedArtist: text('normalized_artist').notNull().default(''),
  dupKey: text('dup_key').notNull(),
  // addition to the spec: the earlier track this one may duplicate (soft duplicate, flagged)
  duplicateOf: integer('duplicate_of'),
  sourceType: text('source_type').notNull().default('manual'),
  sourceId: integer('source_id'),
  originChatId: integer('origin_chat_id'),
  originMessageId: integer('origin_message_id'),
  status: text('status').notNull().default('draft'),
  addedBy: integer('added_by').notNull(),
  playCount: integer('play_count').notNull().default(0),
  // addition to the spec: which channel archive_message_id belongs to
  archiveChatId: integer('archive_chat_id'),
  archiveMessageId: integer('archive_message_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  activatedAt: integer('activated_at'),
}, (t) => ({
  statusChk: check('tracks_status_chk', sql`${t.status} IN ('draft', 'active', 'hidden', 'removed')`),
  languageChk: check('tracks_language_chk', sql`${t.language} IN ('fa', 'en', 'other', 'unknown')`),
  confidenceChk: check('tracks_confidence_chk', sql`${t.languageConfidence} IN ('high', 'medium', 'low')`),
  langSourceChk: check('tracks_language_source_chk', sql`${t.languageSource} IN ('manual', 'source', 'artist', 'heuristic')`),
  sourceTypeChk: check('tracks_source_type_chk', sql`${t.sourceType} IN ('manual', 'telegram_channel', 'provider')`),
  dupKeyIdx: index('idx_tracks_dup_key').on(t.dupKey),
  statusActivatedIdx: index('idx_tracks_status_activated').on(t.status, t.activatedAt),
  originIdx: uniqueIndex('uidx_tracks_origin').on(t.originChatId, t.originMessageId).where(sql`${t.originChatId} IS NOT NULL AND ${t.originMessageId} IS NOT NULL`),
  statusIdIdx: index('idx_tracks_status_id').on(t.status, t.id),
  languageIdx: index('idx_tracks_language_id').on(t.language, t.id),
  titleKeyIdx: index('idx_tracks_norm_title').on(t.normalizedTitle),
  artistKeyIdx: index('idx_tracks_norm_artist').on(t.normalizedArtist),
  archiveIdx: index('idx_tracks_archive_backlog').on(t.id).where(sql`${t.status} = 'active' AND ${t.archiveMessageId} IS NULL`),
  // Phase 3: empty inline query → popular, then newest
  popularIdx: index('idx_tracks_popular').on(t.status, t.playCount, t.activatedAt),
}));

/** Addition to the spec: counts one admin's run of forwarded audios for the bulk summary (atomic upserts). */
export const importSessions = table('import_sessions', {
  adminId: integer('admin_id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  lastAt: integer('last_at').notNull(),
  total: integer('total').notNull().default(0),
  created: integer('created').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0),
  review: integer('review').notNull().default(0),
  messageId: integer('message_id'),
});

// ---------------------------------------------------------------- Phase 3: search

/** Search index: normalized terms of title, artist, album, featured artists and aliases (+ space-free variants). */
export const trackTerms = table('track_terms', {
  term: text('term').notNull(),
  trackId: integer('track_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.term, t.trackId] }),
  byTrack: index('idx_track_terms_track').on(t.trackId),
})).withoutRowid();

export const artists = table('artists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
  language: text('language'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  languageChk: check('artists_language_chk', sql`${t.language} IS NULL OR ${t.language} IN ('fa', 'en', 'other')`),
  nameIdx: index('idx_artists_name').on(t.name),
}));

export const artistAliases = table('artist_aliases', {
  aliasNormalized: text('alias_normalized').primaryKey(),
  artistId: integer('artist_id').notNull(),
}, (t) => ({
  byArtist: index('idx_artist_aliases_artist').on(t.artistId),
}));
