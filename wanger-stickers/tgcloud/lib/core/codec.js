/**
 * callback_data codec (pure): "<ns>:<action>[:<arg>…]", at most 64 bytes, validated per route.
 * callback_data is untrusted (a modified client can send anything), so decoding is strict.
 * (Adapted from wanger-music lib/bot/codec.js.)
 */
import { utf8Length } from './util.js';
import { TELEGRAM } from './limits.js';

const NS = /^[a-z]{1,4}$/;
const ACTION = /^[a-z0-9_]{1,12}$/;
const ARG = /^[A-Za-z0-9_-]{1,40}$/;

/** Argument types a route can declare. */
export const ARG_TYPES = Object.freeze({
  uint: /^\d{1,16}$/,
  int: /^-?\d{1,16}$/,
  lang: /^(fa|en)$/,
  word: /^[a-z0-9_]{1,24}$/,
  fuid: /^[A-Za-z0-9_-]{6,40}$/, // a Telegram file_unique_id
});

/** @param {string} ns @param {string} action @param {...(string|number)} args */
export function encode(ns, action, ...args) {
  if (!NS.test(ns) || !ACTION.test(action)) throw new Error(`bad callback route ${ns}:${action}`);
  const parts = [ns, action, ...args.map(String)];
  for (const a of parts.slice(2)) if (!ARG.test(a)) throw new Error(`bad callback arg "${a}"`);
  const s = parts.join(':');
  if (utf8Length(s) > TELEGRAM.ui.callbackDataMaxBytes) throw new Error(`callback_data over 64 bytes: ${s}`);
  return s;
}

/** @param {unknown} data @returns {{ns: string, action: string, args: string[]} | null} */
export function decode(data) {
  if (typeof data !== 'string' || !data || utf8Length(data) > TELEGRAM.ui.callbackDataMaxBytes) return null;
  const [ns, action, ...args] = data.split(':');
  if (!NS.test(ns || '') || !ACTION.test(action || '')) return null;
  for (const a of args) if (!ARG.test(a)) return null;
  return { ns, action, args };
}

/** Checks args against declared types; numbers come back as numbers. @returns {(string|number)[] | null} */
export function parseArgs(args, spec) {
  if (args.length !== spec.length) return null;
  const out = [];
  for (let i = 0; i < spec.length; i++) {
    const re = /** @type {Record<string, RegExp>} */ (ARG_TYPES)[spec[i]];
    if (!re || !re.test(args[i])) return null;
    if (spec[i] === 'uint' || spec[i] === 'int') {
      const n = Number(args[i]);
      if (!Number.isSafeInteger(n)) return null;
      out.push(n);
    } else out.push(args[i]);
  }
  return out;
}

/** Inline keyboard builders. */
export const btn = (text, ns, action, ...args) => ({ text, callback_data: encode(ns, action, ...args) });
export const urlBtn = (text, url) => ({ text, url });
/** @param {any[][]} rows */
export function markup(rows) {
  return { inline_keyboard: rows.map((r) => r.filter(Boolean)).filter((r) => r.length) };
}
/** Splits buttons into rows of n. */
export function grid(buttons, n = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += n) rows.push(buttons.slice(i, i + n));
  return rows;
}
