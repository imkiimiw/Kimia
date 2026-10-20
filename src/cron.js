import { CRON_BUDGET, CRON_SUBREQUESTS, ownerId } from './config.js';
import * as Q from './db.js';
import { createApi, isBlockedError } from './telegram.js';
import { fa, formatDate, localDateKey, localParts, nextOccurrence } from './time.js';
import { btn, cb, esc, inline, taskLine } from './ui.js';

// Rate limits and network errors are worth retrying next minute; anything else is final.
const transient = (r) => !r.ok && (r.error_code === 429 || r.error_code === 0 || r.error_code >= 500);

// Worst-case calls per item (D1 statements + Telegram requests), used to size each batch up front.
const COST = { reminder: 3, digest: 5, broadcastItem: 2, broadcastFixed: 5 };

/** Wraps D1 and the Telegram API so every call in this invocation is charged to one budget. */
function metered(env, limit) {
  let used = 0;
  const wrap = (stmt) => ({
    stmt,
    bind: (...args) => wrap(stmt.bind(...args)),
    first: (...args) => ((used += 1), stmt.first(...args)),
    run: () => ((used += 1), stmt.run()),
    all: () => ((used += 1), stmt.all()),
  });
  const db = {
    prepare: (sql) => wrap(env.DB.prepare(sql)),
    // Counted per statement: the docs don't say whether a batch counts once, so assume the worst.
    batch: (list) => ((used += list.length), env.DB.batch(list.map((s) => s.stmt))),
  };
  const raw = createApi(env);
  const api = { ...raw, call: (...a) => ((used += 1), raw.call(...a)), send: (...a) => ((used += 1), raw.send(...a)) };
  return { db, api, left: () => limit - used };
}

/** How many items fit after paying `fixed`, capped at `max`. */
const affordable = (ctx, fixed, each, max) => Math.max(0, Math.min(max, Math.floor((ctx.left() - fixed) / each)));

export async function runCron(env, now) {
  const m = metered(env, CRON_SUBREQUESTS);
  await Q.ensureSchema(m.db);
  // Wall-clock time (not scheduledTime) so the status page can tell whether the cron trigger is running.
  await Q.setSetting(m.db, 'last_cron', String(Date.now()));
  const ctx = { env, now, ...m };
  // Sequential on purpose: each job spends what the previous one left.
  const results = [];
  for (const job of [sendReminders, sendDigests, runBroadcast]) {
    try {
      results.push(await job(ctx));
    } catch (err) {
      console.error(`cron ${job.name} failed:`, err?.stack || err);
      results.push(0);
    }
  }
  return results;
}

async function sendReminders(ctx) {
  const n = affordable(ctx, 1, COST.reminder, CRON_BUDGET.reminders);
  if (!n) return 0;
  const tasks = await Q.dueReminders(ctx.db, ctx.now, n);
  let sent = 0;
  await Promise.all(
    tasks.map(async (t) => {
      const next = t.repeat ? nextOccurrence(t.remind_at, t.repeat, ctx.now) : null;
      // Claim the reminder first so an overlapping cron run can't send it twice.
      const claim = await ctx.db
        .prepare(`UPDATE tasks SET remind_at = ? WHERE id = ? AND remind_at = ?`)
        .bind(next, t.id, t.remind_at)
        .run();
      if (!claim.meta.changes) return;
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
  const n = affordable(ctx, 1, COST.digest, CRON_BUDGET.digests);
  if (!n) return 0;
  const lp = localParts(ctx.now);
  const key = localDateKey(ctx.now);
  const users = await Q.digestCandidates(ctx.db, lp.hh, key, n);
  let sent = 0;
  await Promise.all(
    users.map(async (u) => {
      const claim = await ctx.db
        .prepare(`UPDATE users SET digest_last = ? WHERE id = ? AND (digest_last IS NULL OR digest_last <> ?)`)
        .bind(key, u.id, key)
        .run();
      if (!claim.meta.changes) return;
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
      else if (transient(r)) await ctx.db.prepare(`UPDATE users SET digest_last = ? WHERE id = ?`).bind(u.digest_last, u.id).run();
    }),
  );
  return sent;
}

async function runBroadcast(ctx) {
  const n = affordable(ctx, COST.broadcastFixed, COST.broadcastItem, CRON_BUDGET.broadcast);
  if (!n) return 0;
  const b = await Q.activeBroadcast(ctx.db);
  if (!b) return 0;
  const targets = await Q.broadcastTargets(ctx.db, b.cursor, n);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    targets.map(async (id) => {
      const r = await ctx.api.call('copyMessage', { chat_id: id, from_chat_id: b.from_chat, message_id: b.message_id });
      if (r.ok) sent += 1;
      else {
        failed += 1;
        if (isBlockedError(r)) await Q.markBlocked(ctx.db, id);
      }
    }),
  );
  const finished = targets.length < n;
  const cursor = targets.length ? targets[targets.length - 1] : b.cursor;
  await Q.updateBroadcast(ctx.db, b.id, cursor, sent, failed, finished ? 'done' : 'running');
  if (finished) {
    const total = await Q.getBroadcast(ctx.db, b.id);
    await ctx.api.send(
      ownerId(ctx.env),
      `📣 <b>ارسال همگانی تمام شد.</b>\n\n✅ موفق: ${fa(total.sent)}\n❌ ناموفق: ${fa(total.failed)}`,
    );
  }
  return sent;
}
