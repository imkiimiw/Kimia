/**
 * Static configuration for Wanger Stickers. Pure module: never imports 'sdk', so it runs under
 * `node --test` and can be imported by the Mini App build too.
 *
 * Runtime-changeable values (quotas, feature flags, texts, channels) live in the `settings` table
 * from Phase 1 on; only values that need a code change + deploy belong here.
 */

/** The owner (Kimi). Numeric Telegram user id; usernames are never checked. */
export const OWNER_ID = 5557901897;

/**
 * Phase 0 only: extra Telegram user ids allowed to use the spike endpoints (device testers).
 * Empty = owner only. Removed together with the spike in Phase 1.
 */
export const SPIKE_TESTER_IDS = /** @type {number[]} */ ([]);

/**
 * The bot's username, read from getMe in Phase 0 (see docs/SPIKE_REPORT.md). Pack names end in
 * `_by_<BOT_USERNAME>`. `null` until the bot is linked; Phase 1 also caches getMe in settings.
 */
export const BOT_USERNAME = /** @type {string | null} */ (null);

/** Forced-join channels seeded on first run, as data (the owner edits them in the admin panel). */
export const SEED_CHANNELS = ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots'];

/** Hard cap on forced-join channels. */
export const MAX_GATE_CHANNELS = 10;

/** Default language for new users (Persian, RTL). */
export const DEFAULT_LANG = 'fa';
export const LANGS = /** @type {const} */ (['fa', 'en']);

/** Is this numeric id the owner? The single permission check used everywhere. */
export function isOwner(/** @type {unknown} */ id) {
  return typeof id === 'number' && id === OWNER_ID;
}
