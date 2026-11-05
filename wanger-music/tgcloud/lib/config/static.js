// Static configuration — the only place for fixed values (pure: imports nothing).
// Runtime values live in the `settings` table and are read through the settings service,
// with the defaults below. See docs/CONFIG.md for every key.

/** The owner: always full access, cannot be demoted. Not a database role. */
export const OWNER_ID = 5557901897;

/** Verified with getMe on 2026-11-05 (the spec's working name was @WangerMusicBot). */
export const BOT_ID = 9280424458;
export const BOT_USERNAME = 'Wange_Musicbot';
export const BOT_NAME = 'Wanger Music';

/** @type {readonly string[]} */
export const LANGUAGES = Object.freeze(['fa', 'en']);

/** Seeded into force_join_channels only while the table is empty and was never seeded. */
export const FORCE_JOIN_SEED = Object.freeze([
  { chat_id: -1002407928564, username: 'HIDE_i_SEEK', title: 'HIDE & SEEK' },
  { chat_id: -1001816009903, username: 'Nepenthw_ir', title: 'Nepenthe' },
  { chat_id: -1001910797391, username: 'wangerBots', title: 'Wanger bots' },
]);

export const LIMITS = Object.freeze({
  forceJoinMax: 10,
  flowTtlSeconds: 15 * 60,
  lastSeenWriteSeconds: 10 * 60,
  processedUpdatesKeepSeconds: 48 * 3600,
  errorLogKeep: 2000,
  errorMessageMax: 500,
  errorStackMax: 2000,
  callbackMaxBytes: 64,
  startPayloadMax: 64,
  flowInputMax: 512,
  commandArgsMax: 256,
  messageMax: 4096,
  alertErrorEverySeconds: 30 * 60,
  alertForceJoinEverySeconds: 60 * 60,
  channelHealthWriteSeconds: 10 * 60,
  adminPageSize: 10,
  recentErrors: 5,
  maintenanceDeleteCap: 500,
  importBulkWindowSeconds: 60,
  trackTextMax: 200,
  softDuplicateSeconds: 3,
  musicPageSize: 8,
  musicSearchMax: 20,
  archivePerTick: 3,
  archivePerMinute: 18,
  alertArchiveEverySeconds: 60 * 60,
});

/**
 * Editable settings (⚙️ Settings) and internal state keys, with their defaults.
 * type: enum | int | bool | tz | chat | json. Internal keys are not shown in the settings menu.
 * @type {Readonly<Record<string, {type: string, default: any, values?: string[], min?: number, max?: number, internal?: boolean, phase?: number}>>}
 */
export const SETTINGS = Object.freeze({
  'ui.default_language': { type: 'enum', values: ['fa', 'en'], default: 'fa' },
  'forcejoin.failure_mode': { type: 'enum', values: ['open', 'closed'], default: 'open' },
  'forcejoin.ttl_seconds': { type: 'int', min: 60, max: 86400, default: 600 },
  'forcejoin.bypass_staff': { type: 'bool', default: true },
  'inline.page_size': { type: 'int', min: 5, max: 50, default: 20 },
  'inline.cache_time': { type: 'int', min: 0, max: 3600, default: 60 },
  'inline.caption': { type: 'text', default: '', max: 512 },
  'tick.interval_seconds': { type: 'int', min: 10, max: 3600, default: 60 },
  'tick.budget_ms': { type: 'int', min: 1000, max: 20000, default: 8000 },
  'tick.piggyback_budget_ms': { type: 'int', min: 500, max: 5000, default: 2000 },
  'broadcast.batch_size': { type: 'int', min: 1, max: 100, default: 25 },
  'digest.interval_seconds': { type: 'int', min: 300, max: 86400, default: 3600, phase: 6 },
  time_zone: { type: 'tz', default: 'Asia/Tehran' },
  'archive.chat_id': { type: 'chat', default: null },
  'import.bulk_summary': { type: 'bool', default: true },
  // internal state (not editable)
  'system.bootstrapped': { type: 'int', default: 0, internal: true },
  'forcejoin.seeded': { type: 'int', default: 0, internal: true },
  'forcejoin.version': { type: 'int', default: 1, internal: true },
  'tick.last_at': { type: 'int', default: 0, internal: true },
  'tick.last': { type: 'json', default: null, internal: true },
  'telegram.cooldown_until': { type: 'int', default: 0, internal: true },
  'commands.version': { type: 'int', default: 0, internal: true },
  'catalog.version': { type: 'int', default: 1, internal: true },
  'archive.rate': { type: 'json', default: null, internal: true },
  'search.reindex_cursor': { type: 'int', default: -1, internal: true },
});

