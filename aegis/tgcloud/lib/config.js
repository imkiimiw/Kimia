/*
 * Aegis settings. OWNER_ID (the Super Admin) is checked by numeric id only, never by username; it
 * comes from AEGIS_OWNER_ID in env.js (generated from aegis/.env, default 5557901897).
 */
import { AEGIS_OWNER_ID } from './env.js';

export const OWNER_ID = AEGIS_OWNER_ID;
export const BOT_NAME = 'Aegis';
export const VERSION = '1.0.0';
export const PHASE = 10;
export const RELEASED = '2026-10-31';

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

/* Group locks (Phase 4). */
export const LOCK_EXEMPT_MAX = 20; /* members exempted from one lock by hand */
export const LOCK_TEXT_MAX = 300; /* characters of a custom lock notice */
export const LOCK_NOTICE_GAP_SEC = 5; /* at most one lock notice per chat this often (a raid can't flood the group) */
export const LOCK_HITS_KEEP_SEC = 7 * 86400;
export const LOCK_DURATIONS = [600, 3600, 86400, 7 * 86400, 0]; /* punishment durations offered (0 = until lifted) */
export const NEW_WINDOWS = [3600, 86400, 3 * 86400, 7 * 86400]; /* "new member" = joined less than this ago */

/* Group security and federations (Phase 5). */
export const SEC_KEEP_SEC = 86400; /* flood rows, media and message fingerprints are kept this long */
export const RISK_KEEP_SEC = 30 * 86400;
export const CAPTCHA_MAX_ATTEMPTS = 2;
export const SWEEP_LIMIT = 20; /* expired captchas / lockdowns handled per sweep */
export const FED_MAX_CHATS = 50;
export const FED_MAX_ADMINS = 20;
export const FED_NAME_MAX = 48;
export const FED_BAN_PAGE = 10;
export const XGROUP_WINDOW_SEC = 3600; /* the same ad in other groups within this time */

/* Advanced group settings and topics (Phase 6). */
export const MSG_LOG_KEEP_SEC = 48 * 3600; /* Telegram: a bot deletes messages only within 48 h */
export const FJ_CACHE_SEC = 10 * 60; /* a member's passed forced-join check is trusted this long */
export const FJ_MAX_CHANNELS = 3;
export const CLEAN_MAX_TIMES = 5;
export const REPORT_GAP_SEC = 60; /* one report per member per minute */
export const ADMIN_CALL_GAP_SEC = 5 * 60;
export const RULES_MAX = 3000;
export const WELCOME_MAX = 1000;
export const GOODBYE_MAX = 500;
export const REPORT_ADMINS_MAX = 10; /* admins who get a report privately */
export const TOPIC_NAME_MAX = 128; /* Telegram's limit */

/* Phase 7 — channels */
export const JR_FLOOD_HOLD_SEC = 30 * 60; /* after a burst of join requests: no automatic approvals this long */
export const JR_PAGE = 8; /* pending join requests per screen */
export const JR_KEEP_SEC = 30 * 24 * 3600; /* decided join requests are kept this long */
export const INVITE_LINKS_MAX = 50; /* live links created through Aegis per channel */
export const INVITE_NAME_MAX = 32; /* Telegram's limit for a link's name */
export const POSTS_KEEP_SEC = 90 * 24 * 3600; /* the post archive (and its versions) */
export const POST_VERSIONS_MAX = 20; /* versions kept per post */
export const POSTS_PAGE = 8;
export const QUEUE_PAGE = 6;
export const QUEUE_MAX = 50; /* posts waiting per channel */
export const FOOTER_MAX = 200;
export const FAKES_MAX = 30; /* known fake channels/accounts per channel */
export const BACKUP_BATCH = 50; /* older posts copied per step (copyMessages takes up to 100) */
export const BACKUP_FILE_MAX = 200 * 1024; /* a settings backup to restore */
export const DASH_PAGE = 8;
export const XPOST_MAX = 10; /* channels in one cross-post */
export const DM_WINDOW_SEC = 60; /* direct-messages flood window */

/* Phase 8 — reports, stats and social features */
export const TOP_N = 10; /* leaderboards */
export const STATS_DAYS = 30; /* the stats screen and its CSV */
export const BADGE_DEFS_MAX = 20; /* a group's own badges */
export const BADGE_NAME_MAX = 24;
export const CONTEST_TITLE_MAX = 120;
export const CONTEST_ANSWER_MAX = 64;
export const CONTEST_ENTRIES_MAX = 5000;
export const POLL_QUESTION_MAX = 300; /* Telegram's limit */
export const POLL_OPTION_MAX = 100; /* Telegram's limit */
export const POLL_OPTIONS_MAX = 10;
export const QUESTION_MAX = 1000;
export const QUESTION_GAP_SEC = 5 * 60; /* one question per member per chat this often */
export const APPEAL_MAX = 1000;
export const NOTIFY_ADMINS_MAX = 10; /* admins told privately about a question, appeal or review */

/* Phase 10 — the Super Admin panel, the bot's team, the sealed audit log */
export const STAFF_MAX = 20; /* people in the bot's team (aegis_staff) */
export const SUSPEND_MAX = 300; /* chats suspended by the bot's team at once */
export const ADMIN_PAGE = 8; /* chats / errors per screen */
export const AUDIT_PAGE = 10; /* audit entries per screen */
export const SEAL_MAX_ROWS = 1000; /* audit rows one seal covers at most */
export const SEALS_PER_RUN = 3; /* seals made per housekeeping run or button press */
export const VERIFY_SEALS = 40; /* seals re-checked per button press */
export const LATE_SEC = 5 * 60; /* a timed item this far past its time counts as late (health) */
export const GLOBAL_BACKUP_CHATS = 25; /* chats per part of the global configuration backup */
export const GLOBAL_BACKUP_MAX = 1024 * 1024; /* a global backup file to restore */
export const RESTORE_STEP = 8; /* chats restored per button press */

/* Pending inputs (e.g. "send the broadcast message") expire after this. */
export const STATE_TTL_SEC = 30 * 60;

/* Housekeeping on the side of updates (there is no scheduler). */
export const GC_INTERVAL_SEC = 15 * 60;
export const UPDATE_KEEP_SEC = 2 * 86400;
export const UPDATE_RETRY_SEC = 60; /* an update stuck "in progress" this long may be processed again */
export const ERROR_NOTIFY_INTERVAL_SEC = 30 * 60; /* the owner hears about failures at most this often */

/*
 * The Mini App (webapp/) address, as `npx tgcloud push` prints it (https://app<app id>.tgcloud.ai/).
 * When empty it is derived from the bot's id (appUrl in lib/core/tg.js).
 */
export const APP_URL = 'https://app8940801714.tgcloud.ai/';
