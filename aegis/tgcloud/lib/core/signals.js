/*
 * Signals for group security (Phase 5). Pure: no platform calls.
 *
 * - invisible(): zero-width, bidi-override, Hangul-filler and Braille-blank characters. ZWNJ/ZWJ
 *   are normal in Persian and emoji and never count; left/right marks only count when many.
 * - mixedScriptWords(): words that mix Latin letters with look-alike Cyrillic/Greek ones ("раypal").
 * - skeleton(): a name reduced to what it looks like (look-alikes → Latin, no invisible characters),
 *   to catch impersonation of admins and of Telegram itself.
 * - deobfuscate(): undoes link disguises (full-width letters, look-alike dots, "dot"/«نقطه»).
 * - dangerousFile(): executables, installers, scripts, macro documents, double extensions.
 * - adHits(): ad and scam phrases in the five languages.
 * - score()/adjust(): the risk score from weighted signals, and the weights learning from the
 *   admins' feedback (right → ×1.1, wrong → ×0.8, kept within 0.3–2× the default).
 */

const STRONG = /[\u200B\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u3164\u115F\u1160\u2800\u180E]/g;
const MARKS = /[\u200E\u200F\u061C]/g;
const INVISIBLE_ALL = /[\u200B\u200E\u200F\u061C\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u3164\u115F\u1160\u2800\u180E]/g;

export function invisible(text) {
  const s = String(text || '');
  const strong = (s.match(STRONG) || []).length;
  const marks = (s.match(MARKS) || []).length;
  return { strong, marks, suspicious: strong > 0 || marks >= 4 };
}

export const stripInvisible = (text) => String(text || '').replace(INVISIBLE_ALL, '');

/* Look-alike letters (Cyrillic and Greek) → the Latin letter they imitate. */
const CONFUSABLE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

export function mixedScriptWords(text) {
  let n = 0;
  for (const w of stripInvisible(text).split(/[^\p{L}]+/u)) {
    if (w.length >= 3 && LATIN.test(w) && LOOKALIKE.test(w)) n += 1;
  }
  return n;
}

/* What a name looks like: lowercase, look-alikes mapped to Latin, only letters and digits. */
export function skeleton(s) {
  return [...stripInvisible(s).toLowerCase()].map((ch) => CONFUSABLE[ch] || ch).join('').replace(/[^\p{L}\p{N}]+/gu, '');
}

const OFFICIAL = ['telegram', 'telegramsupport', 'telegramteam', 'support', 'admin', 'administrator', 'تلگرام', 'پشتیبانی', 'مدیر', 'ادمین', 'поддержка',
  'администратор', '管理员', '客服'];

/*
 * A member's name: link or @username in it, invisible characters, look-alike letters, and
 * impersonation (the same as an admin's name, or posing as Telegram / support / admin).
 */
export function nameSignals(user, adminNames = []) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const out = [];
  if (/(?:t\.me|telegram\.me|https?:\/\/|www\.)|@[A-Za-z][A-Za-z0-9_]{3,}/i.test(deobfuscate(name))) out.push('name_link');
  if (invisible(name).suspicious || (name && !stripInvisible(name).trim())) out.push('name_invisible');
  if (mixedScriptWords(name) > 0) out.push('name_homoglyph');
  const sk = skeleton(name);
  if (sk.length >= 3 && (adminNames.some((a) => skeleton(a) === sk) || OFFICIAL.some((o) => sk === o || sk.startsWith(o) || sk.endsWith(o)))) out.push('impersonation');
  if (!user.username) out.push('no_username');
  return out;
}

/* ---------- links in disguise ---------- */

const DOTS = /[․。．｡·•∙⋅܁܂]/g;

export function deobfuscate(text) {
  return stripInvisible(text)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(DOTS, '.')
    .replace(/([\p{L}\p{N}])\s*(?:\(\s*dot\s*\)|\[\s*dot\s*\]|\{\s*dot\s*\}|\s+dot\s+|\s*نقطه\s*|\s*точка\s*|\s*点\s*)\s*([\p{L}\p{N}])/giu, '$1.$2')
    .replace(/([\p{L}\p{N}])\s+\.\s*([a-z]{2,})\b/giu, '$1.$2')
    .replace(/\b(t|telegram)\s*\.\s*(me|dog)\s*\/\s*/gi, '$1.$2/');
}

/* URLs on the message's inline buttons (messages sent through inline bots can carry them). */
export function buttonUrls(message) {
  const rows = message && message.reply_markup && message.reply_markup.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  return rows.flat().map((b) => b && (b.url || (b.login_url && b.login_url.url))).filter(Boolean);
}

/* ---------- files ---------- */

const DANGEROUS_EXT = new Set(['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'msp', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'jar', 'apk', 'xapk',
  'apks', 'lnk', 'hta', 'cpl', 'dll', 'reg', 'sh', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'iso', 'img', 'vhd', 'docm', 'xlsm', 'pptm']);
const DANGEROUS_MIME = new Set(['application/x-msdownload', 'application/x-msdos-program', 'application/vnd.android.package-archive', 'application/x-sh',
  'application/java-archive', 'application/x-ms-installer']);
const HARMLESS_LOOK = /\.(pdf|jpe?g|png|gif|webp|docx?|xlsx?|pptx?|txt|mp4|mp3|zip|rar)\.[a-z0-9]{2,5}$/i;

