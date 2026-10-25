// Mandatory channel membership. Each channel is checked with getChatMember, in parallel.
// A channel whose check fails for a channel-side reason (bot not admin, channel gone, Telegram
// error) is skipped, so one broken channel can't lock every user out; the owner is warned.
import { OWNER_ID, WARN_INTERVAL_SEC } from './config.js';
import { call, describeError, isApiError, send } from './tg.js';
import { claimChannelWarning, getChannels, getSettings } from './store.js';
import { esc } from './text.js';

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

// Errors about the *user* (unknown or invalid id) mean "not a member", not a broken channel.
const USER_ERROR = /user not found|participant_id_invalid|user_id_invalid|user_not_participant/i;

export function channelRef(ch) {
  return ch.chatId || `@${ch.username}`;
}

async function checkChannel(ctx, ch, userId) {
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: userId });
    return isMember(m) ? 'joined' : 'missing';
  } catch (err) {
    if (isApiError(err) && err.code === 400 && USER_ERROR.test(err.description)) return 'missing';
    ch.error = describeError(err);
    return 'skipped';
  }
}

/**
 * Checks the user against every mandatory channel.
 * Returns { ok, missing: [channels not joined] }. The owner and a disabled join always pass.
 */
export async function checkJoin(ctx, userId) {
  if (userId === OWNER_ID) return { ok: true, missing: [] };
  const settings = await getSettings();
  if (settings.join === '0') return { ok: true, missing: [] };
  const channels = await getChannels(settings);
  if (!channels.length) return { ok: true, missing: [] };

  const results = await Promise.all(channels.map((ch) => checkChannel(ctx, ch, userId)));
  const missing = channels.filter((_, i) => results[i] === 'missing');
  const skipped = channels.filter((_, i) => results[i] === 'skipped');
  if (skipped.length) await warnOwner(ctx, skipped);
  return { ok: missing.length === 0, missing };
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
    `⚠️ <b>هشدار عضویت اجباری</b>\n\n`
    + `بررسی عضویت در این کانال‌ها خطا داد و فعلاً برای کاربران نادیده گرفته می‌شوند:\n${lines}\n\n`
    + 'احتمالاً ربات در کانال ادمین نیست یا کانال حذف شده یا یوزرنیمش تغییر کرده است. '
    + 'وضعیت را از /admin ← «📢 کانال‌ها» بررسی کنید.',
    null, OWNER_ID);
}
