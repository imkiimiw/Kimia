/**
 * Telegram sticker-pack rules (pure): names, titles, emojis, keywords, links, number lists.
 * Every number comes from limits.js.
 */
import { TELEGRAM } from './limits.js';
import { base36, asciiDigits, tgLength } from './util.js';

const SET = TELEGRAM.set;

/**
 * ws_<base36 user id>_<n>_by_<bot> — ASCII, starts with a letter, no "__", ≤ 64 chars.
 * @param {number} userId @param {number} n @param {string} botUsername
 */
export function makePackName(userId, n, botUsername) {
  const name = `ws_${base36(userId)}_${n}_by_${botUsername}`;
  if (!isValidPackName(name, botUsername)) throw new Error(`bad pack name ${name}`);
  return name;
}

/** Bot API rules for a sticker set name owned by this bot. */
export function isValidPackName(name, botUsername) {
  const s = String(name || '');
  if (s.length < 1 || s.length > SET.nameMaxChars) return false;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s) || s.includes('__')) return false;
  return s.toLowerCase().endsWith(`_by_${String(botUsername).toLowerCase()}`);
}

/** A title the user typed → cleaned title, or null when empty/too long. */
export function cleanTitle(text) {
  const s = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!s || tgLength(s) > SET.titleMaxChars) return null;
  return s;
}

// Emoji sequences: flags, keycaps, and pictographs with optional VS16 / skin tone / ZWJ joins.
const EMOJI_RE = /\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]\ufe0f?\u20e3|\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})?(?:\u200d\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})?)*/gu;

/** All emojis in a text, in order, without duplicates. */
export function extractEmojis(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(EMOJI_RE)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** Emojis for one sticker: 1–max of them, else null. */
export function parseEmojiList(text, max = SET.emojiPerStickerMax) {
  const list = extractEmojis(text);
  if (list.length < SET.emojiPerStickerMin || list.length > max) return null;
  return list;
}

/**
 * Keywords for one sticker: words separated by commas or spaces, 0–20, ≤ 64 characters in total.
 * "-" alone clears them. Returns null when over a limit.
 */
export function parseKeywords(text) {
  const s = String(text ?? '').trim();
  if (s === '-' || s === '—') return [];
  const words = [];
  for (const w of s.split(/[,،\s]+/)) {
    const k = w.trim().toLowerCase();
    if (k && !words.includes(k)) words.push(k);
  }
  if (words.length > SET.keywordsMax) return null;
  if (words.reduce((n, w) => n + tgLength(w), 0) > SET.keywordsTotalChars) return null;
  return words;
}

/** The InputSticker format of a Sticker object. @returns {'static'|'video'|'animated'} */
export function stickerFormat(sticker) {
  if (sticker && sticker.is_animated) return 'animated';
  if (sticker && sticker.is_video) return 'video';
  return 'static';
}

/** Can this sticker go into a regular sticker set by file_id? */
export function isRegularSticker(sticker) {
  return !!sticker && typeof sticker.file_id === 'string' && (!sticker.type || sticker.type === 'regular');
}

export const addStickersUrl = (name) => `https://t.me/addstickers/${name}`;

/** A set name from "t.me/addstickers/NAME", "tg://addstickers?set=NAME" or a bare name. */
export function parseSetRef(text) {
  const s = String(text ?? '').trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/i.exec(s);
  if (!m) m = /^tg:\/\/addstickers\?set=([A-Za-z0-9_]{1,64})$/i.exec(s);
  if (!m) m = /^([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(s);
  return m ? m[1] : null;
}

/**
 * "1-5, 8 12" → [0,1,2,3,4,7,11] (zero-based, sorted, unique), each ≤ max. Null if invalid.
 * Persian digits and "تا" are accepted.
 */
export function parseNumberList(text, max) {
  const s = asciiDigits(text).replace(/\s*(?:تا|to|–|—)\s*/gi, '-').trim();
  if (!s) return null;
  const set = new Set();
  for (const part of s.split(/[,،\s]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > max) return null;
    for (let i = a; i <= b; i++) set.add(i - 1);
  }
  return [...set].sort((x, y) => x - y);
}
