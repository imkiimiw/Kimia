// Small pure helpers: random public ids, time/zone math, text limits, the UserError type.
// Pure: imports only other pure modules, never `sdk`.
import { TIME_ZONES } from '../config/static.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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

/** @param {number} n @returns {Uint8Array} */
function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = /** @type {any} */ (globalThis).crypto;
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(out);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Random id of A-Z a-z 0-9 (unbiased). @param {number} [length] @returns {string} */
export function randomId(length = 9) {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 248) continue; // 248 = 62 * 4 → no modulo bias
      out += ALPHABET[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** UTF-8 byte length (callback_data and other byte limits). @param {string} s */
export function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Cuts to `max` characters (code points), adding "…" when cut. @param {any} s @param {number} max */
export function truncate(s, max) {
  const chars = Array.from(String(s ?? ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** @param {any} v @param {number} min @param {number} max @returns {number|null} */
export function parseIntInRange(v, min, max) {
  const s = String(v ?? '').trim().replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!/^-?\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** @type {Map<string, any>} best-effort per-isolate formatter cache */
const formatters = new Map();

/** Offset of `tz` from UTC in seconds at unix time `ts`. Uses Intl when present, else a fixed table. */
export function tzOffsetSeconds(tz, ts) {
  const I = /** @type {any} */ (globalThis).Intl;
  if (I && typeof I.DateTimeFormat === 'function') {
    try {
      let f = formatters.get(tz);
      if (!f) {
        f = new I.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        formatters.set(tz, f);
      }
      /** @type {Record<string, string>} */
      const p = {};
      for (const part of f.formatToParts(new Date(ts * 1000))) p[part.type] = part.value;
      const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) / 1000;
      return Math.round(asUtc - ts);
    } catch {
      // unknown zone in this runtime: fall through to the table
    }
  }
  return /** @type {Record<string, number>} */ (TIME_ZONES)[tz] ?? 0;
}

/** Wall-clock parts of `ts` in `tz`. @returns {{y:number,m:number,d:number,hh:number,mm:number}} */
export function localParts(ts, tz) {
  const d = new Date((ts + tzOffsetSeconds(tz, ts)) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}

/** Gregorian → Solar Hijri (Jalali), the jdf algorithm; plain arithmetic. @returns {[number, number, number]} */
export function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

/** @param {number} n @param {number} [w] */
export const pad = (n, w = 2) => String(n).padStart(w, '0');
