/**
 * Forced-join decisions (pure): what a getChatMember answer means, which channels are missing.
 * (Adapted from wanger-music lib/forcejoin/gate.js.)
 */
import { classify } from './errors.js';

/** Member = creator, administrator, member, or restricted with is_member: true. */
export function isMemberStatus(m) {
  const s = m && m.status;
  if (s === 'creator' || s === 'administrator' || s === 'member') return true;
  if (s === 'restricted') return m.is_member === true;
  return false;
}

/**
 * One check's outcome from the result or the error.
 * @returns {{outcome: 'member'|'not_member'|'error', health: 'ok'|'bot_not_admin'|'not_found'|'error', transient: boolean}}
 */
export function outcomeOf(result, error) {
  if (!error) return { outcome: isMemberStatus(result) ? 'member' : 'not_member', health: 'ok', transient: false };
  const c = classify(error);
  if (c.kind === 'user_not_found') return { outcome: 'not_member', health: 'ok', transient: false };
  if (c.kind === 'chat_gone') return { outcome: 'error', health: 'not_found', transient: false };
  if (c.kind === 'no_rights') return { outcome: 'error', health: 'bot_not_admin', transient: false };
  return { outcome: 'error', health: 'error', transient: c.kind === 'rate_limit' || c.kind === 'transient' };
}

/**
 * Brief §6: a channel the bot can't check is skipped (users are not locked out).
 * @param {{channel: any, outcome: string}[]} results
 */
export function evaluate(results) {
  const missing = [];
  const broken = [];
  for (const r of results) {
    if (r.outcome === 'not_member') missing.push(r.channel);
    else if (r.outcome === 'error') broken.push(r.channel);
  }
  return { passed: missing.length === 0, missing, broken };
}

/** https://t.me/<username>, else the stored invite link, else null. */
export function joinUrl(ch) {
  if (ch.invite_link) return ch.invite_link;
  if (ch.username) return `https://t.me/${ch.username}`;
  return null;
}
