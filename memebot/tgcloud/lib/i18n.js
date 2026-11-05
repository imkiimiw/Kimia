/*
 * Texts in the user's language. t(lang, key, vars) looks the key up in lib/locales/<lang>.js
 * (falling back to the default language), picks a plural form by {n} when the value is an object, and
 * fills {placeholders}: numbers get the language's digits, strings go in as given — callers
 * escape user content (the texts are Telegram HTML).
 */
import { DEFAULT_LANG, LOCALES } from './locales/index.js';
import { gregorian, jalali } from './util.js';

export const LANGS = Object.keys(LOCALES);
export const isLang = (l) => typeof l === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, l);

const dict = (lang) => LOCALES[isLang(lang) ? lang : DEFAULT_LANG];
const defaultPlural = (n) => (n === 1 ? 'one' : 'other');

/* A number written with the language's digits. */
export function num(lang, n) {
  const digits = dict(lang)._digits;
  const s = String(n);
  return digits ? s.replace(/[0-9]/g, (d) => digits[Number(d)]) : s;
}

export function t(lang, key, vars) {
  const d = dict(lang);
  let s = d[key];
  if (s === undefined) s = LOCALES[DEFAULT_LANG][key];
  if (s === undefined) return key;
  if (s && typeof s === 'object') {
    const form = (d._plural || defaultPlural)(vars ? Number(vars.n) : NaN);
    s = s[form] !== undefined ? s[form] : s.other;
  }
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'number' ? num(lang, v) : String(v);
  });
}

/* The language to talk to someone in: their choice, else their Telegram language if the bot has
   it, else the default (Persian). */
export function langOf(user, from) {
  if (user && isLang(user.lang)) return user.lang;
  const code = from && typeof from.language_code === 'string' ? from.language_code.toLowerCase() : '';
  if (isLang(code)) return code;
  if (isLang(code.slice(0, 2))) return code.slice(0, 2);
  return DEFAULT_LANG;
}

/* "5 minutes ago" in the language. */
export function ago(lang, at, nowSec) {
  const diff = Math.max(0, nowSec - at);
  if (diff < 60) return t(lang, 'ago.now');
  if (diff < 3600) return t(lang, 'ago.m', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t(lang, 'ago.h', { n: Math.floor(diff / 3600) });
  return t(lang, 'ago.d', { n: Math.floor(diff / 86400) });
}

/* A Tehran day number as a date: the Jalali calendar for locales with _calendar 'jalali' (Persian),
   otherwise Gregorian, as y/m/d in the language's digits. */
export function date(lang, day) {
  const [y, m, d] = dict(lang)._calendar === 'jalali' ? jalali(day) : gregorian(day);
  const two = (n) => (n < 10 ? `0${n}` : String(n));
  return num(lang, `${y}/${two(m)}/${two(d)}`);
}
