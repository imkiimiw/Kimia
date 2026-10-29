// Small helpers with no platform dependencies. The runtime is a bare V8 isolate: no Buffer,
// TextEncoder, URL, Intl or timers, so everything here is plain ECMAScript.
import { TZ_OFFSET_MIN } from './config.js';

export const nowSec = () => Math.floor(Date.now() / 1000);

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A random [0-9A-Za-z] id: safe in callback_data, start parameters and /commands. */
export function randomId(length = 8) {
  let bytes = null;
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      bytes = crypto.getRandomValues(new Uint8Array(length));
    }
  } catch {
    bytes = null;
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const n = bytes ? bytes[i] : Math.floor(Math.random() * 256);
    out += ID_CHARS[n % ID_CHARS.length];
  }
  return out;
}

export const isId = (s, min = 8, max = 9) => typeof s === 'string' && s.length >= min && s.length <= max && /^[0-9A-Za-z]+$/.test(s);

/** Escapes text for parse_mode HTML. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** A number with Persian digits. */
export function fa(n) {
  return String(n).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** Persian and Arabic-Indic digits → ASCII. */
export function toAsciiDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Shortens to at most `max` UTF-16 units, cutting at a code point boundary. */
export function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  let cut = max - 1;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair
  return `${str.slice(0, cut)}…`;
}

/** UTF-8 length in bytes (callback_data and start parameters are limited in bytes). */
export function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** "1h30m"-style duration in Persian words: ۱ ساعت و ۳۰ دقیقه. */
export function faDuration(sec) {
  let s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${fa(d)} روز`);
  if (h) parts.push(`${fa(h)} ساعت`);
  if (m) parts.push(`${fa(m)} دقیقه`);
  if (!parts.length) parts.push('کمتر از یک دقیقه');
  return parts.join(' و ');
}

/** "۵ دقیقه پیش" for a past unix time. */
export function faAgo(at, now = nowSec()) {
  const diff = Math.max(0, now - at);
  if (diff < 60) return 'همین الان';
  if (diff < 3600) return `${fa(Math.floor(diff / 60))} دقیقه پیش`;
  if (diff < 86400) return `${fa(Math.floor(diff / 3600))} ساعت پیش`;
  return `${fa(Math.floor(diff / 86400))} روز پیش`;
}

/** Local (Tehran) date as YYYYMMDD, for the "whispers today" counter. */
export function localDay(sec = nowSec()) {
  const d = new Date((sec + TZ_OFFSET_MIN * 60) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** JSON.parse that returns `fallback` instead of throwing. */
export function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** A user's display name for HTML: "@username" if any, else the first name, else the id. */
export function displayName(u) {
  if (!u) return '';
  if (u.username) return `@${u.username}`;
  if (u.first_name || u.firstName) return u.first_name || u.firstName;
  return String(u.id || u.user_id || '');
}
