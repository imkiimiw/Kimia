/*
 * Every user-visible string comes from here. The texts live in aegis/locales/<lang>/<ns>.json and
 * are compiled into strings/<lang>.js (scripts/build-locales.mjs); a key is "<ns>.<key>".
 *
 * t(lang, key, vars) fills {placeholders}. Number vars come out in the language's digits and
 * grouping (Persian digits for fa); there is no Intl in the isolate. Persian (fa) is right-to-left:
 * every line of a fa string starts with a RIGHT-TO-LEFT MARK, so a line that begins with an emoji,
 * a number or a Latin name still lays out right-to-left. Vars are inserted as given: callers pass
 * user content through iso() (escaped and direction-isolated).
 */
import { DEFAULT_LANG, LANGS } from '../config.js';
import { normalizeWord, RLM } from '../core/util.js';
import en from './strings/en.js';
import fa from './strings/fa.js';
import fr from './strings/fr.js';
import ru from './strings/ru.js';
import zh from './strings/zh.js';

const DICTS = { fa, en, ru, zh, fr };

export { LANGS };
export const isLang = (l) => LANGS.includes(l);
export const isRtl = (lang) => lang === 'fa';

/* A Telegram language_code to one of ours (English when unknown). */
export function pickLang(code) {
  const c = String(code || '').toLowerCase();
  const base = c.slice(0, 2);
  if (base === 'fa') return 'fa';
  if (base === 'zh') return 'zh';
  if (base === 'fr') return 'fr';
  if (['ru', 'uk', 'be', 'kk', 'ky'].includes(base)) return 'ru';
  return DEFAULT_LANG;
}

const DIGITS_FA = '۰۱۲۳۴۵۶۷۸۹';
const GROUP = { fa: '٬', en: ',', zh: ',', ru: '\u202F', fr: '\u202F' };

export function num(lang, n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const neg = v < 0;
  const [int, frac] = String(Math.abs(v)).split('.');
  let grouped = int;
  if (int.length > 4) grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP[lang] || ',');
  let s = `${neg ? '-' : ''}${grouped}${frac ? `${lang === 'fa' ? '٫' : '.'}${frac}` : ''}`;
  if (lang === 'fa') s = s.replace(/[0-9]/g, (d) => DIGITS_FA[Number(d)]);
  return s;
}

function rtlLines(s) {
  return s.split('\n').map((line) => (line && line[0] !== RLM ? RLM + line : line)).join('\n');
}

export function t(lang, key, vars) {
  const l = isLang(lang) ? lang : DEFAULT_LANG;
  let s = DICTS[l][key];
  if (s === undefined) s = DICTS[DEFAULT_LANG][key];
  if (s === undefined) {
    console.warn(`i18n: missing key ${key}`);
    return key;
  }
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => {
      const v = vars[k];
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') return num(l, v);
      return String(v).replace(/(^|\n)\u200F/g, '$1'); /* a t() label inside another string: its marks come from the outer line */
    });
  }
  return isRtl(l) ? rtlLines(s) : s;
}

export const has = (key) => DICTS[DEFAULT_LANG][key] !== undefined;

/* "2 d 3 h", "1 h 5 min", "42 s" in the language (minutes are dropped once there are days). */
export function dur(lang, sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = d ? 0 : Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(t(lang, 'common.dur_d', { n: d }));
  if (h) parts.push(t(lang, 'common.dur_h', { n: h }));
  if (m) parts.push(t(lang, 'common.dur_m', { n: m }));
  if (!d && !h && (!m || s % 60)) parts.push(t(lang, 'common.dur_s', { n: s % 60 }));
  return parts.join(' ').replace(new RegExp(RLM, 'g'), '');
}

/*
 * Words typed instead of commands, from a locale namespace of every language (so Persian and
 * English words both work whatever the user's language): "alias" for private-chat commands
 * (aliasCommand), "modcmd" for the group's moderation commands (modCommand), "seccmd" for the security
 * commands (wordCommand). { word → command }.
 */
const wordMaps = {};
function wordMap(ns) {
  if (wordMaps[ns]) return wordMaps[ns];
  const map = new Map();
  const prefix = `${ns}.`;
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(DICTS[lang])) {
      if (!key.startsWith(prefix)) continue;
      const cmd = key.slice(prefix.length);
      for (const word of value.split('|')) {
        const w = normalizeWord(word);
        if (w && !map.has(w)) map.set(w, cmd);
      }
    }
  }
  wordMaps[ns] = map;
  return map;
}
export const aliasCommand = (text) => wordMap('alias').get(normalizeWord(text)) || null;
export const modCommand = (text) => wordMap('modcmd').get(normalizeWord(text)) || null;
export const wordCommand = (ns, text) => wordMap(ns).get(normalizeWord(text)) || null;

/* The language's own name ("فارسی", "English", …) for the picker. */
export const langName = (lang) => DICTS[lang]['lang.name'];
export const langFlag = (lang) => DICTS[lang]['lang.flag'];
