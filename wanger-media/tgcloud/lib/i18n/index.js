// Texts: t() for Telegram HTML (variables escaped), tp() for plain text (buttons, toasts).
// A key missing in a language falls back to English (brief §4). Pure module: must not import 'sdk'.
import { FALLBACK_LANG, LANGS } from '../config.js';
import { esc } from '../util.js';
import en from './en.js';
import fa from './fa.js';
import ru from './ru.js';

export const LOCALES = { fa, en, ru };

/** Each language's own name, the same in every locale. */
export const LANG_NAMES = { fa: '🇮🇷 فارسی', en: '🇬🇧 English', ru: '🇷🇺 Русский' };

/** One of LANGS, or null. */
export const normLang = (code) => (LANGS.includes(code) ? code : null);

/** The language to preselect from Telegram's language_code (fa / ru, otherwise English). */
export function detectLang(languageCode) {
  const c = String(languageCode || '').toLowerCase();
  if (/^fa\b/.test(c)) return 'fa';
  if (/^ru\b/.test(c)) return 'ru';
  return 'en';
}

function raw(lang, key) {
  const table = LOCALES[normLang(lang) || FALLBACK_LANG];
  if (key in table) return table[key];
  if (key in LOCALES[FALLBACK_LANG]) return LOCALES[FALLBACK_LANG][key];
  return key;
}

function fill(template, vars, escape) {
  return template.replace(/\{(\w+)\}/g, (m, name) => {
    if (!vars || !(name in vars)) return m;
    return escape ? esc(vars[name]) : String(vars[name]);
  });
}

/** Telegram-HTML text: the template may contain tags, every variable is escaped. */
export const t = (lang, key, vars) => fill(raw(lang, key), vars, true);
/** Plain text (button labels, callback answers): nothing is escaped. */
export const tp = (lang, key, vars) => fill(raw(lang, key), vars, false);
