// t(lang, key, vars): all user-facing text (pure). String vars are HTML-escaped; numbers get
// Persian digits in Persian. Wrap ready-made HTML with raw() to insert it as is.
import fa from './fa.js';
import en from './en.js';
import { esc } from '../telegram/html.js';
import { localParts, toJalali, pad } from '../core/util.js';

/** @type {Record<string, Record<string, string>>} */
export const DICTS = { fa, en };

/** @param {any} lang @returns {'fa'|'en'} */
export const normLang = (lang) => (lang === 'en' ? 'en' : 'fa');

/** Marks a string as trusted HTML for t(). @param {string} html */
export const raw = (html) => ({ __html: String(html) });

/** Digits in the language's script. @param {number|string} n @param {string} lang */
export function digits(n, lang) {
  const s = String(n);
  return normLang(lang) === 'fa' ? s.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d))) : s;
}

/**
 * @param {string} lang
 * @param {string} key
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function t(lang, key, vars = {}) {
  const l = normLang(lang);
  const s = DICTS[l][key] ?? DICTS.fa[key];
  if (s === undefined) return key;
  return s.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object' && '__html' in v) return v.__html;
    if (typeof v === 'number') return digits(v, l);
    return esc(v);
  });
}

/**
 * Plain-text variant for button labels and callback toasts (not parsed as HTML, so nothing is
 * escaped). The texts used with it contain no HTML tags.
 */
export function tp(lang, key, vars = {}) {
  const l = normLang(lang);
  const s = DICTS[l][key] ?? DICTS.fa[key];
  if (s === undefined) return key;
  return s.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'number' ? digits(v, l) : String(v);
  });
}

/** "5 min ago" from a number of seconds. @param {number} seconds @param {string} lang */
export function ago(seconds, lang) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return t(lang, 'common.just_now');
  if (s < 60) return t(lang, 'common.ago_s', { n: s });
  if (s < 3600) return t(lang, 'common.ago_m', { n: Math.floor(s / 60) });
  if (s < 86400) return t(lang, 'common.ago_h', { n: Math.floor(s / 3600) });
  return t(lang, 'common.ago_d', { n: Math.floor(s / 86400) });
}

/** Date and time in a zone: Jalali for Persian, ISO-like for English. @param {number} ts @param {string} tz @param {string} lang */
export function dateTime(ts, tz, lang) {
  if (!ts) return t(lang, 'common.never');
  const p = localParts(ts, tz);
  if (normLang(lang) === 'fa') {
    const [jy, jm, jd] = toJalali(p.y, p.m, p.d);
    return digits(`${jy}/${pad(jm)}/${pad(jd)} ${pad(p.hh)}:${pad(p.mm)}`, 'fa');
  }
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`;
}
