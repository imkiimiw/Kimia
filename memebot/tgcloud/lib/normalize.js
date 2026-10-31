/*
 * Persian-aware normalisation for keywords and inline queries. The same function runs on both
 * sides, so "گربه\u200Cي ۲" typed with an Arabic keyboard finds "گربه ی 2".
 *
 *  - Arabic letter forms become Persian: ي ى ئ → ی, ك → ک, ة ۀ ھ ە → ه, أ إ آ ٱ → ا, ؤ → و
 *  - Persian (۰-۹) and Arabic-Indic (٠-٩) digits become 0-9
 *  - diacritics (harakat), tatweel, zero-width and bidi control characters are removed
 *  - ZWNJ (نیم\u200Cفاصله): a keyword "می\u200Cخوام" is indexed as "میخوام" AND as "می", "خوام", so
 *    "میخوام", "می\u200Cخوام" and "می خوام" all find it
 *  - punctuation (Latin and Persian) and any run of spaces separate words; apostrophes join
 *  - each emoji is a word of its own; Latin letters are lowercased
 *
 * No regex Unicode property escapes and no String.prototype.normalize: both need ICU, which the
 * platform's isolate may not have. Invisible characters are written as escapes on purpose.
 */
import { KW_MAX_WORDS, QUERY_MAX_WORDS, WORD_MAX_LEN } from './config.js';

const LETTERS = {
  '\u064A': '\u06CC',
  '\u0649': '\u06CC',
  '\u0626': '\u06CC',
  '\u0643': '\u06A9',
  '\u0629': '\u0647',
  '\u06C0': '\u0647',
  '\u06BE': '\u0647',
  '\u06D5': '\u0647',
  '\u0623': '\u0627',
  '\u0625': '\u0627',
  '\u0622': '\u0627',
  '\u0671': '\u0627',
  '\u0624': '\u0648',
};
const LETTERS_RE = /[\u064A\u0649\u0626\u0643\u0629\u06C0\u06BE\u06D5\u0623\u0625\u0622\u0671\u0624]/g;

/* The display form keeps alef-madda (آ) and hamza forms as typed; only the yeh/kaf look-alikes,
   which render the same but break search, are unified there. */
const DISPLAY_LETTERS_RE = /[\u064A\u0649\u0643]/g;

/* Harakat, superscript alef, Quranic marks and tatweel. */
const MARKS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/* Zero-width and bidi controls, BOM, soft hyphen, variation selectors, emoji skin tones.
   ZWNJ (\u200C) is not in this list: it is handled separately. */
const INVISIBLE_RE = /[\u00AD\u200B\u200D-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE0E\uFE0F\uFEFF]|\uD83C[\uDFFB-\uDFFF]/g;

/* Apostrophes join a word ("don't" → "dont"). */
const APOS_RE = /['`\u2018\u2019\u02BC\u00B4]/g;

/* Separators: ASCII punctuation (except the apostrophes above), Latin-1 and general punctuation,
   Persian/Arabic punctuation (، ؛ ؟ ٪ ٫ ٬ ۔ « »), CJK and full-width punctuation, any space. */
const SEP_RE = /[\s!-&(-/:-@[-^_{-~\u00A1-\u00BF\u00D7\u00F7\u060C\u061B\u061F\u066A-\u066C\u06D4\u2010-\u2027\u2030-\u205E\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+/g;

/* Emoji and pictographs: each becomes its own word. */
const EMOJI_RE = /([\u2600-\u27BF]|[\uD83C-\uD83E][\uDC00-\uDFFF])/g;

const ZWNJ = '\u200C';

/* Normalised text: words separated by single spaces; ZWNJ kept only inside words. */
export function normalize(text) {
  let s = String(text === undefined || text === null ? '' : text).toLowerCase();
  s = s.replace(LETTERS_RE, (c) => LETTERS[c]);
  s = s.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(MARKS_RE, '').replace(INVISIBLE_RE, '').replace(APOS_RE, '');
  s = s.replace(EMOJI_RE, ' $1 ');
  s = s.replace(SEP_RE, ' ');
  s = s.replace(/\u200C*( )\u200C*/g, ' ').replace(/\u200C{2,}/g, ZWNJ);
  return s.split(' ').map((w) => w.replace(/^\u200C+|\u200C+$/g, '')).filter(Boolean).join(' ');
}

const clip = (w) => Array.from(w).slice(0, WORD_MAX_LEN).join('');

/* Words to index for a meme's keywords: every word without its ZWNJ, plus the ZWNJ parts. */
export function indexWords(text) {
  const out = [];
  const seen = new Set();
  const add = (w) => {
    const c = clip(w);
    if (c && !seen.has(c) && out.length < KW_MAX_WORDS) {
      seen.add(c);
      out.push(c);
    }
  };
  const words = normalize(text).split(' ').filter(Boolean);
  for (const w of words) add(w.split(ZWNJ).join(''));
  for (const w of words) {
    const parts = w.split(ZWNJ).filter(Boolean);
    if (parts.length > 1) parts.forEach(add);
  }
  return out;
}

/* Words of an inline query (each matched as a prefix of an indexed word; one letter = exact). */
export function queryWords(text) {
  const out = [];
  for (const w of normalize(text).split(' ')) {
    const c = clip(w.split(ZWNJ).join(''));
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= QUERY_MAX_WORDS) break;
  }
  return out;
}

/* The keywords as shown to people: invisible characters removed (ZWNJ kept), yeh/kaf unified,
   whitespace and line breaks collapsed. */
export function cleanKeywords(text) {
  return String(text || '')
    .replace(DISPLAY_LETTERS_RE, (c) => LETTERS[c])
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/\u200C*( )\u200C*/g, ' ')
    .trim();
}

/* The first word of the keywords, for an example search ("@bot word"). */
export function firstWord(text) {
  const w = cleanKeywords(text).split(' ')[0] || '';
  return w.replace(new RegExp('^' + SEP_RE.source), '').replace(new RegExp(SEP_RE.source + '$'), '');
}
