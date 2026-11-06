// Screens: pure functions returning { text, reply_markup } for lib/tg.js. Every button that exists
// here leads to something built (brief §2: no buttons for unbuilt features), and every screen except
// home has Back and Home (brief §8). Pure module: must not import 'sdk'.
import { CB, encode } from './codec.js';
import { CHANNEL_USERNAME, HISTORY_MAX, LANGS, PLATFORM_NAMES, QUALITIES, VERSION } from './config.js';
import { LANG_NAMES, t, tp } from './i18n/index.js';
import { clip } from './util.js';

const button = (text, data) => ({ text, callback_data: data });
const urlButton = (text, url) => ({ text, url });
const markup = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });

/** The Back + Home row; `back` is the parent screen's callback_data. */
const navRow = (lang, back = encode(CB.HOME)) => [button(tp(lang, 'btn.back'), back), button(tp(lang, 'btn.home'), encode(CB.HOME))];

/**
 * Language picker. On first run (no language yet) the prompt is shown in all three languages and
 * the language Telegram reports is marked; later it is in the user's language with Back and Home.
 * `from = 's'` when opened from Settings: choosing returns there, Back too.
 */
export function languagePicker({ current, preselected, from = null }) {
  const mark = current || preselected;
  const text = current ? t(current, 'lang.prompt') : LANGS.map((l) => t(l, 'lang.prompt')).join('\n');
  const pick = (l) => (from === 's' ? encode(CB.LANG_SET, l, 's') : encode(CB.LANG_SET, l));
  const rows = [LANGS.map((l) => button((l === mark ? '✓ ' : '') + LANG_NAMES[l], pick(l)))];
  if (current) rows.push(navRow(current, from === 's' ? encode(CB.SETTINGS) : encode(CB.HOME)));
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

/** First use: the user accepts responsibility for what they download (brief §6). */
export function disclaimer(lang) {
  return { text: t(lang, 'disclaimer.text'), reply_markup: markup([[button(tp(lang, 'btn.accept'), encode(CB.ACCEPT))]]) };
}

/** Main menu. There is no Download button until the download core exists (Phase 3). */
export function home(lang, name) {
  return {
    text: t(lang, 'welcome.text', { name }),
    reply_markup: markup([
      [button(tp(lang, 'btn.downloads'), encode(CB.HISTORY, 0)), button(tp(lang, 'btn.settings'), encode(CB.SETTINGS))],
      [button(tp(lang, 'btn.help'), encode(CB.HELP)), button(tp(lang, 'btn.about'), encode(CB.ABOUT))],
    ]),
  };
}

const STATUS_ICON = { ok: '✅', failed: '❌', denied: '⛔' };

/** "My downloads": one page of the latest HISTORY_MAX entries (items newest first). */
export function history(lang, { items, page, pages, total }) {
  const lines = [t(lang, 'history.title'), ''];
  if (!total) lines.push(t(lang, 'history.empty'));
  for (const it of items) {
    lines.push(t(lang, 'history.item', {
      icon: STATUS_ICON[it.status] || '•',
      date: formatTime(it.created_at),
      platform: PLATFORM_NAMES[it.platform] || it.platform || '?',
      url: clip(it.url || '', 90),
    }), '');
  }
  if (total) lines.push(t(lang, 'history.page', { page: page + 1, pages, max: HISTORY_MAX }));
  const pager = [];
  if (page > 0) pager.push(button(tp(lang, 'btn.prev'), encode(CB.HISTORY, page - 1)));
  if (page < pages - 1) pager.push(button(tp(lang, 'btn.next'), encode(CB.HISTORY, page + 1)));
  return { text: lines.join('\n').trim(), reply_markup: markup([pager, navRow(lang)]) };
}

export function settings(lang, quality) {
  return {
    text: t(lang, 'settings.text', { lang: LANG_NAMES[lang], quality: tp(lang, 'quality.' + quality) }),
    reply_markup: markup([
      [button(tp(lang, 'btn.language'), encode(CB.LANG_MENU, 's')), button(tp(lang, 'btn.quality'), encode(CB.QUALITY_MENU))],
      navRow(lang),
    ]),
  };
}

export function qualityPicker(lang, current) {
  const names = Object.fromEntries(QUALITIES.map((q) => [q, tp(lang, 'quality.' + q)]));
  return {
    text: t(lang, 'quality.text', names),
    reply_markup: markup([
      ...QUALITIES.map((q) => [button((q === current ? '✓ ' : '') + names[q], encode(CB.QUALITY_SET, q))]),
      navRow(lang, encode(CB.SETTINGS)),
    ]),
  };
}

export const help = (lang) => ({ text: t(lang, 'help.text'), reply_markup: markup([navRow(lang)]) });

export const about = (lang) => ({
  text: t(lang, 'about.text', { version: VERSION, channel: CHANNEL_USERNAME }),
  reply_markup: markup([navRow(lang)]),
});

export const plain = (lang, key, vars) => ({ text: t(lang, key, vars) });

/** "YYYY-MM-DD HH:MM" in Tehran time. */
export function formatTime(sec, offsetS = 3.5 * 3600) {
  const d = new Date((Number(sec) + offsetS) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "@name" or the title of a channel, for owner alerts (t() escapes it). */
export const channelLabel = (ch) => (ch.username ? '@' + ch.username : ch.title || String(ch.chat_id || ch.id));
