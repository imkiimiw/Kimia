// Small text helpers: Persian digits, HTML escaping, normalization and truncation.

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Number or string with Western digits shown as Persian digits. */
export function fa(value) {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[d]);
}

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII, for parsing user input. */
export function asciiDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Escapes text for parse_mode HTML. */
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Normalizes user text: Arabic yeh/kaf to their Persian forms (so search finds both spellings),
 * control characters removed (newlines and tabs kept), outer whitespace trimmed.
 */
export function normalize(s) {
  return String(s)
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

/** Length in characters (code points), the way a person counts them. */
export function charLength(s) {
  return [...String(s)].length;
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function short(s, max) {
  const chars = [...String(s).replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
