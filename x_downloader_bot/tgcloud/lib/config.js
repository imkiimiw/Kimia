// Every tunable number in one place.

// The bot's single owner, by numeric Telegram id. Usernames are never trusted.
export const OWNER_ID = 5557901897;

// Seeded into the channels table on first run, only while the table is empty and was never seeded.
export const DEFAULT_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_CHANNELS = 10;
// A channel whose membership check fails is skipped; the owner hears about it at most this often.
export const WARN_INTERVAL_SEC = 3 * 3600;

// Users (the owner is exempt from the quota and the cooldown).
export const DAILY_LIMIT = 30; // posts per user per day
export const COOLDOWN_SEC = 5; // between two download requests
export const BUSY_SEC = 150; // a download job holds the user this long at most (crash safety)
export const MAX_LINKS = 5; // links handled from one message
export const HISTORY_SIZE = 20; // shown in the history screen
export const HISTORY_KEEP = 40; // kept per user; older rows are pruned
export const STATE_TTL_SEC = 30 * 60; // a pending owner prompt expires after this
export const TZ_OFFSET_MIN = 210; // Iran Standard Time (UTC+03:30): "today" for quotas and stats

// Sizes. sdk fetch caps one response at 30 MB, so bigger files are downloaded in Range chunks;
// the Bot API accepts 50 MB per uploaded file (10 MB for a photo) and 20 MB when it downloads a URL itself.
const MB = 1024 * 1024;
export const FETCH_MAX = 28 * MB; // largest single response we ask for
export const CHUNK_SIZE = 16 * MB; // Range chunk for files above FETCH_MAX
export const UPLOAD_MAX = 49 * MB; // largest video/GIF/document we upload
export const PHOTO_MAX = 10 * MB;
export const URL_SEND_MAX = 20 * MB; // Telegram fetches a URL itself up to this size…
export const URL_PHOTO_MAX = 5 * MB; // …and up to this for a photo
export const ALBUM_MAX = 45 * MB; // bytes uploaded in one sendMediaGroup
export const AUTO_MAX_SIDE = 720; // "auto" quality: the best variant up to 720p

// Media may only come from these hosts (SSRF guard: anything else an API returns is refused).
export const MEDIA_HOSTS = ['video.twimg.com', 'pbs.twimg.com'];

// Broadcasts: a batch per "continue" press, a small chunk whenever another update arrives.
export const BROADCAST_BATCH = 25;
export const BROADCAST_TICK = 5;
export const BROADCAST_LOCK_SEC = 90;
