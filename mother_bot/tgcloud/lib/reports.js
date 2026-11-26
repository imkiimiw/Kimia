// Error reports, questions for the team, and reports about abusive users — all are tickets.
//
// Triage of an error report (submitReport), in this order:
//   1. the bot is closed for maintenance        → verdict 'maint': tell the user, they are told when it's back
//   2. the team set a status / an incident is open → verdict 'known': linked to the incident, told when solved
//   3. it looks real: TRIAGE_SAME_REPORTS different users in the window, TRIAGE_ERRORS errors from the bot
//      itself, or its webhook is failing right now → verdict 'bot': an incident is opened, the team alerted
//   4. the catalog's troubleshooting (or the AI, if a key is set) says it's on the user's side and has
//      tips → verdict 'user': the tips, with "✅ solved" / "❌ not solved" (not solved → the team)
//   5. otherwise                                  → verdict 'unclear': the team gets it and answers here
// The team answers in the mother (✉️ پاسخ); the user can answer back; either side can close it.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  REPORTS_PER_DAY, TEXT_MAX, TRIAGE_ERRORS, TRIAGE_FRESH_ERROR_SEC, TRIAGE_SAME_REPORTS, TRIAGE_WINDOW_SEC,
} from './config.js';
import { generate, ready } from './ai.js';
import { bumpDay } from './activity.js';
import {
  STATUS, botTitle, effectiveStatus, getBot, matchFixes,
} from './catalog.js';
import { inspect, recentErrorCount } from './health.js';
import {
  bumpIncidentReports, openIncident, openIncidentOf, watch,
} from './incidents.js';
import { flagAbuse } from './moderation.js';
import { logChat, notifyTeam } from './notify.js';
import { teamIds } from './store.js';
import {
  btn, copy, describeError, send,
} from './tg.js';
import {
  ago, esc, fa, formatDate, nowSec, truncate,
} from './util.js';

export const VERDICTS = {
  maint: '🔧 در حال تعمیر',
  known: '🟡 مشکل شناخته‌شده',
  bot: '🚨 مشکل از ربات (تأییدشده)',
  user: '💡 احتمالاً از سمت کاربر',
  unclear: '❔ نیاز به بررسی',
};
export const TICKET_STATUS = {
  open: '🟠 باز', answered: '💬 پاسخ داده شد', user_side: '💡 راهنمایی شد', resolved: '✅ حل شد', closed: '⚪️ بسته',
};

export async function getTicket(id) {
  return db.get(sql`SELECT * FROM tickets WHERE id = ${Number(id)}`);
}

export async function ticketMessages(id, limit = 6) {
  const rows = await db.all(sql`SELECT * FROM ticket_msgs WHERE ticket_id = ${Number(id)} ORDER BY id DESC LIMIT ${limit}`);
  return rows.reverse();
}

export async function userTickets(userId, limit = 6) {
  return db.all(sql`SELECT * FROM tickets WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`);
}

export async function listTickets(status, offset = 0, limit = 8) {
  return db.all(sql`SELECT * FROM tickets WHERE status = ${status} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`);
}

export async function countTickets(status) {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM tickets WHERE status = ${status} LIMIT 1000)`);
  return Number((r && r.n) || 0);
}

export async function setTicketStatus(id, status) {
  await db.run(sql`UPDATE tickets SET status = ${status}, updated_at = ${nowSec()} WHERE id = ${Number(id)}`);
}

export async function addTicketMsg(ticketId, fromTeam, authorId, body) {
  await db.run(sql`INSERT INTO ticket_msgs (ticket_id, from_team, author_id, body, at) VALUES (${ticketId}, ${fromTeam ? 1 : 0}, ${authorId}, ${truncate(body, TEXT_MAX)}, ${nowSec()})`);
}

/** Tickets this user opened in the last day (for REPORTS_PER_DAY). */
async function todayCount(userId) {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM tickets WHERE user_id = ${userId} AND created_at > ${nowSec() - 86400} ORDER BY id DESC LIMIT 50)`);
  return Number((r && r.n) || 0);
}

