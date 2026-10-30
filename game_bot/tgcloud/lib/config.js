/*
 * Settings of this bot. OWNER_ID is checked by numeric id only (never by username).
 * APP_SHORT_NAME is the Mini App's short name from BotFather /newapp: inline invitations link to
 * https://t.me/<bot>/<APP_SHORT_NAME>?startapp=<payload>. APP_URL is the address `npx tgcloud push`
 * prints (https://app<id>.tgcloud.ai/): it hosts the inline thumbnails and is the menu button's URL.
 */
export const OWNER_ID = 5557901897;
export const APP_SHORT_NAME = 'play';
export const APP_URL = 'https://app8740157051.tgcloud.ai/';

export const DEFAULT_CHANNELS = ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots'];
export const MAX_CHANNELS = 10;
export const JOIN_CACHE_SEC = 8 * 60; /* a passed membership check is trusted this long */
export const WARN_INTERVAL_SEC = 3 * 3600; /* at most one "channel check failed" warning per channel per 3 h */

export const GRACE_SEC = 2; /* turn timers: extra seconds before a timeout counts (clock skew, latency) */
export const MAX_TIMEOUTS = 3; /* consecutive timeouts that forfeit the game */
export const HOKM_BOTS_AFTER_SEC = 60; /* the creator may fill empty Hokm seats with bots after this */
export const ROOM_WAIT_TTL = 2 * 3600; /* a room nobody joined is deleted after this */
export const ROOM_IDLE_TTL = 15 * 60; /* a game where nothing happened for this long is closed */
export const ROOM_KEEP_TTL = 2 * 24 * 3600; /* finished / closed rooms are deleted after this */

export const POINTS = { win: 3, draw: 1 }; /* leaderboard points for multiplayer results */

export const BROADCAST_BATCH = 25; /* messages per batch: Telegram allows about 30 per second */
export const BROADCAST_GAP_MS = 1000; /* at least this long between batches */
export const BROADCAST_BUDGET_MS = 6000; /* stop a batch early after this long */

export const GAMES = ['ttt', 'bg', 'hokm', 'codeword', 'fusion'];
export const ROOM_GAMES = ['ttt', 'bg', 'hokm'];
/* One letter per game in startapp payloads: <letter>_<room id>, or the letter alone for solo games. */
export const PAYLOAD_LETTER = { ttt: 't', bg: 'b', hokm: 'h', codeword: 'c', fusion: 'f' };
