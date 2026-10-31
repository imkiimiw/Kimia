/*
 * Owner tools. /setup — sets the command menu and the bot descriptions in every language (the
 * default language without language_code), adds /admin to the owner's own menu, and checks inline
 * mode and the backup channel. Inline mode (/setinline) and inline feedback (/setinlinefeedback) can only be turned on
 * in @BotFather; the report says so.
 */
import { ENV } from './env.js';
import { LANGS, t } from './i18n.js';
import { DEFAULT_LANG } from './locales/index.js';
import * as store from './store.js';
import { call, describeError, send } from './tg.js';
import { esc } from './util.js';

const COMMANDS = ['start', 'my', 'fav', 'tags', 'lang', 'help', 'cancel'];

export async function setup(ctx, nowSec) {
  const lines = [];
  const me = await call(ctx, 'getMe', {}, 'setup.getMe');
  await store.kvSet('bot:username', me.username, nowSec);
  lines.push(t(ctx.lang, me.supports_inline_queries ? 'owner.setup.inline_on' : 'owner.setup.inline_off'));
  lines.push(t(ctx.lang, 'owner.setup.feedback'));

  try {
    for (const lang of LANGS) {
      const scope = lang === DEFAULT_LANG ? {} : { language_code: lang };
      await call(ctx, 'setMyCommands', { commands: COMMANDS.map((c) => ({ command: c, description: t(lang, `cmd.${c}`) })), ...scope }, 'setup.commands');
      await call(ctx, 'setMyDescription', { description: t(lang, 'bot.description'), ...scope }, 'setup.description');
      await call(ctx, 'setMyShortDescription', { short_description: t(lang, 'bot.short'), ...scope }, 'setup.short');
    }
    const ownerCommands = [...COMMANDS, 'admin'].map((c) => ({ command: c, description: t(ctx.lang, `cmd.${c}`) }));
    await call(ctx, 'setMyCommands', { commands: ownerCommands, scope: { type: 'chat', chat_id: ENV.ownerId } }, 'setup.owner_commands');
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
