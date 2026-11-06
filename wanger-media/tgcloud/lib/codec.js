// callback_data codes: "<code>[:<arg>…]", at most 64 bytes (Bot API limit). Unknown or malformed data
// decodes to null, which the router treats as an expired menu. Pure module: must not import 'sdk'.
import { BUILT_PLATFORMS, HISTORY_MAX, HISTORY_PAGE, LANGS, METHODS, QUALITIES } from './config.js';

export const MAX_CALLBACK_BYTES = 64;

const HISTORY_PAGES = Math.ceil(HISTORY_MAX / HISTORY_PAGE);
const none = (a) => a.length === 0;
const fromSettings = (a) => a.length === 0 || (a.length === 1 && a[0] === 's');

/** code → validator for its arguments. */
const CODES = {
  h: none, // home
  l: fromSettings, // language picker (l:s = opened from settings)
  L: (a) => (a.length === 1 || (a.length === 2 && a[1] === 's')) && LANGS.includes(a[0]), // set language
  j: none, // check forced join again
  a: none, // accept the disclaimer
  H: (a) => a.length === 1 && /^\d{1,2}$/.test(a[0]) && Number(a[0]) < HISTORY_PAGES, // history page (0-based)
  s: none, // settings
  q: none, // quality picker
  Q: (a) => a.length === 1 && QUALITIES.includes(a[0]), // set quality
  i: none, // help
  o: none, // about
  d: none, // how to download
  // admin panel (Phase 4): A[:<section>[:args]] — see ADMIN_SECTIONS
  A: (a) => adminArgs(a),
  P: (a) => a.length === 1 && BUILT_PLATFORMS.includes(a[0]), // one platform
  M: (a) => a.length === 3 && BUILT_PLATFORMS.includes(a[0]) && METHODS.includes(a[1]) && (a[2] === '0' || a[2] === '1'), // method off/on (on → risk note)
  C: (a) => a.length === 2 && BUILT_PLATFORMS.includes(a[0]) && METHODS.includes(a[1]), // confirm enabling after the risk note
  E: (a) => a.length === 2 && BUILT_PLATFORMS.includes(a[0]) && (a[1] === '0' || a[1] === '1'), // pause (1) / resume (0)
  T: (a) => a.length === 1 && BUILT_PLATFORMS.includes(a[0]), // health check
};
const ID = /^\d{1,15}$/;
const SMALL_ID = /^\d{1,9}$/;
const ROLE = /^(user|support|moderator|admin|super_admin)$/;
const TEXT_KEY = /^(welcome|join)$/;
const LANG = new RegExp(`^(${LANGS.join('|')})$`);
const PLATFORM = new RegExp(`^(${BUILT_PLATFORMS.join('|')})$`);
/** Admin sections → the allowed argument patterns (one array per accepted arity). */
export const ADMIN_SECTIONS = {
  o: [[]], // overview
  u: [[], [ID]], // users: search prompt / profile
  ub: [[ID, /^(0|1|7|30)$/]], uu: [[ID]], uq: [[ID]], un: [[ID]], uh: [[ID, /^\d{1,2}$/]],
  c: [[], [SMALL_ID]], ca: [[]], ct: [[SMALL_ID]], cr: [[SMALL_ID]], cd: [[SMALL_ID]], cD: [[SMALL_ID]], // channels
  p: [[]], pb: [[]], pba: [[/^(url|account|domain)$/]], pbd: [[SMALL_ID]], pc: [[]], pe: [[PLATFORM]], // platforms
  s: [[]], sm: [[]], sd: [[]], sf: [[]], sl: [[/^[qcm]$/]], // switches and limits
  t: [[]], te: [[TEXT_KEY, LANG]], tr: [[TEXT_KEY, LANG]], // texts
  b: [[]], bn: [[]], bs: [[SMALL_ID]], bg: [[SMALL_ID]], bx: [[SMALL_ID]], // broadcast
  a: [[/^\d$/]], // audit log page
  x: [[], [ID]], xa: [[]], xr: [[ID, ROLE]], xf: [[ID, /^[0-7]$/]], // staff
  i: [[]], // cancel the pending input
};
function adminArgs(a) {
  if (!a.length) return true; // admin home
  const forms = Object.prototype.hasOwnProperty.call(ADMIN_SECTIONS, a[0]) ? ADMIN_SECTIONS[a[0]] : null;
  const rest = a.slice(1);
  return !!forms && forms.some((f) => f.length === rest.length && f.every((re, i) => re.test(rest[i])));
}

export const CB = {
  HOME: 'h', LANG_MENU: 'l', LANG_SET: 'L', JOIN_CHECK: 'j', ACCEPT: 'a', HISTORY: 'H',
  SETTINGS: 's', QUALITY_MENU: 'q', QUALITY_SET: 'Q', HELP: 'i', ABOUT: 'o', DOWNLOAD: 'd',
  ADMIN: 'A', PLATFORM: 'P', METHOD: 'M', CONFIRM: 'C', PAUSE: 'E', HEALTH: 'T',
};

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
