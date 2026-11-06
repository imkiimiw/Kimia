// Screens: pure functions returning { text, reply_markup } for lib/tg.js. Every button that exists
// here leads to something built (brief §2: no buttons for unbuilt features). Pure: no 'sdk' import.
import { CB, encode } from './codec.js';
import { LANGS } from './config.js';
import { LANG_NAMES, t, tp } from './i18n/index.js';

const button = (text, data) => ({ text, callback_data: data });
const urlButton = (text, url) => ({ text, url });
const markup = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });

/**
 * Language picker. On first run (no language yet) the prompt is shown in all three languages and
 * the language Telegram reports is marked; later it is in the user's language with a Home button.
 */
export function languagePicker({ current, preselected }) {
  const mark = current || preselected;
  const text = current ? t(current, 'lang.prompt') : LANGS.map((l) => t(l, 'lang.prompt')).join('\n');
  const rows = [LANGS.map((l) => button((l === mark ? '✓ ' : '') + LANG_NAMES[l], encode(CB.LANG_SET, l)))];
  if (current) rows.push([button(tp(current, 'btn.home'), encode(CB.HOME))]);
  return { text, reply_markup: markup(rows) };
}

/** The t.me link for a forced channel, or null when it has neither a username nor an invite link. */
export function channelUrl(ch) {
  if (ch.invite_link) return ch.invite_link;
  if (ch.username) return `https://t.me/${ch.username}`;
  return null;
}

/** Forced-join gate: one button per channel still to join (or not checkable), then "check again". */
export function joinGate(lang, { missing, unknown }) {
  const lines = [t(lang, 'join.text')];
  if (unknown.length) lines.push('', t(lang, 'join.unknown', { n: unknown.length }));
  const rows = [...missing, ...unknown]
    .map((ch) => {
      const url = channelUrl(ch);
      return url ? [urlButton(tp(lang, 'join.button', { title: ch.title || (ch.username ? '@' + ch.username : '…') }), url)] : [];
    });
  rows.push([button(tp(lang, 'btn.check_join'), encode(CB.JOIN_CHECK))]);
  return { text: lines.join('\n'), reply_markup: markup(rows) };
}

/** Phase 1 home: truthful about what exists; only the language button is offered. */
export function welcome(lang, name) {
  return {
    text: t(lang, 'welcome.text', { name }),
    reply_markup: markup([[button(tp(lang, 'btn.language'), encode(CB.LANG_MENU))]]),
  };
}

export const plain = (lang, key, vars) => ({ text: t(lang, key, vars) });

/** "YYYY-MM-DD HH:MM" in Tehran time, for ban end dates. */
export function formatTime(sec, offsetS = 3.5 * 3600) {
  const d = new Date((sec + offsetS) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "@name" or the title of a channel, for owner alerts (t() escapes it). */
export const channelLabel = (ch) => (ch.username ? '@' + ch.username : ch.title || String(ch.chat_id || ch.id));
