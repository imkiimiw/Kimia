// The bot's single owner, by numeric Telegram id. Usernames are never trusted for this.
export const OWNER_ID = 5557901897;

// Seeded into the channels table once, and only while the table is empty.
export const DEFAULT_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_CHANNELS = 10;
// A positive membership result is reused for this long, so inline typing doesn't call getChatMember
// on every keystroke. A negative one is reused only by inline queries, and only briefly.
export const JOIN_CACHE_SEC = 5 * 60;
export const JOIN_NEG_CACHE_SEC = 20;
// A channel whose membership check fails is skipped; the owner hears about it at most this often.
export const WARN_INTERVAL_SEC = 3 * 3600;

// Whispers.
export const MAX_RECIPIENTS = 3;
export const ALERT_MAX = 200; // answerCallbackQuery text limit; longer whispers are read in the bot
export const MAX_EXPIRY_SEC = 7 * 86400;
export const MAX_BLOCKS = 50;
export const HISTORY_LIMIT = 20;
export const HISTORY_PAGE = 10;
export const DEFAULT_EXPIRY_CHOICES = [0, 30 * 60, 3600, 6 * 3600, 86400];

// Languages of the bot's UI. NULL in users.lang = not chosen yet: detected from language_code.
export const LANGS = ['fa', 'en', 'ru'];

// Anonymous chat.
export const ANON_CODE_LEN = 10;
export const ANON_MAX_LEN = 3500; // characters of text/caption accepted from a sender
export const INBOX_CAP = 1000; // a user keeps at most this many messages; the oldest go first
export const INBOX_PAGE = 8;
export const FILTERED_TTL_SEC = 30 * 86400; // the filtered folder empties itself after this
export const MAX_WORDS = 30; // a user's own blocked words
export const NAME_MAX = 32;
export const BIO_MAX = 160;
export const QUESTION_MAX = 200;
// Message categories the sender can pick (code → emoji; names are in lib/i18n/*.js as cat.<code>).
// 'd' marks an answer to the link's question; 'g' is the default.
export const CATEGORIES = { q: '❓', c: '💌', o: '💬', f: '😂', h: '❤️', g: '📝', d: '🌟' };
export const PICKABLE_CATEGORIES = ['q', 'c', 'o', 'f', 'h', 'g'];

// Anti-spam for anonymous senders. Limits are per sender; strikes come from recipients blocking or
// reporting them (each recipient counts once), and enough strikes in STRIKE_WINDOW_SEC restrict them
// from sending for a while.
export const ANON_PER_HOUR = 30;
export const ANON_PER_TARGET_10MIN = 5;
export const ANON_MIN_GAP_SEC = 3;
export const DUPLICATE_WINDOW_SEC = 24 * 3600;
export const STRIKE_WINDOW_SEC = 7 * 86400;
export const STRIKES_TO_RESTRICT = 3;
export const RESTRICT_SEC = 24 * 3600;
export const RESTRICT_LONG_SEC = 7 * 86400; // from the owner's moderation, or 6+ strikes

// Lazy cleanup (there is no scheduler): at most once per GC_INTERVAL_SEC, delete up to GC_BATCH
// drafts older than DRAFT_TTL_SEC and states older than STATE_TTL_SEC.
export const DRAFT_TTL_SEC = 24 * 3600;
export const STATE_TTL_SEC = 30 * 60;
export const GC_INTERVAL_SEC = 10 * 60;
export const GC_BATCH = 20;

// Broadcasts: a button press sends one batch; other updates send a small chunk on the side.
export const BC_BATCH = 25;
export const BC_CHUNK = 5;
export const BC_LOCK_SEC = 90;
export const BC_PROGRESS_EVERY_SEC = 20;

// Iran Standard Time, UTC+03:30 — "whispers today" counts by the local date.
export const TZ_OFFSET_MIN = 210;
