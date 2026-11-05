// 👥 Users: totals, look-up by id or @username, ban/unban, and the admins list (owner only).
import { LIMITS } from '../config/static.js';
import { t, tp, raw, digits, dateTime } from '../i18n/index.js';
import { esc, displayName } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton, promptView } from './panel.js';
import { can, isOwner, isStaff } from '../permissions/policy.js';
import { syncCommandMenus } from '../bot/commands.js';
import { UserError } from '../core/util.js';

async function statsView(app, user) {
  const lang = app.lang;
  const s = await app.users.stats();
  return {
    text: t(lang, 'usr.title', { total: s.total, d1: s.d1, d7: s.d7, blocked: s.blocked, banned: s.banned, admins: s.admins }),
    keyboard: markup([
      [btn(tp(lang, 'usr.btn_find'), 'usr', 'find'), can(user, 'admins.manage') ? btn(tp(lang, 'usr.btn_admins'), 'usr', 'adm', 0) : null],
      [homeButton(lang)],
    ]),
  };
}

async function cardView(app, viewer, u) {
  const lang = app.lang;
  const tz = await app.settings.get('time_zone');
  const role = isOwner(u) ? 'owner' : u.role === 'admin' ? 'admin' : 'user';
  const status = u.is_banned ? 'banned' : u.is_blocked ? 'blocked' : 'ok';
  const rows = [];
  if (can(viewer, 'users.ban') && !isStaff(u)) {
    rows.push([u.is_banned ? btn(tp(lang, 'usr.btn_unban'), 'usr', 'unban', u.telegram_id) : btn(tp(lang, 'usr.btn_ban'), 'usr', 'ban', u.telegram_id)]);
  }
  if (can(viewer, 'admins.manage') && !isOwner(u)) {
    rows.push([u.role === 'admin' ? btn(tp(lang, 'usr.btn_remove_admin'), 'usr', 'rmadm', u.telegram_id) : btn(tp(lang, 'usr.btn_make_admin'), 'usr', 'mkadm', u.telegram_id)]);
  }
  rows.push([btn(tp(lang, 'common.back'), 'usr', 'home')]);
  return {
    text: t(lang, 'usr.card', {
      name: displayName(u),
      id: String(u.telegram_id),
      username: u.username ? '@' + u.username : tp(lang, 'common.none'),
      role: tp(lang, `usr.role.${role}`),
      status: tp(lang, `usr.status.${status}`),
      lang: u.ui_language || tp(lang, 'common.none'),
      created: dateTime(u.created_at, tz, lang),
      seen: dateTime(u.last_seen_at, tz, lang),
    }),
    keyboard: markup(rows),
  };
}

