// Screens: pure functions returning { text, reply_markup } for lib/tg.js. Every button that exists
// here leads to something built (brief §2: no buttons for unbuilt features), and every screen except
// home has Back and Home (brief §8). Pure module: must not import 'sdk'.
import { CB, encode } from './codec.js';
import { BOT_USERNAME, CAPTION_MAX, CHANNEL_USERNAME, HISTORY_MAX, LANGS, PLATFORM_NAMES, QUALITIES, VERSION } from './config.js';
import { LANG_NAMES, t, tp } from './i18n/index.js';
import { clip, esc } from './util.js';

export const button = (text, data) => ({ text, callback_data: data });
export const urlButton = (text, url) => ({ text, url });
export const markup = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });

/** The Back + Home row; `back` is the parent screen's callback_data. */
export const navRow = (lang, back = encode(CB.HOME)) => [button(tp(lang, 'btn.back'), back), button(tp(lang, 'btn.home'), encode(CB.HOME))];

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
export function joinGate(lang, { missing, unknown }, custom = null) {
  const lines = [custom ? customText(custom, '') : t(lang, 'join.text')];
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

/** An owner-edited text (plain, escaped here) with {name} filled in. */
export const customText = (text, name) => esc(text).replace(/\{name\}/g, esc(name || ''));

/** Main menu. `custom` = the staff-edited welcome text for this language (Phase 4), if any. */
export function home(lang, name, { staff = false, custom = null } = {}) {
  return {
    text: custom ? customText(custom, name) : t(lang, 'welcome.text', { name }),
    reply_markup: markup([
      [button(tp(lang, 'btn.download'), encode(CB.DOWNLOAD))],
      [button(tp(lang, 'btn.downloads'), encode(CB.HISTORY, 0)), button(tp(lang, 'btn.settings'), encode(CB.SETTINGS))],
      [button(tp(lang, 'btn.help'), encode(CB.HELP)), button(tp(lang, 'btn.about'), encode(CB.ABOUT))],
      staff ? [button(tp(lang, 'btn.admin'), encode(CB.ADMIN))] : [],
    ]),
  };
}

/** The platforms users can download from right now, one line each. */
export function platformLines(lang, ids) {
  return ids.length ? ids.map((id) => t(lang, 'platform.' + id)).join('\n') : t(lang, 'platforms.none');
}

/** "How to download" (the menu's Download button). */
export function downloadInfo(lang, ids) {
  const text = ids.length ? t(lang, 'download.text').replace('{platforms}', platformLines(lang, ids)) : t(lang, 'download.none');
  return { text, reply_markup: markup([navRow(lang)]) };
}

/**
 * A media caption (Telegram HTML, ≤ 1024 characters): the post's text, its author, the platform
 * and the source link — always (brief §6) — then notes. The link sits on its own line (brief §4).
 */
export function caption(lang, post, notes = []) {
  const tail = [];
  if (post.author) tail.push('👤 ' + esc(post.author));
  tail.push(t(lang, 'dl.source', { platform: PLATFORM_NAMES[post.platform] || post.platform }));
  tail.push(esc(post.url));
  for (const n of notes) tail.push(t(lang, 'dl.note.' + n));
  tail.push('@' + BOT_USERNAME);
  const rest = tail.join('\n');
  const text = String(post.title || '').replace(/https?:\/\/t\.co\/\S+/g, '').trim();
  const details = post.details ? clip(String(post.details).trim(), 200) : '';
  const room = CAPTION_MAX - rest.length - 2 - (details ? details.length + 1 : 0);
  const head = [text && room > 20 ? esc(clip(text, Math.min(room, 600))) : '', esc(details)].filter(Boolean).join('\n');
  const out = head ? `${head}\n\n${rest}` : rest;
  return out.length <= CAPTION_MAX ? out : out.slice(0, CAPTION_MAX);
}

export const STATUS_ICON = { ok: '✅', meta: 'ℹ️', failed: '❌', denied: '⛔' };

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

export const help = (lang, ids = []) => ({
  text: t(lang, 'help.text').replace('{platforms}', platformLines(lang, ids)),
  reply_markup: markup([navRow(lang)]),
});

// ---- owner panel (Phase 3: platforms) -------------------------------------------------------

const METHOD_ICON = { true: '🟢', false: '⚪' };
export const platformStateKey = (adapter, state) => (state.paused ? 'paused' : adapter.methodOrder.some((m) => state.methods[m] === true) ? 'on' : 'off');

/** Buttons two per row. */
export function pairs(buttons, n = 2) {
  const out = [];
  for (let i = 0; i < buttons.length; i += n) out.push(buttons.slice(i, i + n));
  return out;
}

/** The list of built platforms with their state; unbuilt ones are named, without buttons. */
export function adminPlatforms(lang, rows, notBuilt) {
  const lines = [t(lang, 'admin.title')];
  if (notBuilt.length) lines.push('', t(lang, 'admin.not_built', { list: notBuilt.map((id) => PLATFORM_NAMES[id] || id).join(', ') }));
  return {
    text: lines.join('\n'),
    reply_markup: markup([
      ...pairs(rows.map(({ adapter, state }) => button(`${tp(lang, 'admin.state.' + platformStateKey(adapter, state))} · ${adapter.name}`, encode(CB.PLATFORM, adapter.id)))),
      [button(tp(lang, 'adm.btn.blocklist'), encode(CB.ADMIN, 'pb')), button(tp(lang, 'adm.btn.purge'), encode(CB.ADMIN, 'pc'))],
      navRow(lang, encode(CB.ADMIN)),
    ]),
  };
}

/** One platform: capability, each method (on/off, or why it can't be used), pause and health. */
export function adminPlatform(lang, adapter, state, healthLine = null) {
  const caps = adapter.capabilities();
  const lines = [t(lang, 'admin.platform', {
    platform: adapter.name, state: tp(lang, 'admin.state.' + platformStateKey(adapter, state)), status: tp(lang, 'status.' + caps.status),
  }), ''];
  const rows = [];
  for (const m of adapter.methodOrder) {
    const on = state.methods[m] === true;
    lines.push(t(lang, 'admin.method_line', { icon: METHOD_ICON[on], method: tp(lang, 'method.' + m) }));
    rows.push([button(tp(lang, on ? 'admin.btn.disable' : 'admin.btn.enable', { method: tp(lang, 'method.' + m) }), encode(CB.METHOD, adapter.id, m, on ? '0' : '1'))]);
  }
  for (const [m, st] of Object.entries(caps.methods)) {
    if (!adapter.methodOrder.includes(m)) lines.push(t(lang, 'admin.method_na', { method: tp(lang, 'method.' + m), status: tp(lang, 'status.' + st) }));
  }
  if (healthLine) lines.push('', healthLine);
  rows.push([
    button(tp(lang, state.paused ? 'admin.btn.resume' : 'admin.btn.pause'), encode(CB.PAUSE, adapter.id, state.paused ? '0' : '1')),
    button(tp(lang, 'admin.btn.health'), encode(CB.HEALTH, adapter.id)),
  ]);
  rows.push([button(tp(lang, 'adm.btn.failures'), encode(CB.ADMIN, 'pe', adapter.id))]);
  rows.push(navRow(lang, encode(CB.ADMIN, 'p')));
  return { text: lines.join('\n'), reply_markup: markup(rows) };
}

/** The risk note shown before a `public`/`thirdparty`/`external` method is switched on (brief §6). */
export function adminRisk(lang, adapter, method) {
  const notes = (adapter.riskNotes && adapter.riskNotes[method]) || {};
  return {
    text: t(lang, 'admin.risk', { method: tp(lang, 'method.' + method), platform: adapter.name, note: notes[lang] || notes.en || '' }),
    reply_markup: markup([
      [button(tp(lang, 'admin.btn.confirm'), encode(CB.CONFIRM, adapter.id, method)), button(tp(lang, 'admin.btn.cancel'), encode(CB.PLATFORM, adapter.id))],
    ]),
  };
}

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
