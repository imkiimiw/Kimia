// Admin › Staff (MANAGE_ADMINS). Roles and flags come from lib/roles.js: SUPER_ADMIN is granted and
// revoked by the owner only; others hand out roles strictly below their own, to people below them;
// per-person flags can only narrow a role's defaults. The owner is not stored and can't be changed.
import * as admin from '../db/admin.js';
import * as system from '../db/system.js';
import * as users from '../db/users.js';
import { t, tp } from '../i18n/index.js';
import { actorOf, canSetRole, outranks, P, ROLE_DEFAULTS, STAFF_ROLES, can } from '../roles.js';
import * as ui from '../ui.js';
import { OWNER_ID } from '../config.js';

const FLAG_NAMES = Object.keys(P); // bit i = 1 << i, in P's order
const actorFor = (row) => actorOf(row.id, row.role ? { role: row.role, perms: row.role_perms } : null);

export async function listScreen(user, notice = null) {
  const lang = user.lang;
  const list = await admin.staffList();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.staff.title'), '', t(lang, 'adm.staff.owner', { id: OWNER_ID }));
  const kb = [];
  for (const r of list) {
    const name = r.username ? '@' + r.username : r.first_name || String(r.user_id);
    kb.push([ui.button(`${tp(lang, 'role.' + r.role)} · ${name}`, 'A:x:' + r.user_id)]);
  }
  if (!list.length) lines.push(t(lang, 'adm.staff.empty'));
  kb.push([ui.button(tp(lang, 'adm.btn.add_staff'), 'A:xa')]);
  kb.push(ui.navRow(lang, 'A'));
  return { view: 'admin_staff', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export async function memberScreen(user, targetId, notice = null) {
  const lang = user.lang;
  const row = await users.load(targetId);
  if (!row) return { view: 'admin_staff', screen: { text: t(lang, 'adm.users.not_found'), reply_markup: ui.markup([ui.navRow(lang, 'A:x')]) } };
  const target = actorFor(row);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.staff.member', { id: targetId, name: row.first_name || '—', username: row.username ? '@' + row.username : '—', role: tp(lang, 'role.' + target.role) }));
  const kb = [];
  const roleButtons = ['super_admin', ...STAFF_ROLES.filter((r) => r !== 'super_admin'), 'user']
    .filter((r) => r !== target.role && canSetRole(user.actor, target, r))
    .map((r) => ui.button((r === 'user' ? '🗑 ' : '→ ') + tp(lang, 'role.' + r), `A:xr:${targetId}:${r}`));
  for (let i = 0; i < roleButtons.length; i += 2) kb.push(roleButtons.slice(i, i + 2));
  if (target.role !== 'user') {
    const editable = can(user.actor, P.MANAGE_ADMINS) && outranks(user.actor, target);
    lines.push('', t(lang, 'adm.staff.flags'));
    FLAG_NAMES.forEach((name, bit) => {
      const flag = P[name];
      if (!(ROLE_DEFAULTS[target.role] & flag)) return;
      const on = (target.perms & flag) === flag;
      lines.push(`${on ? '✅' : '⬜'} ${tp(lang, 'perm.' + name)}`);
      if (editable) kb.push([ui.button(`${on ? '✅' : '⬜'} ${tp(lang, 'perm.' + name)}`, `A:xf:${targetId}:${bit}`)]);
    });
  }
  kb.push(ui.navRow(lang, 'A:x'));
  return { view: 'admin_staff_member', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export async function setRole(ctx, user, targetId, role) {
  const row = await users.load(targetId);
  if (!row) return { toast: t(user.lang, 'adm.users.not_found'), alert: true };
  const target = actorFor(row);
  if (!canSetRole(user.actor, target, role)) return { toast: t(user.lang, 'adm.denied'), alert: true };
  if (role === 'user') await admin.removeRole(targetId);
  else await admin.setRole(targetId, role, null, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'staff.role', String(targetId), { from: target.role, to: role });
  return { ...(await memberScreen(user, targetId)), toast: t(user.lang, 'adm.saved') };
}

export async function toggleFlag(ctx, user, targetId, bit) {
  const row = await users.load(targetId);
  if (!row) return { toast: t(user.lang, 'adm.users.not_found'), alert: true };
  const target = actorFor(row);
  const flag = P[FLAG_NAMES[bit]];
  if (!flag || target.role === 'user' || !(ROLE_DEFAULTS[target.role] & flag) || !can(user.actor, P.MANAGE_ADMINS) || !outranks(user.actor, target)) {
    return { toast: t(user.lang, 'adm.denied'), alert: true };
  }
  const perms = target.perms ^ flag;
  await admin.setPerms(targetId, perms === ROLE_DEFAULTS[target.role] ? null : perms);
  await system.audit(ctx.now, user.id, 'staff.flag', String(targetId), { flag: FLAG_NAMES[bit], on: (perms & flag) === flag });
  return memberScreen(user, targetId);
}

export function addPrompt(user) {
  return { view: 'admin_staff', input: { k: 'xa' }, screen: { text: t(user.lang, 'adm.staff.add_prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } };
}

export async function onInput(ctx, user, text) {
  const found = await admin.findUser(text);
  if (!found) return { error: t(user.lang, 'adm.staff.not_found') };
  return memberScreen(user, found.id);
}
