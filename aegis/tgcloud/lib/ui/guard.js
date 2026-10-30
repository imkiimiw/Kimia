/*
 * Shared by the panel screens: the live access guard and small layout helpers.
 */
import { ADMIN_CACHE_SEC } from '../config.js';
import { answer, btn, screen, send } from '../core/tg.js';
import { iso, nowSec } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import { t } from '../i18n/index.js';
import { register } from './group.js';

const { L } = admins;
export const levelName = (lang, level) => t(lang, `levels.${admins.LEVEL_NAMES[level]}`);
export const typeIcon = (type) => (type === 'channel' ? '📢' : '👥');
export const rowName = (r) => r.first_name || (r.username ? `@${r.username}` : String(r.user_id));
export const back = (lang, data) => [btn(t(lang, 'common.back'), data)];
export const pairs = (buttons) => {
  const out = [];
  for (let i = 0; i < buttons.length; i += 2) out.push(buttons.slice(i, i + 2));
  return out;
};
export const removeKeyboard = { reply_markup: { remove_keyboard: true } };

/*
 * Live re-check of `user` in chat `chatId`. Gives { chat, acc: { id, level, member } } or null
 * (after telling the user why). `need`: the minimum access level for this action.
 */
export async function guard(ctx, user, chatId, need, place) {
  const lang = user.lang;
  let chat = chatId === null ? null : await chats.get(chatId);
  const toList = [[btn(t(lang, 'chat.btn_my_chats'), 'cl')]];
  if (!chat || !Number(chat.active)) {
    await screen(ctx, user.user_id, place, t(lang, 'chat.gone'), toList, 'chat-gone');
    return null;
  }
  const acc = await admins.liveAccess(ctx, chat.chat_id, user.user_id);
  const title = iso(chat.title || '', 48);
  if (!acc.member) {
    await screen(ctx, user.user_id, place, t(lang, 'chat.cant_check', { title }), toList, 'chat-cant-check');
    return null;
  }
  if (acc.level < L.view) {
    const key = admins.defaultLevel(acc.member) > L.none ? 'chat.no_access_level' : 'chat.not_admin';
    await screen(ctx, user.user_id, place, t(lang, key, { title }), toList, 'chat-no-access');
    return null;
  }
  if (acc.level < need) {
    const msg = t(lang, 'chat.need_level', { level: levelName(lang, need), yours: levelName(lang, acc.level) });
    if (ctx.callbackId) await answer(ctx, msg, true);
    else await send(ctx, user.user_id, msg, null, 'chat-need-level');
    return null;
  }
  if (!Number(chat.registered)) chat = await register(ctx, chat, null);
  else if (Number(chat.admins_at) < nowSec() - ADMIN_CACHE_SEC) await admins.refresh(ctx, chat.chat_id);
  return { chat: await chats.get(chat.chat_id), acc: { id: user.user_id, level: acc.level, member: acc.member } };
}

/* The person's level is at least `level`; otherwise they are told (alert) and it gives false. */
export async function needLevel(ctx, user, g, level) {
  if (g.acc.level >= level) return true;
  const msg = t(user.lang, 'chat.need_level', { level: levelName(user.lang, level), yours: levelName(user.lang, g.acc.level) });
  if (ctx.callbackId) await answer(ctx, msg, true);
  else await send(ctx, user.user_id, msg, null, 'chat-need-level');
  return false;
}
