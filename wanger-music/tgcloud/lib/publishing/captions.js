// Caption templates (pure, spec §10.5): used for inline results now (Phase 3) and for channel
// posts in Phase 5. Values are HTML-escaped; a line whose variables are all empty is dropped;
// the result stays within 1024 characters (title / album are shortened with "…" first).
import { esc } from '../telegram/html.js';

export const CAPTION_VARS = Object.freeze(['title', 'artist', 'album', 'duration', 'language', 'genre', 'source', 'artist_tag', 'bot_link', 'channel']);
export const CAPTION_MAX = 1024;
export const DEFAULT_TEMPLATE = '🎵 {title}\n👤 {artist}\n💿 {album}\n⏱ {duration}';

const VAR = /\{([a-z_]+)\}/g;

/** Unknown variables in a template (empty array = valid). */
export function unknownVariables(template) {
  return [...new Set([...String(template || '').matchAll(VAR)].map((m) => m[1]).filter((v) => !CAPTION_VARS.includes(v)))];
}

/** #Artist_Name: spaces → _, ZWNJ and punctuation removed. */
export function artistTag(artist) {
  const s = String(artist || '').replace(/\u200c/g, '').replace(/[^\p{L}\p{N}\s_]/gu, '').trim().replace(/\s+/g, '_');
  return s ? `#${s}` : '';
}

const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

/** Plain values of a track for a template (before escaping). */
export function captionValues(track, { botUsername, languageName = (l) => l, genreName = (g) => g, sourceName = '', channel = '' }) {
  return {
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    duration: mmss(track.duration),
    language: track.language && track.language !== 'unknown' ? languageName(track.language) : '',
    genre: track.genre ? genreName(track.genre) : '',
    source: sourceName || '',
    artist_tag: artistTag(track.artist),
    bot_link: track.public_id && botUsername ? `https://t.me/${botUsername}?start=t_${track.public_id}` : '',
    channel,
  };
}

function fill(template, values) {
  const lines = [];
  for (const line of String(template).split('\n')) {
    const vars = [...line.matchAll(VAR)].map((m) => m[1]);
    if (vars.length && vars.every((v) => !values[v])) continue;
    lines.push(line.replace(VAR, (m, v) => (v in values ? esc(values[v]) : m)));
  }
  return lines.join('\n').trim();
}

const shorten = (s, n) => (Array.from(s).length > n ? Array.from(s).slice(0, Math.max(1, n - 1)).join('') + '…' : s);

/** '@username' of a channel (Telegram makes it a link), or '' for a private channel. @param {{username?: string|null}} ch */
export const channelHandle = (ch) => (ch && ch.username ? `@${ch.username}` : '');

/** The last line of a channel's captions, when its signature switch is on. @param {{username?: string|null, signature?: number}} ch */
export const channelSignature = (ch) => (ch && ch.signature !== 0 && ch.username ? `🆔 @${ch.username}` : '');

/**
 * @param {string} template owner-written HTML with {variables}
 * @param {Record<string, string>} values from captionValues()
 * @param {number} [max]
 * @param {string} [signature] a last line kept whole (the rest is shortened to make room); skipped when
 *   the template places {channel} itself
 * @returns {string}
 */
export function renderCaption(template, values, max = CAPTION_MAX, signature = '') {
  const sig = signature && !/\{channel\}/.test(String(template)) ? esc(signature) : '';
  const room = sig ? max - sig.length - 2 : max;
  const done = (body) => (sig ? (body ? `${body}\n\n${sig}` : sig) : body);
  let out = fill(template, values);
  for (const limit of [120, 60, 30, 10]) {
    if (out.length <= room) return done(out);
    out = fill(template, { ...values, title: shorten(values.title, limit), album: shorten(values.album, limit) });
  }
  return done(out.length <= room ? out : Array.from(out).slice(0, room - 1).join('') + '…');
}
