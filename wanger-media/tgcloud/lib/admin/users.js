// Admin › Users (VIEW_USERS to look; MANAGE_USERS and a higher rank than the target to ban, unban,
// set a quota or a note — lib/roles.js#canModerate; nobody can act on the owner). Search by numeric
// id or exact @username. Every change is audit-logged (a note's text is not copied into the log).
import { HISTORY_PAGE, PLATFORM_NAMES } from '../config.js';
import * as admin from '../db/admin.js';
import * as downloads from '../db/downloads.js';
import * as system from '../db/system.js';
import * as users from '../db/users.js';
import { LANG_NAMES, t, tp } from '../i18n/index.js';
import { limitsFrom } from '../policy.js';
import { actorOf, canModerate, canSetRole, isOwnerId, STAFF_ROLES } from '../roles.js';
import * as ui from '../ui.js';
import { clip, tehranDay } from '../util.js';

const actorFor = (row) => actorOf(row.id, row.role ? { role: row.role, perms: row.role_perms } : null);

export function searchPrompt(user) {
  return { view: 'admin_users', input: { k: 'us' }, screen: { text: t(user.lang, 'adm.users.prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } };
}

export async function profileScreen(ctx, user, targetId, notice = null) {
  const lang = user.lang;
  const row = await users.load(targetId);
  if (!row) return { view: 'admin_users', screen: { text: t(lang, 'adm.users.not_found'), reply_markup: ui.markup([ui.navRow(lang, 'A')]) } };
  const target = actorFor(row);
  const s = await system.loadSettings(['limits']);
  const limits = limitsFrom(s.limits && s.limits.value);
  const today = tehranDay(ctx.now);
  const used = row.dl_day === today ? row.dl_count : 0;
  const quota = row.quota_override != null ? row.quota_override : limits.quota_per_day;
  const total = await downloads.countRecent(targetId, 101);
  const recent = await downloads.page(targetId, 0, 5);
  const banned = !isOwnerId(targetId) && row.ban_until != null && (row.ban_until === 0 || row.ban_until > ctx.now);

  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.users.profile', {
    id: row.id, name: row.first_name || '—', username: row.username ? '@' + row.username : '—',
    lang: LANG_NAMES[row.lang] || '—', joined: ui.formatTime(row.created_at), seen: ui.formatTime(row.last_seen_at),
    role: tp(lang, 'role.' + target.role),
  }));
  lines.push(t(lang, row.blocked ? 'adm.users.blocked_yes' : 'adm.users.blocked_no'));
  lines.push(banned
    ? t(lang, row.ban_until === 0 ? 'adm.users.banned_forever' : 'adm.users.banned_until', { date: ui.formatTime(row.ban_until) })
    : t(lang, 'adm.users.not_banned'));
  lines.push(t(lang, row.quota_override != null ? 'adm.users.quota_custom' : 'adm.users.quota', { used, quota }));
  lines.push(t(lang, 'adm.users.downloads', { n: total > 100 ? '100+' : total }));
  for (const d of recent) lines.push(`  ${d.status === 'ok' ? '✅' : d.status === 'failed' ? '❌' : '⛔'} ${ui.formatTime(d.created_at)} · ${PLATFORM_NAMES[d.platform] || d.platform || '?'}`);
  if (row.note) lines.push('', t(lang, 'adm.users.note', { note: row.note }));

  const kb = [];
  if (canModerate(user.actor, target)) {
    kb.push([1, 7, 30, 0].map((d) => ui.button(tp(lang, d ? 'adm.btn.ban_days' : 'adm.btn.ban_forever', { d }), `A:ub:${targetId}:${d}`)));
    if (banned) kb.push([ui.button(tp(lang, 'adm.btn.unban'), `A:uu:${targetId}`)]);
    kb.push([ui.button(tp(lang, 'adm.btn.quota'), `A:uq:${targetId}`), ui.button(tp(lang, 'adm.btn.note'), `A:un:${targetId}`)]);
  }
  if (total) kb.push([ui.button(tp(lang, 'adm.btn.history'), `A:uh:${targetId}:0`)]);
  if (['user', ...STAFF_ROLES].some((r) => r !== target.role && canSetRole(user.actor, target, r))) kb.push([ui.button(tp(lang, 'adm.btn.role'), `A:x:${targetId}`)]);
  kb.push(ui.navRow(lang, 'A:u'));
  return { view: 'admin_user', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

/** Loads the target and checks canModerate; → { row } or a refusal result. */
async function moderatable(user, targetId) {
  const row = await users.load(targetId);
  if (!row) return { refused: t(user.lang, 'adm.users.not_found') };
  if (!canModerate(user.actor, actorFor(row))) return { refused: t(user.lang, 'adm.denied') };
  return { row };
}

export async function ban(ctx, user, targetId, days) {
  const m = await moderatable(user, targetId);
  if (m.refused) return { toast: m.refused, alert: true };
  const until = days ? ctx.now + days * 86400 : 0;
  await admin.ban(targetId, until, null, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'user.ban', String(targetId), { days });
  return { ...(await profileScreen(ctx, user, targetId)), toast: t(user.lang, 'adm.users.banned_ok') };
}

export async function unban(ctx, user, targetId) {
  const m = await moderatable(user, targetId);
  if (m.refused) return { toast: m.refused, alert: true };
  if (await admin.unban(targetId)) await system.audit(ctx.now, user.id, 'user.unban', String(targetId), null);
  return { ...(await profileScreen(ctx, user, targetId)), toast: t(user.lang, 'adm.users.unbanned_ok') };
}

export async function quotaPrompt(user, targetId) {
  const m = await moderatable(user, targetId);
  if (m.refused) return { toast: m.refused, alert: true };
  return { view: 'admin_user', input: { k: 'uq', a: targetId }, screen: { text: t(user.lang, 'adm.users.quota_prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } };
}

export async function notePrompt(user, targetId) {
  const m = await moderatable(user, targetId);
  if (m.refused) return { toast: m.refused, alert: true };
  return { view: 'admin_user', input: { k: 'un', a: targetId }, screen: { text: t(user.lang, 'adm.users.note_prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } };
}

/** Text input for the users section. → a result, or { error } to ask again. */
export async function onInput(ctx, user, k, arg, text) {
  if (k === 'us') {
    const found = await admin.findUser(text);
    if (!found) return { error: t(user.lang, 'adm.users.not_found') };
    return profileScreen(ctx, user, found.id);
  }
  const m = await moderatable(user, arg);
  if (m.refused) return { error: m.refused, done: true };
  const s = String(text || '').trim();
  if (k === 'uq') {
    const q = s === '-' ? null : /^\d{1,5}$/.test(s) && Number(s) <= 10000 ? Number(s) : undefined;
    if (q === undefined) return { error: t(user.lang, 'adm.users.quota_prompt') };
    await admin.setQuotaOverride(arg, q);
    await system.audit(ctx.now, user.id, 'user.quota', String(arg), { quota: q });
    return profileScreen(ctx, user, arg, t(user.lang, 'adm.saved'));
  }
  if (k === 'un') {
    const note = s === '-' ? null : clip(s, 300);
    await admin.setNote(arg, note);
    await system.audit(ctx.now, user.id, 'user.note', String(arg), { length: note ? note.length : 0 });
    return profileScreen(ctx, user, arg, t(user.lang, 'adm.saved'));
  }
  return { error: t(user.lang, 'adm.denied'), done: true };
}

/** A user's download history, for staff. */
export async function historyScreen(user, targetId, page) {
  const lang = user.lang;
  const total = await downloads.countRecent(targetId, 100);
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const p = Math.min(page, pages - 1);
  const items = total ? await downloads.page(targetId, p * HISTORY_PAGE, Math.min(HISTORY_PAGE, total - p * HISTORY_PAGE)) : [];
  const lines = [t(lang, 'adm.users.history', { id: targetId, page: p + 1, pages }), ''];
  for (const d of items) {
    lines.push(`${d.status === 'ok' ? '✅' : d.status === 'failed' ? '❌' : '⛔'} ${ui.formatTime(d.created_at)} · ${PLATFORM_NAMES[d.platform] || d.platform || '?'}`);
    lines.push(ui.customText(clip(d.url || '', 80), ''));
  }
  const pager = [];
  if (p > 0) pager.push(ui.button(tp(lang, 'btn.prev'), `A:uh:${targetId}:${p - 1}`));
  if (p < pages - 1) pager.push(ui.button(tp(lang, 'btn.next'), `A:uh:${targetId}:${p + 1}`));
  return { view: 'admin_user_history', screen: { text: lines.join('\n'), reply_markup: ui.markup([pager, ui.navRow(lang, `A:u:${targetId}`)]) } };
}