async function adminsView(app, page) {
  const lang = app.lang;
  const size = LIMITS.adminPageSize;
  const s = await app.users.stats();
  const pages = Math.max(1, Math.ceil(s.admins / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const list = await app.users.listAdmins(p, size);
  const lines = list.map((u, i) => `${digits(p * size + i + 1, lang)}. ${esc(displayName(u))} · <code>${u.telegram_id}</code>`);
  const rows = list.map((u) => [btn(displayName(u).slice(0, 40), 'usr', 'view', u.telegram_id)]);
  if (pages > 1) rows.push([p > 0 ? btn(tp(lang, 'common.prev'), 'usr', 'adm', p - 1) : null, p < pages - 1 ? btn(tp(lang, 'common.next'), 'usr', 'adm', p + 1) : null]);
  rows.push([btn(tp(lang, 'usr.btn_add_admin'), 'usr', 'addadm')]);
  rows.push([btn(tp(lang, 'common.back'), 'usr', 'home')]);
  return {
    text: t(lang, 'usr.admins_title', { count: s.admins, list: raw(lines.length ? lines.join('\n') : t(lang, 'usr.admins_empty')) }) + (pages > 1 ? '\n' + t(lang, 'common.page', { page: p + 1, pages }) : ''),
    keyboard: markup(rows),
  };
}

async function showCard(app, viewer, cq, tid) {
  const u = await app.users.get(tid);
  if (!u) return { toast: tp(app.lang, 'usr.not_found'), alert: true };
  await screen(app, viewer, cq, await cardView(app, viewer, u), 'user_card');
  return {};
}

async function confirm(app, user, cq, key, u, yesKey, yesAction) {
  await screen(app, user, cq, {
    text: t(app.lang, key, { name: displayName(u) }),
    keyboard: markup([[btn(tp(app.lang, yesKey), 'usr', yesAction, u.telegram_id), btn(tp(app.lang, 'common.no'), 'usr', 'view', u.telegram_id)]]),
  }, 'user_confirm');
  return {};
}

/** Refreshes one person's command menu after a role change (best effort). */
const refreshMenu = (app, tid, isAdminNow) => syncCommandMenus(app, isAdminNow ? { only: [tid] } : { removed: [tid] });

export const routes = [
  { ns: 'usr', action: 'home', args: [], perm: 'users.view', run: async (app, user, _a, cq) => { await screen(app, user, cq, await statsView(app, user), 'users'); return {}; } },
  {
    ns: 'usr', action: 'find', args: [], perm: 'users.view',
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'usr_find', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'usr.find_prompt')), 'user_find_prompt');
      return {};
    },
  },
  { ns: 'usr', action: 'view', args: ['uint'], perm: 'users.view', run: (app, user, [tid], cq) => showCard(app, user, cq, tid) },
  {
    ns: 'usr', action: 'ban', args: ['uint'], perm: 'users.ban',
    async run(app, user, [tid], cq) {
      const u = await app.users.get(tid);
      if (!u) return { toast: tp(app.lang, 'usr.not_found'), alert: true };
      if (isStaff(u)) throw new UserError(isOwner(u) ? 'usr.err.owner' : 'usr.err.staff_ban');
      return confirm(app, user, cq, 'usr.ban_confirm', u, 'usr.btn_ban_yes', 'banok');
    },
  },
  { ns: 'usr', action: 'banok', args: ['uint'], perm: 'users.ban', run: async (app, user, [tid], cq) => { await app.users.setBanned(user, tid, true); await showCard(app, user, cq, tid); return { toast: tp(app.lang, 'usr.banned') }; } },
  { ns: 'usr', action: 'unban', args: ['uint'], perm: 'users.ban', run: async (app, user, [tid], cq) => { await app.users.setBanned(user, tid, false); await showCard(app, user, cq, tid); return { toast: tp(app.lang, 'usr.unbanned') }; } },
  { ns: 'usr', action: 'adm', args: ['uint'], perm: 'admins.manage', run: async (app, user, [page], cq) => { await screen(app, user, cq, await adminsView(app, page), 'admins'); return {}; } },
  {
    ns: 'usr', action: 'addadm', args: [], perm: 'admins.manage',
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'adm_add', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'usr.add_admin_prompt')), 'admin_add_prompt');
      return {};
    },
  },
  {
    ns: 'usr', action: 'mkadm', args: ['uint'], perm: 'admins.manage',
    async run(app, user, [tid], cq) {
      const u = await app.users.setAdmin(user, tid, true);
      await refreshMenu(app, tid, true);
      await showCard(app, user, cq, tid);
      return { toast: tp(app.lang, 'usr.admin_added', { name: displayName(u) }) };
    },
  },
  {
    ns: 'usr', action: 'rmadm', args: ['uint'], perm: 'admins.manage',
    async run(app, user, [tid], cq) {
      const u = await app.users.get(tid);
      if (!u) return { toast: tp(app.lang, 'usr.not_found'), alert: true };
      return confirm(app, user, cq, 'usr.remove_admin_confirm', u, 'usr.btn_remove_yes', 'rmadmok');
    },
  },
  {
    ns: 'usr', action: 'rmadmok', args: ['uint'], perm: 'admins.manage',
    async run(app, user, [tid], cq) {
      const u = await app.users.setAdmin(user, tid, false);
      await refreshMenu(app, tid, false);
      await showCard(app, user, cq, tid);
      return { toast: tp(app.lang, 'usr.admin_removed', { name: displayName(u) }) };
    },
  },
];

export const flows = {
  usr_find: {
    perm: 'users.view',
    async run(app, user, message) {
      const u = await app.users.find(message.text);
      if (!u) throw new UserError('usr.not_found');
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, await cardView(app, user, u), 'user_card');
    },
  },
  adm_add: {
    perm: 'admins.manage',
    async run(app, user, message) {
      const origin = message.forward_origin;
      let tid = null;
      if (origin && origin.type === 'hidden_user') throw new UserError('usr.err.hidden_forward');
      if (origin && origin.type === 'user' && origin.sender_user) {
        if (origin.sender_user.is_bot) throw new UserError('usr.err.bad_id');
        tid = origin.sender_user.id;
      } else if (/^\d{1,16}$/.test(String(message.text || '').trim())) tid = Number(String(message.text).trim());
      if (!tid || !Number.isSafeInteger(tid)) throw new UserError('usr.err.bad_id');
      const u = await app.users.setAdmin(user, tid, true);
      await app.flows.clear(user.telegram_id);
      await refreshMenu(app, tid, true);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'usr.admin_added', { name: displayName(u) }) }, 'admin_added');
      await app.tg.send(user.telegram_id, await adminsView(app, 0), 'admins');
    },
  },
};
