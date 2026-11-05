// Music text normalization (pure, spec §8.2). Two outputs:
//  - display(): clean, human-readable text (Persian letters fixed, noise removed);
//  - key()/compact(): aggressive matching keys (letters unified, accents/diacritics removed,
//    digits ASCII, ZWNJ and punctuation → space; compact() also drops the spaces).
// Invisible characters are written as escapes on purpose.
import { MUSIC_NOISE, VERSION_MARKERS } from '../config/static.js';

/** Builds a regex with Unicode property escapes, or the fallback when the runtime lacks them. */
function uRegex(source, flags, fallbackSource) {
  try {
    return new RegExp(source, flags);
  } catch {
    return new RegExp(fallbackSource, flags.replace('u', ''));
  }
}

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g;
const ZW_ALL = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g;
const TATWEEL = /ـ/g;
const ARABIC_MARKS = /[ً-ٰٟۖ-ۭ]/g;
const LATIN_MARKS = /[̀-ͯ]/g;
const NOT_WORD = uRegex('[^\\p{L}\\p{N}\\s]', 'gu', '[!-/:-@\\[-`{-~\\u00a1-\\u00bf\\u2010-\\u2027\\u2030-\\u205e\\u060c\\u061b\\u061f\\u066a-\\u066d\\u06d4«»]');
const EMOJI = uRegex('[\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\uFE0F\\u20E3]', 'gu', '[\\u2600-\\u27bf\\ufe0f]|[\\ud83c-\\ud83e][\\udc00-\\udfff]');

/** ي ى → ی, ك → ک, tatweel removed (safe for display). */
export function fixPersianLetters(s) {
  return String(s).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(TATWEEL, '');
}

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII. */
export function toAsciiDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BRACKET_NOISE = new RegExp(`[(\\[{]\\s*(?:${MUSIC_NOISE.bracketed.map(escapeRe).join('|')}|\\d{2,3}\\s*k(?:bps)?|128|192|256|320)\\s*[)\\]}]`, 'gi');
const PERSIAN_PREFIX = new RegExp(`^\\s*(?:${MUSIC_NOISE.persianPrefixes.map(escapeRe).join('|')})(?:\\s+|\\s*[:\\-–—]\\s*)`, 'u');
const PERSIAN_TAIL = new RegExp(`\\s+(?:${MUSIC_NOISE.persianTails.map(escapeRe).join('|')})(?:\\s.*)?$`, 'u');