export async function overLimit(user) {
  return (await todayCount(user.user_id)) >= REPORTS_PER_DAY;
}

/** What the user sent: { body, fileId, fileKind } (text or a caption, and a photo/document/video). */
export function messageContent(msg) {
  const body = truncate(String(msg.text || msg.caption || '').trim(), TEXT_MAX);
  if (Array.isArray(msg.photo) && msg.photo.length) return { body, fileId: msg.photo[msg.photo.length - 1].file_id, fileKind: 'photo' };
  for (const kind of ['document', 'video', 'animation', 'voice']) if (msg[kind]) return { body, fileId: msg[kind].file_id, fileKind: kind };
  return { body, fileId: null, fileKind: null };
}

async function createTicket(f) {
  const now = nowSec();
  const r = await db.run(sql`
    INSERT INTO tickets (user_id, bot_key, kind, body, file_id, file_kind, verdict, signals, status, incident_id, target_user, created_at, updated_at)
    VALUES (${f.userId}, ${f.botKey || null}, ${f.kind}, ${f.body || null}, ${f.fileId || null}, ${f.fileKind || null}, ${f.verdict || null},
      ${f.signals ? JSON.stringify(f.signals) : null}, ${f.status || 'open'}, ${f.incidentId || 0}, ${f.targetUser || 0}, ${now}, ${now})
    RETURNING *`);
  return r.rows[0];
}

async function updateTicket(id, f) {
  await db.run(sql`
    UPDATE tickets SET verdict = ${f.verdict}, signals = ${JSON.stringify(f.signals || {})}, status = ${f.status}, incident_id = ${f.incidentId || 0}, updated_at = ${nowSec()}
    WHERE id = ${id}`);
}

/** Distinct users who reported this bot in the window. */
async function recentReporters(botKey) {
  const rows = await db.all(sql`
    SELECT DISTINCT user_id FROM tickets WHERE bot_key = ${botKey} AND kind = 'report' AND created_at > ${nowSec() - TRIAGE_WINDOW_SEC}
    ORDER BY created_at DESC LIMIT 50`);
  return rows.length;
}

const TRIAGE_SCHEMA = {
  type: 'OBJECT',
  properties: { verdict: { type: 'STRING', enum: ['user', 'bot', 'unclear'] }, guidance: { type: 'STRING' } },
  required: ['verdict', 'guidance'],
};

async function aiTriage(user, bot, text) {
  const key = await ready(user);
  if (!key || !text) return null;
  const fixes = bot.fixes.map((f) => `- ${f.p} → ${f.s}`).join('\n') || '(none)';
  const features = bot.features.map((f) => `- ${f.t}: ${f.h}`).join('\n');
  const prompt = `A user reports a problem with the Telegram bot "${bot.name}". Decide if it is most likely on the user's side
(wrong use, private link, not joined channels, old app, network, quota) → "user", a fault of the bot → "bot", or "unclear".
If "user", write short guidance in Persian (Farsi) using ONLY these troubleshooting entries and features; never invent
features. Plain text, at most 6 lines. If not "user", guidance is "".

Troubleshooting:
${fixes}

Features:
${features}

Report: ${truncate(text, 1200)}`;
  const out = await generate(key, user, prompt, TRIAGE_SCHEMA, { temperature: 0.1 });
  if (!out || !['user', 'bot', 'unclear'].includes(out.verdict)) return null;
  return { verdict: out.verdict, guidance: truncate(String(out.guidance || '').trim(), 900) };
}

