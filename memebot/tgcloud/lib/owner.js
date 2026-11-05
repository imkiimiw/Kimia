/*
 * Owner tools. /aikey <key> | off — the Gemini API key (Phase 6), kept in the database only; the
 * message holding it is deleted at once. /setup — sets the command menu and the bot descriptions in every language (the
 * default language without language_code), adds /admin to the owner's own menu, and checks inline
 * mode and the backup channel. The command menus are also set by themselves the first time the owner
 * sends /start (ensureOwnerMenus), so /admin shows up even if /setup was never sent. Inline mode (/setinline) and inline feedback (/setinlinefeedback) can only be turned on
 * in @BotFather; the report says so.
 */
import * as ai from './ai.js';
import { ENV } from './env.js';
import { LANGS, t } from './i18n.js';
import { DEFAULT_LANG } from './locales/index.js';
import * as store from './store.js';
import { call, describeError, remove, send } from './tg.js';
import { esc } from './util.js';

const COMMANDS = ['start', 'my', 'fav', 'tags', 'top', 'profile', 'lang', 'help', 'cancel'];
/* Bump when COMMANDS or the descriptions change: the owner's next /start applies them again. */
const MENUS_VER = 1;

/* A staff member's own command menu: the usual commands plus /admin (on), or back to the
   default menu (off). Fails quietly if they never opened the bot. */
export async function staffMenu(ctx, uid, lang, on) {
  const scope = { type: 'chat', chat_id: uid };
  try {
    if (on) await call(ctx, 'setMyCommands', { commands: [...COMMANDS, 'admin'].map((c) => ({ command: c, description: t(lang, `cmd.${c}`) })), scope }, 'staff.menu');
    else await call(ctx, 'deleteMyCommands', { scope }, 'staff.menu');
  } catch (err) {
    console.warn(`staff menu for ${uid}: ${describeError(err)}`);
  }
}

/* Every language's command menu and descriptions, plus the owner's own menu with /admin. Throws on failure. */
async function applyMenus(ctx, ownerLang, nowSec) {
  for (const lang of LANGS) {
    const scope = lang === DEFAULT_LANG ? {} : { language_code: lang };
    await call(ctx, 'setMyCommands', { commands: COMMANDS.map((c) => ({ command: c, description: t(lang, `cmd.${c}`) })), ...scope }, 'setup.commands');
    await call(ctx, 'setMyDescription', { description: t(lang, 'bot.description'), ...scope }, 'setup.description');
    await call(ctx, 'setMyShortDescription', { short_description: t(lang, 'bot.short'), ...scope }, 'setup.short');
  }
  const ownerCommands = [...COMMANDS, 'admin'].map((c) => ({ command: c, description: t(ownerLang, `cmd.${c}`) }));
  await call(ctx, 'setMyCommands', { commands: ownerCommands, scope: { type: 'chat', chat_id: ENV.ownerId } }, 'setup.owner_commands');
  await store.kvSet('menus:ver', '', MENUS_VER);
}

/* Applies the menus once (and again after MENUS_VER changes); a failure is retried at the next /start. */
export async function ensureOwnerMenus(ctx, nowSec) {
  const r = await store.kvGet('menus:ver');
  if (r && r.n >= MENUS_VER) return;
  try {
    await applyMenus(ctx, ctx.lang, nowSec);
  } catch (err) {
    console.warn(`menus: ${describeError(err)}`);
  }
}

export async function setAiKey(ctx, msg, arg, nowSec) {
  if (!arg) {
    const s = await ai.aiStatus(nowSec);
    return send(ctx, 'aikey', t(ctx.lang, 'owner.aikey.usage', { state: t(ctx.lang, s.key ? 'owner.aikey.set' : 'owner.aikey.unset') }));
  }
  await remove(ctx, 'aikey.delete', msg.message_id);
  if (arg.toLowerCase() === 'off') {
    await ai.setKey('', nowSec);
    return send(ctx, 'aikey', t(ctx.lang, 'owner.aikey.removed'));
  }
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(arg)) return send(ctx, 'aikey', t(ctx.lang, 'owner.aikey.bad'));
  const check = await ai.checkKey(arg);
  if (check === 'rejected') return send(ctx, 'aikey', t(ctx.lang, 'owner.aikey.rejected'));
  await ai.setKey(arg, nowSec);
  await store.kvSet('ai:pause', '', 0);
  return send(ctx, 'aikey', t(ctx.lang, check === 'ok' ? 'owner.aikey.saved' : 'owner.aikey.saved_unchecked'));
}

export async function setup(ctx, nowSec) {
  const lines = [];
  const me = await call(ctx, 'getMe', {}, 'setup.getMe');
  await store.kvSet('bot:username', me.username, nowSec);
  lines.push(t(ctx.lang, me.supports_inline_queries ? 'owner.setup.inline_on' : 'owner.setup.inline_off'));
  lines.push(t(ctx.lang, 'owner.setup.feedback'));

  try {
    await applyMenus(ctx, ctx.lang, nowSec);
    lines.push(t(ctx.lang, 'owner.setup.commands', { n: LANGS.length }));
  } catch (err) {
    lines.push(t(ctx.lang, 'owner.setup.commands_fail', { err: esc(describeError(err)) }));
  }

  const ch = ENV.backupChannelId;
  if (!ch) {
    lines.push(t(ctx.lang, 'owner.setup.backup_off'));
  } else {
    try {
      const chat = await call(ctx, 'getChat', { chat_id: ch }, 'setup.backup.chat');
      const member = await call(ctx, 'getChatMember', { chat_id: ch, user_id: me.id }, 'setup.backup.member');
      const canPost = member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
      lines.push(canPost
        ? t(ctx.lang, 'owner.setup.backup_ok', { title: esc(chat.title || String(ch)) })
        : t(ctx.lang, 'owner.setup.backup_bad', { ch: esc(String(ch)), err: t(ctx.lang, 'owner.setup.not_admin') }));
    } catch (err) {
      lines.push(t(ctx.lang, 'owner.setup.backup_bad', { ch: esc(String(ch)), err: esc(describeError(err)) }));
    }
  }
  await send(ctx, 'setup', t(ctx.lang, 'owner.setup', { lines: lines.join('\n') }));
}
