import { listChannels } from './store.js';
import { fa } from './time.js';
import { btn, esc, inline, urlBtn } from './ui.js';

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

// Handlers keep no state between invocations, so membership is checked on every update.
export function checkJoin(ctx, userId) {
  return missingChannels(ctx, userId);
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