function teamCard(t, bot, user) {
  const who = user ? `${esc(user.first_name || '')}${user.username ? ` @${esc(user.username)}` : ''} (<code>${t.user_id}</code>)` : `<code>${t.user_id}</code>`;
  const kindName = { report: '🛠 گزارش خطا', question: '❓ سؤال', abuse: '🚨 گزارش کاربر مزاحم' }[t.kind] || t.kind;
  const lines = [`🎫 <b>تیکت #${fa(t.id)}</b> — ${kindName}`];
  if (bot) lines.push(`ربات: ${botTitle(bot)}`);
  lines.push(`از: ${who}`);
  if (t.target_user) lines.push(`کاربر گزارش‌شده: <code>${t.target_user}</code>`);
  if (t.verdict) lines.push(`تشخیص: ${VERDICTS[t.verdict] || t.verdict}`);
  const sig = t.signals ? JSON.parse(t.signals) : null;
  if (sig && sig.notes && sig.notes.length) lines.push(`نشانه‌ها: ${esc(sig.notes.join(' · '))}`);
  if (t.incident_id) lines.push(`اختلال: #${fa(t.incident_id)}`);
  lines.push('', esc(t.body || '(بدون متن)'));
  return lines.join('\n');
}

export function teamKb(t) {
  const rows = [[btn('✉️ پاسخ', `atr:${t.id}`), btn('✅ حل شد', `atx:${t.id}`)]];
  if (t.kind === 'report' && t.bot_key && !t.incident_id) rows.push([btn('🚨 تأیید باگ (اختلال)', `atb:${t.id}`)]);
  rows.push([btn('👤 کاربر', `au:${t.kind === 'abuse' && t.target_user ? t.target_user : t.user_id}`), btn('🎫 تیکت', `ati:${t.id}`)]);
  return rows;
}

/** Posts a ticket to the team, with the attached screenshot/file copied first. */
export async function sendToTeam(ctx, t, user, sourceMsg = null) {
  const bot = t.bot_key ? await getBot(t.bot_key) : null;
  const chat = await logChat();
  const targets = chat ? [chat] : await teamIds();
  for (const to of targets) {
    if (sourceMsg && t.file_id) {
      try {
        await copy(ctx, 'ticket_file', to, sourceMsg.chat.id, sourceMsg.message_id);
      } catch (err) {
        console.warn(`ticket file copy failed: ${describeError(err)}`);
      }
    }
    await send(ctx, 'ticket_team', teamCard(t, bot, user), teamKb(t), to);
  }
}

/**
 * Takes an error report and answers it. `msg` is the user's message (text and/or a screenshot).
 * Returns { ticket, verdict, text, kb } — the reply for the user.
 */
