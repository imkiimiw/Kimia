// Defaults; OWNER_ID and TZ_OFFSET_MINUTES can be overridden from wrangler.toml vars.
export const DEFAULT_OWNER_ID = 5557901897;
export const MAX_CHANNELS = 10;
export const DEFAULT_CHANNELS = ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots'];

// Iran Standard Time (UTC+03:30, no DST since 2022).
export const DEFAULT_TZ_OFFSET_MINUTES = 210;

export const PAGE_SIZE = 8;
export const MAX_TASK_LEN = 300;
export const MAX_NOTE_LEN = 1000;
export const MAX_CATEGORY_LEN = 20;

// Outbound Telegram calls per cron tick (Workers Free allows 50 subrequests per invocation).
export const CRON_BUDGET = { reminders: 20, digests: 10, broadcast: 15 };

// How long a successful membership check is trusted inside one isolate.
export const JOIN_CACHE_MS = 60_000;

// Telegram only accepts these characters in a webhook secret token.
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** Secrets pasted into the dashboard often carry a stray space or newline. */
export function secret(env, name) {
  return String(env[name] ?? '').trim();
}

export function ownerId(env) {
  return Number(env.OWNER_ID || DEFAULT_OWNER_ID);
}
