// Health of the child bots, from three sources:
//   1. errors the child reports through the hub (k: "err"), folded by signature (errors table) and
//      posted to the team's log chat at most once per ERROR_ALERT_EVERY_SEC per signature;
//   2. the child's webhook, read with its token (getWebhookInfo): pending updates and the last delivery
//      error Telegram saw — the bot being down shows up here first;
//   3. silence: a bot that should report regularly (silence_min > 0, e.g. the news bot's scheduled runs)
//      and hasn't for that long.
// A bot that turns 'bad' gets an incident (source 'health') and the team an alert; when it is 'ok'
// again the incident is resolved, which tells the watchers. Checks run on the side of updates
// (HEALTH_PER_UPDATE bots, each at most every HEALTH_EVERY_SEC) and from endpoints/tick.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  ERROR_ALERT_EVERY_SEC, HEALTH_ERROR_RECENT_SEC, HEALTH_EVERY_SEC, HEALTH_PENDING_BAD, HEALTH_PENDING_WARN,
  HEALTH_PER_UPDATE, TRIAGE_WINDOW_SEC,
} from './config.js';
import { bumpDay } from './activity.js';
import { botTitle, getBot, updateBot } from './catalog.js';
import { childCall } from './children.js';
import { openIncident, openIncidentOf, resolveIncident } from './incidents.js';
import { notifyTeam } from './notify.js';
import { btn } from './tg.js';
import {
  ago, esc, fa, nowSec, truncate,
} from './util.js';

/** Errors from a child: [[signature, text, count], ...]. Posts new signatures to the team. */
export async function recordErrors(ctx, bot, list) {
  const now = nowSec();
  let total = 0;
  const alerts = [];
  for (const e of list.slice(0, 30)) {
    if (!Array.isArray(e)) continue;
    const sig = truncate(String(e[0] || 'error'), 120);
    const body = truncate(String(e[1] || sig), 500);
    const n = Math.max(1, Math.min(100000, Number(e[2]) || 1));
    total += n;
    const r = await db.run(sql`
      INSERT INTO errors (bot_key, sig, body, count, first_at, last_at) VALUES (${bot.key}, ${sig}, ${body}, ${n}, ${now}, ${now})
      ON CONFLICT(bot_key, sig) DO UPDATE SET count = count + excluded.count, body = excluded.body, last_at = excluded.last_at
      RETURNING id, count, alerted_at`);
    const row = r.rows[0];
    if (row && Number(row.alerted_at) <= now - ERROR_ALERT_EVERY_SEC) {
      await db.run(sql`UPDATE errors SET alerted_at = ${now} WHERE id = ${row.id}`);
      alerts.push({ sig, body, count: Number(row.count) });
    }
  }
  if (!total) return 0;
  await db.run(sql`
    UPDATE bots SET
      err_count = CASE WHEN err_win <= ${now - TRIAGE_WINDOW_SEC} THEN ${total} ELSE err_count + ${total} END,
      err_win = CASE WHEN err_win <= ${now - TRIAGE_WINDOW_SEC} THEN ${now} ELSE err_win END
    WHERE key = ${bot.key}`);
  await bumpDay(bot.key, { errors: total });
  if (alerts.length) {
    const lines = alerts.slice(0, 5).map((a) => `• <code>${esc(truncate(a.sig, 80))}</code> ×${fa(a.count)}\n  ${esc(truncate(a.body, 200))}`);
    await notifyTeam(ctx, 'child_error', `⚠️ <b>خطا در ${botTitle(bot)}</b>\n\n${lines.join('\n')}`, [[btn('🩺 سلامت ربات', `ah:${bot.key}`)]], { silent: true });
  }
  return total;
}

/** Errors the child reported in the current window (for the report triage). */
export function recentErrorCount(bot) {
  return Number(bot.err_win || 0) > nowSec() - TRIAGE_WINDOW_SEC ? Number(bot.err_count || 0) : 0;
}

export async function lastErrors(botKey, limit = 5) {
  return db.all(sql`SELECT * FROM errors WHERE bot_key = ${botKey} ORDER BY last_at DESC LIMIT ${limit}`);
}

