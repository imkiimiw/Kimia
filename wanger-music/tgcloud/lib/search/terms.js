// Search terms (pure, spec §9). A track is indexed under the normalized tokens of its title,
// artist, album, featured artists and the artists' aliases, plus space-free variants: the whole
// field, and every pair of neighbouring tokens (so «می\u200cخوام» inside a longer title is still found
// as «میخوام», «می خوام» or «می\u200cخوام»). Queries: ≤ 64 characters, ≤ 5 tokens; every token must
// match, the last one as a prefix (a one-letter last token matches exactly).
// Finglish (2026-11-23): every token also gets a consonant "skeleton" term (`~sdmhr` for both
// «شادمهر» and "shadmehr"); a query with no result is tried again with skeletons.
import { key } from '../music/normalize.js';

/** Persian letters → one Latin consonant class each; vowels (ا آ ی و ع ء …) drop. */
const FA = new Map(Object.entries({
  'ب': 'b', 'پ': 'p', 'ت': 't', 'ط': 't', 'ث': 's', 'س': 's', 'ص': 's', 'ج': 'j', 'چ': 'c', 'ح': 'h', 'ه': 'h',
  'خ': 'x', 'د': 'd', 'ذ': 'z', 'ز': 'z', 'ض': 'z', 'ظ': 'z', 'ر': 'r', 'ژ': 'J', 'ش': 'S', 'غ': 'q', 'ق': 'q',
  'ف': 'f', 'ک': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n',
}));
const LATIN_DIGRAPHS = [['sh', 'S'], ['ch', 'c'], ['kh', 'x'], ['gh', 'q'], ['zh', 'J'], ['ph', 'f']];
const LATIN = new Map(Object.entries({ b: 'b', p: 'p', t: 't', s: 's', j: 'j', h: 'h', x: 'x', d: 'd', z: 'z', r: 'r', q: 'q', f: 'f', k: 'k', c: 'k', g: 'g', l: 'l', m: 'm', n: 'n' }));

/**
 * The consonant skeleton of one normalized token, for Persian ↔ Finglish matching: «شادمهر» and
 * "shadmehr" are both "Sdmhr". Vowels, و/v/w and ی/y drop (they are written either way), a final ه or
 * vowel+h drops, repeats collapse. '' for digits-only or other scripts.
 */
export function skeleton(token) {
  const s = String(token || '');
  let out = '';
  if (/[\u0600-\u06ff]/.test(s)) {
    const chars = [...s];
    chars.forEach((ch, i) => {
      if (ch === 'ه' && i === chars.length - 1 && i > 0) return;
      const c = FA.get(ch);
      if (c) out += c;
    });
  } else if (/[a-z]/.test(s)) {
    let w = s.replace(/([aeiou])h$/, '$1');
    for (const [d, c] of LATIN_DIGRAPHS) w = w.split(d).join(c);
    for (const ch of w) {
      if (ch === 'S' || ch === 'c' || ch === 'x' || ch === 'q' || ch === 'J' || ch === 'f') out += ch;
      else if (LATIN.has(ch)) out += LATIN.get(ch);
    }
  }
  return out.replace(/(.)\1+/g, '$1');
}

// 2: «چاوشی» / "chavoshi" is cS; one consonant matches far too much. Only a fallback (no exact result).
const SKELETON_MIN = 2;
/** The skeleton search term of a token, or '' when too short to mean anything. */
export const skeletonTerm = (token) => {
  const k = skeleton(token);
  return k.length >= SKELETON_MIN ? `~${k}` : '';
};

export const QUERY_MAX_CHARS = 64;
export const QUERY_MAX_TOKENS = 5;
const TERM_MAX = 64;
const TERMS_MAX = 200;

/** @param {any} text @returns {string[]} */
export const tokensOf = (text) => key(text).split(' ').filter(Boolean);

/** Terms of one text field: tokens, neighbour pairs joined, and the whole field without spaces. */
function fieldTerms(text, out) {
  const toks = tokensOf(text);
  const add = (term) => {
    out.add(term);
    const sk = skeletonTerm(term);
    if (sk) out.add(sk);
  };
  for (let i = 0; i < toks.length; i++) {
    add(toks[i]);
    if (i + 1 < toks.length) add(toks[i] + toks[i + 1]);
  }
  if (toks.length > 2) add(toks.join(''));
}

/**
 * @param {{title?: string|null, artist?: string|null, album?: string|null, featured_artists?: string|null}} track
 * @param {string[]} [aliases] normalized aliases of the track's artists
 * @returns {string[]}
 */
export function termsForTrack(track, aliases = []) {
  const out = new Set();
  fieldTerms(track.title, out);
  fieldTerms(track.artist, out);
  fieldTerms(track.album, out);
  for (const f of String(track.featured_artists || '').split(',')) fieldTerms(f, out);
  for (const a of aliases) fieldTerms(a, out);
  return [...out].filter((t) => t.length <= TERM_MAX).slice(0, TERMS_MAX);
}

/**
 * @param {any} raw the user's query
 * @returns {{text: string, tokens: string[], full: string}} text: the (cut) query; full: its key
 */
export function parseQuery(raw) {
  const text = Array.from(String(raw || '')).slice(0, QUERY_MAX_CHARS).join('').trim();
  const tokens = [...new Set(tokensOf(text))].slice(0, QUERY_MAX_TOKENS);
  return { text, tokens, full: tokens.join(' ') };
}

/**
 * The same query in skeleton terms, or null: every token needs a skeleton of 2+ consonants;
 * otherwise the tokens joined ("bi to" → ~bt). @param {{tokens: string[]}} q
 * @returns {{tokens: string[], full: string}|null}
 */
export function skeletonQuery(q) {
  if (!q.tokens.length) return null;
  const each = q.tokens.map(skeletonTerm);
  if (each.every(Boolean)) return { tokens: [...new Set(each)], full: '' };
  const joined = skeletonTerm(q.tokens.join(''));
  return joined ? { tokens: [joined], full: '' } : null;
}

/** Keys of every artist of a track (primary + featured), for alias lookup and the artists table. */
export function artistKeys(track) {
  const names = [track.artist, ...String(track.featured_artists || '').split(',')].map((s) => String(s || '').trim()).filter(Boolean);
  return [...new Map(names.map((n) => [key(n), n])).entries()].filter(([k]) => k).map(([k, name]) => ({ key: k, name }));
}
