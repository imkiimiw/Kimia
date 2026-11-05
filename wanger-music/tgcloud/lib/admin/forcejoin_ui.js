// 🔐 Force Join management (owner only): list with health, add, remove, enable/disable, reorder,
// invite link, failure mode, health check. Every change goes through ForceJoinService (audited,
// invalidates all passes), so it applies to the next user check at once.
import { LIMITS, BOT_USERNAME } from '../config/static.js';
import { t, tp, raw, digits, dateTime } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton, promptView } from './panel.js';
import { joinUrl } from '../forcejoin/gate.js';
import { cycleValue } from '../settings/service.js';

const ICON = { ok: '🟢', bot_not_admin: '🔴', not_found: '⚫️', error: '🟠' };
const PERM = 'forcejoin.manage';

const handle = (r) => (r.username ? '@' + r.username : '');
const title = (r) => r.title || handle(r) || String(r.chat_id);

async function listView(app) {
  const lang = app.lang;
  const rows = await app.forcejoin.list();
  const mode = await app.settings.get('forcejoin.failure_mode');
  const lines = rows.map((r, i) => `${digits(i + 1, lang)}. ${r.enabled ? ICON[r.last_check_status] || '🟠' : '⏸'} ${esc(title(r))} ${esc(handle(r))}`.trim());
  const buttons = rows.map((r, i) => [btn(`${digits(i + 1, lang)}. ${title(r)}`.slice(0, 60), 'fjm', 'view', r.id)]);
  if (rows.length < LIMITS.forceJoinMax) buttons.push([btn(tp(lang, 'fjm.btn_add'), 'fjm', 'add')]);
  buttons.push([btn(tp(lang, 'fjm.btn_mode', { mode: tp(lang, `fjm.mode.${mode}`) }), 'fjm', 'mode'), btn(tp(lang, 'fjm.btn_health'), 'fjm', 'health')]);
  buttons.push([homeButton(lang)]);
  return {
    text: t(lang, 'fjm.title', {
      count: rows.length,
      max: LIMITS.forceJoinMax,
      mode: tp(lang, `fjm.mode.${mode}`),
      list: raw(lines.length ? lines.join('\n') : t(lang, 'fjm.empty')),
    }) + '\n\n' + t(lang, 'fjm.mode_help'),
    keyboard: markup(buttons),
  };
}

async function channelView(app, r) {
  const lang = app.lang;
  const tz = await app.settings.get('time_zone');
  const link = joinUrl(r);
  return {
    text: t(lang, 'fjm.view', {
      title: title(r),
      handle: handle(r),
      chat_id: r.chat_id,
      state: tp(lang, r.enabled ? 'fjm.state.on' : 'fjm.state.off'),
      health: tp(lang, `fjm.health.${r.last_check_status}`),
      checked: dateTime(r.last_checked_at, tz, lang),
      link: link ? link : raw(t(lang, 'fjm.no_link')),
    }),
    keyboard: markup([
      [btn(tp(lang, r.enabled ? 'fjm.btn_disable' : 'fjm.btn_enable'), 'fjm', 'tog', r.id)],
      [btn(tp(lang, 'fjm.btn_up'), 'fjm', 'up', r.id), btn(tp(lang, 'fjm.btn_down'), 'fjm', 'down', r.id)],
      [btn(tp(lang, 'fjm.btn_link'), 'fjm', 'link', r.id), btn(tp(lang, 'fjm.btn_delete'), 'fjm', 'del', r.id)],
      [btn(tp(lang, 'common.back'), 'fjm', 'home')],
    ]),
  };
}

const showList = async (app, user, cq) => screen(app, user, cq, await listView(app), 'fj_list');

async function showChannel(app, user, cq, id) {
  const r = await app.forcejoin.get(id);
  if (!r) {
    await showList(app, user, cq);
    return { toast: tp(app.lang, 'fjm.err.gone') };
  }
  await screen(app, user, cq, await channelView(app, r), 'fj_channel');
  return {};
}