/**
 * Looks at one bot now: { state: ok|warn|bad|unknown, note, webhook }. Does not store anything.
 */
export async function inspect(bot, ctx = null) {
  const now = nowSec();
  const notes = [];
  let state = 'unknown';
  let webhook = null;
  if (bot.token) {
    try {
      webhook = await childCall(bot, 'getWebhookInfo', {}, ctx, 'health');
      state = 'ok';
      const pending = Number(webhook.pending_update_count || 0);
      const lastErr = Number(webhook.last_error_date || 0);
      if (lastErr && now - lastErr <= HEALTH_ERROR_RECENT_SEC) {
        state = pending >= HEALTH_PENDING_WARN ? 'bad' : 'warn';
        notes.push(`خطای وبهوک ${ago(lastErr, now)}: ${truncate(webhook.last_error_message || '', 120)}`);
      }
      if (pending >= HEALTH_PENDING_BAD) {
        state = 'bad';
        notes.push(`${fa(pending)} آپدیت در صف`);
      } else if (pending >= HEALTH_PENDING_WARN && state === 'ok') {
        state = 'warn';
        notes.push(`${fa(pending)} آپدیت در صف`);
      }
    } catch (err) {
      if (err.code === 401 || err.code === 404) {
        state = 'bad';
        notes.push('توکن رد شد (عوض شده یا ربات حذف شده)');
      } else {
        notes.push(`بررسی وبهوک نشد (${truncate(err.description || 'network', 60)})`);
      }
    }
  }
  if (Number(bot.silence_min) > 0 && Number(bot.last_event_at) > 0) {
    const silent = now - Number(bot.last_event_at);
    if (silent > Number(bot.silence_min) * 60) {
      state = 'bad';
      notes.push(`از ${ago(bot.last_event_at, now)} هیچ گزارشی از ربات نرسیده`);
    } else if (state === 'unknown') {
      state = 'ok';
    }
  }
  return { state, note: notes.join(' · '), webhook };
}

/** Checks a bot, stores the result, alerts on changes, opens/resolves the health incident. */
export async function checkBot(ctx, bot) {
  const r = await inspect(bot, ctx);
  const now = nowSec();
  await updateBot(bot.key, { health: r.state, health_note: r.note || null, health_at: now });
  const prev = bot.health_alert || 'ok';
  const alertState = r.state === 'bad' ? 'bad' : r.state === 'unknown' ? prev : 'ok';
  if (alertState !== prev) {
    await updateBot(bot.key, { health_alert: alertState });
    if (alertState === 'bad') {
      await notifyTeam(ctx, 'health_bad', `🔴 <b>${botTitle(bot)} مشکل دارد</b>\n${esc(r.note || '')}`, [[btn('🩺 جزئیات', `ah:${bot.key}`)]]);
      await openIncident(ctx, bot.key, r.note || 'بررسی خودکار سلامت', 'health', { quiet: true });
    } else {
      await notifyTeam(ctx, 'health_ok', `🟢 ${botTitle(bot)} دوباره سالم است.`, null, { silent: true });
      const inc = await openIncidentOf(bot.key);
      if (inc && inc.source === 'health') await resolveIncident(ctx, inc.id);
    }
  }
  return r;
}

/** Health checks due on the side of an update: the bots checked longest ago, each claimed once. */
export async function healthDue(ctx, limit = HEALTH_PER_UPDATE) {
  const now = nowSec();
  const rows = await db.all(sql`
    SELECT key, health_at FROM bots WHERE (token IS NOT NULL OR silence_min > 0) AND health_at <= ${now - HEALTH_EVERY_SEC}
    ORDER BY health_at LIMIT ${limit}`);
  let n = 0;
  for (const row of rows) {
    const claimed = await db.run(sql`UPDATE bots SET health_at = ${now} WHERE key = ${row.key} AND health_at = ${row.health_at}`);
    if (!claimed.rowsAffected) continue;
    const bot = await getBot(row.key);
    if (bot) {
      await checkBot(ctx, bot);
      n += 1;
    }
  }
  return n;
}
