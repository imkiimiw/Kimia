/*
 * Limits and fixed settings. Deploy-time settings (owner id, backup channel) live in env.js,
 * which scripts/gen-env.mjs generates from memebot/.env or the environment.
 */

/* Uploads per user per day (Tehran calendar day). The owner has no limit. */
export const DAILY_UPLOADS = 20;

/* Keywords: the text a user types for a meme, and the words indexed for search. */
export const KW_MAX_CHARS = 200;
export const KW_MAX_WORDS = 30;
export const WORD_MAX_LEN = 32;
export const QUERY_MAX_WORDS = 5;

/* Inline mode. 50 is the Bot API maximum per answer. */
export const INLINE_PAGE = 50;
export const INLINE_MAX_OFFSET = 1000;
export const INLINE_CACHE = 10;
export const INLINE_PERSONAL_CACHE = 5;
export const RECENT_SHOW = 10;
export const OWN_SHOW = 5;
export const RECENT_KEEP = 30;

/* A user sending the same meme again within this many seconds doesn't count as another use. */
export const USE_COOLDOWN = 3600;

/* "My memes" list. */
export const MY_PAGE = 8;

/* Anti-spam in the private chat: more than SPAM_MAX messages in SPAM_WINDOW seconds mutes the
   user for SPAM_MUTE seconds (one warning, then silence). Inline queries are not counted. */
export const SPAM_WINDOW = 60;
export const SPAM_MAX = 20;
export const SPAM_MUTE = 600;

/* A media waiting for its keywords is dropped after this many seconds. */
export const PENDING_TTL = 86400;

/* Owner alerts (e.g. backup failures): at most one per kind in this many seconds. */
export const ALERT_EVERY = 3 * 3600;

/* Iran has had no daylight saving time since 2022: Tehran is UTC+3:30 all year. */
export const TEHRAN_OFFSET = 12600;

export const KINDS = ['photo', 'animation', 'video', 'sticker', 'voice'];
export const KIND_ICON = { photo: '🖼', animation: '🎞', video: '🎬', sticker: '🌟', voice: '🎤' };

/* Meme status: pending = only the uploader sees it; approved = public; hidden = taken down by
   reports until an admin reviews it; rejected = refused (the file can't be uploaded again). */
export const PENDING = 'pending';
export const APPROVED = 'approved';
export const HIDDEN = 'hidden';
export const REJECTED = 'rejected';
export const PRIVATE = 'private';

/* Deep-link parameters (/start <param>) of the "upload a meme" and "join the channels" buttons. */
export const START_UPLOAD = 'upload';
export const START_JOIN = 'join';
export const START_FAV = 'fav';

/* Phase 3: favourites per user, hashtags listed by /tags. */
export const FAV_MAX = 500;
export const TAGS_TOP = 20;

/* Phase 2 settings (changed in the admin panel, stored in kv): defaults and limits. */
export const SETTINGS = {
  moderation: { key: 'set:moderation', def: 1, min: 0, max: 1 },
  trust: { key: 'set:trust', def: 5, min: 0, max: 100 },
  hide: { key: 'set:hide', def: 3, min: 0, max: 50 },
  join: { key: 'set:join', def: 1, min: 0, max: 1 },
  likebtn: { key: 'set:likebtn', def: 1, min: 0, max: 1 },
  motd: { key: 'set:motd', def: 1, min: 0, max: 1 },
};

/* Reports: reasons a user can pick, and how many reports one user may file per day. */
export const REPORT_REASONS = ['nsfw', 'hate', 'spam', 'other'];
export const REPORTS_PER_DAY = 10;

/* Forced join: at most this many channels; a positive check is cached JOIN_CACHE seconds, a
   negative one JOIN_NEG_CACHE seconds (inline queries arrive per keystroke). */
export const MAX_CHANNELS = 5;
export const JOIN_CACHE = 600;
export const JOIN_NEG_CACHE = 15;

/* Broadcast: messages per button press, and per other update while one is running. */
export const BROADCAST_BATCH = 25;
export const BROADCAST_SIDE = 5;

/* Admins are told about waiting memes / new reports at most this often. */
export const NOTIFY_EVERY = 1800;

/* A banned user is told so at most this often (otherwise silence). */
export const BAN_NOTICE_EVERY = 86400;

/* Admin panel lists. */
export const ADMIN_PAGE = 8;

/* Phase 4: ranking score = uses + LIKE_WEIGHT × likes (memes.score, kept up to date). */
export const LIKE_WEIGHT = 3;

/* Leaderboards: the top N memes and uploaders of a week (Saturday to Friday, Tehran time). */
export const LB_TOP = 5;

/* Meme of the day: posted by the first update after MOTD_HOUR (Tehran) — there is no scheduler —
   tried at most every MOTD_RETRY seconds, never the same meme twice within MOTD_NO_REPEAT days. */
export const MOTD_HOUR = 12;
export const MOTD_RETRY = 1800;
export const MOTD_NO_REPEAT = 30;

/* Per-day and per-week counters are kept this long, then pruned (when the meme of the day posts). */
export const KEEP_DAYS = 14;
export const KEEP_WEEKS = 12;

/* Phase 5: staff roles below the owner. */
export const ROLE_ADMIN = 'admin';
export const ROLE_MOD = 'mod';

/* Phase 5 stats. Inline queries arrive per keystroke, so a query is counted once the user moves
   on: when they send a result, or when their next query is not a continuation of it (typing on,
   or deleting back) within SEARCH_SETTLE seconds. */
export const SEARCH_SETTLE = 30;
export const STATS_TOP = 20;
export const KEEP_SEARCH_DAYS = 60;
export const KEEP_STAT_DAYS = 400;
