/**
 * Small pure helpers: the UserError type, random ids, text limits, numbers, days. No 'sdk'.
 * (Adapted from wanger-music lib/core/util.js.)
 */

/** An expected refusal shown to the person as an i18n text (not logged as an error). */
export class UserError extends Error {
  /** @param {string} key i18n key @param {Record<string, any>} [vars] */
  constructor(key, vars = {}) {
    super(key);
    this.name = 'UserError';
    this.key = key;
    this.vars = vars;
  }
}

/** A permission refusal (never shown with details). */
export class PermissionError extends Error {
  constructor(what = 'denied') {
    super(what);
    this.name = 'PermissionError';
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** @param {number} n @returns {Uint8Array} */
function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = /** @type {any} */ (globalThis).crypto;
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(out);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Random id of A-Z a-z 0-9 (unbiased). @param {number} [length] */
export function randomId(length = 10) {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 248) continue;
      out += ALPHABET[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** UTF-8 byte length. @param {string} s */
export function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Number of characters as Telegram counts them (UTF-16 code units). @param {string} s */
export const tgLength = (s) => String(s ?? '').length;

/** Cuts to `max` code points, adding "…" when cut. @param {any} s @param {number} max */
export function truncate(s, max) {
  const chars = Array.from(String(s ?? ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Persian/Arabic digits → ASCII. @param {any} s */
export function asciiDigits(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** An integer in [min, max] from text (Persian digits allowed), else null. */
export function parseIntInRange(v, min, max) {
  const s = asciiDigits(v).trim();
  if (!/^-?\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** Base-36 of a non-negative safe integer. @param {number} n */
export const base36 = (n) => Math.max(0, Math.floor(n)).toString(36);

/**
 * The local day YYYYMMDD for a unix time, in a fixed UTC offset (Tehran = +210 min, no DST since
 * 2022). A fixed offset needs no Intl, which the runtime has not always had.
 * @param {number} ts unix seconds @param {number} [offsetMin]
 */
export function dayKey(ts, offsetMin = 210) {
  const d = new Date((ts + offsetMin * 60) * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Start of the local day of `ts` (unix seconds). */
export function dayStart(ts, offsetMin = 210) {
  const local = ts + offsetMin * 60;
  return local - (((local % 86400) + 86400) % 86400) - offsetMin * 60;
}

/** Safe JSON parse with a fallback. */
export function parseJson(s, fallback = null) {
  if (s === null || s === undefined || s === '') return fallback;
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** Clamps a number. */
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