export async function submitReport(ctx, user, botKey, msg) {
  const bot = await getBot(botKey);
  const content = messageContent(msg);
  const t0 = await createTicket({ userId: user.user_id, botKey: bot ? bot.key : null, kind: 'report', ...content, verdict: 'unclear' });
  if (bot) await bumpDay(bot.key, { reports: 1 });
  const notes = [];
  const signals = { notes };
  let verdict = 'unclear';
  let status = 'open';
  let incidentId = 0;
  let reply;
  let kb = [];
  const id = fa(t0.id);
  if (!bot) {
    reply = `📝 گزارش #${id} ثبت شد و برای تیم فرستاده شد. جواب همین‌جا می‌آید.`;
  } else {
    const incident = await openIncidentOf(bot.key);
    const shown = effectiveStatus(bot, incident);
    if (bot.mode === 'closed') {
      verdict = 'maint';
      status = 'closed';
      await watch('bot', bot.key, user.user_id);
      const end = Number(bot.mode_until) ? `\nزمان تقریبی پایان: ${formatDate(bot.mode_until, true)}` : '';
      reply = `🔧 <b>${esc(bot.name)}</b> الان برای تعمیر و به‌روزرسانی بسته است.${bot.mode_msg ? `\n${esc(bot.mode_msg)}` : ''}${end}\n\nمشکل از شما نیست. وقتی دوباره باز شد همین‌جا خبرتان می‌کنیم 🔔`;
    } else if (incident || ['degraded', 'down', 'maint'].includes(bot.status)) {
      verdict = 'known';
      let inc = incident;
      if (!inc) inc = (await openIncident(ctx, bot.key, bot.status_note || STATUS[shown].name, 'manual', { quiet: true })).incident;
      incidentId = inc.id;
      await bumpIncidentReports(inc.id);
      await watch('inc', inc.id, user.user_id);
      reply = `🟡 این مشکل در <b>${esc(bot.name)}</b> را می‌دانیم و تیم در حال رفع آن است${bot.status_note ? `:\n${esc(bot.status_note)}` : '.'}\n\nگزارش شما (#${id}) به آن اضافه شد و وقتی حل شد خبرتان می‌کنیم 🔔`;
    } else {
      const reporters = await recentReporters(bot.key);
      const errs = recentErrorCount(bot);
      let live = null;
      if (bot.token) live = await inspect(bot, ctx);
      if (reporters >= 2) notes.push(`${fa(reporters)} کاربر در ۱ ساعت اخیر`);
      if (errs) notes.push(`${fa(errs)} خطای گزارش‌شده از خود ربات`);
      if (live && live.note) notes.push(live.note);
      if (Number(bot.last_event_at)) notes.push(`آخرین فعالیت ربات ${ago(bot.last_event_at)}`);
      const confirmed = reporters >= TRIAGE_SAME_REPORTS || errs >= TRIAGE_ERRORS || (live && live.state === 'bad');
      if (confirmed) {
        verdict = 'bot';
        const source = live && live.state === 'bad' ? 'health' : errs >= TRIAGE_ERRORS ? 'errors' : 'reports';
        const { incident: inc } = await openIncident(ctx, bot.key, truncate(content.body || 'گزارش کاربران', 120), source);
        incidentId = inc.id;
        await bumpIncidentReports(inc.id);
        await watch('inc', inc.id, user.user_id);
        reply = `🚨 بررسی کردیم: مشکل از سمت <b>${esc(bot.name)}</b> است، نه شما.\nتیم توسعه خبردار شد (گزارش #${id}) و وقتی درست شد همین‌جا خبرتان می‌کنیم 🔔`;
      } else {
        const fresh = bot.err_win && nowSec() - Number(bot.err_win) < TRIAGE_FRESH_ERROR_SEC && errs > 0;
        let tips = matchFixes(content.body, bot).map((f) => `• <b>${esc(f.p)}</b>\n${esc(f.s)}`);
        const ai = !fresh ? await aiTriage(user, bot, content.body) : null;
        if (ai) notes.push(`AI: ${ai.verdict}`);
        if (ai && ai.verdict === 'user' && ai.guidance) tips = [esc(ai.guidance)];
        if (ai && ai.verdict === 'bot') tips = [];
        if (tips.length && !fresh) {
          verdict = 'user';
          status = 'user_side';
          reply = `🔎 بررسی کردیم: <b>${esc(bot.name)}</b> الان درست کار می‌کند و به احتمال زیاد با این کارها مشکل حل می‌شود:\n\n${tips.join('\n\n')}\n\nحل شد؟`;
          kb = [[btn('✅ حل شد', `rok:${t0.id}`), btn('❌ حل نشد، به تیم بفرست', `rno:${t0.id}`)]];
        } else {
          if (fresh) notes.push('خطای تازه از ربات');
          reply = `📝 گزارش #${id} ثبت شد و برای تیم توسعه فرستاده شد.\nبعد از بررسی، جواب همین‌جا می‌آید.`;
        }
      }
    }
  }
  await updateTicket(t0.id, { verdict, signals, status, incidentId });
  const t = await getTicket(t0.id);
  if (verdict === 'unclear' || verdict === 'bot') await sendToTeam(ctx, t, user, msg);
  kb.push([btn('🎫 گزارش‌های من', 'tl'), btn('🏠 منو', 'm')]);
  return {
    ticket: t, verdict, text: reply, kb,
  };
}

/** "❌ not solved": the guidance didn't help, the team gets it. */
export async function escalate(ctx, user, ticketId) {
  const t = await getTicket(ticketId);
  if (!t || t.user_id !== user.user_id) return null;
  if (t.status !== 'user_side') return t;
  await db.run(sql`UPDATE tickets SET status = 'open', verdict = 'unclear', updated_at = ${nowSec()} WHERE id = ${t.id}`);
  const fresh = await getTicket(t.id);
  await sendToTeam(ctx, fresh, user);
  return fresh;
}

