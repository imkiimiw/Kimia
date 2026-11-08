// Static configuration. Pure: never imports `sdk`.
// Limits (spec §9) can be overridden by the owner through the `limits` setting (a JSON object of
// the same keys) — read by lib/db/system.js#limits(); there is no Mother Bot yet to hold them.

export const OWNER_ID = 5557901897;
export const BOT_ID = 9216103899;
export const BOT_USERNAME = 'Wanger_Converterbot';
export const VERSION = '0.1.0';

/** Forced-join channels inserted once on the first run (the same three as the other Wanger bots). */
export const SEED_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_CHANNELS = 10;

/** Other bots of the Wanger ecosystem (🌐 menu). */
export const WANGER_LINKS = [
  { key: 'media', username: 'Wanger_mediabot' },
  { key: 'music', username: 'Wange_Musicbot' },
  { key: 'channel', username: 'wangerBots' },
];

export const MB = 1024 * 1024;

/** Spec §9 defaults (+ RATE_INTAKE_PER_MIN, BATCH_TOTAL_MB, PDF_*, PNG_MAX_PIXELS: docs/DECISIONS.md). */
export const DEFAULT_LIMITS = Object.freeze({
  MAX_INPUT_MB: 20,
  MAX_OUTPUT_MB: 50,
  MAX_IMAGE_PIXELS: 50_000_000,
  MAX_SIDE: 12000,
  JOB_TIMEOUT_LIGHT_S: 30,
  JOB_TIMEOUT_HEAVY_S: 120,
  OCR_MAX_PAGES: 20,
  ARCHIVE_MAX_ENTRIES: 1000,
  ARCHIVE_MAX_UNPACKED_MB: 200,
  ARCHIVE_MAX_RATIO: 100,
  BATCH_MAX_FILES: 20,
  BATCH_TOTAL_MB: 50, // C2: in-bot batch jobs (downloads + one ≤ 50 MB output inside ~30 s)
  PDF_MAX_OBJECTS: 200000, // C2: ≈ 1.2 s of parsing on Serverless (docs/LIMITS.md §3)
  PDF_MAX_PARTS: 100, // C2: a split makes at most this many PDFs
  PNG_MAX_PIXELS: 12000000, // C2: PNG → PDF ≈ 0.12 s per megapixel
  GEMINI_DAILY_BUDGET: 200, // C3: requests per Pacific day for the whole bot (free-tier limits vary; owner can raise)
  GEMINI_RPM: 8, // C3: requests per minute for the whole bot
  GEMINI_USER_DAILY: 20, // C3: OCR requests per user per day (staff unlimited)
  GEMINI_MAX_MB: 14, // C3: inline request ≤ 20 MB after base64 (+33 %)
  GEMINI_PDF_MAX_PAGES: 5, // C3: a PDF must finish inside the ~30 s wall clock
  RATE_JOBS_PER_HOUR: 10,
  RATE_BURST_PER_MIN: 3,
  RATE_INTAKE_PER_MIN: 20,
  AUDIO_MAX_MIN: 60,
  VIDEO_MAX_MIN: 10,
  TEMP_RETENTION_MIN: 30,
  JOB_HISTORY_DAYS: 30,
});

/** Telegram's own hard caps (Bot API): download 20 MB; upload 50 MB. */
export const TG_DOWNLOAD_MAX = 20 * MB;
export const TG_UPLOAD_MAX = 50 * MB;

/** What Telegram keeps of a document name (measured in C0): base ≤ 64 characters, extension ≤ 16. */
export const NAME_BASE_MAX = 64;
export const NAME_EXT_MAX = 16;

export const JOIN_PASS_S = 5 * 60; // a positive forced-join result is trusted this long
export const ALERT_EVERY_S = 3 * 3600; // the same owner alert at most this often
export const INPUT_TTL_S = 15 * 60; // a pending text input (new name, panel input) expires
export const RESUME_TTL_S = 24 * 3600; // a forced-join resume action expires
export const FILE_TTL_S = 24 * 3600; // a received file's card works this long
export const CACHE_TTL_S = 24 * 3600; // result_cache entries
export const STALE_JOB_S = 120; // an in-bot job still "running" after this died with its invocation
export const STATUS_MESSAGE_MIN_BYTES = 8 * MB; // smaller jobs finish in ~2 s: chat action only
export const TAP_GUARD_MS = 1500; // the same button on the same message within this = double tap
export const HISTORY_PAGE = 8;
export const ERRORS_KEEP = 200;
export const BROADCAST_BATCH = 25;
export const UPDATE_KEEP_S = 2 * 86400;
export const HOUSEKEEPING_EVERY = 100; // ~1% of invocations run housekeeping (spec §10)
export const BATCH_COLLECT_S = 600; // an open batch takes more files for 10 min after the last one
export const LIST_PAGE = 8; // archive entries per page

/** Tehran is UTC+03:30 with no DST since 2022; counters use Tehran days. */
export const TZ_OFFSET_S = 3.5 * 3600;

/** Bot secrets the owner may store with /secret (spec §2). */
export const SECRET_NAMES = ['HUB_KEY', 'WORKER_URL', 'WORKER_SECRET', 'GEMINI_API_KEY'];
