// Small pure helpers. Never imports `sdk`.
import { MB, TZ_OFFSET_S } from './config.js';

/** Escapes text for Telegram HTML (parse_mode HTML). */
export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** n Crockford base32 characters from a CSPRNG. */
export function randomCode(n) {
  const b = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += CROCKFORD[b[i] & 31];
  return out;
}

/** A ULID: 48-bit millisecond time + 80 random bits, 26 Crockford characters (sortable by time). */
export function ulid(nowMs = Date.now()) {
  let t = '';
  let ms = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) { t = CROCKFORD[ms % 32] + t; ms = Math.floor(ms / 32); }
  return t + randomCode(16);
}

/** Display code of a job: WC- + 6 Crockford characters (spec §2). */
export const jobCode = () => `WC-${randomCode(6)}`;
export const isJobCode = (s) => /^WC-[0-9A-HJKMNP-TV-Z]{6}$/.test(String(s || '').toUpperCase());

/** Short reference of a received file for callback_data. */
export const fileRef = () => randomCode(6);
export const isFileRef = (s) => /^[0-9A-HJKMNP-TV-Z]{6}$/.test(String(s || ''));

export const nowS = () => Math.floor(Date.now() / 1000);

/** Tehran calendar day 'YYYY-MM-DD' for a unix time in seconds. */
export function tehranDay(tS) {
  const d = new Date((tS + TZ_OFFSET_S) * 1000);
  return d.toISOString().slice(0, 10);
}

/** Unix seconds when the Tehran day containing tS started. */
export function tehranDayStart(tS) {
  return Math.floor((tS + TZ_OFFSET_S) / 86400) * 86400 - TZ_OFFSET_S;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const faDigits = (s) => String(s).replace(/[0-9]/g, (d) => FA_DIGITS[d]);

/** Persian / Arabic-Indic digits → ASCII (for parsing what users type). */
export const asciiDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));

/** "2.4 MB", "830 KB", "12 B". */
export function formatBytes(n) {
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** A short, log-safe description of an error (no stack, no secrets: Bot API descriptions only). */
export function errorText(err) {
  if (!err) return '';
  const code = typeof err.code === 'number' ? `${err.code} ` : '';
  return (code + String(err.description || err.message || err)).slice(0, 200);
}

/** Splits an array into chunks of n. */
export function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** djb2-style 32-bit hash → 8 hex characters (cache keys; not for security). */
export function hash32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}
