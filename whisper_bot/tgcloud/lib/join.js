// Forced channel membership, required to SEND whispers and to use the bot's private chat (reading a
// whisper never needs it). Each channel is checked with getChatMember, in parallel. A channel whose
// check fails for a channel-side reason (bot not admin, channel gone) is skipped so one broken channel
// can't lock everyone out, and the owner is warned at most once per WARN_INTERVAL_SEC.
import {
  JOIN_CACHE_SEC, JOIN_NEG_CACHE_SEC, OWNER_ID, WARN_INTERVAL_SEC,
} from './config.js';
import { call, describeError, isApiError, send } from './tg.js';
import { claimChannelWarning, getChannels, setJoinCache } from './store.js';
import { esc, nowSec } from './util.js';

/** member / administrator / creator count as joined; restricted only while still a member. */
export function isMember(m) {
  if (!m) return false;
  switch (m.status) {
    case 'creator':
    case 'administrator':
    case 'member':
      return true;
    case 'restricted':
      return m.is_member === true;
    default: // left, kicked
      return false;
  }
}

// Errors about the *user* mean "not a member", not a broken channel. Telegram answers
// "Bad Request: member not found" for someone who was never in the channel.
export const USER_ERROR = /member not found|user not found|participant_id_invalid|user_id_invalid|user_not_participant/i;

export const channelRef = (ch) => ch.chatId || `@${ch.username}`;
export const channelUrl = (ch) => `https://t.me/${ch.username}`;

async function checkChannel(ctx, ch, userId) {
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: userId }, 'join_check');
    return isMember(m) ? 'joined' : 'missing';
  } catch (err) {
    if (isApiError(err) && err.code === 400 && USER_ERROR.test(err.description)) return 'missing';
    ch.error = describeError(err);
    return 'skipped';
  }
}

/** Is forced join switched on and are there channels? (no Bot API calls) */
export async function joinChannels(kv) {
  if (kv.join === '0') return [];
  return getChannels(kv);
}

/**
 * Checks `user` against every forced-join channel. Returns { ok, missing: [channels] }.
 * The owner and a switched-off join always pass. A positive result is cached for JOIN_CACHE_SEC.
 * `inline: true` also reuses a recent negative result (missing is then empty: inline only needs ok).
 * `fresh: true` ignores the cache (the "✅ عضو شدم" button).
 */
export async function checkJoin(ctx, user, kv, { inline = false, fresh = false } = {}) {
  if (user.id === OWNER_ID || kv.join === '0') return { ok: true, missing: [] };
  const now = nowSec();
  const ver = Number(kv.chv || 0);
  if (!fresh && user.joinVer === ver && user.joinUntil > now) {
    if (user.joinOk) return { ok: true, missing: [] };
    if (inline) return { ok: false, missing: [] };
  }
  const channels = await joinChannels(kv);
  if (!channels.length) return { ok: true, missing: [] };

  const results = await Promise.all(channels.map((ch) => checkChannel(ctx, ch, user.id)));
  const missing = channels.filter((_, i) => results[i] === 'missing');
  const skipped = channels.filter((_, i) => results[i] === 'skipped');
  if (skipped.length) await warnOwner(ctx, skipped);
  const ok = missing.length === 0;
  await setJoinCache(user.id, ok, now + (ok ? JOIN_CACHE_SEC : JOIN_NEG_CACHE_SEC), ver);
  user.joinOk = ok;
  user.joinUntil = now + (ok ? JOIN_CACHE_SEC : JOIN_NEG_CACHE_SEC);
  user.joinVer = ver;
  return { ok, missing };
}

/** Tells the owner which channels can't be checked, at most once per WARN_INTERVAL_SEC per channel. */
async function warnOwner(ctx, skipped) {
  const fresh = [];
  for (const ch of skipped) {
    console.warn(`membership check skipped for @${ch.username}: ${ch.error}`);
    if (await claimChannelWarning(ch.id, WARN_INTERVAL_SEC)) fresh.push(ch);
  }
  if (!fresh.length) return;
  const lines = fresh.map((ch) => `• @${esc(ch.username)} — <code>${esc(ch.error)}</code>`).join('\n');
  await send(ctx, 'owner_warning',
    '⚠️ <b>هشدار عضویت اجباری</b>\n\n'
    + `بررسی عضویت در این کانال‌ها خطا داد و فعلاً برای کاربران نادیده گرفته می‌شوند:\n${lines}\n\n`
    + 'احتمالاً ربات در کانال ادمین نیست، یا کانال حذف شده یا یوزرنیمش عوض شده. '
    + 'از /admin ← «📋 کانال‌ها» وضعیت را ببینید. (این هشدار حداکثر هر ۳ ساعت یک‌بار تکرار می‌شود.)',
    null, OWNER_ID);
}
