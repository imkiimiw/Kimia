/*
 * Commands. Slash commands are English identifiers (Telegram allows only a-z, 0-9, _); the same
 * commands also work as plain words in any of our languages — Persian and English always — via
 * the "alias" locale namespace (e.g. «زبان» or "language", «پیکربندی» or "config"). The bot's command menu (the "/"
 * button) is set per language with setMyCommands, once per COMMANDS_REV; the owner's private chat
 * gets the owner commands as well.
 */
import { LANGS, OWNER_ID } from '../config.js';
import { defaultRights } from '../engines/rights.js';
import { aliasCommand, t } from '../i18n/index.js';
import * as kv from './kv.js';
import { tryCall } from './tg.js';
import { nowSec } from './util.js';

const SLASH = {
  start: 'start', help: 'help', language: 'language', lang: 'language',
  panel: 'panel', admin: 'panel', owner: 'panel', cancel: 'cancel', config: 'config', settings: 'config',
  status: 'status', shutdown: 'shutdown', activate: 'activate',
};
export const SLASH_NAMES = [...Object.keys(SLASH), 'rules', 'report', 'admins', 'mywarns', 'lockdown', 'readonly', 'fban', 'unfban'];
const PUBLIC = ['start', 'config', 'language', 'help'];
const OWNER = ['start', 'config', 'panel', 'status', 'shutdown', 'activate', 'language', 'help', 'cancel'];
export const COMMANDS_REV = '2';

/*
 * The command in a private message, or null. `aliases`: also accept plain words (off while an
 * input is pending, so a broadcast that happens to say "help" is still a broadcast).
 */
export function parseCommand(text, { aliases = true } = {}) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /^\/([^\s@]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s[\s\S]*)?$/.exec(s);
  if (m) return SLASH[m[1].toLowerCase()] || aliasCommand(m[1]) || 'unknown';
  if (!aliases || s.length > 40) return null;
  return aliasCommand(s);
}

/* The /start payload ("/start c_-100…" → "c_-100…"), or null. */
export function startPayload(text) {
  const m = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(String(text || '').trim());
  return m ? m[1] : null;
}

/* The bot named in "/command@bot" (lowercase), or null. */
export function mentionOf(text) {
  const m = /^\/[^\s@]{1,32}@([A-Za-z0-9_]+)/.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : null;
}

const menu = (lang, names) => names.map((c) => ({ command: c, description: t(lang, `cmd.${c}`).replace(/\u200F/g, '') }));

/*
 * The public command menu, per language (and English as the default), plus the admin rights Aegis
 * asks for by default when someone adds it as an admin to a group or a channel.
 */
export async function syncCommands(ctx) {
  const s = await kv.all(ctx);
  if (s.cmd_rev === COMMANDS_REV) return;
  /* A failed attempt is retried hourly, not on every message; a new revision is tried at once. */
  if (!(await kv.claim(`cmd_try_${COMMANDS_REV}`, nowSec(), 3600))) return;
  let ok = !!(await tryCall(ctx, 'setMyCommands', { commands: menu('en', PUBLIC), scope: { type: 'all_private_chats' } }, 'commands'));
  for (const lang of LANGS) {
    const r = await tryCall(ctx, 'setMyCommands', { commands: menu(lang, PUBLIC), scope: { type: 'all_private_chats' }, language_code: lang }, 'commands');
    ok = ok && !!r;
  }
  for (const forChannels of [false, true]) {
    const r = await tryCall(ctx, 'setMyDefaultAdministratorRights', { rights: defaultRights(forChannels), for_channels: forChannels }, 'default-rights');
    ok = ok && !!r;
  }
  if (ok) await kv.set(ctx, 'cmd_rev', COMMANDS_REV);
}

/* The owner's own menu (only possible once the owner has opened the bot's chat). */
export async function syncOwnerCommands(ctx, lang) {
  const s = await kv.all(ctx);
  const rev = `${COMMANDS_REV}:${lang}`;
  if (s.owner_cmd_rev === rev) return;
  const r = await tryCall(ctx, 'setMyCommands', { commands: menu(lang, OWNER), scope: { type: 'chat', chat_id: OWNER_ID } }, 'commands-owner');
  if (r) await kv.set(ctx, 'owner_cmd_rev', rev);
}
