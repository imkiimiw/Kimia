/*
 * The event channel of a chat (settings ev_chat): members joining and leaving, admin changes and
 * name changes are posted there, each type switchable (ev_join, ev_leave, ev_admin, ev_names).
 * Like the log channel, a failing event channel never breaks anything.
 */
import { send } from '../core/tg.js';
import { iso } from '../core/util.js';
import { t } from '../i18n/index.js';
import * as settings from './settings.js';

export const TYPES = ['join', 'leave', 'admin', 'names'];

export async function post(ctx, chat, type, text) {
  if (ctx.quiet) return false;
  const s = await settings.all(ctx, chat.chat_id);
  if (s.ev_chat === '0' || !settings.flag(s, `ev_${type}`)) return false;
  const head = t(chat.lang, 'adv.ev_header', { title: iso(chat.title || String(chat.chat_id), 40) });
  return !!(await send(ctx, Number(s.ev_chat), `${head}\n${text}`, null, `event-${type}`));
}
