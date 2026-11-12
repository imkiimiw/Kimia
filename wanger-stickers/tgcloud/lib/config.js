/**
 * Static configuration for Wanger Stickers (pure: never imports 'sdk'). Values the owner can change
 * at run time live in the `settings` table; DEFAULTS below are their starting values. Telegram and
 * WhatsApp platform numbers live in core/limits.js, never here.
 */

/** The owner (Kimi). Numeric Telegram user id; usernames are never checked. */
export const OWNER_ID = 5557901897;

/** This bot (getMe, measured 2026-11-12). Pack names end in `_by_<BOT_USERNAME>`. */
export const BOT_ID = 9292593567;
export const BOT_USERNAME = 'Wanger_Motionbot';

/** The Mini App (static site + endpoints). */
export const APP_URL = 'https://app9292593567.tgcloud.ai/';

/** Phase 0 spike endpoints: extra testers besides the owner (removed with the spike in Phase 2). */
export const SPIKE_TESTER_IDS = /** @type {number[]} */ ([]);

/** Forced-join channels seeded on first run, as data (the owner edits them in the panel). */
export const SEED_CHANNELS = Object.freeze([
  { chat_id: -1002407928564, username: 'HIDE_i_SEEK', title: 'HIDE & SEEK' },
  { chat_id: -1001816009903, username: 'Nepenthw_ir', title: 'Nepenthe' },
  { chat_id: -1001910797391, username: 'wangerBots', title: 'Wanger bots' },
]);

/** Hard cap on forced-join channels (brief §6). */
export const MAX_GATE_CHANNELS = 10;

export const LANGS = Object.freeze(['fa', 'en']);
export const DEFAULT_LANG = 'fa';

/** Features with a flag; a button is shown only when its flag is on (brief §1 rule 7). */
export const FEATURES = Object.freeze(['packs', 'pack_import', 'pack_publish', 'studio', 'gif_studio', 'convert', 'whatsapp', 'ai', 'gallery', 'payments']);
/** Features with a daily free quota (counted only after success). */
export const QUOTA_FEATURES = Object.freeze(['pack_create', 'sticker_add', 'pack_import', 'publish']);

/** Starting values of the owner-editable settings (key → value). */
export const DEFAULTS = Object.freeze({
  'gate.enabled': true,
  'gate.cache_sec': 600,
  'maintenance.on': false,
  'maintenance.text': '',
  'flags.packs': true,
  'flags.pack_import': true,
  'flags.pack_publish': true,
  'flags.studio': false,
  'flags.gif_studio': false,
  'flags.convert': false,
  'flags.whatsapp': false,
  'flags.ai': false,
  'flags.gallery': false,
  'flags.payments': false,
  'quota.pack_create': 10,
  'quota.sticker_add': 300,
  'quota.pack_import': 20,
  'quota.publish': 2,
  'limits.packs_per_user': 50,
  'text.start.fa': '',
  'text.start.en': '',
  'text.help.fa': '',
  'text.help.en': '',
  'storage.chat_id': 0,
  'account.provider': 'local',
  'broadcast.batch': 25,
  'notify.gate': true,
  'notify.errors': true,
  'notify.daily': true,
  'publish.chat': null, // { chat_id, username, title } of the destination channel
  'publish.min_stickers': 3,
  'publish.gap_sec': 30,
  'publish.republish_days': 7,
});

/** Validation of owner input for numeric settings: [min, max]. */
export const SETTING_RANGES = Object.freeze({
  'gate.cache_sec': [0, 86400],
  'quota.pack_create': [0, 1000],
  'quota.sticker_add': [0, 10000],
  'quota.pack_import': [0, 1000],
  'quota.publish': [0, 100],
  'limits.packs_per_user': [1, 500],
  'broadcast.batch': [1, 100],
  'publish.min_stickers': [1, 120],
  'publish.gap_sec': [3, 3600],
  'publish.republish_days': [0, 365],
});

/** Internal timings and caps (not owner-editable). */
export const T = Object.freeze({
  stateTtlSec: 15 * 60, // a pending conversation step
  pendingTtlSec: 15 * 60, // an action kept while the user joins the channels (brief §6)
  housekeepingEverySec: 10 * 60,
  processedKeepSec: 2 * 86400,
  errorsKeep: 1000,
  alertGateEverySec: 3600,
  alertErrorEverySec: 600,
  piggybackBudgetMs: 2500, // work done after a reply (CPU ≈ 3 s, wall ≈ 30 s measured)
  buttonBudgetMs: 20000, // work done when the owner taps "continue"
  broadcastLeaseSec: 60,
  postLeaseSec: 60,
  packOpLeaseSec: 60,
  packOpSlice: 25, // stickers copied per step of a bulk operation
  floodBurst: 20, // token bucket per user: capacity …
  floodRefillPerSec: 1, // … and refill
  pageSize: 8,
  recentErrors: 50,
  backupRows: 5000,
});

/** Is this numeric id the owner? */
export function isOwner(id) {
  return typeof id === 'number' && id === OWNER_ID;
}
