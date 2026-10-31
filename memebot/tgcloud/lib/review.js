/*
 * Moderation (Phase 2): the approval queue, reported memes, users' own reports, and bans.
 *
 * Cards: the meme itself with its details as caption and the action buttons under it (a sticker
 * can't have a caption, so it is followed by a text message that carries the details and buttons).
 * After an action the buttons are replaced by one status label ("✅ Approved — name") and the next
 * card is sent, so an admin can work through the queue. Every state change is compare-and-set in
 * lib/adminstore.js: a second admin pressing the same button gets "already handled".
 * Uploaders are told when their meme is approved, rejected, or removed after reports.
 *
 * callback_data (admins; checked in lib/router.js):
 *   a:q | a:qs:<id>           next pending meme (after id)          a:ok:<id> | a:no:<id>  approve / reject
 *   a:nb:<id> → a:nby:<id>    reject + ban the uploader (confirm)    a:qk:<id>              back to the card's buttons
 *   a:r | a:rs:<id>           next reported meme (after id)         a:rk:<id> | a:rd:<id>  keep / remove
 *   a:rb:<id> → a:rby:<id>    remove + ban the uploader (confirm)    a:rq:<id>              back to the card's buttons
 * callback_data (users): rp:<id> → choose a reason → rp:<id>:<reason> | rp:<id>:x (cancel)
 */
import { APPROVED, HIDDEN, PENDING, REJECTED, REPORT_REASONS, REPORTS_PER_DAY } from './config.js';
import * as admin from './adminstore.js';
import { memePublished, memeRemoved } from './backup.js';
import { notifyAdmins, roleOf } from './bot.js';
import { existingKeyboard } from './collection.js';
import { ago, langOf, num, t } from './i18n.js';
import * as store from './store.js';
import { answer, captionable, editKeyboard, send, sendMeme } from './tg.js';
import { cut, esc, iso, tehranDay } from './util.js';

/* ---------- shared ---------- */

export function who(lang, u) {
  const name = iso(cut(u.first_name || '—', 40));
  return `${name}${u.username ? ` @${esc(u.username)}` : ''} · <code>${u.uploader_id || u.id}</code>`;
}

const label = (text) => [[{ text, callback_data: 'nop' }]];

async function tellUser(ctx, uid, key, vars, extraKey = null) {
  const u = await store.getUser(uid);
  if (!u || u.blocked) return;
  const lang = langOf(u, null);
  const text = t(lang, key, vars) + (extraKey ? `\n\n${t(lang, extraKey)}` : '');
  await send(ctx, `tell.${key}`, text, null, { chatId: uid });
}

/* Sends a card; returns the id of the message that holds the buttons. */
async function sendCard(ctx, view, m, text, kb) {
  if (captionable(m.kind)) {
    const r = await sendMeme(ctx, view, ctx.chatId, m.kind, m.file_id, text, kb).catch(() => null);
    if (r) return r.message_id;
    const fallback = await send(ctx, view, text, kb);
    return fallback && fallback.message_id;
  }
  const media = await sendMeme(ctx, view, ctx.chatId, m.kind, m.file_id, null, null).catch(() => null);
  const r = await send(ctx, view, text, kb, media ? { replyTo: media.message_id } : {});
  return r && r.message_id;
}

/* Bans a user and rejects their memes waiting for approval. Returns { changed, rejected }. */
export async function banUser(uid, by, nowSec) {
  const changed = await admin.setBanned(uid, true);
  const rejected = await admin.rejectAllOf(uid, [PENDING], by, nowSec);
  return { changed, rejected };
}

/* ---------- approval queue ---------- */

/* Moderators (role 'mod') approve and reject; only the owner and admins can also ban. */
const queueKeyboard = (lang, id, role) => [
  [{ text: t(lang, 'adm.approve'), callback_data: `a:ok:${id}` }, { text: t(lang, 'adm.reject'), callback_data: `a:no:${id}` }],
  role === 'mod'
    ? [{ text: t(lang, 'adm.skip'), callback_data: `a:qs:${id}` }]
    : [{ text: t(lang, 'adm.reject_ban'), callback_data: `a:nb:${id}` }, { text: t(lang, 'adm.skip'), callback_data: `a:qs:${id}` }],
];

