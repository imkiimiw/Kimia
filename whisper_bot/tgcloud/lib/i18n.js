// Three UI languages: Persian (fa), English (en), Russian (ru). Every user-visible string lives in
// lib/i18n/<lang>.js under the same keys; t() fills {placeholders}. Callers escape user content
// before passing it in (the strings are HTML). A missing key falls back to English, then Persian.
import fa from './i18n/fa.js';
import en from './i18n/en.js';
import ru from './i18n/ru.js';
import { LANGS } from './config.js';

const DICT = { fa, en, ru };

export const isLang = (l) => LANGS.includes(l);

export function t(lang, key, vars) {
  const d = DICT[lang] || DICT.en;
  let s = d[key];
  if (s === undefined) s = DICT.en[key];
  if (s === undefined) s = DICT.fa[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/** A list from the dictionary (e.g. the questions of the day); same length in every language. */
export function list(lang, key) {
  const v = (DICT[lang] || DICT.en)[key];
  return Array.isArray(v) ? v : DICT.en[key] || [];
}

/** The language for a Telegram language_code, when the user hasn't chosen one yet. */
export function detectLang(code) {
  const c = String(code || '').toLowerCase().slice(0, 2);
  if (c === 'fa') return 'fa';
  if (['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az'].includes(c)) return 'ru';
  if (c === 'en' || c) return 'en';
  return 'fa';
}

/** The language to talk to `user` (a users row) or a raw Telegram `from` in. */
export function langOf(user, from) {
  if (user && isLang(user.lang)) return user.lang;
  if (from && from.language_code) return detectLang(from.language_code);
  if (user && isLang(user.tgLang)) return user.tgLang; // their Telegram language, seen on an earlier update
  return detectLang(null);
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** A number in the language's digits (Persian digits for fa). */
export function num(lang, n) {
  const s = String(n);
  return lang === 'fa' ? s.replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]).replace('.', '٫') : s;
}

/** Russian plural form: one (1, 21), few (2-4, 22-24), many (the rest). */
export function ruPlural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function unit(lang, n, key) {
  if (lang === 'ru') {
    const forms = { d: ['день', 'дня', 'дней'], h: ['час', 'часа', 'часов'], m: ['минута', 'минуты', 'минут'] }[key];
    return `${n} ${ruPlural(n, ...forms)}`;
  }
  if (lang === 'en') return `${n} ${{ d: 'day', h: 'hour', m: 'minute' }[key]}${n === 1 ? '' : 's'}`;
  return `${num('fa', n)} ${{ d: 'روز', h: 'ساعت', m: 'دقیقه' }[key]}`;
}

/** "1 hour 30 minutes" in the language. */
export function dur(lang, sec) {
  let s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(unit(lang, d, 'd'));
  if (h) parts.push(unit(lang, h, 'h'));
  if (m) parts.push(unit(lang, m, 'm'));
  if (!parts.length) return t(lang, 'time.lt_min');
  return parts.join(t(lang, 'time.and'));
}

/** "5 minutes ago" in the language. */
export function ago(lang, at, now = Math.floor(Date.now() / 1000)) {
  const diff = Math.max(0, now - at);
  if (diff < 60) return t(lang, 'time.now');
  let n;
  let k;
  if (diff < 3600) {
    n = Math.floor(diff / 60);
    k = 'm';
  } else if (diff < 86400) {
    n = Math.floor(diff / 3600);
    k = 'h';
  } else {
    n = Math.floor(diff / 86400);
    k = 'd';
  }
  if (lang === 'ru') {
    const forms = { d: ['день', 'дня', 'дней'], h: ['час', 'часа', 'часов'], m: ['минуту', 'минуты', 'минут'] }[k];
    return `${n} ${ruPlural(n, ...forms)} назад`;
  }
  return t(lang, 'time.ago', { t: unit(lang, n, k) });
}

/** "4.6" with one decimal, in the language's digits. */
export function avg(lang, sum, count) {
  if (!count) return num(lang, 0);
  return num(lang, (Math.round((sum / count) * 10) / 10).toFixed(1));
}
