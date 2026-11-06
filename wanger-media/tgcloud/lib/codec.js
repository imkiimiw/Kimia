// callback_data codes: "<code>[:<arg>…]", at most 64 bytes (Bot API limit). Unknown or malformed data
// decodes to null, which the router treats as an expired menu. Pure module: must not import 'sdk'.
import { LANGS } from './config.js';

export const MAX_CALLBACK_BYTES = 64;

/** code → validator for its arguments. */
const CODES = {
  h: (a) => a.length === 0, // home
  l: (a) => a.length === 0, // language picker
  L: (a) => a.length === 1 && LANGS.includes(a[0]), // set language
  j: (a) => a.length === 0, // check forced join again
};
export const CB = { HOME: 'h', LANG_MENU: 'l', LANG_SET: 'L', JOIN_CHECK: 'j' };

/** UTF-8 byte length without TextEncoder. */
export function utf8Length(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export function encode(code, ...args) {
  const parts = [code, ...args.map(String)];
  if (!(code in CODES) || !CODES[code](parts.slice(1))) throw new Error(`codec: invalid callback ${parts.join(':')}`);
  const data = parts.join(':');
  if (utf8Length(data) > MAX_CALLBACK_BYTES) throw new Error(`codec: callback_data over ${MAX_CALLBACK_BYTES} bytes: ${data}`);
  return data;
}

export function decode(data) {
  if (typeof data !== 'string' || !data || utf8Length(data) > MAX_CALLBACK_BYTES) return null;
  const [code, ...args] = data.split(':');
  if (!Object.prototype.hasOwnProperty.call(CODES, code) || !CODES[code](args)) return null;
  return { code, args };
}
