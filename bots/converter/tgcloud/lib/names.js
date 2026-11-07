// File names (spec §6): sanitizing and the safe-rename operations. Pure.
// Telegram keeps ≤ 64 characters of a document's base name and ≤ 16 of its extension and drops
// emoji (measured, docs/LIMITS.md §5 #2), so the sanitizer applies the same rules itself: what the
// user is shown is exactly what arrives.
import { NAME_BASE_MAX, NAME_EXT_MAX } from './config.js';
import { TYPES } from './detect/types.js';
import { tehranDay } from './util.js';

// bidi embeddings/overrides/isolates (the "RTLO trick"), LRM/RLM/ALM marks
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
// format characters except ZWNJ (U+200C, needed in Persian words) and ZWJ (U+200D)
const FORMAT = /(?![\u200c\u200d])[\p{Cf}]/gu;
const CONTROL = /[\p{Cc}\p{Co}\p{Cs}]/gu;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}︎️⃣]/gu;
const UNSAFE = /[/\\:*?"<>|]/g; // path separators + what Windows refuses in names
const EXT_RE = /^[a-z0-9]{1,16}$/;

const cp = (s) => [...s];

/** → { base, ext } with ext lower-case ('' if none or not a plausible extension). */
export function splitName(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  if (dot > 0) {
    const ext = s.slice(dot + 1).toLowerCase();
    if (EXT_RE.test(ext)) return { base: s.slice(0, dot), ext };
  }
  return { base: s, ext: '' };
}

/** Cleans a base name (no extension): NFC, no controls/bidi/emoji/separators, ≤ 64 characters. */
export function cleanBase(base) {
  let s = String(base || '').normalize('NFC');
  s = s.replace(BIDI, '').replace(CONTROL, ' ').replace(FORMAT, '').replace(EMOJI, '');
  s = s.replace(UNSAFE, '_');
  s = s.replace(/\u200c{2,}/g, '\u200c').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s\u200c]+/, '').replace(/[.\s\u200c]+$/, ''); // no hidden files, no trailing dots
  s = cp(s).slice(0, NAME_BASE_MAX).join('').replace(/[.\s\u200c]+$/, '');
  return s;
}

/**
 * Full name: sanitized base + extension (ext must look like an extension, ≤ 16). An empty base
 * becomes `fallback`. → string
 */
export function sanitizeName(name, { fallback = 'file', ext: forcedExt } = {}) {
  const { base, ext } = splitName(String(name || '').normalize('NFC').replace(BIDI, ''));
  let b = cleanBase(base);
  if (!b) b = cleanBase(fallback) || 'file';
  const e = forcedExt !== undefined ? forcedExt : ext;
  const cleanExt = EXT_RE.test(e || '') ? cp(e).slice(0, NAME_EXT_MAX).join('') : '';
  return joinName(b, cleanExt);
}

/**
 * base + extension. Without an extension, Telegram still treats the text after the last dot as one
 * and cuts it to 16 characters, so such dots become '_' (what the user sees is what arrives).
 */
export function joinName(base, ext) {
  if (ext) return `${base}.${ext}`;
  let b = base;
  for (;;) {
    const dot = b.lastIndexOf('.');
    if (dot <= 0 || cp(b.slice(dot + 1)).length <= NAME_EXT_MAX) return b;
    b = `${b.slice(0, dot)}_${b.slice(dot + 1)}`;
  }
}

/** True when the original name contained characters the sanitizer removes for safety. */
export function hadSuspiciousChars(name) {
  BIDI.lastIndex = 0;
  return BIDI.test(String(name || ''));
}

/** Persian-friendly tidy-up of a base name (the «🧹 مرتب\u200cسازی» rename). */
export function normalizeBase(base) {
  let s = String(base || '').normalize('NFC');
  s = s.replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک'); // ي ى → ی, ك → ک
  s = s.replace(/ـ/g, ''); // tatweel
  s = s.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x660 + 0x6f0)); // ٠-٩ → ۰-۹
  s = s.replace(/[_]+/g, ' ').replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-');
  s = s.replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ');
  return cleanBase(s);
}

/** Extensions a renamed file may get: only ones that describe its detected type (spec §5). */
export function allowedExts(detected) {
  if (!detected || detected.dangerous) return [];
  return (TYPES[detected.id] && TYPES[detected.id].exts) || [];
}

/**
 * The extension a result file keeps: the current one if it describes the type, else the type's
 * canonical one; for unknown types the current one (it can't be checked, and it's not changed).
 */
export function resultExt(detected, currentExt) {
  if (detected.id === 'unknown' || detected.id === 'empty') return currentExt;
  return detected.extOk && currentExt ? currentExt : detected.ext;
}

const joinSep = (a, b) => (/[\p{L}\p{N}]$/u.test(a) && /^[\p{L}\p{N}]/u.test(b) ? `${a} ${b}` : `${a}${b}`);

/**
 * Applies a rename operation. op: { mode: 'name'|'prefix'|'suffix'|'normalize'|'ext', value }.
 * → { ok: true, name } | { ok: false, error: 'dangerous'|'empty'|'same'|'ext_not_allowed'|'too_long' }
 */
export function renameTo(currentName, detected, op) {
  if (detected.dangerous) return { ok: false, error: 'dangerous' };
  const { base, ext } = splitName(currentName);
  const curBase = cleanBase(base) || 'file';
  let newBase = curBase;
  let newExt = resultExt(detected, ext);
  const value = String(op.value ?? '');
  switch (op.mode) {
    case 'name': {
      const typed = splitName(value.normalize('NFC'));
      // a typed extension is accepted only if it describes the type; otherwise it stays part of the name
      if (typed.ext && allowedExts(detected).includes(typed.ext)) { newBase = cleanBase(typed.base); newExt = typed.ext; } else newBase = cleanBase(value);
      if (cp(value.trim()).length > 200) return { ok: false, error: 'too_long' };
      break;
    }
    case 'prefix': newBase = cleanBase(joinSep(cleanBase(value), curBase)); break;
    case 'suffix': newBase = cleanBase(joinSep(curBase, cleanBase(value))); break;
    case 'normalize': newBase = normalizeBase(curBase); break;
    case 'ext': {
      const e = value.toLowerCase();
      if (!allowedExts(detected).includes(e)) return { ok: false, error: 'ext_not_allowed' };
      newExt = e;
      break;
    }
    default: return { ok: false, error: 'empty' };
  }
  if (!newBase) return { ok: false, error: 'empty' };
  const name = joinName(newBase, newExt);
  if (name === currentName) return { ok: false, error: 'same' };
  return { ok: true, name };
}

/** The Detect & Fix name: same base, the detected type's canonical extension. */
export function fixedName(currentName, detected) {
  const { base } = splitName(currentName);
  return `${cleanBase(base) || 'file'}.${detected.ext}`;
}

/** A default name for media without one (photos, voice notes, video notes). */
export function defaultName(kind, detected, dateS) {
  const d = tehranDay(dateS);
  const ext = detected && detected.ext ? `.${detected.ext}` : '';
  return `${kind}_${d}${ext}`;
}
