// Opt-in news. A user subscribes to the bots they care about (user_bots.sub) and/or to "all Wanger news"
// (bot_key '*': new bots and general announcements), and picks which kinds of news they want
// (users.news_kinds, a bitmask). Nothing is sent to anyone who didn't subscribe.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { createBroadcast } from './broadcast.js';
import { kvGet, setUserField } from './store.js';
import { btn } from './tg.js';
import { nowSec } from './util.js';

export const KINDS = [
  { bit: 1, id: 'new', name: 'ربات‌های جدید', emoji: '🆕' },
  { bit: 2, id: 'update', name: 'آپدیت‌ها و قابلیت‌های تازه', emoji: '✨' },
  { bit: 4, id: 'status', name: 'اختلال و تعمیرات', emoji: '⚠️' },
  { bit: 8, id: 'notice', name: 'اطلاعیه‌های مهم', emoji: '📢' },
];
export const KIND = { NEW: 1, UPDATE: 2, STATUS: 4, NOTICE: 8 };
export const kindOf = (bit) => KINDS.find((k) => k.bit === Number(bit)) || KINDS[3];

export async function isSubscribed(userId, botKey) {
  const r = await db.get(sql`SELECT sub FROM user_bots WHERE user_id = ${userId} AND bot_key = ${botKey}`);
  return !!(r && Number(r.sub));
}

/** Flips a subscription; returns the new state. */
export async function toggleSub(userId, botKey) {
  const on = !(await isSubscribed(userId, botKey));
  await db.run(sql`
    INSERT INTO user_bots (user_id, bot_key, sub) VALUES (${userId}, ${botKey}, ${on ? 1 : 0})
    ON CONFLICT(user_id, bot_key) DO UPDATE SET sub = excluded.sub`);
  return on;
}

export async function subsOf(userId) {
  const rows = await db.all(sql`SELECT bot_key FROM user_bots WHERE user_id = ${userId} AND sub = 1 ORDER BY bot_key LIMIT 70`);
  return new Set(rows.map((r) => r.bot_key));
}

export async function toggleKind(user, bit) {
  const kinds = Number(user.news_kinds) ^ Number(bit);
  await setUserField(user.user_id, 'news_kinds', kinds);
  return kinds;
}

export async function subscriberCount(botKey) {
  const r = await db.get(sql`SELECT count(*) AS n FROM user_bots WHERE bot_key = ${botKey} AND sub = 1`);
  return Number((r && r.n) || 0);
}

/**
 * Queues news for subscribers. `botKey` '*' = general news. `content` is a broadcast content
 * ({ html, kb } or { copy }). Returns the broadcast id.
 */
export async function announce({ botKey, kind, content, title, createdBy = 0 }) {
  const audiences = [`s:${botKey}:${kind}`];
  return createBroadcast({ kind: 'news', title: title || null, content, audiences, createdBy });
}

/** Automatic status news (outage, maintenance, back to normal), unless the owner switched it off. */
export async function statusNews(bot, html) {
  if ((await kvGet('auto_news')) === '0') return null;
  if (!(await db.get(sql`SELECT 1 AS x FROM user_bots WHERE bot_key = ${bot.key} AND sub = 1 LIMIT 1`))) return null;
  const kb = bot.username ? [[{ text: `🚀 ${bot.name}`, url: `https://t.me/${bot.username}` }]] : null;
  return announce({ botKey: bot.key, kind: KIND.STATUS, content: { html, kb }, title: `وضعیت ${bot.name}` });
}

/** "🔔 خبرهای این ربات: روشن/خاموش" button for a bot page. */
export const subButton = (on, botKey) => btn(on ? '🔕 لغو اطلاع‌رسانی این ربات' : '🔔 خبرهای این ربات را بفرست', `ns:${botKey}`);

export const nowStamp = nowSec;