/** A question the assistant couldn't answer, sent to the team. */
export async function submitQuestion(ctx, user, text, botKey = null) {
  const t = await createTicket({ userId: user.user_id, botKey, kind: 'question', body: truncate(text, TEXT_MAX) });
  await sendToTeam(ctx, t, user);
  return t;
}

/** A user reports another user. */
export async function submitAbuse(ctx, user, targetId, msg, botKey = null) {
  const content = messageContent(msg);
  const t = await createTicket({ userId: user.user_id, botKey, kind: 'abuse', ...content, targetUser: targetId });
  await flagAbuse(ctx, { userId: targetId, botKey, source: 'user', reason: 'گزارش کاربر', detail: content.body, reporterId: user.user_id });
  await sendToTeam(ctx, t, user, msg);
  return t;
}

/** The team answers a ticket: the user gets it with "reply" / "solved" buttons. */
export async function teamReply(ctx, teamUser, ticketId, text) {
  const t = await getTicket(ticketId);
  if (!t) return false;
  await addTicketMsg(t.id, true, teamUser.user_id, text);
  const sent = await send(ctx, 'ticket_answer', `💬 <b>پاسخ تیم Wanger</b> به گزارش #${fa(t.id)}:\n\n${esc(text)}`,
    [[btn('✉️ جواب بده', `tr:${t.id}`), btn('✅ مشکل حل شد', `tk:${t.id}`)]], t.user_id);
  if (sent) await setTicketStatus(t.id, 'answered');
  return !!sent;
}

/** The user answers the team. */
export async function userReply(ctx, user, ticketId, msg) {
  const t = await getTicket(ticketId);
  if (!t || t.user_id !== user.user_id) return false;
  const content = messageContent(msg);
  await addTicketMsg(t.id, false, user.user_id, content.body || '(فایل)');
  await setTicketStatus(t.id, 'open');
  const chat = await logChat();
  const targets = chat ? [chat] : await teamIds();
  for (const to of targets) {
    if (content.fileId) {
      try {
        await copy(ctx, 'ticket_file', to, msg.chat.id, msg.message_id);
      } catch {
        // the text still goes
      }
    }
    await send(ctx, 'ticket_user_reply', `↩️ <b>جواب کاربر</b> در تیکت #${fa(t.id)} (<code>${user.user_id}</code>):\n\n${esc(content.body || '(فایل)')}`, teamKb(t), to);
  }
  return true;
}

/** Closes a ticket (team: resolved, the user is told; user: they said it's solved). */
export async function closeTicket(ctx, ticketId, { byTeam = false } = {}) {
  const t = await getTicket(ticketId);
  if (!t || t.status === 'resolved' || t.status === 'closed') return false;
  await setTicketStatus(t.id, 'resolved');
  if (byTeam) await send(ctx, 'ticket_closed', `✅ گزارش #${fa(t.id)} بررسی و بسته شد. ممنون که خبر دادید 🙏`, [[btn('🏠 منو', 'm')]], t.user_id);
  return true;
}

/** The team confirms a report as a bug: an incident (or the open one), the reporter watches it. */
export async function confirmBug(ctx, ticketId) {
  const t = await getTicket(ticketId);
  if (!t || !t.bot_key) return null;
  const { incident } = await openIncident(ctx, t.bot_key, truncate(t.body || 'تأیید تیم', 120), 'manual', { quiet: true });
  await db.run(sql`UPDATE tickets SET incident_id = ${incident.id}, verdict = 'bot', updated_at = ${nowSec()} WHERE id = ${t.id}`);
  await bumpIncidentReports(incident.id);
  await watch('inc', incident.id, t.user_id);
  await send(ctx, 'ticket_confirmed', `🚨 تیم بررسی کرد: مشکلی که در گزارش #${fa(t.id)} گفتید واقعی است و در حال رفع آن هستیم. وقتی درست شد خبرتان می‌کنیم 🔔`, null, t.user_id);
  return incident;
}

export const reportNotify = notifyTeam;