export const routes = [
  { ns: 'fjm', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await showList(app, user, cq); return {}; } },
  { ns: 'fjm', action: 'view', args: ['uint'], perm: PERM, run: (app, user, [id], cq) => showChannel(app, user, cq, id) },
  {
    ns: 'fjm', action: 'tog', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const r = await app.forcejoin.get(id);
      if (!r) return showChannel(app, user, cq, id);
      await app.forcejoin.setEnabled(user, id, !r.enabled);
      await showChannel(app, user, cq, id);
      return { toast: tp(app.lang, r.enabled ? 'fjm.disabled' : 'fjm.enabled') };
    },
  },
  { ns: 'fjm', action: 'up', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { const moved = await app.forcejoin.move(user, id, -1); await showChannel(app, user, cq, id); return moved ? { toast: tp(app.lang, 'fjm.moved') } : {}; } },
  { ns: 'fjm', action: 'down', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { const moved = await app.forcejoin.move(user, id, 1); await showChannel(app, user, cq, id); return moved ? { toast: tp(app.lang, 'fjm.moved') } : {}; } },
  {
    ns: 'fjm', action: 'del', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const r = await app.forcejoin.get(id);
      if (!r) return showChannel(app, user, cq, id);
      await screen(app, user, cq, {
        text: t(app.lang, 'fjm.delete_confirm', { title: title(r) }),
        keyboard: markup([[btn(tp(app.lang, 'common.yes_delete'), 'fjm', 'delok', id), btn(tp(app.lang, 'common.no'), 'fjm', 'view', id)]]),
      }, 'fj_delete_confirm');
      return {};
    },
  },
  { ns: 'fjm', action: 'delok', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await app.forcejoin.remove(user, id); await showList(app, user, cq); return { toast: tp(app.lang, 'fjm.deleted') }; } },
  {
    ns: 'fjm', action: 'link', args: ['uint'], perm: PERM,
    async run(app, user, [id]) {
      if (!(await app.forcejoin.get(id))) return { toast: tp(app.lang, 'fjm.err.gone') };
      await app.flows.start(user.telegram_id, 'fj_link', { id });
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'fjm.link_prompt')), 'fj_link_prompt');
      return {};
    },
  },
  {
    ns: 'fjm', action: 'add', args: [], perm: PERM,
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'fj_add', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'fjm.add_prompt')), 'fj_add_prompt');
      return {};
    },
  },
  {
    ns: 'fjm', action: 'mode', args: [], perm: PERM,
    async run(app, user, _a, cq) {
      const mode = cycleValue('forcejoin.failure_mode', await app.settings.get('forcejoin.failure_mode'));
      await app.forcejoin.setFailureMode(user, mode);
      await showList(app, user, cq);
      return { toast: tp(app.lang, 'fjm.mode_set', { mode: tp(app.lang, `fjm.mode.${mode}`) }) };
    },
  },
  { ns: 'fjm', action: 'health', args: [], perm: PERM, run: async (app, user, _a, cq) => { const n = await app.forcejoin.checkHealth(user); await showList(app, user, cq); return { toast: tp(app.lang, 'fjm.health_done', { n }) }; } },
];

export const flows = {
  fj_add: {
    perm: PERM,
    async run(app, user, message) {
      const row = await app.forcejoin.add(user, message.text || message.caption || '', message);
      await app.flows.clear(user.telegram_id);
      const key = row.username || row.invite_link ? 'fjm.added' : 'fjm.added_no_link';
      await app.tg.send(user.telegram_id, { text: t(app.lang, key, { title: title(row), bot: BOT_USERNAME }) }, 'fj_added');
      await app.tg.send(user.telegram_id, await listView(app), 'fj_list');
    },
  },
  fj_link: {
    perm: PERM,
    async run(app, user, message, flow) {
      const text = String(message.text || '').trim();
      const id = Number(flow.data && flow.data.id);
      await app.forcejoin.setInviteLink(user, id, text === '-' ? null : text);
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, { text: t(app.lang, text === '-' ? 'fjm.link_cleared' : 'fjm.link_saved') }, 'fj_link_saved');
      const r = await app.forcejoin.get(id);
      if (r) await app.tg.send(user.telegram_id, await channelView(app, r), 'fj_channel');
    },
  },
};
