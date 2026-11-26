// Small helpers with no platform dependencies. The runtime is a bare V8 isolate: no Buffer,
// TextEncoder, URL, Intl, atob or timers, so everything here is plain ECMAScript.
import { TZ_OFFSET_MIN } from './config.js';

export const nowSec = () => Math.floor(Date.now() / 1000);

const ID_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O: codes people type

/** A random code of capital letters and digits (discount codes, refs). */
export function randomCode(length = 8) {
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

/** Escapes text for parse_mode HTML. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Persian and Arabic-Indic digits → ASCII. */
export function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** ASCII digits → Persian digits, with a thousands separator for numbers. */
export function fa(value) {
  let s = String(value == null ? '' : value);
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) >= 1000) {
    s = String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  }
  return s.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/** Shortens to at most `max` UTF-16 units, cutting at a code point boundary. */
export function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  let cut = max - 1;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${str.slice(0, cut)}…`;
}

/** UTF-8 length in bytes (callback_data is limited in bytes). */
export function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
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

/** Local (Tehran) date as the number YYYYMMDD. */
export function localDay(sec = nowSec()) {
  const d = new Date((sec + TZ_OFFSET_MIN * 60) * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Text for search: lowercase, Arabic letters unified, no diacritics or zero-width marks, ZWNJ → space. */
export function normalize(s) {
  return toAsciiDigits(String(s || ''))
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ی')
    .replace(/[ً-ٰٟـ]/g, '') // harakat, tatweel
    .replace(/[‌]/g, ' ') // ZWNJ: "می‌خوام" → "می خوام"
    .replace(/[​‍-‏⁠﻿]/g, '')
    .replace(/[.,!?؟،؛;:()[\]{}"'«»…\-_/\\|*+=<>@#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Jalali calendar (the jalaali-js algorithm, after Borkowski) ----------

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a, b) => ~~(a / b);
const mod = (a, b) => a - ~~(a / b) * b;

function jalCal(jy) {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j += div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function toJalali(gy, gm, gd) {
  const jdn = g2d(gy, gm, gd);
  let jy = d2g(jdn).gy - 621;
  const r = jalCal(jy);
  let k = jdn - g2d(r.gy, 3, r.march);
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

/** The Tehran-local Jalali date of a moment. */
export function jalaliOf(sec = nowSec()) {
  const d = new Date((sec + TZ_OFFSET_MIN * 60) * 1000);
  return toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export const jalaliMonthName = (jm) => MONTHS[jm - 1] || '';

/** "۵ آذر ۱۴۰۵" (and the time with `withTime`). */
export function formatDate(sec, withTime = false) {
  if (!sec) return '—';
  const j = jalaliOf(sec);
  let s = `${fa(j.jd)} ${MONTHS[j.jm - 1]} ${fa(String(j.jy))}`;
  if (withTime) {
    const d = new Date((sec + TZ_OFFSET_MIN * 60) * 1000);
    s += `، ${fa(String(d.getUTCHours()).padStart(2, '0'))}:${fa(String(d.getUTCMinutes()).padStart(2, '0'))}`;
  }
  return s;
}

/** "۵ دقیقه پیش", "۲ ساعت پیش", "۳ روز پیش". */
export function ago(sec, now = nowSec()) {
  if (!sec) return 'هرگز';
  const d = Math.max(0, now - sec);
  if (d < 60) return 'همین الان';
  if (d < 3600) return `${fa(Math.floor(d / 60))} دقیقه پیش`;
  if (d < 86400) return `${fa(Math.floor(d / 3600))} ساعت پیش`;
  return `${fa(Math.floor(d / 86400))} روز پیش`;
}

/** "۲ ساعت", "۳ روز", "۴۵ دقیقه". */
export function duration(sec) {
  const d = Math.max(0, Math.round(sec));
  if (d < 3600) return `${fa(Math.max(1, Math.round(d / 60)))} دقیقه`;
  if (d < 86400) return `${fa(Math.round(d / 3600))} ساعت`;
  return `${fa(Math.round(d / 86400))} روز`;
}

/** "5h", "2d", "30m", "1w" (Persian or ASCII digits; Persian units too) → seconds, or null. */
export function parseDuration(input) {
  const s = normalize(input).replace(/\s+/g, '');
  const m = /^(\d{1,4})(m|min|دقیقه|h|ساعت|d|روز|w|هفته)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60, min: 60, دقیقه: 60, h: 3600, ساعت: 3600, d: 86400, روز: 86400, w: 604800, هفته: 604800 }[m[2]];
  return n > 0 ? n * unit : null;
}
