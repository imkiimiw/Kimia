// Inline keyboard builders (pure). Callback data always goes through the codec.
import { encode } from './codec.js';

/** @typedef {{text: string, callback_data?: string, url?: string, switch_inline_query_current_chat?: string}} Button */

/** A callback button. @param {string} text @param {string} ns @param {string} action @param {...(string|number)} args @returns {Button} */
export const btn = (text, ns, action, ...args) => ({ text, callback_data: encode(ns, action, ...args) });

/** @param {string} text @param {string} url @returns {Button} */
export const urlBtn = (text, url) => ({ text, url });

/** @param {(Button|null|undefined|false)[][]} rows */
export function markup(rows) {
  const clean = rows.map((r) => r.filter(Boolean)).filter((r) => r.length);
  return { inline_keyboard: /** @type {Button[][]} */ (clean) };
}

/** Splits buttons into rows of `n`. @param {Button[]} buttons @param {number} n */
export function grid(buttons, n = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
}
