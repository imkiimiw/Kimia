/*
 * Small helpers with no platform dependencies: time, HTML escaping, text shortening, bidi
 * isolation, Persian text normalization. The isolate has no Intl, URL, TextEncoder or timers.
 */

export const nowSec = () => Math.floor(Date.now() / 1000);

/* Unix second when the current day started, in a fixed UTC offset (minutes). */
export function dayStart(nowS, offsetMin) {
  const local = nowS + offsetMin * 60;
  return local - (local % 86400) - offsetMin * 60;
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* At most `max` characters (by UTF-16 unit, never splitting a surrogate pair), with an ellipsis. */
export function short(s, max = 32) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  let cut = max - 1;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${str.slice(0, cut)}…`;
}

/*
 * User-supplied text (names, titles) inside a message: escaped, shortened and wrapped in Unicode
 * first-strong isolates, so a Latin name can't flip a Persian line or the other way round.
 */
export const FSI = '\u2068';
export const PDI = '\u2069';
export const RLM = '\u200F';
export const iso = (s, max = 32) => `${FSI}${esc(short(s, max))}${PDI}`;

export function fullName(u) {
  if (!u) return '';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : String(u.id || ''));
}

/* Normalizes typed words for alias matching: Arabic → Persian letters, no ZWNJ/tatweel, lowercase. */
export function normalizeWord(s) {
  return String(s == null ? '' : s)
    .replace(/[\u064A\u0649]/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u200C\u200D\u0640\u200E\u200F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);

/* A positive/negative integer from a callback_data or text fragment, else null. */
export function toInt(s) {
  if (typeof s === 'number') return Number.isSafeInteger(s) ? s : null;
  if (!/^-?\d{1,16}$/.test(String(s == null ? '' : s))) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/* JSON.parse that gives `fallback` instead of throwing. */
export function parseJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

/* UTF-8 byte length (callback_data is limited to 64 bytes). */
export function utf8Length(s) {
  let n = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}
