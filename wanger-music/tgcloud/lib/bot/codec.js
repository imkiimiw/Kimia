// callback_data codec (pure): "<ns>:<action>[:<arg>…]", at most 64 bytes, validated per route.
// callback_data is untrusted (modified clients can send anything), so decoding is strict.
import { utf8Length } from '../core/util.js';
import { LIMITS } from '../config/static.js';

const NS = /^[a-z]{1,8}$/;
const ACTION = /^[a-z0-9_]{1,16}$/;
const ARG = /^[A-Za-z0-9_.-]{1,40}$/;

/** Argument types a route can declare. */
export const ARG_TYPES = Object.freeze({
  uint: /^\d{1,16}$/,
  int: /^-?\d{1,16}$/,
  lang: /^(fa|en)$/,
  key: /^[a-z_.]{1,40}$/,
  word: /^[a-z0-9_]{1,24}$/,
  tlang: /^(fa|en|other)$/,
  field: /^(title|artist|album)$/,
  pid: /^[A-Za-z0-9]{8,10}$/,
  mode: /^(inc|exc)$/,
});

/** @param {string} ns @param {string} action @param {...(string|number)} args @returns {string} */
export function encode(ns, action, ...args) {
  if (!NS.test(ns) || !ACTION.test(action)) throw new Error(`bad callback route ${ns}:${action}`);
  const parts = [ns, action, ...args.map(String)];
  for (const a of parts.slice(2)) if (!ARG.test(a)) throw new Error(`bad callback arg "${a}"`);
  const s = parts.join(':');
  if (utf8Length(s) > LIMITS.callbackMaxBytes) throw new Error(`callback_data over 64 bytes: ${s}`);
  return s;
}

/** @param {unknown} data @returns {{ns: string, action: string, args: string[]} | null} */
export function decode(data) {
  if (typeof data !== 'string' || !data || utf8Length(data) > LIMITS.callbackMaxBytes) return null;
  const [ns, action, ...args] = data.split(':');
  if (!NS.test(ns || '') || !ACTION.test(action || '')) return null;
  for (const a of args) if (!ARG.test(a)) return null;
  return { ns, action, args };
}

/**
 * Checks args against a route's declared types; returns parsed values or null.
 * @param {string[]} args @param {string[]} spec e.g. ['uint'] @returns {(string|number)[] | null}
 */
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
