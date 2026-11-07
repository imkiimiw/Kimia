// The ecosystem gate: forced channel membership. Spec v2 puts it in the Wanger Hub (/v1/gate), which
// doesn't exist yet, so this is the LOCAL provider (same rules as the other Wanger bots); a hub
// provider plugs in at check() later. Bans and maintenance are flags checked in lib/router.js.
//
// Fail-open, like the spec's "hub down → fail open": a channel whose membership can't be checked
// (bot not admin there, chat gone, network) is skipped for that check — users aren't locked out by
// a setup mistake — and the owner is told (throttled). Only "not a member" holds a user.
import { BOT_ID, JOIN_PASS_S, SEED_CHANNELS } from './config.js';
import * as channels from './db/channels.js';
import * as users from './db/users.js';
import { setSetting } from './db/system.js';
import { alertOwner } from './alerts.js';
import * as tg from './tg.js';
import { errorText } from './util.js';

const MEMBER = ['creator', 'administrator', 'member'];
const BAD = ['not_admin', 'error'];
const SKIP_BAD_S = 600;

/** Pure: getChatMember result or error → { state: 'member'|'not_member'|'unknown', reason }. */
export function classifyMember(result, error) {
  if (error) {
    const kind = error.kind || tg.classify(error).kind;
    if (kind === 'member_not_found') return { state: 'not_member', reason: kind }; // Telegram's answer for "never joined"
    return { state: 'unknown', reason: kind };
  }
  const status = result && result.status;
  if (MEMBER.includes(status)) return { state: 'member', reason: status };
  if (status === 'restricted') return { state: result.is_member ? 'member' : 'not_member', reason: status };
  if (status === 'left' || status === 'kicked') return { state: 'not_member', reason: status };
  return { state: 'unknown', reason: 'unexpected_status' };
}

/** How a failed check reflects on the channel's setup: 'not_admin' | 'error' | null (transient). */
export function channelProblem(reason) {
  if (reason === 'no_access' || reason === 'forbidden') return 'not_admin';
  if (reason === 'chat_not_found' || reason === 'bad_request' || reason === 'unexpected_status') return 'error';
  return null;
}

export const chatRef = (ch) => (ch.chat_id ? ch.chat_id : `@${ch.username}`);
export const channelLabel = (ch) => (ch.username ? `@${ch.username}` : ch.title || String(ch.chat_id));

/**
 * → { pass: true, ... } | { pass: false, missing: [channel rows] }
 * Staff skip it; a positive result is trusted for JOIN_PASS_S.
 */
export async function check(ctx, { useCache = true } = {}) {
  if (!ctx.flags.forcedJoin || ctx.actor !== 'user') return { pass: true, skipped: true };
  if (useCache && ctx.user.join_ok_until > ctx.now) return { pass: true, cached: true };
  const all = await channels.listEnabled();
  if (!all.length) return { pass: true, empty: true };
  // a channel known to be uncheckable (bot not admin) is skipped for SKIP_BAD_S instead of asking
  // Telegram again on every update; my_chat_member and «🔄 بررسی دوباره» refresh it sooner
  const list = all.filter((ch) => !(BAD.includes(ch.bot_status) && ch.checked_at > ctx.now - SKIP_BAD_S));
  const skipped = all.length - list.length;
  const results = await Promise.all(list.map(async (ch) => {
    try {
      const m = await tg.call(ctx, 'join_check', 'getChatMember', { chat_id: chatRef(ch), user_id: ctx.user.id });
      return { ch, ...classifyMember(m, null) };
    } catch (err) {
      return { ch, ...classifyMember(null, err), err };
    }
  }));
  const missing = results.filter((r) => r.state === 'not_member').map((r) => r.ch);
  const unknown = results.filter((r) => r.state === 'unknown');
  for (const r of results) {
    if (r.state !== 'unknown' && r.ch.bot_status !== 'ok') await channels.setStatus(r.ch.id, 'ok', null, ctx.now);
  }
  const problems = [];
  for (const r of unknown) {
    const p = channelProblem(r.reason);
    if (p) { problems.push(r.ch); await channels.setStatus(r.ch.id, p, errorText(r.err), ctx.now); }
  }
  if (problems.length) await alertOwner(ctx, 'channels', 'alert.channels', { channels: problems.map(channelLabel).join('، ') });
  if (missing.length) return { pass: false, missing };
  // a pass is cached only when every channel could be checked
  if (!unknown.length && !skipped) await users.setJoinPass(ctx.user.id, ctx.now + JOIN_PASS_S);
  return { pass: true, partial: unknown.length + skipped > 0 };
}

