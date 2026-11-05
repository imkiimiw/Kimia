// Small helpers with no platform dependencies. The runtime is a bare V8 isolate: no Buffer,
// TextEncoder, URL, Intl, atob or timers, so everything here is plain ECMAScript.
// Language-aware formatting (digits, durations, "5 minutes ago") is in lib/i18n.js.
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

/** Local (Tehran) date as YYYYMMDD, for the "whispers today" counter. */
export function localDay(sec = nowSec()) {
  const d = new Date((sec + TZ_OFFSET_MIN * 60) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Days since 1970-01-01 in Tehran time: the question of the day changes at local midnight. */
export function localDayIndex(sec = nowSec()) {
  return Math.floor((sec + TZ_OFFSET_MIN * 60) / 86400);
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

/** 32-bit FNV-1a of a string, as a non-negative integer (duplicate detection). */
export function hash32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) m[B64.charCodeAt(i)] = i;
  m['-'.charCodeAt(0)] = 62; // base64url too
  m['_'.charCodeAt(0)] = 63;
  return m;
})();

/** Decodes base64 (or a data: URL) to bytes; null if it isn't valid base64. */
export function base64ToBytes(input) {
  let s = String(input || '');
  const comma = s.startsWith('data:') ? s.indexOf(',') : -1;
  if (comma >= 0) s = s.slice(comma + 1);
  s = s.replace(/[\s=]+/g, '');
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j] = (buf >> bits) & 0xff;
      j += 1;
    }
  }
  return out.subarray(0, j);
}
