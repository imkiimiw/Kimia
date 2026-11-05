// User-facing screens and routes: /start (with payloads), /help, /lang, the force-join message
// and «✅ عضو شدم».
import { BOT_USERNAME } from '../config/static.js';
import { t, tp } from '../i18n/index.js';
import { btn, markup } from './keyboards.js';
import { parseStartPayload } from './commands.js';
import { joinView } from '../forcejoin/gate.js';
import { isStaff, can } from '../permissions/policy.js';

/** @param {string} lang @param {any} user */
export function welcomeView(lang, user) {
  return {
    text: t(lang, 'start.welcome', { bot: BOT_USERNAME }),
    keyboard: markup([
      [btn(tp(lang, 'start.btn_help'), 'u', 'help'), btn(tp(lang, 'start.btn_lang'), 'u', 'lang')],
      can(user, 'panel.open') ? [btn(tp(lang, 'common.home'), 'adm', 'home')] : [],
    ]),
  };
}

export function helpView(lang, user) {
  return { text: t(lang, 'help.text', { bot: BOT_USERNAME }) + (isStaff(user) ? t(lang, 'help.admin') : '') };
}

export function langView(lang) {
  return {
    text: t(lang, 'lang.choose'),
    keyboard: markup([[btn('🇮🇷 فارسی', 'lang', 'set', 'fa'), btn('🇬🇧 English', 'lang', 'set', 'en')]]),
  };
}

/** What /start does once the user is through the gate. @param {string} payloadText */
export async function continueStart(app, user, payloadText) {
  const p = parseStartPayload(payloadText);
  const chat = user.telegram_id;
  if (p.kind === 'track') return app.tg.send(chat, { text: t(app.lang, 'start.track_soon') }, 'track_soon');
  if (p.kind === 'search') await app.tg.send(chat, { text: t(app.lang, 'start.search_soon') }, 'search_soon');
  return app.tg.send(chat, welcomeView(app.lang, user), 'welcome');
}

/** The join message, as a new message or in place of the pressed one. */
export function sendJoinPrompt(app, user, missing, messageId = null) {
  return app.tg.show(user.telegram_id, messageId, joinView(missing, app.lang), 'join_prompt');
}

/** @type {any[]} */
export const routes = [
  {
    ns: 'fj', action: 'check', args: [], perm: null, gate: false,
    async run(app, user, _args, cq) {
      const verdict = await app.forcejoin.check(user, { useCache: false });
      const messageId = cq.message ? cq.message.message_id : null;
      if (!verdict.passed) {
        await sendJoinPrompt(app, user, verdict.missing, messageId);
        return { toast: tp(app.lang, 'fj.still_missing') };
      }
      let payload = '';
      const pending = await app.flows.get(user.telegram_id);
      if (pending && pending.flow === 'fj_pending') {
        payload = String((pending.data && pending.data.payload) || '');
        await app.flows.clear(user.telegram_id);
      }
      await app.tg.show(user.telegram_id, messageId, { text: t(app.lang, 'start.unlocked') }, 'unlocked');
      await continueStart(app, user, payload);
      return {};
    },
  },
  {
    ns: 'lang', action: 'set', args: ['lang'], perm: null, gate: false,
    async run(app, user, [lang], cq) {
      await app.users.setLanguage(user, lang);
      app.lang = lang;
      await app.tg.show(user.telegram_id, cq.message ? cq.message.message_id : null, { text: t(lang, 'lang.set') }, 'lang_set');
      return {};
    },
  },
  { ns: 'u', action: 'help', args: [], perm: null, run: async (app, user) => { await app.tg.send(user.telegram_id, helpView(app.lang, user), 'help'); return {}; } },
  { ns: 'u', action: 'lang', args: [], perm: null, gate: false, run: async (app, user) => { await app.tg.send(user.telegram_id, langView(app.lang), 'lang'); return {}; } },
  {
    ns: 'u', action: 'cancel', args: [], perm: null, gate: false,
    async run(app, user, _args, cq) {
      const n = await app.flows.clear(user.telegram_id);
      await app.tg.show(user.telegram_id, cq.message ? cq.message.message_id : null, { text: t(app.lang, n ? 'common.cancelled' : 'common.nothing_to_cancel') }, 'cancel');
      return {};
    },
  },
];