/** Time zones offered in ⚙️ Settings; the fixed offset is the fallback when Intl is missing. */
export const TIME_ZONES = Object.freeze({
  'Asia/Tehran': 12600,
  UTC: 0,
  'Europe/Istanbul': 10800,
  'Asia/Dubai': 14400,
  'Europe/Berlin': 3600,
  'Europe/London': 0,
  'America/New_York': -18000,
});

/** Admin-panel sections, in menu order. `phase` > current means an honest placeholder. */
export const ADMIN_SECTIONS = Object.freeze([
  { id: 'music', perm: 'catalog.manage', phase: 2 },
  { id: 'sources', perm: 'sources.manage', phase: 4 },
  { id: 'dest', perm: 'destinations.manage', phase: 5 },
  { id: 'fj', perm: 'forcejoin.manage', phase: 1 },
  { id: 'users', perm: 'users.view', phase: 1 },
  { id: 'bc', perm: 'broadcast.send', phase: 1 },
  { id: 'stats', perm: 'stats.view', phase: 7 },
  { id: 'settings', perm: 'settings.manage', phase: 1 },
  { id: 'system', perm: 'system.view', phase: 1 },
]);

export const CURRENT_PHASE = 3;

/** Genre keys (shown through i18n `genre.<key>`); channel rules in Phase 5 use the same keys. */
export const GENRES = Object.freeze(['pop', 'rock', 'rap', 'electronic', 'rnb', 'jazz', 'classical', 'traditional', 'folk', 'instrumental', 'soundtrack', 'other']);

/** Track languages and the confidence order (higher index = more confident). */
export const TRACK_LANGUAGES = Object.freeze(['fa', 'en', 'other', 'unknown']);
export const CONFIDENCE_ORDER = Object.freeze(['low', 'medium', 'high']);

/**
 * Noise stripped from titles/artists/file names before display and matching (spec §8.2).
 * Phrases are matched case-insensitively as whole words; the patterns in lib/music/normalize.js
 * cover mentions, URLs, emojis and bitrate tags.
 */
export const MUSIC_NOISE = Object.freeze({
  bracketed: ['official audio', 'official video', 'official music video', 'official lyric video', 'lyric video', 'lyrics', 'audio', 'video', 'visualizer', 'hq', 'hd', '4k'],
  persianPrefixes: ['دانلود آهنگ جدید', 'دانلود آهنگ', 'آهنگ جدید', 'دانلود'],
  persianTails: ['با کیفیت', 'با متن', 'کانال', 'بشنوید', 'به همراه متن'],
});

/** Version markers (spec §8.2): kept as data in tracks.version because they change identity. */
export const VERSION_MARKERS = Object.freeze([
  'remix', 'live', 'acoustic', 'unplugged', 'instrumental', 'cover', 'slowed', 'reverb', 'sped up', 'speed up', 'nightcore',
  'remaster', 'remastered', 'radio edit', 'extended', 'version', 'edit', 'mix',
  'ریمیکس', 'لایو', 'بی\u200cکلام', 'بیکلام', 'بی کلام', 'کاور', 'آکوستیک', 'اجرای زنده',
]);

/** Bump when the command menus change (e.g. /search in Phase 3); the owner's next update re-syncs them. */
export const COMMANDS_VERSION = 2;
