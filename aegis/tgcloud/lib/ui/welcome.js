/*
 * Welcome and goodbye messages (settings welcome_*, goodbye_*). The admins' own text may use {name},
 * {mention}, {group} and {count}; it is HTML-escaped first. Link buttons are written like broadcast
 * buttons (`Text - link`); with «rules button» on and rules set, a button opens the rules in the
 * bot's private chat. The previous welcome is deleted when a new one comes (welcome_clean), and no
 * welcome is posted during a raid. A newcomer who owes a captcha is welcomed after solving it.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { me, send, tryCall, urlBtn } from '../core/tg.js';
import { esc, fullName, iso } from '../core/util.js';
import { parseButtons } from '../core/content.js';
import * as chats from '../engines/chats.js';
import * as guards from '../engines/guards.js';
import * as settings from '../engines/settings.js';
import { t } from '../i18n/index.js';

const mention = (user) => `<a href="tg://user?id=${user.id}">${esc(fullName(user).slice(0, 64))}</a>`;

/* The admins' text with its placeholders filled in (everything else escaped). */
export async function render(ctx, text, chat, user) {
  let count = '';
  if (text.includes('{count}')) count = String((await tryCall(ctx, 'getChatMemberCount', { chat_id: chat.chat_id }, 'welcome-count')) || '');
  return esc(text).replace(/\{name\}/g, esc(fullName(user))).replace(/\{mention\}/g, mention(user)).replace(/\{group\}/g, esc(chat.title || ''))
    .replace(/\{count\}/g, count);
}

/* The welcome's text and buttons for this chat and member. */
export async function compose(ctx, chat, user, s) {
  const lang = chat.lang;
  const text = s.welcome_text ? await render(ctx, s.welcome_text, chat, user) : t(lang, 'adv.welcome_default', { user: mention(user), group: iso(chat.title || '', 48) });
  const parsed = s.welcome_btns ? parseButtons(s.welcome_btns) : { rows: [] };
  const rows = (parsed.rows || []).map((r) => r.map((b) => urlBtn(b.text, b.url)));
  if (s.rules && settings.flag(s, 'rules_btn')) rows.push([urlBtn(t(lang, 'adv.btn_rules'), `https://t.me/${(await me(ctx)).username}?start=r_${chat.chat_id}`)]);
  return { text, rows };
}

export async function welcome(ctx, chat, user) {
  if (ctx.quiet || chat.type === 'channel' || !user || user.is_bot) return null;
  const s = await settings.all(ctx, chat.chat_id);
  if (!settings.flag(s, 'welcome_on')) return null;
  if (await guards.lockdown(chat.chat_id, 'raid')) return null;
  const { text, rows } = await compose(ctx, chat, user, s);
  const fresh = await chats.get(chat.chat_id);
  if (settings.flag(s, 'welcome_clean') && fresh && Number(fresh.welcome_msg)) {
    await tryCall(ctx, 'deleteMessage', { chat_id: chat.chat_id, message_id: Number(fresh.welcome_msg) }, 'welcome-old');
  }
  const m = await send(ctx, chat.chat_id, text, rows, 'welcome');
  if (m) await db.run(sql`UPDATE aegis_chats SET welcome_msg = ${m.message_id} WHERE chat_id = ${chat.chat_id}`);
  return m;
}

export async function goodbye(ctx, chat, user) {
  if (ctx.quiet || chat.type === 'channel' || !user || user.is_bot) return null;
  const s = await settings.all(ctx, chat.chat_id);
  if (!settings.flag(s, 'goodbye_on')) return null;
  const text = s.goodbye_text ? await render(ctx, s.goodbye_text, chat, user) : t(chat.lang, 'adv.goodbye_default', { user: iso(fullName(user)) });
  return send(ctx, chat.chat_id, text, null, 'goodbye');
}
