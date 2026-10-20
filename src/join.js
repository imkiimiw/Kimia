import { JOIN_CACHE_MS } from './config.js';
import { listChannels } from './db.js';
import { fa } from './time.js';
import { btn, esc, inline, urlBtn } from './ui.js';

// userId -> time of last successful check; per isolate only, so it never outlives a channel change by more than JOIN_CACHE_MS.
const verified = new Map();

export function clearJoinCache() {
  verified.clear();
}

const MEMBER = new Set(['creator', 'administrator', 'member']);

export async function missingChannels(ctx, userId) {
  const channels = await listChannels(ctx.db);
  const missing = await Promise.all(
    channels.map(async (c) => {
      const r = await ctx.api.call('getChatMember', { chat_id: c.chat, user_id: userId });
      // Unverifiable channel (bot not admin, channel deleted): skip it instead of locking everyone out.
      if (!r.ok) return false;
      const { status, is_member: isMember } = r.result;
      return !(MEMBER.has(status) || (status === 'restricted' && isMember));
    }),
  );
  return channels.filter((_, i) => missing[i]);
}

export async function checkJoin(ctx, userId, { force = false } = {}) {
  const last = verified.get(userId);
  if (!force && last && ctx.now - last < JOIN_CACHE_MS) return [];
  const missing = await missingChannels(ctx, userId);
  if (missing.length) {
    verified.delete(userId);
  } else {
    if (verified.size > 10_000) verified.clear();
    verified.set(userId, ctx.now);
  }
  return missing;
}

export function joinGateView(missing) {
  const text = [
    '🔒 <b>برای استفاده از ربات، ابتدا در کانال‌های زیر عضو شوید:</b>',
    '',
    ...missing.map((c, i) => `${fa(i + 1)}. ${esc(c.title || c.chat)}`),
    '',
    'بعد از عضویت روی «✅ عضو شدم» بزنید 👇',
  ].join('\n');
  const rows = missing.map((c) => [urlBtn(`📢 عضویت در ${c.title || c.chat}`, c.link)]);
  rows.push([btn('✅ عضو شدم، بررسی کن', 'J')]);
  return { text, kb: inline(rows) };
}
