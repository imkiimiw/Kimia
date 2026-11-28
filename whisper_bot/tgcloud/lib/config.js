// The bot's single owner, by numeric Telegram id. Usernames are never trusted for this.
export const OWNER_ID = 5557901897;

// Admins the owner adds (lib/staff.js), each with some of these permissions; the owner has them all,
// and alone manages admins, the scheduler, the confession channel and the health page.
//   cf review confessions · rp review reports · ban ban/unban · st stats · bc broadcasts · ch forced-join channels
export const ADMIN_PERMS = ['cf', 'rp', 'ban', 'st', 'bc', 'ch'];
export const DEFAULT_ADMIN_PERMS = ['cf', 'rp', 'ban', 'st'];
export const MAX_ADMINS = 20;

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
export const BC_LOCK_SEC = 180; // a batch takes seconds; this only outlives a crashed one, with room for clock skew
export const BC_PROGRESS_EVERY_SEC = 20;

// Confessions (lib/confess.js).
export const CONFESSION_MAX = 3000; // characters; the post adds a short header
export const CF_COMMENT_MAX = 500;
export const CF_COMMENTS_PAGE = 10;
export const CF_PER_DAY = 3; // confessions one person may send for review per day
export const CF_COMMENT_GAP_SEC = 20; // between two comments by the same person

// Random anonymous chat (lib/rchat.js).
export const RC_QUEUE_TTL_SEC = 10 * 60; // a wait older than this is forgotten (they may have left)
export const RC_IDLE_SEC = 30 * 60; // a chat quiet this long ends when either side starts a new one
export const RC_MIN_GAP_SEC = 1; // between two messages in a chat
export const RC_MAX_LEN = 2000;

// Reactions to anonymous messages: shown to the sender on their own message (setMessageReaction takes
// only Telegram's reaction emoji, so these are from that list).
export const REACTIONS = ['❤', '🔥', '🤣', '😱', '😢'];

// A media whisper's caption (the posted message never shows it; it opens in the bot's chat).
export const MEDIA_WHISPER_MAX = 800;

// The question of the day sent to those who asked for it, from this local hour on.
export const DAILY_QUESTION_HOUR = 10;
export const DAILY_BATCH = 25;

// The bot waking itself up between steps of long work (lib/wake.js).
export const WAKE_MAX_PER_HOUR = 600; // a runaway loop stops here; work then goes on with other updates
export const WAKE_STALE_SEC = 60; // a wake whose update never came stops blocking the next one after this
export const WAKE_MAX_WAIT_SEC = 10; // a 429 wait up to this long is woken through; longer waits for an update

// Iran Standard Time, UTC+03:30 — "whispers today" counts by the local date.
export const TZ_OFFSET_MIN = 210;
