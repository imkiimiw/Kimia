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
export const INLINE_CACHE = 30;
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

/* Meme status. Phase 1 has no moderation, so every upload is approved at once. */
export const APPROVED = 'approved';

/* Deep-link parameter of the "upload a meme" buttons (inline mode and elsewhere). */
export const START_UPLOAD = 'upload';
