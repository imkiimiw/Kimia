/*
 * Languages: en, fr, ru, fa. t(lang, key, vars) fills {placeholders}; numbers in vars come out in
 * the language's digits (Persian digits for fa). Missing keys fall back to English. Shared by the
 * bot and the Mini App. No Intl: the platform's isolate doesn't have it.
 */
import en from './en.js';
import fa from './fa.js';
import fr from './fr.js';
import ru from './ru.js';

export const LANGS = ['en', 'fr', 'ru', 'fa'];
const DICTS = { en, fr, ru, fa };

export const isRtl = (lang) => lang === 'fa';

/* A Telegram language_code to one of ours (English when unknown). */
export function pickLang(code) {
  const c = String(code || '').toLowerCase().slice(0, 2);
  return LANGS.includes(c) ? c : 'en';
}

export function num(lang, n) {
  const s = String(n);
  return lang === 'fa' ? s.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]) : s;
}

export function t(lang, key, vars) {
  const dict = DICTS[lang] || en;
  let s = dict[key];
  if (s === undefined) s = en[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return m;
    return typeof v === 'number' ? num(lang, v) : String(v);
  });
}

export const GAME_ICONS = { ttt: '❌⭕', bg: '🎲', hokm: '🃏', codeword: '🔤', fusion: '🧩' };
