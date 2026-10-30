/*
 * Aegis settings. OWNER_ID (the Super Admin) is checked by numeric id only, never by username; it
 * comes from AEGIS_OWNER_ID in env.js (generated from aegis/.env, default 5557901897).
 */
import { AEGIS_OWNER_ID } from './env.js';

export const OWNER_ID = AEGIS_OWNER_ID;
export const BOT_NAME = 'Aegis';
export const VERSION = '0.3.0';
export const PHASE = 3;

/* Languages, in picker order. fa is right-to-left. */
export const LANGS = ['fa', 'en', 'ru', 'zh', 'fr'];
export const DEFAULT_LANG = 'en';

/* Forced join. */
export const DEFAULT_JOIN_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_JOIN_CHANNELS = 10;
export const JOIN_CACHE_SEC = 5 * 60; /* a passed membership check is trusted this long */
export const JOIN_WARN_INTERVAL_SEC = 3 * 3600; /* at most one "check failed" warning per channel per 3 h */

/* Owner stats: "today" starts at midnight in this fixed UTC offset (Asia/Tehran, no DST). */
export const STATS_TZ_OFFSET_MIN = 210;
export const MEMBER_COUNT_TTL_SEC = 3600; /* a chat's cached member count is refreshed after this */
export const MEMBER_COUNT_REFRESH = 15; /* at most this many getChatMemberCount calls per stats view */

/* Broadcasts. Telegram allows about 30 messages per second to different chats. */
export const BC_BATCH = 25; /* messages per batch (button press, Mini App tick) */
export const BC_CHUNK = 5; /* messages sent on the side of an ordinary update */
export const BC_GAP_MS = 1000; /* at least this long between batches */
export const BC_BUDGET_MS = 5000; /* a batch stops early after this long */
export const BC_CHUNK_BUDGET_MS = 1500;
export const BC_LOCK_MS = 30000; /* outlives a crashed batch only */
export const BC_PROGRESS_EVERY_SEC = 15; /* background progress edits at most this often */
export const BC_MAX_BUTTON_ROWS = 8;
export const BC_MAX_BUTTONS_PER_ROW = 4;
export const BC_MAX_BUTTON_TEXT = 48;

/* Chats and admins (Phase 2). */
export const ADMIN_CACHE_SEC = 10 * 60; /* a chat's cached admin list is refreshed after this */
export const REMINDER_INTERVAL_SEC = 24 * 3600; /* "admins not appointed through Aegis" in the group, at most this often */
export const REMINDER_EVENT_GAP_SEC = 10 * 60; /* … and after a new such admin, not more often than this */
export const CHATS_PAGE = 8; /* chats per page in «پیکربندی» */
export const LOG_PAGE = 12; /* change-log entries shown in a chat's panel */

/* Lists, punishments, warnings, anti-betrayal, logs (Phase 3). */
export const LIST_PAGE = 10; /* entries per page */
export const LIST_MAX_ENTRIES = 2000; /* per list and chat */
export const LIST_ADD_MAX_LINES = 50; /* entries added at once from one message */
export const LIST_VALUE_MAX = 120; /* characters of a text entry */
export const EXPORT_MAX_ROWS = 5000;
export const REASON_MAX = 200;
export const PUNISH_PAGE = 10;
export const MAX_DURATION_SEC = 366 * 86400; /* Telegram: longer (or under 30 s) means forever */
export const MIN_DURATION_SEC = 60;
export const MAX_STEPS = 10;
export const BETRAY_KEEP_SEC = 2 * 86400; /* admin actions older than this are swept */

/* Pending inputs (e.g. "send the broadcast message") expire after this. */
export const STATE_TTL_SEC = 30 * 60;

/* Housekeeping on the side of updates (there is no scheduler). */
export const GC_INTERVAL_SEC = 15 * 60;
export const UPDATE_KEEP_SEC = 2 * 86400;
export const UPDATE_RETRY_SEC = 60; /* an update stuck "in progress" this long may be processed again */
export const ERROR_NOTIFY_INTERVAL_SEC = 30 * 60; /* the owner hears about failures at most this often */

/*
 * The Mini App (webapp/) address, as `npx tgcloud push` prints it (https://app<app id>.tgcloud.ai/).
 * When empty it is derived from the bot's id (lib/core/bot.js).
 */
export const APP_URL = 'https://app8940801714.tgcloud.ai/';