/** The bot's own standing in a channel: 'ok' | 'not_admin' | 'error' | 'unknown'. */
export async function botStanding(ctx, ref) {
  try {
    const m = await tg.call(ctx, 'channel_check', 'getChatMember', { chat_id: ref, user_id: BOT_ID });
    return m && (m.status === 'administrator' || m.status === 'creator') ? { status: 'ok' } : { status: 'not_admin', detail: m && m.status };
  } catch (err) {
    return { status: channelProblem(err.kind) || 'unknown', detail: errorText(err) };
  }
}

/** Resolves a channel reference (@name or t.me link) → { chatId, title, username, standing } or { error }. */
export async function resolveChannel(ctx, ref) {
  try {
    const chat = await tg.call(ctx, 'channel_add', 'getChat', { chat_id: ref });
    if (chat.type !== 'channel' && chat.type !== 'supergroup') return { error: 'not_channel' };
    const standing = await botStanding(ctx, chat.id);
    return { chatId: chat.id, title: chat.title || null, username: chat.username || null, standing };
  } catch (err) {
    return { error: err.kind === 'chat_not_found' || err.kind === 'bad_request' ? 'not_found' : 'failed' };
  }
}

/**
 * First run: inserts the seed channels (once; the owner may remove them later) and checks the bot's
 * standing in each one it inserted. Race-safe: only the inserting call resolves a row.
 */
export async function seedOnce(ctx) {
  const inserted = await channels.seed(SEED_CHANNELS, ctx.now);
  const problems = [];
  for (const row of inserted) {
    let info;
    try {
      const chat = await tg.call(ctx, 'channel_seed', 'getChat', { chat_id: `@${row.username}` });
      const standing = await botStanding(ctx, chat.id);
      info = { chatId: chat.id, title: chat.title || null, botStatus: standing.status, botDetail: standing.detail || null };
    } catch (err) {
      info = { botStatus: channelProblem(err.kind) || 'unknown', botDetail: errorText(err) };
    }
    await channels.setInfo(row.id, info, ctx.now);
    if (info.botStatus !== 'ok') problems.push(`@${row.username}`);
  }
  await setSetting('seeded', true, ctx.now);
  if (problems.length) await alertOwner(ctx, 'channels', 'alert.channels', { channels: problems.join('، ') });
  return inserted.length;
}

/** my_chat_member in a forced channel: keeps bot_status current; tells the owner about a lost admin. */
export async function onChannelStatus(ctx, chat, newStatus) {
  const ch = await channels.find(chat.id, chat.username);
  if (!ch) return { forced: false };
  const status = newStatus === 'administrator' || newStatus === 'creator' ? 'ok' : 'not_admin';
  const changed = await channels.setStatus(ch.id, status, status === 'ok' ? null : newStatus, ctx.now);
  if (!ch.chat_id) await channels.setInfo(ch.id, { chatId: chat.id, title: chat.title || null, botStatus: status }, ctx.now);
  if (changed && status !== 'ok') await alertOwner(ctx, `lost:${ch.id}`, 'alert.lost_admin', { channel: channelLabel(ch) }, 60);
  return { forced: true, status, changed };
}
