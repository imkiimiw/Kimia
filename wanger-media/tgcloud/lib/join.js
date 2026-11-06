// Forced channel membership (brief §5): getChatMember for each enabled channel. A Bot API error
// means "unknown", never "member": the user is not let through, the channel is marked and the
// owner is told which channel is misconfigured. Positive results are cached for JOIN_PASS_S.
import { channelLabel } from './ui.js';
import { alertOwner } from './alerts.js';
import { BOT_ID, JOIN_PASS_S, SEED_CHANNELS } from './config.js';
import * as channels from './db/channels.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { skipsForcedJoin } from './roles.js';
import * as tg from './tg.js';
import { errorText } from './util.js';

const MEMBER_STATUSES = ['creator', 'administrator', 'member'];

/**
 * Pure: a getChatMember result or error → { state: 'member' | 'not_member' | 'unknown', reason }.
 * "member not found" is Telegram's answer for someone who never joined (measured), so it means
 * not a member; every other error is unknown.
 */
export function classifyMember(result, error) {
  if (error) {
    const { kind } = tg.classify(error);
    if (kind === 'member_not_found') return { state: 'not_member', reason: 'member_not_found' };
    return { state: 'unknown', reason: kind };
  }
  const status = result && result.status;
  if (MEMBER_STATUSES.includes(status)) return { state: 'member', reason: status };
  if (status === 'restricted') return result.is_member ? { state: 'member', reason: 'restricted' } : { state: 'not_member', reason: 'restricted' };
  if (status === 'left' || status === 'kicked') return { state: 'not_member', reason: status };
  return { state: 'unknown', reason: 'unexpected_status' };
}

/** How a failed check reflects on the channel's own setup: 'not_admin', 'error' or null (transient). */
export function channelProblem(reason) {
  if (reason === 'forbidden') return 'not_admin';
  if (reason === 'chat_not_found' || reason === 'bad_request' || reason === 'unexpected_status') return 'error';
  return null; // rate limit, network, server, an unknown user id: says nothing about the channel
}

const chatRef = (ch) => (ch.chat_id ? ch.chat_id : '@' + ch.username);

/**
 * Checks `user` (from lib/router.js prepareUser) against the enabled channels.
 * → { pass: true } or { pass: false, missing: [rows], unknown: [rows] }
 */
export async function check(ctx, user, { useCache = true } = {}) {
  if (!ctx.flags.forcedJoin || skipsForcedJoin(user.actor)) return { pass: true, skipped: true };
  if (useCache && user.row.join_ok_until > ctx.now) return { pass: true, cached: true };
  const list = await channels.listEnabled();
  if (!list.length) return { pass: true, empty: true };

  const results = await Promise.all(list.map(async (ch) => {
    try {
      const m = await tg.call(ctx, 'join_check', 'getChatMember', { chat_id: chatRef(ch), user_id: user.id });
      return { ch, ...classifyMember(m, null) };
    } catch (err) {
      return { ch, ...classifyMember(null, err), err };
    }
  }));

  const missing = [];
  const unknown = [];
  for (const r of results) {
    if (r.state === 'not_member') missing.push(r.ch);
    if (r.state === 'unknown') unknown.push(r.ch);
    if (r.state !== 'unknown' && r.ch.bot_status !== 'ok') await channels.setStatus(r.ch.id, 'ok', null, ctx.now);
    if (r.state === 'unknown') await reportProblem(ctx, r.ch, channelProblem(r.reason), errorText(r.err));
  }
  if (!missing.length && !unknown.length) {
    await users.setJoinPass(user.id, ctx.now + JOIN_PASS_S);
    return { pass: true };
  }
  return { pass: false, missing, unknown };
}

async function reportProblem(ctx, ch, problem, detail) {
  if (!problem) return;
  await channels.setStatus(ch.id, problem, detail, ctx.now);
  await alertOwner(ctx, 'channel:' + ch.id, 'alert.channel', { channel: channelLabel(ch), detail });
}

/** The bot's own standing in a channel, from getChatMember(bot): 'ok' | 'not_admin' | 'error'. */
async function botStanding(ctx, ref) {
  try {
    const m = await tg.call(ctx, 'channel_check', 'getChatMember', { chat_id: ref, user_id: BOT_ID });
    return m && (m.status === 'administrator' || m.status === 'creator') ? { status: 'ok' } : { status: 'not_admin', detail: m && m.status };
  } catch (err) {
    return { status: channelProblem(err.kind) || 'unknown', detail: errorText(err) };
  }
}

/**
 * First run only: inserts the seed channels and asks Telegram about each one this call inserted
 * (chat id, title, whether the bot is admin there). Safe under concurrency: inserts skip existing
 * rows and only the inserting call resolves them.
 */
export async function seedOnce(ctx) {
  const inserted = await channels.seed(SEED_CHANNELS, ctx.now);
  for (const row of inserted) {
    const ref = '@' + row.username;
    let info = { botStatus: 'unknown' };
    try {
      const chat = await tg.call(ctx, 'channel_seed', 'getChat', { chat_id: ref });
      const standing = await botStanding(ctx, chat.id);
      info = { chatId: chat.id, title: chat.title || null, botStatus: standing.status, detail: standing.detail || null };
    } catch (err) {
      info = { botStatus: channelProblem(err.kind) || 'unknown', detail: errorText(err) };
    }
    await channels.setInfo(row.id, info, ctx.now);
    if (info.botStatus !== 'ok') {
      await alertOwner(ctx, 'channel:' + row.id, 'alert.channel', { channel: '@' + row.username, detail: info.detail || info.botStatus });
    }
  }
  await system.setSetting('seed.channels', true, 0, ctx.now);
  if (inserted.length) await system.audit(ctx.now, 0, 'channels.seed', null, { usernames: inserted.map((r) => r.username) });
  return inserted.length;
}

/**
 * my_chat_member in a channel: keeps a forced channel's bot_status current and tells the owner
 * when the bot stops being an admin there.
 */
export async function onChannelStatus(ctx, chat, newStatus) {
  const ch = await channels.findByChat(chat.id, chat.username);
  if (!ch) return { forced: false };
  const status = newStatus === 'administrator' || newStatus === 'creator' ? 'ok' : 'not_admin';
  const changed = await channels.setStatus(ch.id, status, status === 'ok' ? null : newStatus, ctx.now);
  if (ch.chat_id == null) await channels.setInfo(ch.id, { chatId: chat.id, title: chat.title || null, botStatus: status }, ctx.now);
  if (changed && status !== 'ok') {
    await alertOwner(ctx, 'channel:' + ch.id, 'alert.lost_admin', { channel: channelLabel(ch) });
  }
  return { forced: true, status, changed };
}
