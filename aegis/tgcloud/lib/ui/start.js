/*
 * The private chat's user screens: language picker, welcome (main menu), help, forced-join screen.
 * Every screen edits the pressed message when there is one, else sends a new message.
 */
import { OWNER_ID } from '../config.js';
import { btn, me, screen, urlBtn } from '../core/tg.js';
import { fullName, iso } from '../core/util.js';
import { addToChannelUrl, addToGroupUrl } from '../engines/rights.js';
import { langFlag, langName, LANGS, t } from '../i18n/index.js';

/* Picker text: the prompt in every language (the user may not have one yet). */
export function pickerText(current) {
  const lines = LANGS.map((l) => t(l, 'lang.pick'));
  if (current) lines.push('', t(current, 'lang.current', { name: langName(current) }));
  return lines.join('\n');
}

export function pickerRows(current) {
  const b = (l) => btn(`${l === current ? '✓ ' : ''}${langFlag(l)} ${langName(l)}`, `lg:${l}`);
  return [[b('fa'), b('en')], [b('ru'), b('zh')], [b('fr')]];
}

export async function picker(ctx, user, place = null) {
  const current = Number(user.lang_set) ? user.lang : null;
  return screen(ctx, user.user_id, place, pickerText(current), pickerRows(current), 'language');
}

export async function mainRows(ctx, lang, userId) {
  const bot = (await me(ctx)).username;
  const rows = [
    [btn(t(lang, 'start.btn_my_chats'), 'cl')],
    [urlBtn(t(lang, 'start.btn_add_group'), addToGroupUrl(bot)), urlBtn(t(lang, 'start.btn_add_channel'), addToChannelUrl(bot))],
    [btn(t(lang, 'start.btn_language'), 'lg'), btn(t(lang, 'start.btn_help'), 'hp')],
  ];
  if (userId === OWNER_ID) rows.push([btn(t(lang, 'start.btn_owner'), 'op')]);
  return rows;
}

export async function welcome(ctx, user, from, place = null) {
  const lang = user.lang;
  const text = t(lang, 'start.welcome', { name: iso(fullName(from) || user.first_name || '') });
  return screen(ctx, user.user_id, place, text, await mainRows(ctx, lang, user.user_id), 'welcome');
}

export async function help(ctx, user, place = null) {
  const lang = user.lang;
  const parts = [t(lang, 'start.help')];
  if (user.user_id === OWNER_ID) parts.push('', t(lang, 'start.help_owner'));
  return screen(ctx, user.user_id, place, parts.join('\n'), [[btn(t(lang, 'common.back'), 'mm')]], 'help');
}

/* "Join these channels first": one URL button per missing channel, then "✅ I joined". */
export async function joinScreen(ctx, user, missing, place = null) {
  const lang = user.lang;
  const lines = [t(lang, 'join.required'), ''];
  for (const m of missing) lines.push(t(lang, 'join.item', { title: iso(m.title, 48) }));
  lines.push('', t(lang, 'join.after'));
  const rows = missing.filter((m) => m.url).map((m) => [urlBtn(t(lang, 'join.btn_open', { title: m.title.slice(0, 40) }), m.url)]);
  rows.push([btn(t(lang, 'join.btn_check'), 'jc')]);
  rows.push([btn(t(lang, 'start.btn_language'), 'lg')]);
  return screen(ctx, user.user_id, place, lines.join('\n'), rows, 'join');
}
