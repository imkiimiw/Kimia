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
import { REASON_MAX } from '../config.js';
import { modCommand } from '../i18n/index.js';
import { asciiDigits, parseDuration } from './duration.js';
import { toInt } from './util.js';

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
