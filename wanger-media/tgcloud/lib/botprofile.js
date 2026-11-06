// The bot's public profile (brief §6 Launch): localized command menus (setMyCommands) and
// descriptions (setMyDescription / setMyShortDescription) in fa, en (default) and ru. Applied by the
// owner from Admin › Switches ("apply commands and descriptions"); idempotent.
import { LANGS, OWNER_ID } from './config.js';
import { tp } from './i18n/index.js';
import * as tg from './tg.js';

export const PRIVATE_COMMANDS = ['start', 'download', 'downloads', 'settings', 'language', 'help', 'about'];
export const GROUP_COMMANDS = ['settings', 'status', 'platforms', 'help'];

const commands = (lang, names, prefix) => names.map((c) => ({ command: c, description: tp(lang, `${prefix}.${c}`) }));

/** Every Bot API call that sets the profile: [method, params] (pure, for tests and for apply()). */
export function profileCalls() {
  const calls = [];
  for (const lang of LANGS) {
    const language_code = lang === 'en' ? '' : lang; // English is the default for every other language
    calls.push(['setMyCommands', { commands: commands(lang, PRIVATE_COMMANDS, 'cmd'), scope: { type: 'all_private_chats' }, ...(language_code ? { language_code } : {}) }]);
    calls.push(['setMyCommands', { commands: commands(lang, GROUP_COMMANDS, 'gcmd'), scope: { type: 'all_group_chats' }, ...(language_code ? { language_code } : {}) }]);
    calls.push(['setMyDescription', { description: tp(lang, 'profile.description'), ...(language_code ? { language_code } : {}) }]);
    calls.push(['setMyShortDescription', { short_description: tp(lang, 'profile.short'), ...(language_code ? { language_code } : {}) }]);
  }
  // The owner's private chat also lists /admin (in the owner's language and the default).
  for (const lang of ['en', 'fa']) {
    calls.push(['setMyCommands', {
      commands: [...commands(lang, PRIVATE_COMMANDS, 'cmd'), { command: 'admin', description: tp(lang, 'cmd.admin') }],
      scope: { type: 'chat', chat_id: OWNER_ID }, ...(lang === 'en' ? {} : { language_code: lang }),
    }]);
  }
  return calls;
}

/** Applies the profile; → { ok, failed: [method…] }. */
export async function apply(ctx) {
  const failed = [];
  for (const [method, params] of profileCalls()) {
    try {
      await tg.call(ctx, 'bot_profile', method, params);
    } catch (err) {
      failed.push(`${method}:${params.language_code || 'default'}:${err.kind || err.code || 'error'}`);
    }
  }
  return { ok: !failed.length, failed };
}
