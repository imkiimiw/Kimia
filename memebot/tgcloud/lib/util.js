/*
 * Small helpers with no platform dependency: time, HTML escaping, truncation.
 * The isolate has no Intl, TextEncoder or Buffer, so everything here is plain JavaScript.
 */
import { TEHRAN_OFFSET } from './config.js';

/* Unix seconds. Date.now() does not move during one update on the platform. */
export const now = () => Math.floor(Date.now() / 1000);

/* The Tehran calendar day number of a unix time (changes at 00:00 Tehran time). */
export const tehranDay = (t) => Math.floor((t + TEHRAN_OFFSET) / 86400);

/* The hour (0-23) in Tehran. */
export const tehranHour = (t) => Math.floor(((t + TEHRAN_OFFSET) % 86400) / 3600);

/* Week number of a Tehran day; Iranian weeks start on Saturday (day 2 since 1970 was a Saturday). */
export const weekOfDay = (day) => Math.floor((day + 5) / 7);
export const tehranWeek = (t) => weekOfDay(tehranDay(t));
export const firstDayOfWeek = (week) => week * 7 - 5;

/* [year, month, day] of a Tehran day number, in the Gregorian calendar. */
export function gregorian(day) {
  const d = new Date(day * 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/* [year, month, day] in the Solar Hijri (Jalali) calendar; plain arithmetic, no Intl. */
export function jalali(day) {
  const [gy, gm, gd] = gregorian(day);
  const before = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + before[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = days < 186 ? 1 + (days % 31) : 1 + ((days - 186) % 30);
  return [jy, jm, jd];
}

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

/* Links, t.me addresses and @usernames (refused in keywords; dropped from AI suggestions). */
export const LINK_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.(me|dog)\/|tg:\/\/|@[a-z0-9_]{4,})/i;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* Base64 of a Uint8Array (no Buffer or btoa in the isolate). */
export function base64(bytes) {
  const out = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out.push(B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=');
  }
  return out.join('');
}
