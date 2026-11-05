/*
 * Commands. Slash commands are English identifiers (Telegram allows only a-z, 0-9, _); the same
 * commands also work as plain words in any of our languages — Persian and English always — via
 * the "alias" locale namespace (e.g. «زبان» or "language", «پیکربندی» or "config"). The bot's command menu (the "/"
 * button) is set per language with setMyCommands, once per COMMANDS_REV; the owner's private chat
 * gets the owner commands as well.
 */
import { LANGS, OWNER_ID, REASON_MAX } from '../config.js';
import { defaultRights } from '../engines/rights.js';
import { aliasCommand, modCommand, t } from '../i18n/index.js';
import * as kv from './kv.js';
import { tryCall } from './tg.js';
import { nowSec, toInt } from './util.js';
import { asciiDigits, parseDuration } from './clock.js';

const SLASH = {
  start: 'start', help: 'help', language: 'language', lang: 'language',
  panel: 'panel', admin: 'panel', owner: 'panel', cancel: 'cancel', config: 'config', settings: 'config',
  status: 'status', shutdown: 'shutdown', activate: 'activate', appeal: 'appeal', staff: 'staff', team: 'staff',
};
export const SLASH_NAMES = [...Object.keys(SLASH), 'rules', 'report', 'admins', 'mywarns', 'lockdown', 'readonly', 'fban', 'unfban', 'me', 'top', 'give',
  'take', 'ask', 'anon'];
const PUBLIC = ['start', 'config', 'appeal', 'language', 'help'];
const OWNER = ['start', 'config', 'panel', 'staff', 'status', 'shutdown', 'activate', 'appeal', 'language', 'help', 'cancel'];
const STAFF = [...PUBLIC, 'staff'];
export const COMMANDS_REV = '4';

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

/* A member of the bot's team (Phase 10) gets /staff in their menu; removed, the menu goes back to the public one. */
export async function syncStaffCommands(ctx, userId, lang, on) {
  const scope = { type: 'chat', chat_id: userId };
  if (on) await tryCall(ctx, 'setMyCommands', { commands: menu(lang, STAFF), scope }, 'commands-staff');
  else await tryCall(ctx, 'deleteMyCommands', { scope }, 'commands-staff');
}

/* ========== merged from core/modparse.js ========== */
/*
 * Moderation commands typed in a group. Pure: no platform calls.
 *
 *   /ban [@user | id] [duration] [reason]        — or as a reply to the member's message
 *   «بن ۱ روز اسپم» (reply) · «سکوت @user 2h» · "mute 30m flood"
 *
 * Commands: warn, unwarn, warns, mute, unmute, restrict, unrestrict, kick, ban, unban. Slash forms
 * are English; plain words work in any of our languages (the "modcmd" locale namespace, up to three
 * words: «رفع سکوت»). A plain word counts only with a target (a reply, @user or an id) — the caller
 * checks that — so ordinary chat that happens to start with «بن» or "warn" is left alone.
 */
export const MOD_COMMANDS = ['warn', 'unwarn', 'warns', 'mute', 'unmute', 'restrict', 'unrestrict', 'kick', 'ban', 'unban'];
export const TIMED_COMMANDS = new Set(['mute', 'restrict', 'ban']);

/* { cmd, slash, mention, args } or null. */
export function parseModCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 1000) return null;
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) {
    const cmd = m[1].toLowerCase();
    if (!MOD_COMMANDS.includes(cmd)) return null;
    return { cmd, slash: true, mention: m[2] ? m[2].toLowerCase() : null, args: tokens.slice(1) };
  }
  for (let n = Math.min(3, tokens.length); n >= 1; n -= 1) {
    const cmd = modCommand(tokens.slice(0, n).join(' '));
    if (cmd && MOD_COMMANDS.includes(cmd)) return { cmd, slash: false, mention: null, args: tokens.slice(n) };
  }
  return null;
}

/*
 * The words after the command: an optional target (@username or a numeric id of 5+ digits), an
 * optional duration (mute, restrict, ban), and the rest as the reason.
 * { target: { id } | { username } | null, sec (null = none given), badDuration, reason }
 */
export function parseArgs(cmd, args) {
  let rest = args.slice();
  let target = null;
  const first = asciiDigits(rest[0] || '');
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(first)) {
    target = { username: first.slice(1) };
    rest = rest.slice(1);
  } else if (/^\d{5,16}$/.test(first) && toInt(first) !== null) {
    target = { id: toInt(first) };
    rest = rest.slice(1);
  }
  let sec = null;
  let badDuration = false;
  if (TIMED_COMMANDS.has(cmd) && rest.length) {
    const d = parseDuration(rest);
    if (d) {
      if (d.invalid) badDuration = true;
      else sec = d.sec;
      rest = rest.slice(d.used);
    }
  }
  const reason = [...rest.join(' ').trim()].slice(0, REASON_MAX).join('');
  return { target, sec, badDuration, reason: reason || null };
}
