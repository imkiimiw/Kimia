// Texts live in locale modules (fa default, en); adding a language = adding one file and listing it
// here. Both locales have the same keys (tests/unit/i18n.test.mjs). Pure.
//   t(lang, key, vars)  → Telegram HTML; vars are escaped, except keys starting with '_' (already HTML)
//   tp(lang, key, vars) → plain text (buttons, toasts)
import fa from './fa.js';
import en from './en.js';
import { esc } from '../util.js';

export const LOCALES = { fa, en };
export const LANGS = Object.keys(LOCALES);
export const DEFAULT_LANG = 'fa';

const pick = (lang, key) => {
  const loc = LOCALES[lang] || LOCALES[DEFAULT_LANG];
  const v = loc[key] ?? LOCALES[DEFAULT_LANG][key];
  if (v === undefined) throw new Error(`missing text ${key}`);
  return v;
};

const fill = (s, vars, escape) => s.replace(/\{(_?[a-zA-Z0-9]+)\}/g, (m, k) => {
  if (!(k in vars)) return m;
  const v = vars[k] ?? '';
  return escape && !k.startsWith('_') ? esc(v) : String(v);
});

export const t = (lang, key, vars = {}) => fill(pick(lang, key), vars, true);
export const tp = (lang, key, vars = {}) => fill(pick(lang, key), vars, false);
export const has = (lang, key) => key in (LOCALES[lang] || {});
