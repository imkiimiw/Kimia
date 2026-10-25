// The bot's single owner, by numeric Telegram id. Usernames are never trusted.
export const OWNER_ID = 5557901897;

// Seeded into the channels table on first run, only while it has never been seeded.
export const DEFAULT_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_CHANNELS = 10;
// A channel whose membership check fails is skipped; the owner hears about it at most this often.
export const WARN_INTERVAL_SEC = 3 * 3600;

export const PAGE_SIZE = 8;
export const MAX_TASK_LEN = 500;
export const MAX_TASKS = 500;
export const MAX_CATEGORIES = 20;
export const MAX_CATEGORY_LEN = 30;
export const MAX_SEARCH_LEN = 50;
// A pending "send me ..." prompt older than this is dropped, so a stale prompt can't swallow a new task.
export const STATE_TTL_SEC = 30 * 60;

// Iran Standard Time, UTC+03:30 (no DST since 2022). "Overdue" is judged by the local date.
export const TZ_OFFSET_MIN = 210;
