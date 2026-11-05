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

/* ========== merged from core/csv.js ========== */
/*
 * CSV files for list exports, without TextEncoder (the isolate has none): utf8Bytes encodes by hand,
 * utf8Text decodes (a backup file to restore).
 * The file starts with a byte-order mark so spreadsheet apps read Persian/Chinese text correctly.
 */
export function utf8Bytes(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

/* Bytes → text (UTF-8, by hand: no TextDecoder in the isolate). Bad sequences become U+FFFD; a BOM is dropped. */
export function utf8Text(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = '';
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const cont = (k) => k < b.length && (b[k] & 0xc0) === 0x80;
  while (i < b.length) {
    const x = b[i];
    let c = 0xfffd;
    let n = 1;
    if (x < 0x80) c = x;
    else if (x >= 0xc2 && x < 0xe0 && cont(i + 1)) {
      c = ((x & 31) << 6) | (b[i + 1] & 63);
      n = 2;
    } else if (x >= 0xe0 && x < 0xf0 && cont(i + 1) && cont(i + 2)) {
      c = ((x & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63);
      n = 3;
    } else if (x >= 0xf0 && x < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      c = ((x & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
      n = 4;
    }
    out += String.fromCodePoint(c);
    i += n;
  }
  return out;
}

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csv(rows) {
  return `\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/* 2026-10-30 09:00 (UTC) for a unix second; '' for 0. */
export function isoMinute(sec) {
  if (!sec) return '';
  const d = new Date(Number(sec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
