/*
 * Codeword: guess a hidden 5-letter word. Each guess only tells how many letters are right and in
 * the right place (exact) and how many more are in the word but elsewhere (near) — not which ones;
 * the player marks letters on the keyboard to deduce the rest. 10 guesses. A daily word (the same
 * for everyone, per language) and free play. Pure; the answer lives only on the server.
 *
 * Words are compared after normalize(): lowercase; French without accents; Russian ё = е; Persian
 * with Arabic ي/ك as ی/ک and آ as ا. Duplicate letters count as in Bulls and Cows: a letter scores
 * at most as many times as it appears in both words.
 */

export const LENGTH = 5;
export const MAX_GUESSES = 10;
export const LANGS = ['en', 'fr', 'ru', 'fa'];

/* On-screen keyboards, row by row (Persian is laid out right to left by the Mini App). */
export const KEYBOARDS = {
  en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  fr: ['azertyuiop', 'qsdfghjklm', 'wxcvbn'],
  ru: ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'],
  fa: ['ضصثقفغعهخحجچ', 'شسیبلاتنمکگ', 'ظطزرذدپوژ'],
};

const ALPHABETS = {};
for (const lang of LANGS) ALPHABETS[lang] = new Set(Array.from(KEYBOARDS[lang].join('')));

const FR_ACCENTS = { 'à': 'a', 'â': 'a', 'ä': 'a', 'ç': 'c', 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'î': 'i', 'ï': 'i', 'ô': 'o', 'ö': 'o', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ÿ': 'y' };

export function normalize(lang, word) {
  let w = String(word || '').trim().toLowerCase();
  if (lang === 'fr') w = Array.from(w).map((c) => FR_ACCENTS[c] || c).join('');
  if (lang === 'ru') w = w.replace(/ё/g, 'е');
  if (lang === 'fa') {
    w = w.replace(/ي|ى/g, 'ی').replace(/ك/g, 'ک').replace(/آ/g, 'ا')
      .replace(/[ً-ٰٟـ‌‍]/g, '');
  }
  return w;
}

export const letters = (word) => Array.from(word);

/* Whether a normalized word has the right length and only letters of the language's keyboard. */
export function wellFormed(lang, word) {
  const ls = letters(word);
  return ls.length === LENGTH && ls.every((c) => ALPHABETS[lang].has(c));
}

/* { exact, near } for a guess against the answer (both normalized). */
export function score(guess, answer) {
  const g = letters(guess);
  const a = letters(answer);
  let exact = 0;
  const left = {};
  const want = {};
  for (let i = 0; i < a.length; i += 1) {
    if (g[i] === a[i]) exact += 1;
    else {
      left[a[i]] = (left[a[i]] || 0) + 1;
      want[g[i]] = (want[g[i]] || 0) + 1;
    }
  }
  let near = 0;
  for (const c of Object.keys(want)) near += Math.min(want[c], left[c] || 0);
  return { exact, near };
}

/* Points for a solved word: more for fewer guesses. */
export const pointsFor = (guesses) => Math.max(1, MAX_GUESSES + 1 - guesses);

/* The day key (UTC) and which word of a list it picks: the same for everyone that day. */
export function dayKey(nowMs) {
  const d = new Date(nowMs);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function dailyIndex(day, lang, count) {
  let h = 2166136261;
  const s = `${day}:${lang}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % count;
}
