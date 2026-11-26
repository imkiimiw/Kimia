// Incidents: a confirmed problem with one bot. Opened by the report triage (several users, errors from
// the bot), by the health check, or by the team. While one is open the bot shows 🟡 on the status board
// and new reports about it are answered with "we know, the team is on it". Everyone who reported it or
// pressed "tell me when it works" is a watcher and gets a message when it is resolved.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { createBroadcast, startBroadcast } from './broadcast.js';
import { botTitle, getBot } from './catalog.js';
import { KIND } from './news.js';
import { notifyTeam } from './notify.js';
import { btn } from './tg.js';
import { esc, fa, nowSec } from './util.js';

export async function openIncidentOf(botKey) {
  return db.get(sql`SELECT * FROM incidents WHERE bot_key = ${botKey} AND status = 'open' ORDER BY id DESC LIMIT 1`);
}

export async function getIncident(id) {
  return db.get(sql`SELECT * FROM incidents WHERE id = ${Number(id)}`);
}

export async function listIncidents(status = 'open', limit = 10) {
  return db.all(sql`SELECT * FROM incidents WHERE status = ${status} ORDER BY id DESC LIMIT ${limit}`);
}

/** Opens an incident (or returns the open one). { incident, created }. */
export async function openIncident(ctx, botKey, title, source, { quiet = false } = {}) {
  const open = await openIncidentOf(botKey);
  if (open) return { incident: open, created: false };
  const now = nowSec();
  const r = await db.run(sql`
    INSERT INTO incidents (bot_key, title, status, source, started_at) VALUES (${botKey}, ${String(title || '').slice(0, 200)}, 'open', ${source}, ${now})
    RETURNING *`);
  const incident = r.rows[0];
  const bot = await getBot(botKey);
  if (!quiet && bot) {
    await notifyTeam(ctx, 'incident_open', `🚨 <b>اختلال تأییدشده #${fa(incident.id)}</b>\n${botTitle(bot)}\nمنبع: ${esc(sourceName(source))}\n${esc(incident.title || '')}`,
      [[btn('👁 مشاهده', `aii:${incident.id}`), btn('✅ حل شد', `aix:${incident.id}`)]]);
  }
  return { incident, created: true };
}

export const sourceName = (s) => ({
  reports: 'گزارش چند کاربر', health: 'بررسی خودکار سلامت', manual: 'تیم', errors: 'خطاهای خود ربات',
}[s] || s || '—');

export async function bumpIncidentReports(id) {
  await db.run(sql`UPDATE incidents SET reports = reports + 1 WHERE id = ${id}`);
}

/** Adds a watcher; kind 'inc' (ref = incident id) or 'bot' (ref = bot key: end of maintenance). */
export async function watch(kind, ref, userId) {
  const r = await db.run(sql`
    INSERT INTO watchers (kind, ref, user_id, at) VALUES (${kind}, ${String(ref)}, ${userId}, ${nowSec()})
    ON CONFLICT(kind, ref, user_id) DO NOTHING`);
  return r.rowsAffected > 0;
}

export async function clearWatchers(kind, ref) {
  await db.run(sql`DELETE FROM watchers WHERE kind = ${kind} AND ref = ${String(ref)}`);
}

/**
 * Tells watchers (and the bot's status-news subscribers) that a bot works again, as a queued broadcast.
 * The watchers are moved to the broadcast (kind 'bc', ref = its id), so new watchers of the next
 * problem start fresh and nobody is told twice; lib/due.js deletes them when the broadcast is done.
 */
export async function noticeBack(bot, watchKind, ref, extra = '') {
  const html = `✅ <b>${esc(bot.name)}</b> دوباره درست کار می‌کند.${extra ? `\n${extra}` : ''}\n\nممنون از صبرتان 🙏`;
  const kb = bot.username ? [[{ text: `🚀 باز کردن ${bot.name}`, url: `https://t.me/${bot.username}` }]] : null;
  const id = await createBroadcast({ kind: 'notice', title: `${bot.name}: رفع مشکل`, content: { html, kb }, audiences: [], start: false });
  await db.run(sql`UPDATE watchers SET kind = 'bc', ref = ${String(id)} WHERE kind = ${watchKind} AND ref = ${String(ref)}`);
  await db.run(sql`UPDATE broadcasts SET audiences = ${JSON.stringify([`w:bc:${id}`, `s:${bot.key}:${KIND.STATUS}`])} WHERE id = ${id}`);
  await startBroadcast(id);
  return id;
}

/** Resolves an incident and queues the notices. Returns false if it was not open. */
export async function resolveIncident(ctx, id, { note = '' } = {}) {
  const now = nowSec();
  const r = await db.run(sql`UPDATE incidents SET status = 'resolved', resolved_at = ${now} WHERE id = ${Number(id)} AND status = 'open' RETURNING *`);
  if (!r.rowsAffected) return false;
  const inc = r.rows[0];
  const bot = await getBot(inc.bot_key);
  // tickets linked to it are resolved with it
  await db.run(sql`UPDATE tickets SET status = 'resolved', updated_at = ${now} WHERE incident_id = ${inc.id} AND status IN ('open', 'answered')`);
  if (bot) {
    await noticeBack(bot, 'inc', inc.id, note ? esc(note) : '');
    await notifyTeam(ctx, 'incident_resolved', `✅ اختلال #${fa(inc.id)} (${botTitle(bot)}) حل شد.`, null, { silent: true });
  }
  return true;
}
