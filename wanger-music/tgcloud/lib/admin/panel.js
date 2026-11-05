// /admin main menu (only the sections the person may use) and honest placeholders for later phases.
import { ADMIN_SECTIONS, CURRENT_PHASE } from '../config/static.js';
import { can } from '../permissions/policy.js';
import { t, tp } from '../i18n/index.js';
import { btn, markup, grid } from '../bot/keyboards.js';

/** Where a built section's button goes. */
const TARGETS = { music: ['mus', 'home'], sources: ['src', 'home'], fj: ['fjm', 'home'], users: ['usr', 'home'], bc: ['bc', 'home'], settings: ['set', 'home'], system: ['sys', 'home'] };

/** Shows a view in the pressed message (or as a new message). */
export const screen = (app, user, cq, view, name) => app.tg.show(user.telegram_id, cq && cq.message ? cq.message.message_id : null, view, name);

/** A prompt for flow input, with a cancel button. */
export const promptView = (lang, text) => ({ text, keyboard: markup([[btn(tp(lang, 'common.no'), 'u', 'cancel')]]) });

export const homeButton = (lang) => btn(tp(lang, 'common.home'), 'adm', 'home');

export function homeView(lang, user) {
  const buttons = ADMIN_SECTIONS.filter((s) => can(user, s.perm)).map((s) => {
    const target = s.phase <= CURRENT_PHASE && TARGETS[s.id] ? TARGETS[s.id] : ['adm', 'sec', s.id];
    return btn(tp(lang, `adm.sec.${s.id}`), target[0], target[1], ...target.slice(2));
  });
  return { text: t(lang, 'adm.title'), keyboard: markup(grid(buttons, 2)) };
}

export const openPanel = (app, user, cq = null) => screen(app, user, cq, homeView(app.lang, user), 'admin_home');

export const routes = [
  { ns: 'adm', action: 'home', args: [], perm: 'panel.open', run: async (app, user, _a, cq) => { await openPanel(app, user, cq); return {}; } },
  {
    ns: 'adm', action: 'sec', args: ['word'], perm: 'panel.open',
    async run(app, user, [id], cq) {
      const s = ADMIN_SECTIONS.find((x) => x.id === id);
      if (!s) return { toast: tp(app.lang, 'common.expired'), alert: true };
      if (!can(user, s.perm)) return { toast: tp(app.lang, 'common.denied'), alert: true };
      await screen(app, user, cq, { text: t(app.lang, 'adm.placeholder', { title: tp(app.lang, `adm.sec.${s.id}`), phase: s.phase }), keyboard: markup([[homeButton(app.lang)]]) }, 'placeholder');
      return {};
    },
  },
];
