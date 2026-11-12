/** HTML helpers for parse_mode 'HTML' (pure). Every dynamic value goes through esc(). (From wanger-music.) */

/** Escapes &, <, > and ". @param {any} v */
export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escaped text in a bidi isolate (FSI…PDI), so a Latin name inside Persian text stays readable. */
export const bidi = (v) => '\u2068' + esc(v) + '\u2069';

/** @param {any} v */
export const code = (v) => `<code>${esc(v)}</code>`;

/** Display name of a user row or Telegram user. */
export function displayName(u) {
  if (!u) return '?';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || (u.username ? '@' + u.username : String(u.tg_id ?? u.id ?? '?'));
}
