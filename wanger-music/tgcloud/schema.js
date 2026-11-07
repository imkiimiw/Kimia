// Database schema (docs/SPEC.md §6), each table added in the phase that needs it (Phases 1–7).
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
  // Phase 8 flood guard: start of the current window and the updates counted in it
  floodAt: integer('flood_at').notNull().default(0),
  floodN: integer('flood_n').notNull().default(0),
}, (t) => ({
  roleChk: check('users_role_chk', sql`${t.role} IN ('user', 'admin')`),
  langChk: check('users_ui_language_chk', sql`${t.uiLanguage} IS NULL OR ${t.uiLanguage} IN ('fa', 'en')`),
  flagsChk: check('users_flags_chk', sql`${t.isBanned} IN (0, 1) AND ${t.isBlocked} IN (0, 1)`),
  lastSeenIdx: index('idx_users_last_seen').on(t.lastSeenAt),
  usernameIdx: index('idx_users_username').on(sql`lower(${t.username})`),
  adminsIdx: index('idx_users_admins').on(t.role).where(sql`${t.role} = 'admin'`),
  // Phase 7: new users per day (stats aggregation counts a created_at range)
  createdIdx: index('idx_users_created').on(t.createdAt),
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
  // added later: tracks whose language nobody decided (unknown, or a low-confidence script guess)
  undecidedIdx: index('idx_tracks_undecided_language').on(t.sourceId, t.status).where(sql`${t.languageSource} = 'heuristic' AND (${t.language} = 'unknown' OR ${t.languageConfidence} = 'low')`),
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

// ---------------------------------------------------------------- Phase 4: source channels

/** Telegram channels (bot is admin) whose new audio posts are imported. Imports never publish. */
export const sources = table('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceType: text('source_type').notNull().default('telegram_channel'),
  chatId: integer('chat_id').notNull().unique(),
  username: text('username'),
  title: text('title'),
  defaultLanguage: text('default_language'),
  enabled: integer('enabled').notNull().default(1),
  autoImport: text('auto_import').notNull().default('draft'),
  lastPostAt: integer('last_post_at'),
  importedCount: integer('imported_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // added later: 'channel' | 'supergroup' | 'group' (NULL = a channel added before groups could be sources)
  chatType: text('chat_type'),
}, (t) => ({
  typeChk: check('sources_type_chk', sql`${t.sourceType} IN ('telegram_channel')`),
  importChk: check('sources_auto_import_chk', sql`${t.autoImport} IN ('off', 'draft', 'active')`),
  languageChk: check('sources_language_chk', sql`${t.defaultLanguage} IS NULL OR ${t.defaultLanguage} IN ('fa', 'en', 'other')`),
  enabledChk: check('sources_enabled_chk', sql`${t.enabled} IN (0, 1)`),
}));

// ---------------------------------------------------------------- Phase 5: destination channels

/**
 * Channels tracks are published to (Phase 6). New ones start disabled, auto-publish off, approval
 * on. Removal is soft (removed_at), so publication history keeps its channel.
 */
export const destinationChannels = table('destination_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull().unique(),
  username: text('username'),
  title: text('title'),
  enabled: integer('enabled').notNull().default(0),
  autoPublish: integer('auto_publish').notNull().default(0),
  approvalRequired: integer('approval_required').notNull().default(1),
  rules: text('rules').notNull().default('{"languages":[],"genres":[],"exclude_genres":[],"min_language_confidence":"medium"}'),
  captionTemplate: text('caption_template'),
  postFormat: text('post_format').notNull().default('audio'),
  minIntervalSeconds: integer('min_interval_seconds').notNull().default(600),
  activeHours: text('active_hours'),
  dailyLimit: integer('daily_limit').notNull().default(50),
  timeZone: text('time_zone').notNull().default('Asia/Tehran'),
  botRightsOk: integer('bot_rights_ok').notNull().default(0),
  // additions to the spec: the bot's rights in detail ({post, edit, delete, checked_at, error}) and soft removal
  botRights: text('bot_rights'),
  removedAt: integer('removed_at'),
  // Phase 6 addition: when the channel last became enabled + auto-publish (no backfill before it)
  publishingSince: integer('publishing_since'),
  lastPublishedAt: integer('last_published_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // added later (owner's request): end every caption with the channel's link (🆔 @username)
  signature: integer('signature').notNull().default(1),
}, (t) => ({
  formatChk: check('dest_post_format_chk', sql`${t.postFormat} IN ('audio', 'cover_then_audio')`),
  flagsChk: check('dest_flags_chk', sql`${t.enabled} IN (0, 1) AND ${t.autoPublish} IN (0, 1) AND ${t.approvalRequired} IN (0, 1) AND ${t.botRightsOk} IN (0, 1)`),
  routingIdx: index('idx_dest_routing').on(t.enabled, t.autoPublish),
}));

// ---------------------------------------------------------------- Phase 6: publishing

/**
 * One track → one destination channel. UNIQUE (track_id, channel_id) makes routing idempotent;
 * every status change is a conditional UPDATE; a send holds a lease (locked_until), and an expired
 * lease becomes "uncertain" (never re-sent automatically: at most once).
 */
export const publications = table('publications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackId: integer('track_id').notNull(),
  channelId: integer('channel_id').notNull(),
  status: text('status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0),
  lockedUntil: integer('locked_until'),
  telegramMessageId: integer('telegram_message_id'),
  // additions to the spec: the cover photo's message (cover_then_audio) and when the posts were deleted
  coverMessageId: integer('cover_message_id'),
  deletedAt: integer('deleted_at'),
  decidedBy: integer('decided_by'),
  decidedAt: integer('decided_at'),
  publishedAt: integer('published_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  statusChk: check('pub_status_chk', sql`${t.status} IN ('pending_approval', 'queued', 'sending', 'published', 'failed', 'rejected', 'uncertain', 'cancelled')`),
  pair: uniqueIndex('uidx_pub_track_channel').on(t.trackId, t.channelId),
  dueIdx: index('idx_pub_status_next').on(t.status, t.nextAttemptAt),
  channelIdx: index('idx_pub_channel_status').on(t.channelId, t.status, t.id),
  dailyIdx: index('idx_pub_channel_published').on(t.channelId, t.publishedAt).where(sql`${t.status} = 'published'`),
  // Phase 8 (query review): a channel's history, newest first, without sorting all its rows
  historyIdx: index('idx_pub_channel_id').on(t.channelId, t.id),
}));

/**
 * Phase 7 — aggregated daily numbers (never per-user histories). date = the local day ('YYYY-MM-DD'
 * in the time_zone setting); dimension = '' for totals, else a channel / source / track id.
 * Event counters are added up (INSERT … ON CONFLICT DO UPDATE SET value = value + n); numbers that
 * can be counted from the tables (new users, published posts…) are recomputed for today and
 * yesterday by the aggregator, so they always equal a direct count.
 */
export const statsDaily = table('stats_daily', {
  date: text('date').notNull(),
  metric: text('metric').notNull(),
  dimension: text('dimension').notNull().default(''),
  value: integer('value').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.date, t.metric, t.dimension] }),
})).withoutRowid();