export async function showQueue(ctx, afterId, nowSec, role = 'admin') {
  const m = await admin.nextPending(afterId);
  if (!m) {
    await send(ctx, 'adm.queue_empty', t(ctx.lang, afterId ? 'adm.queue_end' : 'adm.queue_empty'), [[{ text: t(ctx.lang, 'adm.back'), callback_data: 'a:p' }]]);
    return;
  }
  const text = t(ctx.lang, 'adm.queue_card', { id: String(m.id), kw: iso(m.keywords), who: who(ctx.lang, m), approved: m.approved_n || 0, ago: ago(ctx.lang, m.created_at, nowSec) });
  await sendCard(ctx, 'adm.queue_card', m, text, queueKeyboard(ctx.lang, m.id, role));
}

/* a:ok / a:no */
export async function decide(ctx, from, id, approve, cardId, settings, nowSec, role = 'admin') {
  const done = await admin.review(id, [PENDING], approve ? APPROVED : REJECTED, from.id, nowSec);
  if (!done) {
    await answer(ctx, t(ctx.lang, 'adm.done_already'), true);
    return;
  }
  const name = cut(from.first_name || String(from.id), 24);
  await editKeyboard(ctx, 'adm.card.done', cardId, label(t(ctx.lang, approve ? 'adm.approved_by' : 'adm.rejected_by', { name })));
  await answer(ctx, t(ctx.lang, approve ? 'adm.approved_by' : 'adm.rejected_by', { name }));
  if (approve) {
    await memePublished(ctx, id, nowSec);
    const n = await admin.incApproved(done.uploader_id);
    const trusted = settings.trust > 0 && n === settings.trust;
    await tellUser(ctx, done.uploader_id, 'mod.approved', { kw: iso(done.keywords) }, trusted ? 'mod.trusted' : null);
  } else {
    await tellUser(ctx, done.uploader_id, 'mod.rejected', { kw: iso(done.keywords) });
  }
  await showQueue(ctx, id, nowSec, role);
}

/* a:nb (ask) / a:qk (back) on a queue card; a:rb / a:rq on a report card. */
export async function askBan(ctx, id, cardId, yesCode, backCode) {
  await editKeyboard(ctx, 'adm.card.confirm', cardId, [[
    { text: t(ctx.lang, 'adm.confirm_ban'), callback_data: `a:${yesCode}:${id}` },
    { text: t(ctx.lang, 'adm.cancel'), callback_data: `a:${backCode}:${id}` },
  ]]);
  await answer(ctx);
}

export async function restoreQueueCard(ctx, id, cardId, role = 'admin') {
  await editKeyboard(ctx, 'adm.card', cardId, queueKeyboard(ctx.lang, id, role));
  await answer(ctx);
}

/* a:nby: reject this meme and ban its uploader (their other waiting memes are rejected too). */
export async function rejectAndBan(ctx, from, id, cardId, nowSec) {
  const m = await store.memeById(id);
  if (!m || m.status !== PENDING) return void (await answer(ctx, t(ctx.lang, 'adm.done_already'), true));
  if (await isProtected(m.uploader_id)) return void (await answer(ctx, t(ctx.lang, 'adm.cant_ban_admin'), true));
  await banUser(m.uploader_id, from.id, nowSec);
  const name = cut(from.first_name || String(from.id), 24);
  await editKeyboard(ctx, 'adm.card.done', cardId, label(t(ctx.lang, 'adm.banned_by', { name })));
  await answer(ctx, t(ctx.lang, 'adm.banned_by', { name }));
  await showQueue(ctx, id, nowSec);
}

/* The owner and admins can't be banned (remove an admin first). */
export async function isProtected(uid) {
  return !!(await roleOf(uid));
}

/* ---------- reported memes ---------- */

const reportKeyboard = (lang, id) => [
  [{ text: t(lang, 'adm.keep'), callback_data: `a:rk:${id}` }, { text: t(lang, 'adm.remove'), callback_data: `a:rd:${id}` }],
  [{ text: t(lang, 'adm.remove_ban'), callback_data: `a:rb:${id}` }, { text: t(lang, 'adm.skip'), callback_data: `a:rs:${id}` }],
];

