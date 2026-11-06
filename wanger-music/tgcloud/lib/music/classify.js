// Language classification (pure, deterministic, spec §8.4). Behind a small interface, so a better
// classifier can replace it later: classifyLanguage(input) → { language, confidence, source }.
// Priority: manual (high) > source default (high) > artist hint (high) > script heuristic.

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-\ufeff]/;
const PERSIAN_ONLY = /[پچژگ]/; // پ چ ژ گ
const LATIN = /[A-Za-zÀ-ɏ]/;
const DIGIT_OR_MARK = /[٠-٩۰-۹ً-ٰٟـ،؛؟۔]/;

/** Letters per script. @param {string} text */
export function scriptCounts(text) {
  let arabic = 0;
  let latin = 0;
  for (const ch of String(text || '')) {
    if (DIGIT_OR_MARK.test(ch)) continue;
    if (ARABIC_SCRIPT.test(ch)) arabic += 1;
    else if (LATIN.test(ch)) latin += 1;
  }
  return { arabic, latin };
}

/** Share of letters one script must have for the text not to count as mixed. */
export const DOMINANCE = 0.9;

/**
 * Script heuristic: Persian letters (پ چ ژ گ) or other Arabic-script text → fa (medium);
 * Latin only → en (low: it may be Persian written in Latin letters); mixed or empty → unknown.
 * @returns {{language: 'fa'|'en'|'unknown', confidence: 'medium'|'low'}}
 */
export function heuristicLanguage(text) {
  const { arabic, latin } = scriptCounts(text);
  const total = arabic + latin;
  if (!total) return { language: 'unknown', confidence: 'low' };
  if (arabic / total >= DOMINANCE) return { language: 'fa', confidence: 'medium' };
  if (latin / total >= DOMINANCE) return { language: 'en', confidence: 'low' };
  return { language: 'unknown', confidence: 'low' };
}

/** Does the text use letters only Persian has? (kept for the card's explanation) */
export const hasPersianLetters = (text) => PERSIAN_ONLY.test(String(text || ''));

/**
 * @param {{manual?: string|null, sourceDefault?: string|null, artistHint?: string|null, text?: string, heuristic?: 'confident'|'all'|'off'}} input
 *   heuristic: 'all' = any script guess; 'confident' = only a guess of medium confidence or better
 *   (Latin-only text stays unknown: it may be Persian written in Latin letters); 'off' = never guess
 * @returns {{language: string, confidence: 'high'|'medium'|'low', source: 'manual'|'source'|'artist'|'heuristic'}}
 */
export function classifyLanguage({ manual = null, sourceDefault = null, artistHint = null, text = '', heuristic = 'all' }) {
  const known = (l) => l === 'fa' || l === 'en' || l === 'other';
  if (known(manual)) return { language: /** @type {string} */ (manual), confidence: 'high', source: 'manual' };
  if (known(sourceDefault)) return { language: /** @type {string} */ (sourceDefault), confidence: 'high', source: 'source' };
  if (known(artistHint)) return { language: /** @type {string} */ (artistHint), confidence: 'high', source: 'artist' };
  const unknown = { language: 'unknown', confidence: /** @type {'low'} */ ('low'), source: /** @type {'heuristic'} */ ('heuristic') };
  if (heuristic === 'off') return unknown;
  const guess = heuristicLanguage(text);
  if (heuristic === 'confident' && guess.confidence === 'low') return unknown;
  return { ...guess, source: 'heuristic' };
}

/** The classifier as a replaceable object. */
export const scriptClassifier = Object.freeze({ id: 'script-heuristic-v1', classify: classifyLanguage });
