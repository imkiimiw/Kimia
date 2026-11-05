// HTML helpers for parse_mode: 'HTML' (pure). Every dynamic value goes through esc().

/** Escapes &, <, > (and " for attributes). @param {any} v @returns {string} */
export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escaped text in a bidi isolate, so a Latin name inside Persian text (or the reverse) stays readable. */
export function bidi(v) {
  return '\u2068' + esc(v) + '\u2069';
}

/** @param {any} v */
export const code = (v) => `<code>${esc(v)}</code>`;

/** Display name of a Telegram user/chat row. @param {{first_name?: string|null, username?: string|null, title?: string|null, telegram_id?: number}} u */
export function displayName(u) {
  return (u && (u.first_name || u.title || (u.username ? '@' + u.username : ''))) || String((u && u.telegram_id) || '?');
}