export async function showReports(ctx, afterId, nowSec) {
  const m = await admin.nextReported(afterId);
  if (!m) {
    await send(ctx, 'adm.reports_empty', t(ctx.lang, afterId ? 'adm.reports_end' : 'adm.reports_empty'), [[{ text: t(ctx.lang, 'adm.back'), callback_data: 'a:p' }]]);
    return;
  }
  const reasons = (await admin.reportReasons(m.id)).map((r) => `${t(ctx.lang, `report.reason.${r.reason}`)} ${num(ctx.lang, r.n)}`).join(' · ');
  const text = t(ctx.lang, 'adm.report_card', {
    n: m.reports, id: String(m.id), status: t(ctx.lang, `status.${m.status}`), kw: iso(m.keywords), reasons, who: who(ctx.lang, m), ago: ago(ctx.lang, m.created_at, nowSec),
  });
  await sendCard(ctx, 'adm.report_card', m, text, reportKeyboard(ctx.lang, m.id));
}

export async function restoreReportCard(ctx, id, cardId) {
  await editKeyboard(ctx, 'adm.card', cardId, reportKeyboard(ctx.lang, id));
  await answer(ctx);
}

/* a:rk (keep) / a:rd (remove) / a:rby (remove + ban). */
export async function resolve(ctx, from, id, action, cardId, nowSec) {
  const m = await store.memeById(id);
  if (action === 'ban' && m && (await isProtected(m.uploader_id))) return void (await answer(ctx, t(ctx.lang, 'adm.cant_ban_admin'), true));
  const done = await admin.resolveReports(id, action === 'keep', from.id, nowSec);
  if (!done) return void (await answer(ctx, t(ctx.lang, 'adm.done_already'), true));
  if (action === 'ban') await banUser(done.uploader_id, from.id, nowSec);
  if (action !== 'keep') {
    await memeRemoved(ctx, m);
    await tellUser(ctx, done.uploader_id, 'mod.removed', { kw: iso(done.keywords) });
  }
  const name = cut(from.first_name || String(from.id), 24);
  const key = { keep: 'adm.kept_by', remove: 'adm.removed_by', ban: 'adm.banned_by' }[action];
  await editKeyboard(ctx, 'adm.card.done', cardId, label(t(ctx.lang, key, { name })));
  await answer(ctx, t(ctx.lang, key, { name }));
  await showReports(ctx, id, nowSec);
}

/* ---------- users reporting a meme (they sent or forwarded it to the bot) ---------- */

/* rp:<id> — show the reasons on the same message. */
export async function pickReason(ctx, user, id, msgId) {
  const m = await store.memeById(id);
  if (!m || m.status !== APPROVED || m.uploader_id === user.id) return void (await answer(ctx, t(ctx.lang, m && m.uploader_id === user.id ? 'report.own' : 'report.gone'), true));
  const kb = [];
  for (let i = 0; i < REPORT_REASONS.length; i += 2) {
    kb.push(REPORT_REASONS.slice(i, i + 2).map((r) => ({ text: t(ctx.lang, `report.reason.${r}`), callback_data: `rp:${id}:${r}` })));
  }
  kb.push([{ text: t(ctx.lang, 'report.cancel'), callback_data: `rp:${id}:x` }]);
  await editKeyboard(ctx, 'report.reasons', msgId, kb);
  await answer(ctx, t(ctx.lang, 'report.pick'));
}

/* rp:<id>:<reason> — file the report; enough distinct reports hide the meme until reviewed. */
export async function fileReport(ctx, user, id, reason, msgId, settings, nowSec) {
  const m = await store.memeById(id);
  const restore = async (withReport) => editKeyboard(ctx, 'report.keyboard', msgId, m ? existingKeyboard(ctx.lang, m, user.id, await store.isFav(user.id, id), withReport) : null);
  if (reason === 'x') {
    await restore(true);
    return answer(ctx);
  }
  if (!REPORT_REASONS.includes(reason)) return answer(ctx);
  if (!m || (m.status !== APPROVED && m.status !== HIDDEN) || m.uploader_id === user.id) return answer(ctx, t(ctx.lang, 'report.gone'), true);
  if (!(await admin.consumeReport(user.id, tehranDay(nowSec), REPORTS_PER_DAY))) return answer(ctx, t(ctx.lang, 'report.limit'), true);
  const count = await admin.addReport(id, user.id, reason, nowSec);
  await restore(false);
  if (count === null) return answer(ctx, t(ctx.lang, 'report.again'), true);
  if (settings.hide > 0 && count >= settings.hide) await admin.hideReported(id, nowSec);
  await answer(ctx, t(ctx.lang, 'report.done'), true);
  const open = await admin.countReported();
  await notifyAdmins(ctx, 'reports', (lang) => [t(lang, 'notify.reports', { n: open }), [[{ text: t(lang, 'adm.reports_btn', { n: open }), callback_data: 'a:r' }]]], nowSec, false);
}