/* null, or why a file is dangerous: rlo (reversed name trick), double (photo.jpg.exe), ext, mime. */
export function dangerousFile(doc) {
  if (!doc) return null;
  const name = String(doc.file_name || '');
  if (/\u202E/.test(name)) return 'rlo';
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(name.trim()) || [])[1];
  const bad = ext && DANGEROUS_EXT.has(ext.toLowerCase());
  if (bad && HARMLESS_LOOK.test(name.trim())) return 'double';
  if (bad) return 'ext';
  if (doc.mime_type && DANGEROUS_MIME.has(String(doc.mime_type).toLowerCase())) return 'mime';
  return null;
}

/* ---------- ads and scams ---------- */

const AD_WORDS = [
  'join', 'subscribe', 'promo', 'discount', 'earn money', 'income', 'profit', 'investment', 'invest', 'crypto', 'airdrop', 'giveaway', 'free', 'followers',
  'members', 'cheap', 'dm me', 'contact me', 'casino', 'betting', 'forex', 'loan',
  'عضو شو', 'عضو شوید', 'جوین', 'تبلیغ', 'تبلیغات', 'ممبر', 'فالوور', 'سفارش', 'کسب درآمد', 'درآمد', 'سرمایه گذاری', 'ارز دیجیتال', 'رایگان', 'تخفیف', 'پیوی',
  'پی وی', 'شرط بندی', 'کازینو', 'وام',
  'подпишись', 'подписывайтесь', 'заработок', 'заработать', 'доход', 'инвестиции', 'крипта', 'бесплатно', 'скидка', 'пиши в лс', 'реклама', 'казино', 'ставки',
  '加群', '进群', '赚钱', '兼职', '投资', '优惠', '免费', '私聊', '广告', '博彩',
  'abonnez', 'rejoignez', 'gagner', 'revenu', 'investissement', 'gratuit', 'réduction', 'contactez',
];
const SCAM = [
  'telegram support', 'telegram team', 'verify your account', 'your account will be', 'account has been', 'پشتیبانی تلگرام', 'حساب شما مسدود', 'تایید حساب',
  'служба поддержки telegram', 'ваш аккаунт будет', '账号将被', 'telegram 官方', 'votre compte sera',
];

const lower = (t) => stripInvisible(t).toLowerCase().replace(/\s+/g, ' ');
function hits(text, words) {
  const t = ` ${lower(text)} `;
  return words.filter((w) => (/^[a-z ]+$/.test(w) ? new RegExp(`\\b${w}\\b`).test(t) : t.includes(w))).length;
}
export const adHits = (text) => hits(text, AD_WORDS);
export const scamHits = (text) => hits(text, SCAM);

/* A short fingerprint of a message's text (FNV-1a), the same for the same visible text. */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (const ch of lower(text).trim()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ---------- risk ---------- */

export const WEIGHTS = {
  no_username: 10, name_link: 30, name_pattern: 30, name_invisible: 25, name_homoglyph: 20, impersonation: 40, raid: 20,
  new_link: 30, first_link: 20, ad_words: 15, xgroup: 45, fwd_channel_new: 20, invisible: 20, homoglyph: 25, deceptive: 30, danger_file: 50,
  dup_media: 20, flood: 25,
};
export const RISK_LEVELS = { low: [50, 90], medium: [40, 70], high: [30, 50] }; /* [alert at, act at] */

/* { score, reasons: [[signal, points]] }, strongest reasons first. mult: the chat's learned weights. */
export function score(signals, mult = {}) {
  const reasons = [...new Set(signals)].filter((s) => WEIGHTS[s]).map((s) => [s, Math.round(WEIGHTS[s] * (Number(mult[s]) || 1))]);
  reasons.sort((a, b) => b[1] - a[1]);
  return { score: reasons.reduce((n, r) => n + r[1], 0), reasons };
}

export function adjust(mult, signals, right) {
  const out = { ...mult };
  for (const s of signals) {
    if (!WEIGHTS[s]) continue;
    const cur = Number(out[s]) || 1;
    out[s] = Math.round(Math.min(2, Math.max(0.3, cur * (right ? 1.1 : 0.8))) * 100) / 100;
  }
  return out;
}

/* ---------- captcha ---------- */

const EMOJIS = ['🍎', '🚗', '🐶', '🌙', '⭐', '🎈', '🍕', '⚽', '🔑', '🎵', '🌵', '🐟'];

function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* { kind, target, options, answer }: press the shown emoji, or solve a small sum. */
export function makeCaptcha(mode, rnd = Math.random) {
  if (mode === 'math') {
    const a = 1 + Math.floor(rnd() * 9);
    const b = 1 + Math.floor(rnd() * 9);
    const right = a + b;
    const opts = new Set([right]);
    while (opts.size < 4) opts.add(Math.max(2, right + Math.floor(rnd() * 9) - 4));
    const options = shuffle([...opts].map(String), rnd);
    return { kind: 'math', target: `${a} + ${b}`, options, answer: options.indexOf(String(right)) };
  }
  const options = shuffle(EMOJIS, rnd).slice(0, 6);
  const answer = Math.floor(rnd() * options.length);
  return { kind: 'button', target: options[answer], options, answer };
}
