// Fixed settings. Everything the owner changes at run time lives in the kv table (lib/store.js).

/** The owner: numeric id only, never a username. Checked on every admin command and button. */
export const OWNER_ID = 5557901897;

export const BOT_NAME = 'ربات مادر Wanger';
export const TZ_OFFSET_MIN = 210; // Tehran, UTC+3:30 (no daylight saving since 2022)

// ---------- hub (lib/hub.js) ----------
export const HUB_PREFIX = '#wg1'; // every hub message starts with this tag, then one JSON document
export const HUB_SELF = 'mother'; // the "b" of messages the mother posts
export const HUB_MAX_TEXT = 3900; // a hub post stays under Telegram's 4096 characters
export const HUB_BAN_CHUNK = 150; // user ids per ban message

// ---------- limits ----------
export const MAX_BOTS = 60;
export const MAX_CHANNELS_PER_SCOPE = 10;
export const TEXT_MAX = 3500; // what a user may send in a report / question
export const ALERT_MAX = 200; // Telegram's limit for answerCallbackQuery text
export const STATE_TTL_SEC = 3600; // a flow step left alone longer than this is forgotten
export const PAGE = 8; // list rows per page

// anti-spam in the mother's private chat
export const SPAM_WINDOW_SEC = 60;
export const SPAM_MAX = 20;
export const SPAM_MUTE_SEC = 600;
export const REPORTS_PER_DAY = 10; // error reports + questions to the team, per user per day

// ---------- report triage (lib/reports.js) ----------
export const TRIAGE_WINDOW_SEC = 3600; // reports and errors this recent count as signals
export const TRIAGE_SAME_REPORTS = 3; // distinct users reporting the same bot in the window → confirmed
export const TRIAGE_ERRORS = 5; // errors the child reported in the window → confirmed
export const TRIAGE_FRESH_ERROR_SEC = 900; // one error this recent counts as a weaker signal

// ---------- health (lib/health.js) ----------
export const HEALTH_EVERY_SEC = 600; // a bot's webhook is checked at most this often
export const HEALTH_PER_UPDATE = 2; // bots checked on the side of one update
export const HEALTH_PENDING_WARN = 50; // pending updates in the child's webhook queue
export const HEALTH_PENDING_BAD = 500;
export const HEALTH_ERROR_RECENT_SEC = 900; // a webhook delivery error this recent
export const ERROR_ALERT_EVERY_SEC = 1800; // the same error signature is posted to the log chat once per this

// ---------- activity & club ----------
export const LEVELS = [
  { min: 0, name: 'برنزی', emoji: '🥉' },
  { min: 100, name: 'نقره‌ای', emoji: '🥈' },
  { min: 500, name: 'طلایی', emoji: '🥇' },
  { min: 2000, name: 'الماس', emoji: '💎' },
];
export const POINTS_DAILY = 2; // first activity of a local day in any Wanger bot
export const POINTS_JOIN = 10; // joining the club
export const POINTS_REFERRAL = 20; // a friend opened the mother through your link
export const POINTS_PER_PURCHASE = 50; // a purchase reported by a child bot
export const POINTS_PER_STAR = 1; // plus one point per Telegram Star spent
export const CODE_DAYS_DEFAULT = 14;

// ---------- broadcasts (lib/broadcast.js) ----------
export const BC_BATCH = 25; // messages per step when woken for it
export const BC_CHUNK = 5; // messages on the side of a user's update
export const BC_LOCK_SEC = 50;
export const BC_PROGRESS_EVERY_SEC = 20;

// ---------- waking itself (lib/wake.js) ----------
export const WAKE_MAX_PER_HOUR = 600;
export const WAKE_STALE_SEC = 60;
export const WAKE_MAX_WAIT_SEC = 10;

// ---------- AI (optional, lib/ai.js) ----------
export const AI_MODEL = 'gemini-3.5-flash-lite';
export const AI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const AI_DAILY = 800; // calls per Tehran day, whole bot
export const AI_PER_USER_DAY = 25; // assistant answers per user per day
export const AI_PAUSE_SEC = 3600; // after a 429

// ---------- Bot API of the child bots (lib/children.js) ----------
export const TG_API = 'https://api.telegram.org';
export const CHILD_FILE_MAX = 20 * 1024 * 1024; // getFile limit: media bigger than this can't be re-uploaded

export const GC_EVERY_SEC = 3600;
