// Abuse handling for the whole ecosystem. Flags come from child bots (their spam/flood detection, hub
// "abuse"), from users ("🚨 report a user" in the mother) and from the team. The team reviews a user's
// whole picture in the mother (bots used, flags, reports, tickets, bans) and acts: a warning, a
// temporary or permanent ban on every bot or on one bot, a note. Bans reach the child bots through the
// hub (lib/hubout.js pushBan); the mother enforces 'mother' and '*' bans itself.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { SPAM_MAX, SPAM_MUTE_SEC, SPAM_WINDOW_SEC } from './config.js';
import { getBot } from './catalog.js';
import { childCall } from './children.js';
import { pushBan, pushUnban } from './hubout.js';
import { notifyTeam } from './notify.js';
import {
  ensureUser, getUser, liftBans, putBan, setUserField,
} from './store.js';
import { btn, send } from './tg.js';
import {
  esc, fa, nowSec, truncate,
} from './util.js';

/** Records an abuse flag and tells the team (folded: one alert per user per hour). */
export async function flagAbuse(ctx, { userId, botKey = null, source, reason = '', detail = '', reporterId = 0 }) {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const now = nowSec();
  await ensureUser(userId);
  const recent = await db.get(sql`SELECT id FROM abuse WHERE user_id = ${userId} AND at > ${now - 3600} ORDER BY id DESC LIMIT 1`);
  const r = await db.run(sql`
    INSERT INTO abuse (user_id, bot_key, source, reason, detail, reporter_id, at)
    VALUES (${userId}, ${botKey}, ${source}, ${truncate(String(reason || ''), 100)}, ${truncate(String(detail || ''), 500)}, ${reporterId}, ${now})
    RETURNING id`);
  const id = Number(r.rows[0].id);
  if (!recent) {
    const bot = botKey ? await getBot(botKey) : null;
    const from = { bot: `ربات ${bot ? esc(bot.name) : esc(botKey || '')}`, user: 'گزارش کاربر', team: 'تیم' }[source] || source;
    await notifyTeam(ctx, 'abuse_flag', `🚨 <b>گزارش سوءاستفاده</b>\nکاربر: <code>${userId}</code>\nاز طرف: ${from}\nدلیل: ${esc(truncate(String(reason || '—'), 100))}${detail ? `\n${esc(truncate(String(detail), 300))}` : ''}`,
      [[btn('👤 بررسی کاربر', `au:${userId}`), btn('🗂 صف گزارش‌ها', 'aq')]]);
  }
  return id;
}

export async function abuseQueue(limit = 8) {
  return db.all(sql`SELECT * FROM abuse WHERE reviewed = 0 ORDER BY id LIMIT ${limit}`);
}

export async function abuseQueueSize() {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM abuse WHERE reviewed = 0 LIMIT 100)`);
  return Number((r && r.n) || 0);
}

export async function markReviewed(userId) {
  await db.run(sql`UPDATE abuse SET reviewed = 1 WHERE user_id = ${userId} AND reviewed = 0`);
}

export async function dismissFlag(id) {
  await db.run(sql`UPDATE abuse SET reviewed = 1 WHERE id = ${Number(id)}`);
}

/** Everything the team needs on one screen about a user. */
export async function userDossier(userId) {
  const user = await getUser(userId);
  const flags = await db.all(sql`SELECT * FROM abuse WHERE user_id = ${userId} ORDER BY id DESC LIMIT 5`);
  const flagCount = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM abuse WHERE user_id = ${userId} LIMIT 500)`);
  const reportsAgainst = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM tickets WHERE target_user = ${userId} LIMIT 500)`);
  const tickets = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM tickets WHERE user_id = ${userId} LIMIT 500)`);
  const bots = await db.all(sql`
    SELECT ub.bot_key, ub.uses, ub.last_at, ub.blocked, b.name, b.emoji FROM user_bots ub LEFT JOIN bots b ON b.key = ub.bot_key
    WHERE ub.user_id = ${userId} AND ub.uses > 0 ORDER BY ub.uses DESC LIMIT 10`);
  const now = nowSec();
  const bans = await db.all(sql`SELECT * FROM bans WHERE user_id = ${userId} AND (until = 0 OR until > ${now}) ORDER BY scope LIMIT 20`);
  return {
    user, flags, bots, bans,
    flagCount: Number((flagCount && flagCount.n) || 0),
    reportsAgainst: Number((reportsAgainst && reportsAgainst.n) || 0),
    tickets: Number((tickets && tickets.n) || 0),
  };
}

/** Bans a user. scope: '*' | 'mother' | bot key; durSec 0 = permanent. Pushes it to the hub. */
export async function ban(ctx, userId, scope, durSec, reason, byId) {
  await ensureUser(userId);
  const until = durSec > 0 ? nowSec() + durSec : 0;
  await putBan(userId, scope, until, reason, byId);
  await markReviewed(userId);
  const pushed = await pushBan(ctx, [userId], scope, until);
  return { until, pushed };
}

export async function unban(ctx, userId) {
  const scopes = await liftBans(userId);
  if (scopes.length) await pushUnban(ctx, [userId], scopes);
  return scopes;
}

/**
 * Sends a warning: through the mother if the user opened it, else through the child bot they used
 * most (needs its token). Returns 'mother' | the bot key | null.
 */
export async function warnUser(ctx, userId, text) {
  const user = await getUser(userId);
  const body = `⚠️ <b>اخطار از طرف تیم Wanger</b>\n\n${esc(text)}\n\nتکرار این رفتار باعث محدود شدن دسترسی شما به ربات‌های Wanger می‌شود.`;
  await setUserField(userId, 'warns', Number((user && user.warns) || 0) + 1);
  if (user && user.started && !user.blocked && (await send(ctx, 'warn', body, null, userId))) return 'mother';
  const rows = await db.all(sql`SELECT bot_key FROM user_bots WHERE user_id = ${userId} AND uses > 0 AND blocked = 0 ORDER BY last_at DESC LIMIT 5`);
  for (const r of rows) {
    const bot = await getBot(r.bot_key);
    if (!bot || !bot.token) continue;
    try {
      await childCall(bot, 'sendMessage', { chat_id: userId, text: body, parse_mode: 'HTML' }, ctx, 'warn');
      return bot.key;
    } catch {
      // try the next bot
    }
  }
  return null;
}

/**
 * Anti-spam for the mother's private chat: more than SPAM_MAX messages in SPAM_WINDOW_SEC mutes the
 * user for SPAM_MUTE_SEC. Returns 'ok' | 'muted_now' | 'muted'.
 */
export async function spamCheck(user) {
  const now = nowSec();
  if (Number(user.muted_until) > now) return 'muted';
  const fresh = now - Number(user.msg_win) > SPAM_WINDOW_SEC;
  const count = fresh ? 1 : Number(user.msg_count) + 1;
  if (count > SPAM_MAX) {
    await db.run(sql`UPDATE users SET muted_until = ${now + SPAM_MUTE_SEC}, msg_count = 0, msg_win = ${now} WHERE user_id = ${user.user_id}`);
    return 'muted_now';
  }
  await db.run(sql`UPDATE users SET msg_win = ${fresh ? now : user.msg_win}, msg_count = ${count} WHERE user_id = ${user.user_id}`);
  return 'ok';
}

export const banScopeName = async (scope) => {
  if (scope === '*') return 'همه‌ی ربات‌ها';
  if (scope === 'mother') return 'ربات مادر';
  const bot = await getBot(scope);
  return bot ? bot.name : scope;
};

export const fmtCount = (n) => fa(n);
