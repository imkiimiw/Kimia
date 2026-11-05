/*
 * Optional forced join: when the switch is on and channels are set (admin panel), ordinary users
 * must be members of every channel to use the private chat and inline mode. Admins are exempt.
 *
 * Each channel is checked with getChatMember (the bot must be an admin there). A positive result is
 * cached JOIN_CACHE seconds, a negative one JOIN_NEG_CACHE seconds (inline queries arrive per
 * keystroke); "✅ I joined" ignores the cache. A channel that can't be checked (bot not admin,
 * channel gone) is skipped so one broken channel can't lock everyone out, and the owner is alerted.
 * Changing the channels or the switch bumps join:ver, which invalidates every cached result.
 *
 * callback_data: j:chk ("I joined")
 */
import { JOIN_CACHE, JOIN_NEG_CACHE } from './config.js';
import * as admin from './adminstore.js';
import { alertOwner } from './bot.js';
import { t } from './i18n.js';
import { call, describeError, isApiError, send } from './tg.js';
import { esc } from './util.js';

/* member / administrator / creator are members; restricted only while still in the chat. */
export function isMember(m) {
  if (!m) return false;
  if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true;
  return m.status === 'restricted' && m.is_member === true;
}

/* Telegram's answers about the *user* (never joined) mean "not a member", not a broken channel. */
const USER_ERROR = /member not found|user not found|participant_id_invalid|user_id_invalid|user_not_participant/i;

export const channelUrl = (ch) => ch.link || (ch.username ? `https://t.me/${ch.username}` : null);

async function checkOne(ctx, ch, userId) {
  try {
    return isMember(await call(ctx, 'getChatMember', { chat_id: ch.chat_id, user_id: userId }, 'join.check')) ? 'in' : 'out';
  } catch (err) {
    if (isApiError(err) && err.code === 400 && USER_ERROR.test(err.description)) return 'out';
    ch.error = describeError(err);
    return 'skip';
  }
}

/*
 * { ok, missing }. `inline`: a fresh negative cache answers "not ok" without Bot API calls.
 * `fresh`: ignore the cache (the "I joined" button). `role`: admins always pass.
 */
export async function checkJoin(ctx, user, settings, nowSec, { role = null, inline = false, fresh = false } = {}) {
  if (role || !settings.joinActive) return { ok: true, missing: [] };
  const ver = settings.joinVer;
  if (!fresh && user.join_ver === ver && user.join_until > nowSec) {
    if (user.join_ok) return { ok: true, missing: [] };
    if (inline) return { ok: false, missing: [] };
  }
  const channels = await admin.listChannels();
  if (!channels.length) return { ok: true, missing: [] };
  const results = [];
  for (const ch of channels) results.push(await checkOne(ctx, ch, user.id));
  const missing = channels.filter((_, i) => results[i] === 'out');
  const skipped = channels.filter((_, i) => results[i] === 'skip');
  if (skipped.length) {
    const names = skipped.map((c) => `${c.title || c.chat_id}: ${c.error}`).join('\n');
    await alertOwner(ctx, 'join', 'owner.join_broken', { list: esc(names) }, nowSec);
  }
  const ok = missing.length === 0;
  await admin.setJoinCache(user.id, ok, nowSec + (ok ? JOIN_CACHE : JOIN_NEG_CACHE), ver);
  Object.assign(user, { join_ok: ok ? 1 : 0, join_until: nowSec + (ok ? JOIN_CACHE : JOIN_NEG_CACHE), join_ver: ver });
  return { ok, missing };
}

/* The lock message: one link button per missing channel, then "I joined". */
export function lockKeyboard(lang, missing) {
  const rows = missing.filter(channelUrl).map((ch) => [{ text: `📢 ${ch.title || ch.username || ch.chat_id}`, url: channelUrl(ch) }]);
  rows.push([{ text: t(lang, 'join.check_btn'), callback_data: 'j:chk' }]);
  return rows;
}

export async function sendLock(ctx, missing) {
  await send(ctx, 'join.lock', t(ctx.lang, 'join.lock'), lockKeyboard(ctx.lang, missing));
}
