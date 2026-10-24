// Telegram Serverless runs code only when an update arrives, so the work a cron would do (reminders,
// daily digests, broadcasts) runs here, piggybacking on incoming updates at most once per minute.
import { OWNER_ID, TICK_BUDGET, TICK_INTERVAL_MS } from './config.js';
import * as Q from './store.js';
import { isBlockedError } from './telegram.js';
import { fa, formatDate, localParts, nextDigestAt, nextOccurrence } from './time.js';
import { btn, cb, esc, inline, taskLine } from './ui.js';

// Rate limits and network errors are worth retrying next time; anything else is final.
const transient = (r) => !r.ok && (r.error_code === 429 || r.error_code === 0 || r.error_code >= 500);

/**
 * Claims the tick for this minute. The upsert only writes when the stored time is at least a minute old,
 * so of many concurrent updates exactly one gets rowsAffected = 1 and does the work.
 */
async function claimTick(db, now) {
  const r = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('last_tick', ?1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE CAST(settings.value AS INTEGER) <= ?2`,
    )
    .bind(String(now), now - TICK_INTERVAL_MS)
    .run();
  return r.meta.changes > 0;
}

/** Called after every update is handled. Never throws: a failed tick must not affect the reply. */
export async function maybeTick(base) {
  try {
    if (!(await claimTick(base.db, base.now))) return null;
    const results = [];
    for (const job of [sendReminders, sendDigests, runBroadcast]) {
      try {
        results.push(await job(base));
      } catch (err) {
        console.error(`tick ${job.name} failed:`, err?.stack || err);
        results.push(0);
      }
    }
    return results;
  } catch (err) {
    console.error('tick failed:', err?.stack || err);
    return null;
  }
}

async function sendReminders(ctx) {
  const tasks = await Q.dueReminders(ctx.db, ctx.now, TICK_BUDGET.reminders);
  let sent = 0;
  await Promise.all(
    tasks.map(async (t) => {
      const next = t.repeat ? nextOccurrence(t.remind_at, t.repeat, ctx.now) : null;
      // Claim the reminder first so an overlapping tick can't send it twice.
      const claim = await ctx.db
        .prepare(`UPDATE tasks SET remind_at = ? WHERE id = ? AND remind_at = ?`)
        .bind(next, t.id, t.remind_at)
        .run();
      // Finished tasks and users who blocked the bot are claimed (cleared/advanced) but not messaged.
      if (!claim.meta.changes || t.done || t.blocked) return;
      const r = await ctx.api.send(t.user_id, `⏰ <b>یادآوری</b>\n\n${taskLine(t, ctx.now, Infinity)}${t.note ? `\n\n📝 ${esc(t.note)}` : ''}`, {
        reply_markup: inline([
          [btn('✅ انجام شد', cb('D', t.num, 'p.0')), btn('📄 جزئیات', cb('T', t.num, 'p.0'))],
          [btn('😴 ۱۰ دقیقه بعد', `SN|${t.num}|10`), btn('😴 ۱ ساعت بعد', `SN|${t.num}|60`)],
        ]),
      });
      if (r.ok) sent += 1;
      else if (isBlockedError(r)) await Q.markBlocked(ctx.db, t.user_id);
      else if (transient(r)) await ctx.db.prepare(`UPDATE tasks SET remind_at = ? WHERE id = ?`).bind(t.remind_at, t.id).run();
    }),
  );
  return sent;
}

function greeting(hour) {
  if (hour < 12) return '🌅 صبح بخیر';
  if (hour < 17) return '☀️ روز بخیر';
  return '🌙 عصر بخیر';
}

async function sendDigests(ctx) {
  const lp = localParts(ctx.now);
  const users = await Q.digestCandidates(ctx.db, ctx.now, TICK_BUDGET.digests);
  let sent = 0;
  await Promise.all(
    users.map(async (u) => {
      // Move to the next day first, so an overlapping run can't send it twice and a missed day sends only once.
      const next = u.digest_hour === null ? null : nextDigestAt(ctx.now, u.digest_hour);
      const claim = await ctx.db
        .prepare(`UPDATE users SET digest_next = ? WHERE id = ? AND digest_next = ?`)
        .bind(next, u.id, u.digest_next)
        .run();
      if (!claim.meta.changes || u.blocked || next === null) return;
      const [stats, tasks] = await Promise.all([Q.userStats(ctx.db, u.id, ctx.now), Q.pendingForDigest(ctx.db, u.id, ctx.now)]);
      const lines = [
        `${greeting(lp.hh)} ${esc(u.first_name || '')}!`,
        `📋 <b>خلاصه روزانه</b> — ${formatDate(ctx.now, { time: false, now: ctx.now })}`,
        '',
        `⏳ در جریان: <b>${fa(stats.pending)}</b> · 📅 امروز: <b>${fa(stats.today)}</b> · ⚠️ عقب‌افتاده: <b>${fa(stats.overdue)}</b>`,
        `🏁 در ۷ روز اخیر <b>${fa(stats.week)}</b> کار انجام داده‌اید.`,
        '',
      ];
      if (tasks.length) lines.push('<b>کارهای مهم امروز:</b>', '', tasks.map((t) => taskLine(t, ctx.now)).join('\n\n'));
      else lines.push('🎉 هیچ کار در جریانی ندارید. یک روز عالی داشته باشید!');
      const r = await ctx.api.send(u.id, lines.join('\n'), {
        reply_markup: inline([[btn('📋 همه کارها', 'L|p|0'), btn('📅 کارهای امروز', 'L|t|0')]]),
      });
      if (r.ok) sent += 1;
      else if (isBlockedError(r)) await Q.markBlocked(ctx.db, u.id);
      else if (transient(r)) await ctx.db.prepare(`UPDATE users SET digest_next = ? WHERE id = ?`).bind(u.digest_next, u.id).run();
    }),
  );
  return sent;
}

/** Sends the next batch of the running broadcast; also called right after the owner confirms one. */
export async function runBroadcast(ctx) {
  const n = TICK_BUDGET.broadcast;
  const b = await Q.activeBroadcast(ctx.db);
  if (!b) return 0;
  const targets = await Q.broadcastTargets(ctx.db, b.cursor, n);
  let sent = 0;
  let failed = 0;
  let cursor = b.cursor;
  let interrupted = false;
  // In order, stopping at a rate limit or network error: the cursor then resumes exactly there next minute,
  // so nobody is skipped and nobody gets the message twice.
  for (const id of targets) {
    const r = await ctx.api.call('copyMessage', { chat_id: id, from_chat_id: b.from_chat, message_id: b.message_id });
    if (transient(r)) {
      interrupted = true;
      break;
    }
    if (r.ok) sent += 1;
    else {
      failed += 1;
      if (isBlockedError(r)) await Q.markBlocked(ctx.db, id);
    }
    cursor = id;
  }
  const finished = !interrupted && targets.length < n;
  await Q.updateBroadcast(ctx.db, b.id, cursor, sent, failed, finished ? 'done' : 'running');
  if (finished) {
    const total = await Q.getBroadcast(ctx.db, b.id);
    await ctx.api.send(
      OWNER_ID,
      `📣 <b>ارسال همگانی تمام شد.</b>\n\n✅ موفق: ${fa(total.sent)}\n❌ ناموفق: ${fa(total.failed)}`,
    );
  }
  return sent;
}
