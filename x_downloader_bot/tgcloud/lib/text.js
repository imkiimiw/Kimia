// Small text helpers: Persian digits, HTML escaping, truncation, sizes and dates.
import { TZ_OFFSET_MIN } from './config.js';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Number or string with Western digits shown as Persian digits. */
export function fa(value) {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[d]);
}

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII, for parsing what the owner types. */
export function asciiDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Escapes text for parse_mode HTML. */
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One line, at most `max` characters (code points), with an ellipsis when cut. */
export function short(s, max) {
  const chars = [...String(s || '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/**
 * Cuts `s` to at most `max` UTF-16 units (what Telegram counts for the 1024-unit caption limit),
 * never splitting a surrogate pair, adding "…" when cut.
 */
export function clip(s, max) {
  const str = String(s || '');
  if (str.length <= max) return str;
  if (max <= 1) return '';
  let out = '';
  for (const ch of str) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** 4977071 -> "۴٫۷ مگابایت"; small files in KB. */
export function size(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${fa(Math.max(1, Math.round(n / 1024)))} کیلوبایت`;
  return `${fa((n / (1024 * 1024)).toFixed(1).replace('.', '٫'))} مگابایت`;
}

/** Short size for buttons: "4.7MB". */
export function sizeShort(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Today's date in Iran time, YYYY-MM-DD. */
export function today(ms = Date.now()) {
  return new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** "۵ دقیقه پیش" style relative time. */
export function ago(unixSec) {
  const d = Math.max(0, nowSec() - Number(unixSec || 0));
  if (d < 60) return 'همین الان';
  if (d < 3600) return `${fa(Math.floor(d / 60))} دقیقه پیش`;
  if (d < 86400) return `${fa(Math.floor(d / 3600))} ساعت پیش`;
  return `${fa(Math.floor(d / 86400))} روز پیش`;
}
