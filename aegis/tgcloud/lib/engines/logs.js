/*
 * The log channel of a chat (settings log_chat): punishments, list changes, lock hits, admin/security
 * events and setting changes are posted there, in the chat's language, if the category is switched on.
 * A failing log channel never breaks the action that is being logged.
 * Section `events` (was engines/events.js): the event channel of a chat (settings ev_chat) — members
 * joining and leaving, admin changes and name changes, each type switchable (ev_join, ev_leave,
 * ev_admin, ev_names); a failing event channel never breaks anything either.
 */
import { send } from '../core/tg.js';
import { iso } from '../core/util.js';
import { t } from '../i18n/index.js';
import * as settings from './settings.js';

export const CATEGORIES = ['punish', 'lists', 'locks', 'security', 'admin', 'settings'];

export async function post(ctx, chat, category, text, rows = null) {
  if (ctx.quiet) return false;
  const s = await settings.all(ctx, chat.chat_id);
  if (!settings.flag(s, 'log_on') || s.log_chat === '0' || !settings.flag(s, `log_${category}`)) return false;
  const head = t(chat.lang, 'logs.header', { title: iso(chat.title || String(chat.chat_id), 40) });
  return !!(await send(ctx, Number(s.log_chat), `${head}\n${text}`, rows, `log-${category}`));
}

export const events = (() => {
  const TYPES = ['join', 'leave', 'admin', 'names'];

  async function post(ctx, chat, type, text) {
    if (ctx.quiet) return false;
    const s = await settings.all(ctx, chat.chat_id);
    if (s.ev_chat === '0' || !settings.flag(s, `ev_${type}`)) return false;
    const head = t(chat.lang, 'adv.ev_header', { title: iso(chat.title || String(chat.chat_id), 40) });
    return !!(await send(ctx, Number(s.ev_chat), `${head}\n${text}`, null, `event-${type}`));
  }

  return { TYPES, post };
})();
