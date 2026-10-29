// Content filters for anonymous messages, applied by the recipient's settings: offensive words
// (Persian, English, Russian — on by default), links and @mentions, and the recipient's own blocked
// words. A filtered message isn't delivered; it waits in the recipient's "filtered" folder, so a
// false positive is never lost, and the sender isn't told (that would teach abusers to evade).
//
// Evasion handling: letters normalized (Arabic/Persian variants, ё→е, case), zero-width characters
// and tatweel removed, repeated letters squeezed ("fuuuck"), leetspeak (f*ck, 5h1t), Latin
// look-alikes inside Cyrillic words. Short Persian roots are matched as whole words only, because
// e.g. «کس» also means "person" («هیچ کس»).

/** Lowercase, unified letters, no zero-width / diacritics: for search and word matching. */
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[ً-ٰٟـ]/g, '') // harakat, tatweel
    .replace(/[​-‏⁠﻿]/g, '') // zero-width joiners/non-joiners, marks
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '*': '' };
const LATIN_TO_CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', u: 'и' };

/** Words of a normalized text. */
function tokens(norm) {
  return norm.split(/[^\p{L}\p{N}*@$!]+/u).filter(Boolean);
}

/** A word as written, and with repeated letters squeezed ("کیییر" → "کیر", "fuuuck" → "fuck"). */
function variants(w) {
  const out = new Set();
  for (const base of [w, w.replace(/^[*@$!]+|[*@$!]+$/g, '')]) { // "bitch!" as well as "$hit"
    const two = base.replace(/(.)\1{2,}/gu, '$1$1');
    out.add(base).add(two).add(two.replace(/(.)\1+/gu, '$1'));
  }
  out.delete('');
  return [...out];
}

const FA_WORDS = new Set([
  'کیر', 'کص', 'کون', 'جنده', 'جندع', 'کونی', 'کیری', 'لاشی', 'جاکش', 'کسکش', 'کصکش', 'کسخل', 'کصخل', 'کسده', 'کصده',
  'حرومزاده', 'حرامزاده', 'مادرجنده', 'ننهجنده', 'خارکسده', 'خوارکسده', 'خارکصده', 'پدرسگ', 'بیناموس', 'دیوث', 'گاییدم',
  'گاییدن', 'میگام', 'بگا', 'تخمی', 'پفیوز', 'کسکشی', 'کیرم', 'کسشر', 'کصشر', 'کسننت', 'کصننت', 'عنتر',
]);
const EN_WORDS = new Set([
  'fuck', 'fucking', 'fucker', 'fucked', 'motherfucker', 'shit', 'bullshit', 'bitch', 'cunt', 'dick', 'dickhead', 'pussy',
  'whore', 'slut', 'bastard', 'asshole', 'faggot', 'fag', 'retard', 'nigger', 'nigga', 'twat', 'wanker', 'cock', 'prick',
  'kys', 'stfu', 'fck', 'fuk', 'shitty', 'bitches',
]);
const EN_STEMS = ['fuck', 'motherf', 'nigger', 'faggot']; // inside longer words too (not "cunt": Scunthorpe)
// Roots matched at the start of a word, after an optional prefix. Kept specific on purpose: a bare
// "еб" would hit «себе», «манда» would hit «мандарин».
const RU_ROOTS = ['хуй', 'хуе', 'хуя', 'хуи', 'пизд', 'ебат', 'ебан', 'ебал', 'ебло', 'ебуч', 'ебну', 'бля',
  'сука', 'суки', 'сучк', 'мудак', 'мудил', 'пидор', 'пидар', 'пидр', 'шлюх', 'гандон', 'залуп', 'долбоеб', 'уеб'];
const RU_PREFIXES = ['', 'за', 'на', 'по', 'вы', 'от', 'у', 'до', 'раз', 'рас', 'при', 'пере', 'недо', 'об', 'съ', 'под', 'ах', 'с'];

function deleet(w) {
  return w.replace(/[013457@$!*]/g, (c) => LEET[c]);
}

function toCyr(w) {
  return /[а-я]/.test(w) ? w.replace(/[a-z]/g, (c) => LATIN_TO_CYR[c] || c) : w;
}

function offensiveWord(w) {
  if (FA_WORDS.has(w)) return true;
  const en = deleet(w);
  if (EN_WORDS.has(en) || EN_STEMS.some((s) => en.includes(s))) return true;
  const ru = toCyr(en);
  if (!/[а-я]/.test(ru)) return false;
  return RU_ROOTS.some((root) => RU_PREFIXES.some((p) => ru.startsWith(p + root)));
}

const offensiveToken = (w) => variants(w).some(offensiveWord);

/** True if the normalized text contains an offensive word in any of the three languages. */
export function isOffensive(norm) {
  const toks = tokens(norm);
  if (toks.some(offensiveToken)) return true;
  // "f u c k" / "к и р" spelled with spaces or dots between single letters
  const joined = toks.filter((w) => w.length === 1).join('');
  return joined.length >= 3 && tokens(joined).some(offensiveToken);
}

const LINK = /(https?:\/\/|www\.|t\.me\/|telegram\.(me|dog)\/|tg:\/\/|\b[a-z0-9-]{2,}\.(com|ir|net|org|me|io|ru|app|link|xyz|info|site|online|top|shop|club)\b|(^|\s)@[a-z][a-z0-9_]{3,})/i;

/** Links or @mentions, in the text or in Telegram's entities. */
export function hasLink(text, entities) {
  if (Array.isArray(entities) && entities.some((e) => ['url', 'text_link', 'mention', 'text_mention'].includes(e.type))) return true;
  return LINK.test(String(text || ''));
}

/** The user's own words: substrings of the normalized text (whole words for 1-2 letters). */
export function hasOwnWord(norm, words) {
  if (!words.length) return false;
  const toks = new Set(tokens(norm).flatMap(variants));
  return words.some((w) => (w.length <= 2 ? toks.has(w) : norm.includes(w)));
}

/** Which filter (if any) hides this message from `owner`: 'offensive' | 'link' | 'word' | null. */
export function filterReason(owner, words, text, entities) {
  const norm = normalize(text);
  if (owner.aFilter && norm && isOffensive(norm)) return 'offensive';
  if (owner.aLinks && hasLink(text, entities)) return 'link';
  if (norm && hasOwnWord(norm, words)) return 'word';
  return null;
}
