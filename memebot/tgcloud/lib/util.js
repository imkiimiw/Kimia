/*
 * Small helpers with no platform dependency: time, HTML escaping, truncation.
 * The isolate has no Intl, TextEncoder or Buffer, so everything here is plain JavaScript.
 */
import { TEHRAN_OFFSET } from './config.js';

/* Unix seconds. Date.now() does not move during one update on the platform. */
export const now = () => Math.floor(Date.now() / 1000);

/* The Tehran calendar day number of a unix time (changes at 00:00 Tehran time). */
export const tehranDay = (t) => Math.floor((t + TEHRAN_OFFSET) / 86400);

/* Escapes text for parse_mode HTML. */
export function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Escaped user text wrapped in a bidi isolate, so Latin text inside Persian (or the reverse) can't
   flip the direction of the sentence around it. */
export const iso = (s) => '\u2068' + esc(s) + '\u2069';

/* Truncates to n code points (not UTF-16 units, so an emoji is never cut in half). */
export function cut(s, n) {
  const chars = Array.from(String(s || ''));
  return chars.length <= n ? chars.join('') : chars.slice(0, Math.max(0, n - 1)).join('') + '\u2026';
}

export const charCount = (s) => Array.from(String(s || '')).length;

/* UTF-8 byte length (the Bot API counts callback_data and next_offset in bytes). */
export function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/* Parses a JSON string, or returns null. */
export function parseJson(s) {
  if (typeof s !== 'string' || !s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}