/** Removes mentions, URLs, emojis, bitrate tags and the configured noise phrases. */
export function stripNoise(s) {
  let t = String(s);
  t = t.replace(/(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/\b(?:t|telegram)\.me\/\S+/gi, ' ');
  t = t.replace(/(^|[\s(\[])@[A-Za-z0-9_]{3,}/g, '$1');
  t = t.replace(EMOJI, ' ');
  t = t.replace(BRACKET_NOISE, ' ');
  t = t.replace(/\b(?:128|192|256|320)\s*(?:k|kbps)\b/gi, ' ').replace(/\bkbps\b/gi, ' ');
  t = t.replace(/[\s\-–—|]+\b(?:HQ|HD)\s*$/i, ' ');
  t = t.replace(PERSIAN_PREFIX, '');
  t = t.replace(PERSIAN_TAIL, '');
  return t;
}

const trimSeparators = (s) => s.replace(/^[\s\-–—_|.:,•·]+|[\s\-–—_|:,•·]+$/g, '');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Clean, human-readable text (or null when nothing is left). @param {any} s */
export function display(s) {
  if (s === null || s === undefined) return null;
  let t = String(s);
  if (typeof t.normalize === 'function') t = t.normalize('NFC');
  t = fixPersianLetters(t).replace(BIDI, '').replace(/\u200c{2,}/g, '\u200c');
  t = trimSeparators(collapse(stripNoise(t)));
  return t ? t : null;
}

/** Aggressive matching key. @param {any} s @returns {string} */
export function key(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).replace(/[ةۀەہ]/g, 'ه');
  if (typeof t.normalize === 'function') t = t.normalize('NFKD');
  else t = t.replace(/[آأإٱ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  t = t.replace(LATIN_MARKS, '').replace(ARABIC_MARKS, '').replace(/ٱ/g, 'ا');
  t = fixPersianLetters(t).toLowerCase();
  t = toAsciiDigits(t);
  t = t.replace(ZW_ALL, ' ').replace(/&/g, ' and ');
  t = t.replace(NOT_WORD, ' ');
  return collapse(t);
}

/** The space-free variant of a key («می\u200cخوام» = «میخوام» = «می خوام»). */
export const compact = (s) => key(s).replace(/\s+/g, '');

const MARKER_KEYS = VERSION_MARKERS.map((m) => key(m));
/** Does a phrase contain a version marker as a whole word (or word group)? */
export function hasVersionMarker(text) {
  const k = ` ${key(text)} `;
  return MARKER_KEYS.some((m) => m && k.includes(` ${m} `));
}

const FEAT_WORD = '(?:feat\\.?|ft\\.?|featuring)';
const PERSIAN_MARKER_TAIL = /\s+(ریمیکس|لایو|بی\u200cکلام|بیکلام|بی کلام|کاور|آکوستیک|اجرای زنده)$/u;

/**
 * Splits version markers off a title: "Song (Kygo Remix) [Live]" → { title: "Song", version: "Kygo Remix Live" }.
 * Markers count only in trailing brackets, a trailing " - …" part, or a trailing Persian marker word,
 * so a title like "Live Your Life" keeps its words.
 */
export function extractVersion(title) {
  let t = title || '';
  const parts = [];
  for (let guard = 0; guard < 4; guard++) {
    const m = /\s*[(\[]([^()\[\]]{1,60})[)\]]\s*$/.exec(t);
    if (m && hasVersionMarker(m[1])) {
      parts.unshift(m[1].trim());
      t = t.slice(0, m.index);
      continue;
    }
    const d = /\s+[-–—]\s+([^\-–—]{1,60})$/.exec(t);
    if (d && hasVersionMarker(d[1])) {
      parts.unshift(d[1].trim());
      t = t.slice(0, d.index);
      continue;
    }
    const p = PERSIAN_MARKER_TAIL.exec(t);
    if (p) {
      parts.unshift(p[1]);
      t = t.slice(0, p.index);
      continue;
    }
    break;
  }
  return { title: trimSeparators(collapse(t)) || null, version: parts.length ? parts.join(' ') : null };
}

/** Removes "(feat. X)" / " ft. X" from a title. @returns {{title: string|null, featured: string[]}} */
export function extractFeaturedFromTitle(title) {
  let t = title || '';
  const featured = [];
  const br = new RegExp(`\\s*[(\\[]\\s*${FEAT_WORD}\\s+([^()\\[\\]]+)[)\\]]`, 'i');
  let m = br.exec(t);
  if (m) {
    featured.push(...splitArtists(m[1]));
    t = t.slice(0, m.index) + t.slice(m.index + m[0].length);
  }
  m = new RegExp(`\\s+${FEAT_WORD}\\s+(.+)$`, 'i').exec(t);
  if (m) {
    featured.push(...splitArtists(m[1]));
    t = t.slice(0, m.index);
  }
  return { title: trimSeparators(collapse(t)) || null, featured };
}

/** "A & B x C و D" → ["A", "B", "C", "D"] (spec: feat., ft., featuring, x, &, و). */
export function splitArtists(s) {
  return String(s || '')
    .split(new RegExp(`\\s+${FEAT_WORD}\\s+|\\s*&\\s*|\\s+x\\s+|\\s+و\\s+`, 'iu'))
    .map((x) => trimSeparators(collapse(x)))
    .filter(Boolean);
}

/** "01. Artist - Title (320).mp3" → { artist: "Artist", title: "Title" } (raw, before display()). */
export function parseFileName(name) {
  let n = String(name || '').replace(/\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|wma|alac|mp4)$/i, '');
  n = n.replace(/_/g, ' ');
  n = stripNoise(n);
  n = n.replace(/^\s*\(?\d{1,3}\)?\s*[-.)]\s+/, '').replace(/^\s*0\d\s+/, '');
  n = collapse(n);
  let parts = n.split(/\s+[-–—]\s+/);
  if (parts.length < 2) parts = n.split(/\s*[–—]\s*/);
  if (parts.length < 2 && (n.match(/-/g) || []).length === 1) parts = n.split('-');
  if (parts.length >= 2) return { artist: parts[0].trim() || null, title: parts.slice(1).join(' - ').trim() || null };
  return { artist: null, title: n || null };
}

/**
 * Full metadata normalization for one audio.
 * @param {{title?: string|null, performer?: string|null, fileName?: string|null}} raw
 * @returns {{title: string|null, artist: string|null, featured: string|null, version: string|null, normalizedTitle: string, normalizedArtist: string, versionKey: string}}
 */
export function normalizeTrack({ title, performer, fileName }) {
  let rawTitle = title || null;
  let rawArtist = performer || null;
  if (rawTitle && !rawArtist && /\s[-–—]\s/.test(rawTitle)) {
    const p = parseFileName(rawTitle);
    rawArtist = p.artist;
    rawTitle = p.title;
  }
  if ((!rawTitle || !rawArtist) && fileName) {
    const p = parseFileName(fileName);
    rawTitle = rawTitle || p.title;
    rawArtist = rawArtist || p.artist;
  }
  const t1 = display(rawTitle);
  const ft = extractFeaturedFromTitle(t1);
  const v = extractVersion(ft.title);
  const artists = splitArtists(display(rawArtist));
  const primary = artists[0] || null;
  const featured = [...new Set([...artists.slice(1), ...ft.featured])];
  return {
    title: v.title,
    artist: primary,
    featured: featured.length ? featured.join(', ') : null,
    version: v.version,
    normalizedTitle: key(v.title),
    normalizedArtist: key(primary),
    versionKey: key(v.version),
  };
}
