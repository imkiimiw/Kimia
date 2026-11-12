/**
 * t(lang, key, vars): every user-facing text (pure). String vars are HTML-escaped; numbers get
 * Persian digits in Persian. raw() inserts ready-made HTML. tp() is the plain variant for button
 * labels and toasts. (Adapted from wanger-music lib/i18n/index.js.)
 */
import fa from './fa.js';
import en from './en.js';
import { esc } from '../core/html.js';

export const DICTS = Object.freeze({ fa, en });

/** @returns {'fa'|'en'} */
export const normLang = (lang) => (lang === 'en' ? 'en' : 'fa');

export const raw = (html) => ({ __html: String(html) });

/** Digits in the language's script. */
export function digits(n, lang) {
  const s = String(n);
  return normLang(lang) === 'fa' ? s.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d))) : s;
}

function fill(lang, key, vars, escape) {
  const l = normLang(lang);
  const s = DICTS[l][key] ?? DICTS.fa[key];
  if (s === undefined) return key;
  return s.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object' && '__html' in v) return escape ? v.__html : String(v.__html).replace(/<[^>]+>/g, '');
    if (typeof v === 'number') return digits(v, l);
    return escape ? esc(v) : String(v);
  });
}

export const t = (lang, key, vars = {}) => fill(lang, key, vars, true);
export const tp = (lang, key, vars = {}) => fill(lang, key, vars, false);

/** Gregorian → Jalali (from wanger-music lib/core/util.js). */
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

const pad = (n) => String(n).padStart(2, '0');

/** Date (+ time) in Tehran time: Jalali for Persian, ISO-like for English. */
export function dateText(ts, lang, withTime = true) {
  if (!ts) return t(lang, 'common.never');
  const d = new Date((ts + 210 * 60) * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const time = withTime ? ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : '';
  if (normLang(lang) === 'fa') {
    const [jy, jm, jd] = toJalali(y, m, day);
    return digits(`${jy}/${pad(jm)}/${pad(jd)}${time}`, 'fa');
  }
  return `${y}-${pad(m)}-${pad(day)}${time}`;
}
