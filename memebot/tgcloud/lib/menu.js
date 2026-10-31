/*
 * Welcome, help, the language picker and the hint for stray text.
 * callback_data: lang:<code>[:u] (u = show the upload help next) | m:up | m:my | m:help | m:lang
 */
import { DAILY_UPLOADS } from './config.js';
import { botUsername } from './bot.js';
import { LANGS, t } from './i18n.js';
import { LOCALES } from './locales/index.js';
import { edit, send } from './tg.js';
import { cut, esc } from './util.js';

export function mainKeyboard(lang) {
  return [
    [{ text: t(lang, 'menu.upload'), callback_data: 'm:up' }, { text: t(lang, 'menu.my'), callback_data: 'm:my' }],
    [{ text: t(lang, 'menu.search'), switch_inline_query_current_chat: '' }],
    [{ text: t(lang, 'menu.lang'), callback_data: 'm:lang' }, { text: t(lang, 'menu.help'), callback_data: 'm:help' }],
  ];
}

/* The picker is written in every language at once: the user may not read the current one. */
export async function sendLanguagePicker(ctx, next = '') {
  const text = LANGS.map((l) => t(l, 'lang.prompt')).join('\n');
  const kb = [LANGS.map((l) => ({ text: LOCALES[l]._name, callback_data: `lang:${l}${next ? `:${next}` : ''}` }))];
  await send(ctx, 'lang.pick', text, kb);
}

export async function sendWelcome(ctx, from, nowSec) {
  const bot = await botUsername(ctx, nowSec);
  await send(ctx, 'start', t(ctx.lang, 'start.welcome', { name: esc(cut(from.first_name || '', 40)), bot: esc(bot) }), mainKeyboard(ctx.lang));
}

export async function sendHelp(ctx, nowSec, messageId = null) {
  const bot = await botUsername(ctx, nowSec);
  const text = t(ctx.lang, 'help', { bot: esc(bot), limit: DAILY_UPLOADS });
  if (messageId && (await edit(ctx, 'help', messageId, text, mainKeyboard(ctx.lang)))) return;
  await send(ctx, 'help', text, mainKeyboard(ctx.lang));
}

export async function sendUploadHow(ctx) {
  await send(ctx, 'upload.how', t(ctx.lang, 'upload.how'));
}

/* Text that is not a command and not awaited: explain, and offer to search for it. */
export async function sendHint(ctx, text, nowSec) {
  const bot = await botUsername(ctx, nowSec);
  const q = cut(String(text).replace(/\s+/g, ' ').trim(), 60);
  const kb = q ? [[{ text: t(ctx.lang, 'hint.search_btn', { q: cut(q, 24) }), switch_inline_query_current_chat: q }]] : null;
  await send(ctx, 'hint', t(ctx.lang, 'hint', { bot: esc(bot) }), kb);
}
