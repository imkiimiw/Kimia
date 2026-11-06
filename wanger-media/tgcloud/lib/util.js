// Small pure helpers. Pure module: must not import 'sdk'.
import { TZ_OFFSET_S } from './config.js';

/** Unix seconds now. (Date.now() advances across awaits, not during synchronous work.) */
export const nowSec = () => Math.floor(Date.now() / 1000);

/** YYYY-MM-DD of a unix time in Tehran (fixed UTC+03:30). */
export function tehranDay(sec) {
  const d = new Date((sec + TZ_OFFSET_S) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Escapes text for Telegram HTML parse mode. */
export function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cuts a string to at most n characters (code points), adding an ellipsis. */
export function clip(value, n) {
  const chars = Array.from(String(value ?? ''));
  return chars.length <= n ? chars.join('') : chars.slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** A user's display name for messages (escaped later by the caller). */
export function displayName(user) {
  const name = [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim();
  return name || (user && user.username) || String((user && user.id) || '');
}

/** Splits an array into chunks of at most `size` items. */
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Error text safe to store: message only, capped, never request params. */
export function errorText(err) {
  if (!err) return 'unknown error';
  const code = err.code ? `[${err.code}] ` : '';
  return clip(code + (err.description || err.message || String(err)), 300);
}
