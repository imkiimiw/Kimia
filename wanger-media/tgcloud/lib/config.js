// Static configuration (no secrets here, ever: third-party keys live in the database, Phase 3+).
// Pure module: must not import 'sdk'.

/** The owner: permanent super admin, checked by numeric id only (never by username). */
export const OWNER_ID = 5557901897;

/** This bot, as reported by getMe on 2026-11-05. */
export const BOT_ID = 9080356648;
export const BOT_USERNAME = 'Wanger_mediabot';

export const VERSION = '0.1.0';
export const PHASE = 1;

export const LANGS = ['fa', 'en', 'ru'];
export const FALLBACK_LANG = 'en';

/** Forced-join channels inserted on first run (usernames without @). */
export const SEED_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_CHANNELS = 10;

/** Seconds a positive forced-join check is trusted before Telegram is asked again. */
export const JOIN_PASS_S = 300;
/** At most one owner alert per key (e.g. one misconfigured channel) in this many seconds. */
export const ALERT_EVERY_S = 3 * 3600;
/** Error alerts to the owner: at most one per source in this many seconds. */
export const ERROR_ALERT_EVERY_S = 1800;
/** A second press of the same button on the same message within this window is ignored. */
export const DOUBLE_TAP_MS = 1500;

/** processed_updates rows older than this are deleted by housekeeping. */
export const UPDATE_KEEP_S = 2 * 86400;
/** Housekeeping runs at most once per this many seconds, piggybacked on an update. */
export const HOUSEKEEP_EVERY_S = 600;
export const HOUSEKEEP_BATCH = 300;
export const ERROR_LOG_KEEP = 300;

/** Bound parameters per statement: 4 000 measured as working, 4 096 failing; keep a margin. */
export const MAX_SQL_PARAMS = 1000;

/** Tehran has no DST since 2022: UTC+03:30 all year. Days in counters are Tehran dates. */
export const TZ_OFFSET_S = 3.5 * 3600;
