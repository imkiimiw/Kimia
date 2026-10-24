// The bot owner: the only account that sees the admin panel and manages the mandatory channels.
export const OWNER_ID = 5557901897;
export const MAX_CHANNELS = 10;
// Seeded once, on the bot's first update; afterwards only the owner changes the list.
export const DEFAULT_CHANNELS = ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots'];

// Iran Standard Time (UTC+03:30, no DST since 2022).
export const TZ_OFFSET_MINUTES = 210;

export const PAGE_SIZE = 8;
export const MAX_TASK_LEN = 300;
export const MAX_NOTE_LEN = 1000;
export const MAX_CATEGORY_LEN = 20;

// Telegram Serverless has no scheduler, so reminders, daily digests and broadcasts are processed by a
// "tick" that piggybacks on incoming updates, at most once per TICK_INTERVAL_MS.
export const TICK_INTERVAL_MS = 60_000;
// Upper bounds per tick, so one update never does an unbounded amount of extra work.
export const TICK_BUDGET = { reminders: 10, digests: 5, broadcast: 15 };
