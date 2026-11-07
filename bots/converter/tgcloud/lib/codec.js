// callback_data: short codes joined by ':' (≤ 64 bytes, a Telegram limit). Pure.
// The table of codes is in lib/router.js. Wizard state lives in the database, never in buttons.

const MAX = 64;
const enc = new TextEncoder();

/** Builds callback_data from parts; throws if it would exceed 64 bytes (caught by tests). */
export function cb(...parts) {
  const data = parts.map((p) => String(p)).join(':');
  if (enc.encode(data).length > MAX) throw new Error(`callback_data too long: ${data}`);
  if (!data) throw new Error('empty callback_data');
  return data;
}

/** → { code, args } */
export function parse(data) {
  const parts = String(data || '').split(':');
  return { code: parts[0], args: parts.slice(1) };
}

/** An inline button. */
export const btn = (text, ...parts) => ({ text, callback_data: cb(...parts) });
export const urlBtn = (text, url) => ({ text, url });

/** An inline keyboard from rows (falsy entries are dropped). */
export function kb(...rows) {
  const clean = rows.map((r) => (Array.isArray(r) ? r.filter(Boolean) : [r].filter(Boolean))).filter((r) => r.length);
  return { inline_keyboard: clean };
}

/** Lays buttons out two per row (the spec's two-column menus). */
export function grid(buttons, perRow = 2) {
  const rows = [];
  const list = buttons.filter(Boolean);
  for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
  return rows;
}
