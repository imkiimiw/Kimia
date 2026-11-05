// Search terms (pure, spec §9). A track is indexed under the normalized tokens of its title,
// artist, album, featured artists and the artists' aliases, plus space-free variants: the whole
// field, and every pair of neighbouring tokens (so «می\u200cخوام» inside a longer title is still found
// as «میخوام», «می خوام» or «می\u200cخوام»). Queries: ≤ 64 characters, ≤ 5 tokens; every token must
// match, the last one as a prefix (a one-letter last token matches exactly).
import { key } from '../music/normalize.js';

export const QUERY_MAX_CHARS = 64;
export const QUERY_MAX_TOKENS = 5;
const TERM_MAX = 64;
const TERMS_MAX = 200;

/** @param {any} text @returns {string[]} */
export const tokensOf = (text) => key(text).split(' ').filter(Boolean);

/** Terms of one text field: tokens, neighbour pairs joined, and the whole field without spaces. */
function fieldTerms(text, out) {
  const toks = tokensOf(text);
  for (let i = 0; i < toks.length; i++) {
    out.add(toks[i]);
    if (i + 1 < toks.length) out.add(toks[i] + toks[i + 1]);
  }
  if (toks.length > 2) out.add(toks.join(''));
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

/** Keys of every artist of a track (primary + featured), for alias lookup and the artists table. */
export function artistKeys(track) {
  const names = [track.artist, ...String(track.featured_artists || '').split(',')].map((s) => String(s || '').trim()).filter(Boolean);
  return [...new Map(names.map((n) => [key(n), n])).entries()].filter(([k]) => k).map(([k, name]) => ({ key: k, name }));
}
