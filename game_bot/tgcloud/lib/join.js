/*
 * Forced join: before using the bot, the Mini App or inline mode, a user must be a member of every
 * channel in the `channels` table (seeded with DEFAULT_CHANNELS the first time). The owner is exempt.
 *
 * - A passed check is cached on the user's row for JOIN_CACHE_SEC (and only for the current channel
 *   list: join_rev changes whenever the owner edits the list).
 * - A channel whose check fails for a channel-side reason (the bot isn't an admin, the channel is
 *   gone, a Telegram error) is skipped, so one broken channel can't lock everyone out; the owner is
 *   warned at most once per WARN_INTERVAL_SEC per channel.
 */
import { DEFAULT_CHANNELS, JOIN_CACHE_SEC, OWNER_ID, WARN_INTERVAL_SEC } from './config.js';
import { t } from './i18n/index.js';
import * as store from './store.js';
import { call, describeError, esc, isApiError, send } from './tg.js';

export function isMember(m) {
  if (!m) return false;
  if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true;
  return m.status === 'restricted' && m.is_member === true;
}

/* Errors about the user (not the channel) mean "not a member". */
const USER_ERROR = /user not found|participant_id_invalid|user_id_invalid|user_not_participant/i;

export const channelRef = (ch) => (ch.chat_id ? Number(ch.chat_id) : `@${ch.username}`);
export const channelUrl = (ch) => (ch.username ? `https://t.me/${ch.username}` : (ch.link || null));
export const channelTitle = (ch) => ch.title || (ch.username ? `@${ch.username}` : String(ch.chat_id));

/* Puts the default channels in place the first time the bot runs. */
export async function seedChannels(settings) {
  if (settings.seeded === '1') return;
  for (const username of DEFAULT_CHANNELS) await store.addChannel({ username });
  await store.setSetting('seeded', '1');
  settings.seeded = '1';
}

async function checkChannel(ctx, ch, userId) {
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: userId }, 'join-check');
    return isMember(m) ? 'joined' : 'missing';
  } catch (err) {
    if (isApiError(err) && err.code === 400 && USER_ERROR.test(err.description)) return 'missing';
    ch.error = describeError(err);
    return 'skipped';
  }
}

async function warnOwner(ctx, ch) {
  const now = store.nowSec();
  if (!(await store.claimChannelWarning(ch.id, now, WARN_INTERVAL_SEC))) return;
  const owner = await store.getUser(OWNER_ID);
  if (!owner || !owner.started) return;
  await send(ctx, OWNER_ID, t(owner.lang, 'admin_ch_warn', { title: esc(channelTitle(ch)), error: esc(ch.error) }), null, 'join-warn');
}

/*
 * { ok: true } or { ok: false, missing: [{ title, url }] }. `force` skips the cache (the "I've
 * joined" button).
 */
export async function joinStatus(ctx, userId, { force = false } = {}) {
  if (userId === OWNER_ID) return { ok: true };
  const settings = await store.getSettings();
  await seedChannels(settings);
  if (settings.join === '0') return { ok: true };
  const rev = Number(settings.join_rev || 0);
  const now = store.nowSec();
  if (!force) {
    const u = await store.getUser(userId);
    if (u && Number(u.join_ok_at) > now - JOIN_CACHE_SEC && Number(u.join_rev) === rev) return { ok: true };
  }
  const chans = await store.listChannels();
  if (!chans.length) return { ok: true };
  const results = await Promise.all(chans.map((ch) => checkChannel(ctx, ch, userId)));
  const missing = [];
  for (let i = 0; i < chans.length; i += 1) {
    if (results[i] === 'skipped') await warnOwner(ctx, chans[i]);
    if (results[i] === 'missing') missing.push({ title: channelTitle(chans[i]), url: channelUrl(chans[i]) });
  }
  if (!missing.length) {
    await store.setJoinOk(userId, now, rev);
    return { ok: true };
  }
  return { ok: false, missing };
}

/* The "join these channels" keyboard: one button per missing channel, then "I've joined". */
export function joinKeyboard(lang, missing) {
  const rows = missing.filter((m) => m.url).map((m) => [{ text: `📢 ${m.title}`, url: m.url }]);
  rows.push([{ text: t(lang, 'join_check'), callback_data: 'jc' }]);
  return rows;
}

/* Bumps the channel-list revision, so cached "joined" results are checked again. */
export async function bumpJoinRev() {
  const s = await store.getSettings();
  await store.setSetting('join_rev', Number(s.join_rev || 0) + 1);
}
