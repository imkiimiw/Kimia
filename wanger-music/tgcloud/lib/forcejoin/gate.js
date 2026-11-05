// Force-join decisions (pure): what a getChatMember answer means, which channels are missing,
// what the join message and the inline-mode gate look like.
import { t, tp } from '../i18n/index.js';
import { btn, urlBtn, markup } from '../bot/keyboards.js';
import { classify } from '../telegram/errors.js';

/**
 * Member = creator, administrator, member, or restricted with is_member: true.
 * @param {any} chatMember @returns {boolean}
 */
export function isMemberStatus(chatMember) {
  const s = chatMember && chatMember.status;
  if (s === 'creator' || s === 'administrator' || s === 'member') return true;
  if (s === 'restricted') return chatMember.is_member === true;
  return false;
}

/**
 * Outcome of one membership check, from the getChatMember result or its error.
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
 * @param {{channel: any, outcome: string}[]} results
 * @param {'open'|'closed'} failureMode open: a channel that can't be checked is skipped; closed: counts as not joined
 * @returns {{passed: boolean, missing: any[], broken: any[]}}
 */
export function evaluate(results, failureMode) {
  const missing = [];
  const broken = [];
  for (const r of results) {
    if (r.outcome === 'not_member') missing.push(r.channel);
    else if (r.outcome === 'error') {
      broken.push(r.channel);
      if (failureMode === 'closed') missing.push(r.channel);
    }
  }
  return { passed: missing.length === 0, missing, broken };
}

/** https://t.me/<username>, else the stored invite link, else null. */
export function joinUrl(channel) {
  if (channel.username) return `https://t.me/${channel.username}`;
  return channel.invite_link || null;
}

/** The join message: one URL button per missing channel and «✅ عضو شدم». */
export function joinView(missing, lang) {
  const rows = missing.map((ch) => {
    const url = joinUrl(ch);
    return url ? [urlBtn(tp(lang, 'fj.btn_join', { title: ch.title || ch.username || 'Channel' }), url)] : [];
  });
  rows.push([btn(tp(lang, 'fj.btn_joined'), 'fj', 'check')]);
  return { text: t(lang, 'fj.prompt'), keyboard: markup(rows) };
}

/** answerInlineQuery parameters for a user who hasn't passed force-join. */
export function inlineGateAnswer(inlineQueryId, lang) {
  return {
    inline_query_id: inlineQueryId,
    results: [],
    is_personal: true,
    cache_time: 0,
    button: { text: tp(lang, 'fj.inline_button'), start_parameter: 'join' },
  };
}
