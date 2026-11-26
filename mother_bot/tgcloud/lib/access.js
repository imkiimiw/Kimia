// The team's controls over a bot, pushed to the child through the hub:
//   status  ok | degraded | maint | down — what users see on the status board (with a note);
//   mode    off | slow | closed — access restriction the child enforces with client/mother-client.js:
//           'closed' = maintenance: every request of a non-admin gets the maintenance message;
//           'slow'   = limited: one request per slow_sec seconds per user.
// Both can end by themselves (`until`): the child stops enforcing at that time on its own, and the
// mother resets the row and tells the people who asked (lib/due.js expireDue).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { botTitle, getBot, updateBot } from './catalog.js';
import { pushConfig } from './hubout.js';
import { noticeBack } from './incidents.js';
import { statusNews } from './news.js';
import { notifyTeam } from './notify.js';
import {
  duration, esc, formatDate, nowSec,
} from './util.js';

export const MODES = {
  off: { emoji: '✅', name: 'آزاد' },
  slow: { emoji: '⏳', name: 'محدود (کند)' },
  closed: { emoji: '🔧', name: 'بسته (تعمیر)' },
};

/** Sets the access mode; `durSec` 0 = until changed again. Returns the posted hub message (or null). */
export async function setMode(ctx, key, mode, durSec = 0, { msg = null, slowSec = null, byId = 0 } = {}) {
  const bot = await getBot(key);
  if (!bot || !MODES[mode]) return null;
  const now = nowSec();
  const until = mode !== 'off' && durSec > 0 ? now + durSec : 0;
  const fields = { mode, mode_until: until };
  if (msg !== null) fields.mode_msg = msg || null;
  if (mode === 'off') fields.mode_msg = null;
  if (slowSec) fields.slow_sec = slowSec;
  await updateBot(key, fields);
  const posted = await pushConfig(ctx, key);
  const was = bot.mode || 'off';
  const fresh = await getBot(key);
  if (mode === 'closed' && was !== 'closed') {
    const end = until ? `\nزمان تقریبی پایان: ${formatDate(until, true)} (حدود ${duration(durSec)})` : '';
    await statusNews(fresh, `🔧 <b>${esc(bot.name)}</b> برای تعمیر و به‌روزرسانی موقتاً در دسترس نیست.${fresh.mode_msg ? `\n${esc(fresh.mode_msg)}` : ''}${end}`);
  }
  if (mode !== 'closed' && was === 'closed') await noticeBack(fresh, 'bot', key);
  if (byId) {
    await notifyTeam(ctx, 'mode_changed', `🎛 دسترسی ${botTitle(bot)}: ${MODES[mode].emoji} ${MODES[mode].name}${until ? ` تا ${formatDate(until, true)}` : ''}${posted ? '' : '\n⚠️ کانال هاب تنظیم نیست یا ارسال نشد؛ ربات فرزند خبردار نشد.'}`, null, { silent: true });
  }
  return posted;
}

export const STATUSES = ['ok', 'degraded', 'maint', 'down'];

/** Sets the status users see; `durSec` 0 = until changed. */
export async function setStatus(ctx, key, status, note = null, durSec = 0) {
  const bot = await getBot(key);
  if (!bot || !STATUSES.includes(status)) return false;
  const now = nowSec();
  await updateBot(key, {
    status, status_note: status === 'ok' ? null : note, status_at: now, status_until: status !== 'ok' && durSec > 0 ? now + durSec : 0,
  });
  const fresh = await getBot(key);
  if (status !== 'ok' && (bot.status || 'ok') === 'ok') {
    const label = { degraded: '⚠️ اختلال', maint: '🔧 تعمیرات', down: '🔴 قطعی' }[status];
    await statusNews(fresh, `${label} در <b>${esc(bot.name)}</b>${note ? `\n${esc(note)}` : ''}\n\nتیم در حال رسیدگی است؛ وقتی درست شد خبر می‌دهیم.`);
  }
  if (status === 'ok' && (bot.status || 'ok') !== 'ok') await noticeBack(fresh, 'bot', key);
  return true;
}

/** Ends modes and statuses whose time is up. Returns how many bots changed. */
export async function expireDue(ctx) {
  const now = nowSec();
  const rows = await db.all(sql`
    SELECT key, mode, mode_until, status, status_until FROM bots
    WHERE (mode_until > 0 AND mode_until <= ${now}) OR (status_until > 0 AND status_until <= ${now}) LIMIT 10`);
  let n = 0;
  for (const r of rows) {
    if (Number(r.mode_until) > 0 && Number(r.mode_until) <= now) {
      const claimed = await db.run(sql`UPDATE bots SET mode_until = 0 WHERE key = ${r.key} AND mode_until = ${r.mode_until}`);
      if (claimed.rowsAffected) await setMode(ctx, r.key, 'off');
    }
    if (Number(r.status_until) > 0 && Number(r.status_until) <= now) {
      const claimed = await db.run(sql`UPDATE bots SET status_until = 0 WHERE key = ${r.key} AND status_until = ${r.status_until}`);
      if (claimed.rowsAffected) await setStatus(ctx, r.key, 'ok');
    }
    n += 1;
  }
  return n;
}
