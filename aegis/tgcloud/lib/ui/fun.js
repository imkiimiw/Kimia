/*
 * Fun features at work (Phase 9, fortune telling and fonts added after the release): the 36 features as commands (slash or the words of the funcmd
 * namespace — only as the whole message, or with valid arguments), the games and their answers,
 * buttons, birthdays greeted on the first message of the day, games ended lazily (sweep). Groups use
 * their own settings (engines/fun.js); private chats the defaults, for the features that make sense
 * alone. The panel section is panelFun below.
 *
 * Anti-abuse: a feature can be off or for admins only; a cooldown and a daily limit per member; a
 * limit per minute for the whole chat (silently ignored beyond it); games one of each kind at a
 * time; guesses at most every 3 s per member; the typing test refuses pasted text; duels must be
 * accepted; replies can delete themselves (fun_clean).
 *
 * Fortune telling (/fal and its six readings) and fonts: one message each, readings for the one who asked;
 * their buttons run the command again for whoever presses (with that member's own limits).
 *
 * callback_data: fn:<game>:c:<i> quick click · fn:<game>:a accept · fn:<game>:x cancel (the challenger)
 *   · fn:<game>:r|p|s rock-paper-scissors · fn:<game>:t:<cell> tic-tac-toe
 *   · fn:f:<code>[:<arg>] run a fortune command (tarot 1|3, horo <sign 0–11>) · fn:f:horo:p the sign buttons
 *   · fn:d:<a|b|e…> the decision helper's answers so far (only the one who asked)
 *   · fn:q:<test>[:<answers>] · fn:q:m:<self|spirit> a questionnaire (only the one who asked) · fn:m / fn:k:<A's answers>[:j|:<id>:<answers>] /match, /knowme
 *   · fn:r:<m|u|b>[:g|l|a:<page>|p:<r|g<i>|l<i>|a<i>>] film, music and book recommendations (menu, lists, a pick), for the one who asked
 *   · fn:t:<page>[:<part>] a page of /font (combo, mix, tg, uni, look, mark, fa, frame, extra), for the one who asked
 * Panel: g:c:fn  ·  g:c:fn:s:<key>  ·  g:c:fn:c:<cat>  ·  g:c:fn:m:<cat> (who may use the group: a → s → d)  ·  g:c:fn:f:<code>[:o|w|c|d|r]
 * /special, /unspecial (a reply, an id or @username; the chat's owner and admins): the «fun» list of special members.
 */
import { LIST_MAX_ENTRIES } from '../config.js';
import * as audit from '../core/audit.js';
import { asciiDigits, dateOf, toJalali, tzOf } from '../core/clock.js';
import { answer, btn, edit, markup, me, screen, send, tryCall, urlBtn } from '../core/tg.js';
import { esc, fullName, iso, normalizeWord, nowSec, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import * as fun from '../engines/fun.js';
import * as lists from '../engines/lists.js';
import * as msglog from '../engines/msglog.js';
import * as settings from '../engines/settings.js';
import { stats } from '../engines/social.js';
import * as users from '../engines/users.js';
import { LANGS, dur, isRtl, num, pickLang, t, wordCommand } from '../i18n/index.js';
import { isAdmin } from './enforce.js';
import { back, needLevel, pairs } from './guard.js';
import { toggle } from './panel_channel.js';

const flag = settings.flag;
const RLM = /[\u200F\u200E]/g;
/* A content list from funlist (one item per line), without direction marks. */
const list = (lang, key) => t(lang, `funlist.${key}`).split('\n').map((x) => x.replace(RLM, '').trim()).filter(Boolean);
/* The same for the fortune-telling lists (fallist). */
/* a t() string used inside a line (its right-to-left mark belongs at the line's start, not here) */
const inline = (lang, key, vars) => t(lang, key, vars).replace(RLM, '');
const flist = (lang, key) => t(lang, `fallist.${key}`).split('\n').map((x) => x.replace(RLM, '').trim()).filter(Boolean);
const norm = (s) => normalizeWord(String(s || '').replace(RLM, '').replace(new RegExp(fun.PASTE_MARK, 'g'), ''));
/* features that need a group (members, replies, the group's own lists); the rest also work in private */
const GROUP_ONLY = new Set(['love', 'wyr', 'act', 'couple', 'motd', 'bday', 'daily', 'click', 'ttt', 'lottery', 'vote', 'likely', 'lie', 'match', 'knowme']);
const PRIVATE_OK = new Set(fun.CODES.filter((c) => !GROUP_ONLY.has(c)));
const KEY_CODE = { hug: 'act', pat: 'act', highfive: 'act', wave: 'act', cheer: 'act', birthday: 'bday', birthdays: 'bday', fun: 'fun', fal: 'fal' };
const MENUS = new Set(['fun', 'fal']);
/* not features: an admin marks or unmarks a fun special member (a reply, an id or @username) */
const MANAGE = new Set(['special', 'unspecial']);
const ECHO_MAX = 4000;
const FONT_MAX = 40;
const LRI = (x) => `\u2068${x}\u2069`;
/* Lines built here (not by t()) get the right-to-left mark a Persian line needs. */
const rtl = (lang, text) => (isRtl(lang) ? text.split('\n').map((l) => (l && l[0] !== '\u200F' ? `\u200F${l}` : l)).join('\n') : text);
const CLICK = ['🍕', '🍔', '🍟', '🌭', '🍿', '🍩', '🍪', '🍉', '🍓', '🍒', '🍍', '🥝', '🥑', '🌶', '🥕', '🧀', '🍦', '🍫'];
const RPS_ICON = { r: '✊', p: '✋', s: '✌\uFE0F' };
const reply = (message) => ({ reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
const nameOf = (u) => iso(fullName(u), 32);

/* ---------- parsing ---------- */

export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > ECHO_MAX) return null; /* longer than 300 characters: only /echo */
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) {
    const name = m[1].toLowerCase();
    const code = MENUS.has(name) || MANAGE.has(name) ? name : fun.SLASH[name];
    if (!code || (s.length > 300 && code !== 'echo')) return null;
    return { code, sub: name, args: tokens.slice(1), slash: true, mention: m[2] ? m[2].toLowerCase() : null, words: 1 };
  }
  for (let n = Math.min(4, tokens.length); n >= 1; n -= 1) {
    const key = wordCommand('funcmd', tokens.slice(0, n).join(' '));
    if (!key) continue;
    const code = KEY_CODE[key] || key;
    const args = tokens.slice(n);
    const f = fun.byCode(code);
    if (args.length && !(f && f.args) && !MANAGE.has(code) && !(code === 'bday' && key === 'birthday')) continue;
    if (s.length > 300 && code !== 'echo') return null;
    return { code, sub: key, args, slash: false, mention: null, words: n };
  }
  return null;
}

/*
 * The text after the command's first `words` words, as typed (line breaks kept), and where it starts
 * (UTF-16 units, as Telegram counts entity offsets).
 */
export function restOf(text, words) {
  const raw = String(text || '');
  const m = new RegExp(`^\\s*\\S+(?:\\s+\\S+){${Math.max(0, words - 1)}}\\s*`).exec(raw);
  const start = m ? m[0].length : raw.length;
  return { text: raw.slice(start).replace(/\s+$/, ''), start };
}

/* ---------- helpers ---------- */

function dayOf(s, lang, now = nowSec()) {
  const tz = tzOf(s ? s.tz : 'auto', lang);
  return Math.floor((now + tz * 60) / 86400);
}

async function say(ctx, chatId, s, text, rows, view, extra = {}) {
  const m = await send(ctx, chatId, text, rows, view, extra);
  if (m && s && Number(s.fun_clean) && chatId < 0) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
  return m;
}

/* Points for a win (groups with points on and rewards on). Gives the line to add, or ''. */
async function reward(chatId, s, userId, n, lang) {
  if (!s || chatId > 0 || !n || !flag(s, 'pts_on') || !flag(s, 'fun_reward')) return '';
  const r = await stats.adjust(chatId, userId, n);
  return `\n${t(lang, 'fun.reward', { n: num(lang, n), total: num(lang, r.after) })}`;
}

/* ---------- commands ---------- */

/*
 * Gives true when the message was a fun command (handled, or ignored on purpose).
 * press: set when a button runs the command ({ answered }); its notices become the button's alert.
 */
export async function command(ctx, message, privUser = null, press = null) {
  const parsed = parseCommand(message.text);
  const from = message.from;
  if (!parsed || !from || from.is_bot || message.sender_chat) return false;
  const priv = message.chat.type === 'private';
  let chat = null;
  let s = null;
  let lang;
  if (priv) {
    lang = privUser ? privUser.lang : pickLang(from.language_code);
    if (!MENUS.has(parsed.code) && !PRIVATE_OK.has(parsed.code)) {
      await send(ctx, from.id, t(lang, 'fun.groups_only'), null, 'fun-groups-only');
      return true;
    }
  } else {
    chat = await chats.get(message.chat.id);
    if (!chat || !Number(chat.registered)) return false;
    if (parsed.mention && parsed.mention !== String((await me(ctx)).username).toLowerCase()) return false;
    s = await settings.all(ctx, chat.chat_id);
    lang = chat.lang;
    if (!flag(s, 'fun_on')) return parsed.slash;
  }
  const chatId = message.chat.id;
  if (parsed.code === 'fun') {
    await say(ctx, chatId, s, funList(lang, s, priv), null, 'fun-list', reply(message));
    return true;
  }
  if (parsed.code === 'fal') {
    const menu = falMenu(lang, s, priv);
    await say(ctx, chatId, s, menu.text, menu.rows, 'fun-fal', reply(message));
    return true;
  }
  if (MANAGE.has(parsed.code)) {
    await special(ctx, message, chat, s, lang, parsed);
    return true;
  }
  const notice = async (text, view) => {
    if (!press) return say(ctx, chatId, s, text, null, view, reply(message));
    press.answered = true;
    return answer(ctx, text.replace(RLM, '').replace(/<[^>]+>/g, '').slice(0, 190), true);
  };
  const c = fun.conf(s, parsed.code);
  if (!c.on) return parsed.slash;
  const admin = !priv && (await isAdmin(chatId, from.id));
  const f = fun.byCode(parsed.code);
  if (!priv && !admin) {
    /* the feature's own «who», then its group's: everyone, special members (and admins), or the owner and admins */
    const mode = fun.catMode(s, f.cat);
    const deny = c.who === 'd' || mode === 'd' ? 'admins' : (mode === 's' && !(await fun.isSpecial(chatId, from.id)) ? 'special' : null);
    if (deny) {
      if (!press) return parsed.slash;
      press.answered = true;
      await answer(ctx, inline(lang, `fun.only_${deny}`), true);
      return true;
    }
  }
  const pre = prepare(parsed, message, lang, s);
  if (pre && pre.bad) {
    if (parsed.slash) await notice(t(lang, pre.long ? 'fal.font_long' : `fun.usage_${parsed.code}`, { n: num(lang, FONT_MAX) }), 'fun-usage');
    return parsed.slash;
  }
  const free = admin && flag(s, 'fun_free');
  if (!priv && !free && !(await fun.claimRate(chatId, Number(s.fun_rate)))) return true;
  const day = dayOf(s, lang);
  const limits = parsed.code === 'daily' ? { ...c, cd: 0, daily: 1 } : c;
  /* a screen that only asks for input (sign buttons, «send your birth date») costs nothing; the reading does */
  const use = (await promptOnly(parsed, pre, priv, chatId, from.id)) ? 'ok'
    : await fun.claimUse(priv ? 0 : chatId, from.id, parsed.code, limits, day, { free: free && parsed.code !== 'daily' });
  if (use !== 'ok') {
    const text = use === 'daily' ? t(lang, parsed.code === 'daily' ? 'fun.daily_done' : 'fun.limit_daily', { n: num(lang, c.daily) })
      : t(lang, 'fun.limit_wait', { time: dur(lang, use.wait) });
    await notice(text, 'fun-limit');
    return true;
  }
  await run(ctx, { message, chat, chatId, s, lang, priv, parsed, f, c, pre, day });
  return true;
}

/* True when the command will only ask for input: no sign or saved birthday, no birth date or year. */
async function promptOnly(parsed, pre, priv, chatId, userId) {
  if (['chinese', 'lifepath', 'weekday'].includes(parsed.code)) return !pre.date && !pre.year;
  if (['horo', 'birthmonth', 'weekly'].includes(parsed.code) && pre.sign === null) return priv || !(await fun.birthdayOf(chatId, userId));
  return false;
}

/* Arguments checked before anything is counted. Gives { bad } or the parsed values. */
function prepare(parsed, message, lang, s) {
  const a = parsed.args;
  const text = a.join(' ');
  const target = message.reply_to_message && message.reply_to_message.from;
  const human = target && !target.is_bot && target.id !== message.from.id ? target : null;
  switch (parsed.code) {
    case 'hafez': {
      if (!a.length) return {};
      const n = toInt(asciiDigits(text));
      if (n !== null) return n >= 1 && n <= fun.fal.HAFEZ_COUNT ? { n } : { bad: true };
      return parsed.slash ? {} : { bad: true }; /* a slash command may carry an intention; a word, only a number */
    }
    case 'dialogue':
    case 'bookquote': {
      if (!a.length) return {};
      const n = toInt(asciiDigits(text));
      const max = fun.culture.count(parsed.code === 'dialogue' ? 'dialogues' : 'excerpts');
      if (n !== null) return n >= 1 && n <= max ? { n } : { bad: true };
      return parsed.slash ? {} : { bad: true };
    }
    case 'movie':
    case 'music':
    case 'book': {
      if (!a.length) return {};
      if (text.length > 60) return { bad: true };
      return recFind(lang, REC_KIND[parsed.code], text) || { none: text };
    }
    case 'khayyam':
    case 'babataher': {
      if (!a.length) return {};
      const n = toInt(asciiDigits(text));
      if (n !== null) return n >= 1 && n <= fun.poems.count(parsed.code) ? { n } : { bad: true };
      return parsed.slash ? {} : { bad: true };
    }
    case 'tarot': {
      if (!a.length) return { mode: 'one' };
      const n = toInt(asciiDigits(text));
      if (n !== null) return n === 1 ? { mode: 'one' } : (n === 3 ? { mode: 'three' } : { bad: true });
      return text.length >= 2 && text.length <= 200 ? { mode: 'yesno', q: text } : { bad: true };
    }
    case 'horo': {
      if (!a.length) return { sign: null };
      const sign = signFrom(text, lang, s);
      return sign === null ? { bad: true } : { sign };
    }
    case 'abjad': {
      if (text.length > 60) return { bad: true };
      if (text) return { name: text };
      return { name: (human || message.from).first_name || '', self: !human };
    }
    case 'birthmonth': {
      if (!a.length) return { sign: null };
      const sign = signFrom(text, lang, s);
      return sign === null ? { bad: true } : { sign };
    }
    case 'chinese': {
      if (!a.length) return {};
      const digits0 = asciiDigits(text).trim();
      const date = fun.birth.parseDate(digits0);
      if (date) return { date };
      if (!/^\d{4}$/.test(digits0)) return { bad: true };
      const y = Number(digits0);
      if (y >= 1300 && y < 1500) return { year: y + 621, jalali: true };
      return y >= 1900 && y <= 2100 ? { year: y } : { bad: true };
    }
    case 'cards':
    case 'runes':
    case 'lenormand': {
      if (!a.length) return {};
      const n = toInt(asciiDigits(text));
      return n === 1 || n === 3 ? { n } : { bad: true };
    }
    case 'iching':
      if (!a.length) return {};
      return parsed.slash && text.length <= 200 ? { q: text } : { bad: true };
    case 'lifepath':
    case 'weekday': {
      if (!a.length) return {};
      const date = fun.birth.parseDate(asciiDigits(text));
      return date ? { date } : { bad: true };
    }
    case 'clock':
    case 'mirror':
    case 'reversed':
    case 'triple': {
      if (!a.length) return {};
      const time = fun.numbers.parseTime(asciiDigits(text));
      return time ? { time } : { bad: true };
    }
    case 'angel':
    case 'sequence':
    case 'repeat':
    case 'number': {
      if (!a.length) return {};
      const n = fun.numbers.parseNumber(asciiDigits(text).replace(/[:.٫]/g, ''));
      return n ? { num: n } : { bad: true };
    }
    case 'echo': {
      const r = restOf(message.text, parsed.words || 1);
      return r.text ? { text: r.text, start: r.start } : { bad: true };
    }
    case 'font': {
      const src = text || (message.reply_to_message && (message.reply_to_message.text || message.reply_to_message.caption)) || '';
      const clean = String(src).replace(/[\u0000-\u001F\u200E\u200F\u202A-\u202E\u2066-\u2069]+/g, ' ').replace(/ {2,}/g, ' ').trim();
      if (!clean) return { bad: true };
      return [...clean].length > FONT_MAX ? { bad: true, long: true } : { text: clean };
    }
    case 'rand': {
      const nums = a.map((x) => toInt(asciiDigits(x)));
      if (!a.length) return { lo: 1, hi: 100 };
      if (nums.some((x) => x === null || Math.abs(x) > 1e9)) return { bad: true };
      const [lo, hi] = nums.length === 1 ? [1, nums[0]] : [nums[0], nums[1]];
      return lo < hi ? { lo, hi } : { bad: true };
    }
    case 'coin': {
      const opts = text.split(/\s*(?:\||,|،|\s+or\s+|\s+یا\s+|\s+или\s+|\s+ou\s+|还是)\s*/i).map((x) => x.trim()).filter(Boolean);
      return opts.length === 2 && text.length <= 200 ? { opts } : {};
    }
    case 'shuffle': {
      const opts = text.split(/\s*(?:\||,|،|、|\n)\s*/).map((x) => x.trim()).filter(Boolean);
      return opts.length >= 2 && opts.length <= 20 && text.length <= 600 ? { opts } : { bad: true };
    }
    case 'lottery': {
      const m = /^(\d{1,2})(?:\s+|$)/.exec(asciiDigits(text));
      const n = m ? Number(m[1]) : 1;
      const what = (m ? text.slice(m[0].length) : text).trim();
      return n >= 1 && n <= 10 && what.length <= 80 ? { n, what } : { bad: true };
    }
    case 'vote': {
      const raw = restOf(message.text, parsed.words || 1).text;
      const parts = raw.split(/\s*(?:\||\n)\s*/).map((x) => x.trim()).filter(Boolean);
      const [q, ...opts] = parts;
      return q && q.length <= 255 && opts.length >= 2 && opts.length <= 10 && opts.every((o) => o.length <= 100) ? { q, opts } : { bad: true };
    }
    case 'decide': {
      const opts = text.split(/\s*(?:\||,|،|\s+or\s+|\s+یا\s+|\s+или\s+|\s+ou\s+|还是)\s*/i).map((x) => x.trim()).filter(Boolean);
      return opts.length === 2 && opts.every((o) => [...o].length <= 40) && opts[0] !== opts[1] ? { opts } : { bad: true };
    }
    case 'lie': {
      const raw = restOf(message.text, parsed.words || 1).text;
      const parts = raw.split(/\s*(?:\||\n)\s*/).map((x) => x.trim()).filter(Boolean);
      const starred = parts.map((x, i) => (/^[*٭✱]/.test(x) ? i : -1)).filter((i) => i >= 0);
      const opts = parts.map((x) => x.replace(/^[*٭✱]\s*/, ''));
      return parts.length >= 3 && parts.length <= 4 && starred.length === 1 && opts.every((o) => o && o.length <= 100) ? { opts, correct: starred[0] } : { bad: true };
    }
    case 'likely':
      return human ? { target: human } : {};
    case 'ptest':
    case 'spirit': {
      if (!a.length) return {};
      const code = norm(text);
      const t = fun.tests.of(code);
      return t && t.g === (parsed.code === 'ptest' ? 'self' : 'spirit') ? { test: code } : { bad: true };
    }
    case 'weekly': {
      if (!a.length) return { sign: null };
      const sign = signFrom(text, lang, s);
      return sign === null ? { bad: true } : { sign };
    }
    case 'choose': {
      const opts = text.split(/\s*(?:\||,|،|\s+or\s+|\s+یا\s+|\s+или\s+|\s+ou\s+|还是)\s*/i).map((x) => x.trim()).filter(Boolean);
      return opts.length >= 2 && opts.length <= 20 && text.length <= 300 ? { opts } : { bad: true };
    }
    case 'ball8':
      return text.length >= 2 ? {} : { bad: true };
    case 'rate':
      return text.length >= 1 && text.length <= 100 ? { what: text } : (human ? { what: fullName(human), user: human } : { bad: true });
    case 'love':
      return human ? { target: human } : { bad: true };
    case 'act':
      return { target: human };
    case 'truth':
    case 'dare':
      return { target: human };
    case 'rps':
      return { target: human };
    case 'ttt':
      return human ? { target: human } : { bad: true };
    case 'bday':
      return { text };
    default:
      return {};
  }
}

/* A zodiac sign from a name (any language), a symbol, a Persian (Jalali) or Gregorian month name, or a birth date. */
export function signFrom(text, lang, s) {
  const raw = asciiDigits(String(text || '').replace(RLM, '')).trim();
  const symbol = fun.fal.SIGNS.findIndex((x) => raw.includes(x));
  if (symbol >= 0) return symbol;
  if (/^\d{1,4}([/.-]\d{1,4}){1,2}$/.test(raw)) {
    /* y/m/d, d.m.y, or m/d without a year (in the group's birthday calendar); a first number above 12 is the day */
    const n = raw.split(/[/.-]/).map(Number);
    let [y, m, d] = n.length === 3 ? (n[0] > 31 ? n : [n[2], n[1], n[0]]) : [0, n[0], n[1]];
    if (m > 12 && d <= 12) [m, d] = [d, m];
    if (n.length === 3 && y < 100) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return fun.fal.signOf(y ? (y < 1700 ? 'j' : 'g') : calOf(s, lang), m, d);
  }
  const words = new Set(norm(raw).split(/\s+/).filter(Boolean));
  const whole = norm(raw);
  const has = (w) => { const x = norm(w); return x && (words.has(x) || whole === x); };
  for (const l of LANGS) {
    const signs = flist(l, 'signs');
    for (let i = 0; i < 12; i += 1) if (String(signs[i] || '').split('|').some(has)) return i;
  }
  for (const l of LANGS) {
    for (let m = 1; m <= 12; m += 1) {
      if (has(t(l, `fun.month_j_${m}`))) return fun.fal.signOf('j', m, 1);
      if (has(t(l, `fun.month_g_${m}`))) return fun.fal.signOf('g', m, 1);
    }
  }
  return null;
}

/* categories with a menu of their own: one line in /fun */
const MENU_CAT = { fal: '/fal', hours: '/clock', numbers: '/number' };
function funList(lang, s, priv) {
  const lines = [t(lang, 'fun.list_title')];
  for (const cat of fun.CATS) {
    const feats = fun.FEATURES.filter((f) => f.cat === cat && (priv ? PRIVATE_OK.has(f.code) : fun.conf(s, f.code).on));
    if (!feats.length) continue;
    const mode = priv ? 'a' : fun.catMode(s, cat);
    const name = `${t(lang, `fun.cat_${cat}`)}${mode === 'a' ? '' : ` ${inline(lang, `fun.tag_${mode}`)}`}`;
    if (MENU_CAT[cat]) {
      lines.push('', t(lang, 'fun.list_menu', { cat: name, cmd: MENU_CAT[cat], n: num(lang, feats.length) }));
      continue;
    }
    lines.push('', rtl(lang, name));
    for (const f of feats) lines.push(rtl(lang, `${f.emoji} ${f.cmds.map((c) => `/${c}`).join(' ')} — ${t(lang, `fun.n_${f.code}`)}`));
  }
  if (!priv) lines.push('', t(lang, 'fun.list_words'));
  return lines.join('\n');
}

async function run(ctx, x) {
  const { message, chatId, s, lang, parsed, f, c, pre, day } = x;
  const from = message.from;
  const me = nameOf(from);
  const r = reply(message);
  const code = parsed.code;
  if (f.cat === 'dice') {
    const m = await tryCall(ctx, 'sendDice', { chat_id: chatId, emoji: f.dice, ...r }, `fun-${code}`);
    if (!m || !m.dice) return;
    if (s && Number(s.fun_clean)) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
    const v = Number(m.dice.value);
    const won = f.win(v);
    const extra = won ? await reward(chatId, s, from.id, c.reward, lang) : '';
    await say(ctx, chatId, s, t(lang, `fun.${code}_${won ? 'win' : 'lose'}`, { user: me, value: num(lang, v) }) + extra, null, `fun-${code}-result`,
      { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
    return;
  }
  switch (code) {
    case 'coin': {
      const heads = Math.random() < 0.5;
      const side = t(lang, heads ? 'fun.coin_heads' : 'fun.coin_tails');
      if (pre.opts) return say(ctx, chatId, s, t(lang, 'fun.coin_pick', { user: me, side: inline(lang, heads ? 'fun.coin_heads' : 'fun.coin_tails'), choice: iso(pre.opts[heads ? 0 : 1], 100) }), null, 'fun-coin', r);
      return say(ctx, chatId, s, t(lang, 'fun.coin', { user: me, side }), null, 'fun-coin', r);
    }
    case 'universe':
    case 'challenge':
      /* the same all day for each member */
      return say(ctx, chatId, s, t(lang, `fun.${code}`, { user: me, text: esc(list(lang, code)[fun.hash(`${code}:${from.id}:${day}`) % list(lang, code).length]) }), null, `fun-${code}`, r);
    case 'lovefal':
    case 'jobfal':
      return say(ctx, chatId, s, t(lang, `fun.${code}`, { user: me, text: esc(fun.pick(list(lang, code))) }), [[btn(inline(lang, `fun.n_${code}`), `fn:f:${code}`)]], `fun-${code}`, r);
    case 'deepq':
    case 'dateidea':
      return say(ctx, chatId, s, t(lang, `fun.${code}`, { text: esc(fun.pick(list(lang, code))) }), null, `fun-${code}`, r);
    case 'weekly':
      return weeklyReading(ctx, x);
    case 'shuffle': {
      const order = [...pre.opts].sort(() => Math.random() - 0.5).map((o, i) => rtl(lang, `${num(lang, i + 1)}. ${iso(o, 60)}`));
      return say(ctx, chatId, s, t(lang, 'fun.shuffle', { list: order.join('\n') }), null, 'fun-shuffle', r);
    }
    case 'lottery':
      return lottery(ctx, x);
    case 'vote': {
      const m = await tryCall(ctx, 'sendPoll', { chat_id: chatId, question: pre.q, options: pre.opts.map((o) => ({ text: o })), is_anonymous: true, ...r }, 'fun-vote');
      if (m && s && Number(s.fun_clean)) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
      return m;
    }
    case 'decide': {
      const sc = decideScreen(lang, pre.opts[0], pre.opts[1], me, '');
      return say(ctx, chatId, s, sc.text, sc.rows, 'fun-decide', r);
    }
    case 'likely':
      return likely(ctx, x);
    case 'ptest':
    case 'spirit': {
      const g = parsed.code === 'ptest' ? 'self' : 'spirit';
      const sc = pre.test ? testScreen(lang, pre.test, '', me) : testMenu(lang, g);
      return say(ctx, chatId, s, sc.text, sc.rows, `fun-${parsed.code}`, r);
    }
    case 'match':
    case 'knowme': {
      const sc = pairScreen(lang, code, '', null, '', me, null);
      return say(ctx, chatId, s, sc.text, sc.rows, `fun-${code}`, r);
    }
    case 'lie': {
      if (await tryCall(ctx, 'deleteMessage', { chat_id: chatId, message_id: message.message_id }, 'fun-lie-delete')) ctx.deletedCommand = message.message_id;
      const extra = message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {};
      return tryCall(ctx, 'sendPoll', { chat_id: chatId, question: inline(lang, 'fun.lie_q', { user: [...fullName(from)].slice(0, 40).join('') }).replace(/[\u2068\u2069]/g, ''),
        options: pre.opts.map((o) => ({ text: o })), type: 'quiz', correct_option_id: pre.correct, explanation: inline(lang, 'fun.lie_explain'), is_anonymous: false, ...extra }, 'fun-lie');
    }
    case 'rand':
      return say(ctx, chatId, s, t(lang, 'fun.rand', { lo: num(lang, pre.lo), hi: num(lang, pre.hi), n: num(lang, fun.randInt(pre.lo, pre.hi)) }), null, 'fun-rand', r);
    case 'choose':
      return say(ctx, chatId, s, t(lang, 'fun.choose', { choice: iso(fun.pick(pre.opts), 100) }), null, 'fun-choose', r);
    case 'ball8':
      return say(ctx, chatId, s, t(lang, 'fun.ball8', { answer: esc(fun.pick(list(lang, 'ball8'))) }), null, 'fun-ball8', r);
    case 'fortune':
      return say(ctx, chatId, s, t(lang, 'fun.fortune', { user: me, text: esc(fun.pick(list(lang, 'fortune'))) }), null, 'fun-fortune', r);
    case 'quote':
      return say(ctx, chatId, s, t(lang, 'fun.quote', { text: esc(fun.pick(list(lang, 'quote'))) }), null, 'fun-quote', r);
    case 'hafez':
      return hafez(ctx, x);
    case 'khayyam':
    case 'babataher':
      return poemReading(ctx, x);
    case 'dialogue':
      return dialogueReading(ctx, x);
    case 'bookquote':
      return excerptReading(ctx, x);
    case 'movie':
    case 'music':
    case 'book':
      return recommend(ctx, x);
    case 'tarot':
      return tarot(ctx, x);
    case 'horo':
      return horoscope(ctx, x);
    case 'abjad':
      return abjad(ctx, x);
    case 'coffee':
      return coffee(ctx, x);
    case 'font':
      return font(ctx, x);
    case 'echo':
      return echo(ctx, x);
    case 'clock':
    case 'mirror':
    case 'reversed':
    case 'triple':
    case 'angel':
    case 'sequence':
    case 'repeat':
    case 'number':
      return hours(ctx, x);
    case 'birthmonth':
    case 'chinese':
    case 'lifepath':
    case 'weekday':
      return birthReading(ctx, x);
    case 'cards':
    case 'runes':
    case 'iching':
    case 'tas':
    case 'lenormand':
      return drawReading(ctx, x);
    case 'quran':
    case 'tasbih':
    case 'anbia':
      return faithReading(ctx, x);
    case 'truth':
    case 'dare':
      return say(ctx, chatId, s, t(lang, `fun.${code}`, { user: pre.target ? nameOf(pre.target) : me, text: esc(fun.pick(list(lang, code))) }), null, `fun-${code}`, r);
    case 'love': {
      const ids = [from.id, pre.target.id].sort((a, b) => a - b);
      const pct = fun.hash(`${ids.join(':')}:${day}`) % 101;
      const hearts = '❤\uFE0F'.repeat(Math.round(pct / 20)) + '🤍'.repeat(5 - Math.round(pct / 20));
      return say(ctx, chatId, s, t(lang, 'fun.love', { a: me, b: nameOf(pre.target), pct: num(lang, pct), hearts }), null, 'fun-love', r);
    }
    case 'rate': {
      const score = fun.hash(`${norm(pre.what)}:${day}`) % 11;
      return say(ctx, chatId, s, t(lang, 'fun.rate', { what: iso(pre.what, 100), score: num(lang, score) }), null, 'fun-rate', r);
    }
    case 'wyr': {
      const [a, b] = fun.pick(list(lang, 'wyr')).split('|').map((y) => y.trim());
      if (!a || !b) return null;
      const m = await tryCall(ctx, 'sendPoll', { chat_id: chatId, question: t(lang, 'fun.wyr_q').replace(RLM, ''), options: [{ text: a.slice(0, 100) }, { text: b.slice(0, 100) }],
        is_anonymous: chatId > 0, ...r }, 'fun-wyr');
      if (m && s && Number(s.fun_clean)) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
      return m;
    }
    case 'act':
      return say(ctx, chatId, s, t(lang, pre.target ? `fun.act_${parsed.sub}` : `fun.act_${parsed.sub}_all`, { a: me, b: pre.target ? nameOf(pre.target) : '' }), null, 'fun-act', r);
    case 'couple':
    case 'motd':
      return dailyPick(ctx, x);
    case 'bday':
      return birthday(ctx, x);
    case 'daily': {
      if (!flag(s, 'pts_on')) return say(ctx, chatId, s, t(lang, 'fun.daily_off'), null, 'fun-daily-off', r);
      const n = fun.randInt(1, 10);
      const res = await stats.adjust(chatId, from.id, n);
      return say(ctx, chatId, s, t(lang, 'fun.daily_got', { user: me, n: num(lang, n), total: num(lang, res.after) }), null, 'fun-daily', r);
    }
    default:
      return startGame(ctx, x);
  }
}

/* ---------- fortune telling ---------- */

/* The /fal menu: the readings that are on, with a button each. */
function falMenu(lang, s, priv) {
  const feats = fun.FEATURES.filter((f) => f.cat === 'fal' && (priv ? PRIVATE_OK.has(f.code) : fun.conf(s, f.code).on));
  const lines = [t(lang, 'fal.menu_title'), ''];
  for (const f of feats) lines.push(rtl(lang, `${f.emoji} ${f.cmds.map((c) => `/${c}`).join(' ')} — ${t(lang, `fun.d_${f.code}`)}`));
  lines.push('', feats.length ? t(lang, 'fal.menu_note') : t(lang, 'fal.menu_none'));
  const label = (f) => `${f.emoji} ${t(lang, `fun.n_${f.code}`)}`.replace(RLM, '');
  const rows = pairs(feats.flatMap((f) => {
    if (f.code === 'tarot') return [btn(t(lang, 'fal.btn_tarot1'), 'fn:f:tarot:1'), btn(t(lang, 'fal.btn_tarot3'), 'fn:f:tarot:3')];
    return [btn(label(f), `fn:f:${f.code}${f.code === 'horo' || f.code === 'weekly' ? ':p' : ''}`)];
  }));
  return { text: lines.join('\n'), rows };
}

async function hafez(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const g = fun.fal.ghazal(pre.n || fun.randInt(1, fun.fal.HAFEZ_COUNT));
  const verses = g.v.map(([a, b]) => `\u200F${esc(a)}\n\u200F${esc(b)}`).join('\n\n');
  const text = [t(lang, 'fal.hafez_title', { user: nameOf(message.from), n: num(lang, g.n) }), `\u200F<blockquote expandable>${verses}</blockquote>`,
    t(lang, 'fal.hafez_meaning'), `\u200F${esc(g.f)}`, '', t(lang, 'fal.hafez_note')].join('\n');
  const rows = [[btn(t(lang, 'fal.btn_hafez_again'), 'fn:f:hafez'), urlBtn(t(lang, 'fal.btn_ganjoor'), `https://ganjoor.net/hafez/ghazal/sh${g.n}`)]];
  return say(ctx, chatId, s, text, rows, 'fun-hafez', reply(message));
}

/* Khayyam / Baba Taher: one quatrain (or dobeyti) with its interpretation, like the Hafez reading. */
async function poemReading(ctx, x) {
  const { chatId, s, lang, pre, message, parsed } = x;
  const code = parsed.code;
  const p = fun.poems.poem(code, pre.n || fun.randInt(1, fun.poems.count(code)));
  const verses = p.v.map(([a, b]) => `\u200F${esc(a)}\n\u200F${esc(b)}`).join('\n');
  const text = [t(lang, `fal.${code}_title`, { user: nameOf(message.from), n: num(lang, p.n) }), `\u200F<blockquote>${verses}</blockquote>`,
    t(lang, 'fal.hafez_meaning'), `\u200F${esc(p.f)}`, '', t(lang, `fal.${code}_note`)].join('\n');
  const rows = [[btn(t(lang, `fal.btn_${code}_again`), `fn:f:${code}`), urlBtn(t(lang, 'fal.btn_ganjoor'), p.url)]];
  return say(ctx, chatId, s, text, rows, `fun-${code}`, reply(message));
}

/* A card's name and meaning in the language: { name, meaning } (a reversed card has its own meaning). */
function card(lang, c) {
  const name = flist(lang, 'tarot_names')[c.card] || '';
  const meaning = flist(lang, c.reversed ? 'tarot_rev' : 'tarot_up')[c.card] || '';
  return { name: t(lang, c.reversed ? 'fal.card_rev' : 'fal.card_up', { name: esc(name) }), meaning: esc(meaning) };
}

async function tarot(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const r = reply(message);
  const me = nameOf(message.from);
  const again = [[btn(t(lang, 'fal.btn_tarot1'), 'fn:f:tarot:1'), btn(t(lang, 'fal.btn_tarot3'), 'fn:f:tarot:3')]];
  if (pre.mode === 'three') {
    const lines = [t(lang, 'fal.tarot3_title', { user: me })];
    fun.fal.draw(3).forEach((c, i) => {
      const k = card(lang, c);
      lines.push('', t(lang, 'fal.tarot3_card', { pos: t(lang, `fal.pos_${i + 1}`), card: k.name }), rtl(lang, k.meaning));
    });
    lines.push('', t(lang, 'fal.tarot_note'));
    return say(ctx, chatId, s, lines.join('\n'), again, 'fun-tarot3', r);
  }
  const [c] = fun.fal.draw(1);
  const k = card(lang, c);
  const lines = [pre.mode === 'yesno' ? t(lang, 'fal.tarot_q', { user: me, q: iso(pre.q, 120) }) : t(lang, 'fal.tarot_title', { user: me }), '',
    t(lang, 'fal.tarot_card', { card: k.name }), rtl(lang, k.meaning)];
  if (pre.mode === 'yesno') lines.push('', t(lang, `fal.yn_${fun.fal.answer(c)}`));
  lines.push('', t(lang, 'fal.tarot_note'));
  const text = lines.join('\n');
  const m = await tryCall(ctx, 'sendPhoto', { chat_id: chatId, photo: fun.fal.image(c.card), caption: text, parse_mode: 'HTML', reply_markup: markup(again), ...r }, 'fun-tarot');
  if (!m) return say(ctx, chatId, s, text, again, 'fun-tarot', r);
  if (s && Number(s.fun_clean) && chatId < 0) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
  return m;
}

const signName = (lang, i) => String(flist(lang, 'signs')[i] || '').split('|')[0].trim();
const signRows = (lang, code = 'horo') => [0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => {
  const i = r * 3 + c;
  return btn(`${fun.fal.SIGNS[i]} ${signName(lang, i)}`, `fn:f:${code}:${i}`);
}));
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

async function horoscope(ctx, x) {
  const { chatId, s, lang, pre, message, priv, day } = x;
  const r = reply(message);
  let sign = pre.sign;
  if (sign === null && !priv) {
    const b = await fun.birthdayOf(chatId, message.from.id);
    if (b) sign = fun.fal.signOf(b.cal, Number(b.month), Number(b.day));
  }
  if (sign === null) return say(ctx, chatId, s, t(lang, 'fal.horo_pick'), signRows(lang), 'fun-horo-pick', r);
  const pools = { love: flist(lang, 'horo_love'), work: flist(lang, 'horo_work'), health: flist(lang, 'horo_health'), advice: flist(lang, 'horo_advice'), color: flist(lang, 'colors') };
  const sizes = Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]));
  const h = fun.fal.horoscope(sign, day, sizes);
  const rg = fun.fal.range(sign);
  const dates = isRtl(lang) ? t(lang, 'fal.horo_month', { month: t(lang, `fun.month_j_${sign + 1}`) })
    : t(lang, 'fal.horo_dates', { from: dateText(lang, 'g', rg.from[0], rg.from[1]), to: dateText(lang, 'g', rg.to[0], rg.to[1]) });
  const text = [t(lang, 'fal.horo_title', { symbol: fun.fal.SIGNS[sign], sign: esc(signName(lang, sign)), dates }),
    t(lang, 'fal.horo_element', { element: t(lang, `fal.el_${fun.fal.ELEMENTS[sign % 4]}`) }), '',
    t(lang, 'fal.horo_love', { stars: stars(h.stars.love), text: esc(pools.love[h.love]) }),
    t(lang, 'fal.horo_work', { stars: stars(h.stars.work), text: esc(pools.work[h.work]) }),
    t(lang, 'fal.horo_health', { stars: stars(h.stars.health), text: esc(pools.health[h.health]) }),
    t(lang, 'fal.horo_advice', { text: esc(pools.advice[h.advice]) }),
    t(lang, 'fal.horo_lucky', { color: esc(pools.color[h.color]), n: num(lang, h.number) }), '', t(lang, 'fal.horo_note')].join('\n');
  return say(ctx, chatId, s, text, [[btn(t(lang, 'fal.btn_signs'), 'fn:f:horo:p')]], 'fun-horo', r);
}

/* 1–9, then the master numbers 11 and 22 */
const NUMBER_ROW = { 11: 9, 22: 10 };
async function abjad(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const r = reply(message);
  const res = fun.fal.numerology(pre.name);
  if (!res) return say(ctx, chatId, s, t(lang, 'fal.abjad_none'), null, 'fun-abjad', r);
  const [title, meaning] = String(flist(lang, 'numbers')[NUMBER_ROW[res.number] ?? res.number - 1] || '|').split('|').map((y) => y.trim());
  const text = [t(lang, 'fal.abjad_title', { name: iso(pre.name, 40) }), t(lang, `fal.sys_${res.system}`, { total: num(lang, res.total) }),
    t(lang, 'fal.abjad_number', { n: num(lang, res.number), title: esc(title) }), rtl(lang, esc(meaning)), '', t(lang, 'fal.abjad_note')].join('\n');
  return say(ctx, chatId, s, text, null, 'fun-abjad', r);
}

async function coffee(ctx, x) {
  const { chatId, s, lang, message } = x;
  const items = flist(lang, 'coffee');
  const lines = [t(lang, 'fal.coffee_title', { user: nameOf(message.from) }), ''];
  for (const i of fun.fal.symbols(items.length, 3)) {
    const [emoji, name, meaning] = items[i].split('|').map((y) => y.trim());
    lines.push(t(lang, 'fal.coffee_line', { emoji, name: esc(name), meaning: esc(meaning) }));
  }
  lines.push('', t(lang, 'fal.coffee_note'));
  return say(ctx, chatId, s, lines.join('\n'), [[btn(t(lang, 'fal.btn_coffee'), 'fn:f:coffee')]], 'fun-coffee', reply(message));
}

/* ---------- religious readings ---------- */

async function faithReading(ctx, x) {
  const { chatId, s, lang, message, parsed } = x;
  const r = reply(message);
  const F = fun.faith;
  const me = nameOf(message.from);
  if (parsed.code === 'quran') {
    const v = F.istikhara();
    const tr = await F.translation(v.surah, v.ayah, lang);
    const lines = [t(lang, 'fal.qr_title', { user: me, page: num(lang, v.page) }), '',
      t(lang, 'fal.qr_ref', { surah: esc(F.surahName(v.surah, lang)), arabic: esc(F.surahArabic(v.surah)), ayah: num(lang, v.ayah) }),
      `\u200F<blockquote>${esc(v.text)}</blockquote>`];
    if (tr) lines.push(t(lang, 'fal.qr_tr'), rtl(lang, esc(tr)));
    else lines.push(t(lang, 'fal.qr_no_tr'));
    lines.push('', t(lang, 'fal.qr_guide'), '', t(lang, 'fal.qr_note'));
    return say(ctx, chatId, s, lines.join('\n'), [[urlBtn(t(lang, 'fal.btn_quran_com'), `https://quran.com/${v.surah}/${v.ayah}`)]], 'fun-quran', r);
  }
  if (parsed.code === 'tasbih') {
    const b = F.tasbih();
    const lines = [t(lang, 'fal.tb_title', { user: me }), '', t(lang, 'fal.tb_count', { n: num(lang, b.beads), left: num(lang, b.good ? 1 : 2) }),
      t(lang, b.good ? 'fal.tb_good' : 'fal.tb_bad'), '', t(lang, 'fal.tb_note')];
    return say(ctx, chatId, s, lines.join('\n'), null, 'fun-tasbih', r);
  }
  const i = fun.randInt(0, F.PROPHETS - 1);
  const [name, text] = String(flist(lang, 'anbia')[i] || '|').split('|').map((y) => esc(y.trim()));
  const lines = [t(lang, 'fal.an_title', { user: me }), '', rtl(lang, `<b>${name}</b>`), rtl(lang, text), '', t(lang, 'fal.an_note')];
  return say(ctx, chatId, s, lines.join('\n'), [[btn(t(lang, 'fal.btn_anbia'), 'fn:f:anbia')]], 'fun-anbia', r);
}

/* ---------- drawn readings ---------- */

async function drawReading(ctx, x) {
  const { chatId, s, lang, pre, message, parsed } = x;
  const r = reply(message);
  const D = fun.draw;
  const code = parsed.code;
  const me = nameOf(message.from);
  const two = (k) => String(k || '|').split('|').map((y) => esc(y.trim()));
  const out = (lines, view, rows) => say(ctx, chatId, s, [...lines, '', t(lang, `fal.${code}_note`)].join('\n'), rows, view, r);
  const pos = (i, n) => (n === 3 ? `${t(lang, `fal.pos_${i + 1}`)}: ` : '');
  if (code === 'cards') {
    const n = pre.n || 3;
    const ranks = flist(lang, 'cd_ranks');
    const suits = flist(lang, 'cd_suits');
    const lines = [t(lang, n === 3 ? 'fal.cards_title3' : 'fal.cards_title1', { user: me })];
    for (const [i, c] of D.picks(52, n).entries()) {
      lines.push('', rtl(lang, `${pos(i, n)}<b>${esc(inline(lang, 'fal.cd_name', { rank: ranks[c % 13], suit: suits[Math.floor(c / 13)] }))}</b> ${D.cardGlyph(c)}`),
        rtl(lang, esc(flist(lang, 'cd_mean')[c] || '')));
    }
    return out(lines, 'fun-cards', [[btn(t(lang, 'fal.btn_cards1'), 'fn:f:cards:1'), btn(t(lang, 'fal.btn_cards3'), 'fn:f:cards:3')]]);
  }
  if (code === 'runes') {
    const n = pre.n || 1;
    const lines = [t(lang, n === 3 ? 'fal.runes_title3' : 'fal.runes_title1', { user: me })];
    for (const [i, { rune, reversed }] of D.runes(n).entries()) {
      const [name, kw] = two(flist(lang, 'rune_names')[rune]);
      lines.push('', rtl(lang, `${pos(i, n)}<b>${D.RUNES[rune]} ${name}</b> — ${kw} ${inline(lang, reversed ? 'fal.rn_rev' : 'fal.rn_up')}`),
        rtl(lang, esc(flist(lang, reversed ? 'rune_rev' : 'rune_up')[rune] || '')));
    }
    return out(lines, 'fun-runes', [[btn(t(lang, 'fal.btn_rune1'), 'fn:f:runes:1'), btn(t(lang, 'fal.btn_rune3'), 'fn:f:runes:3')]]);
  }
  if (code === 'iching') {
    const c = D.iching();
    const hex = (h) => {
      const [name, text] = two(flist(lang, 'iching')[h - 1]);
      return { title: `<b>${D.hexGlyph(h)} ${num(lang, h)}. ${name}</b>`, text };
    };
    const a = hex(c.hex);
    const lines = [pre.q ? t(lang, 'fal.iching_q', { user: me, q: iso(pre.q, 120) }) : t(lang, 'fal.iching_title', { user: me }), '', rtl(lang, a.title)];
    for (let i = 5; i >= 0; i -= 1) {
      const mark = c.changing.includes(i + 1) ? (c.lines[i] ? ' ○' : ' ×') : '';
      lines.push(rtl(lang, `<code>${c.lines[i] ? '━━━━━━━' : '━━━ ━━━'}${mark}</code>`));
    }
    lines.push(rtl(lang, a.text), '');
    if (c.to) {
      const b = hex(c.to);
      lines.push(t(lang, 'fal.ic_changing', { lines: c.changing.map((v) => num(lang, v)).join(t(lang, 'common.sep')), hex: b.title }), rtl(lang, b.text));
    } else lines.push(t(lang, 'fal.ic_none'));
    return out(lines, 'fun-iching', [[btn(t(lang, 'fal.btn_iching'), 'fn:f:iching')]]);
  }
  if (code === 'tas') {
    const roll = D.dice();
    const sum = roll.reduce((a, b) => a + b, 0);
    const [title, text] = two(flist(lang, 'tas')[sum - 3]);
    return out([t(lang, 'fal.tas_title', { user: me, faces: roll.map((v) => D.FACES[v - 1]).join(' '), sum: num(lang, sum) }), '', t(lang, 'fal.tas_mean', { title, text })],
      'fun-tas', [[btn(t(lang, 'fal.btn_tas'), 'fn:f:tas')]]);
  }
  const n = pre.n || 3;
  const cards = D.picks(36, n);
  const lines = [t(lang, n === 3 ? 'fal.lenormand_title3' : 'fal.lenormand_title1', { user: me })];
  for (const [i, c] of cards.entries()) {
    const [name, text] = two(flist(lang, 'lenormand')[c]);
    lines.push('', rtl(lang, `${pos(i, n)}${D.LENORMAND[c]} <b>${num(lang, c + 1)}. ${name}</b>`), rtl(lang, text));
  }
  if (n === 3) lines.push('', t(lang, 'fal.ln_sum', { list: cards.map((c) => two(flist(lang, 'lenormand')[c])[0]).join(' → ') }));
  return out(lines, 'fun-lenormand', [[btn(t(lang, 'fal.btn_len1'), 'fn:f:lenormand:1'), btn(t(lang, 'fal.btn_len3'), 'fn:f:lenormand:3')]]);
}

/* ---------- birth readings ---------- */

/* the 12 birth months: Persian month names in Persian, signs elsewhere */
const bmRows = (lang) => [0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => {
  const i = r * 3 + c;
  const label = isRtl(lang) ? t(lang, `fun.month_j_${i + 1}`).replace(RLM, '') : `${fun.fal.SIGNS[i]} ${signName(lang, i)}`;
  return btn(label, `fn:f:birthmonth:${i}`);
}));

async function birthReading(ctx, x) {
  const { chatId, s, lang, pre, message, parsed, priv } = x;
  const r = reply(message);
  const B = fun.birth;
  const code = parsed.code;
  const typed = (dt) => digitsIn(lang, `${dt.y}/${dt.m}/${dt.d}`);
  const out = (lines, view, rows = null) => say(ctx, chatId, s, [...lines, '', t(lang, 'fal.birth_note')].join('\n'), rows, view, r);
  if (code === 'birthmonth') {
    let sign = pre.sign;
    if (sign === null && !priv) {
      const b = await fun.birthdayOf(chatId, message.from.id);
      if (b) sign = fun.fal.signOf(b.cal, Number(b.month), Number(b.day));
    }
    if (sign === null) return say(ctx, chatId, s, t(lang, 'fal.bm_pick'), bmRows(lang), 'fun-birthmonth-pick', r);
    const L = (k) => esc(flist(lang, k)[sign] || '');
    const [color, stone, day, n] = String(flist(lang, 'bm_lucky')[sign] || '').split('|').map((y) => esc(y.trim()));
    const rg = fun.fal.range(sign);
    const title = isRtl(lang) ? t(lang, 'fal.bm_title_m', { month: t(lang, `fun.month_j_${sign + 1}`), sign: esc(signName(lang, sign)), symbol: fun.fal.SIGNS[sign] })
      : t(lang, 'fal.bm_title', { sign: esc(signName(lang, sign)), symbol: fun.fal.SIGNS[sign],
        dates: t(lang, 'fal.horo_dates', { from: dateText(lang, 'g', rg.from[0], rg.from[1]), to: dateText(lang, 'g', rg.to[0], rg.to[1]) }) });
    const lines = [title, '',
    t(lang, 'fal.bm_traits', { text: L('bm_traits') }), t(lang, 'fal.bm_love', { text: L('bm_love') }), t(lang, 'fal.bm_work', { text: L('bm_work') }),
    t(lang, 'fal.bm_good', { text: L('bm_good') }), t(lang, 'fal.bm_bad', { text: L('bm_bad') }),
    t(lang, 'fal.bm_lucky', { color, stone, day, n: digitsIn(lang, n) })];
    return out(lines, 'fun-birthmonth', [[btn(t(lang, 'fal.btn_months'), 'fn:f:birthmonth:p')]]);
  }
  if (code === 'chinese') {
    const today = dateOf(nowSec(), tzOf(s ? s.tz : 'auto', lang));
    const cur = B.chinese(today.y, today.m, today.d);
    const animal = (i) => esc(String(flist(lang, 'cz_names')[i] || ''));
    const element = (i) => esc(String(flist(lang, 'cz_elements')[i] || '').split('|')[0]);
    const nowLine = t(lang, 'fal.cz_now', { emoji: B.ANIMALS[cur.animal], year: digitsIn(lang, cur.year), animal: animal(cur.animal), element: element(cur.element) });
    if (!pre.date && !pre.year) return out([nowLine, '', t(lang, 'fal.cz_pick')], 'fun-chinese-pick');
    const c = pre.date ? B.chinese(pre.date.gy, pre.date.gm, pre.date.gd) : B.chinese(pre.year);
    const L = (k) => esc(flist(lang, k)[c.animal] || '');
    const [nums, colors] = String(flist(lang, 'cz_lucky')[c.animal] || '').split('|').map((y) => esc(y.trim()));
    const lines = [t(lang, 'fal.cz_title', { emoji: B.ANIMALS[c.animal], animal: animal(c.animal), element: element(c.element), yy: t(lang, c.yang ? 'fal.cz_yang' : 'fal.cz_yin'),
      year: digitsIn(lang, c.year) }),
    t(lang, 'fal.cz_element', { text: esc(String(flist(lang, 'cz_elements')[c.element] || '').split('|')[1] || '') }), '',
    t(lang, 'fal.cz_traits', { text: L('cz_traits') }), t(lang, 'fal.cz_love', { text: L('cz_love') }), t(lang, 'fal.cz_work', { text: L('cz_work') }),
    t(lang, 'fal.cz_lucky', { numbers: nums, colors }), t(lang, 'fal.cz_friends', { list: B.trio(c.animal).map(animal).join(t(lang, 'common.sep')) }), '',
    t(lang, 'fal.cz_year', { year: digitsIn(lang, cur.year), animal: animal(cur.animal), text: t(lang, `fal.cz_rel_${B.relation(c.animal, cur.animal)}`) })];
    if (!pre.date) lines.push('', t(lang, pre.jalali ? 'fal.cz_edge_j' : 'fal.cz_edge_g'));
    return out(lines, 'fun-chinese');
  }
  if (code === 'lifepath') {
    if (!pre.date) return out([t(lang, 'fal.lp_pick')], 'fun-lifepath-pick');
    const lp = B.lifePath(pre.date.gy, pre.date.gm, pre.date.gd);
    const [title, text] = String(flist(lang, 'lifepath')[{ 11: 9, 22: 10, 33: 11 }[lp.number] ?? lp.number - 1] || '|').split('|').map((y) => y.trim());
    return out([t(lang, 'fal.lp_title', { date: typed(pre.date) }), t(lang, 'fal.lp_steps', { steps: lp.steps.map((v) => num(lang, v)).join(' ← ') }), '',
      t(lang, 'fal.lp_number', { n: num(lang, lp.number), title: esc(title) }), rtl(lang, esc(text))], 'fun-lifepath');
  }
  if (!pre.date) return out([t(lang, 'fal.wd_pick')], 'fun-weekday-pick');
  const [day, text] = String(flist(lang, 'weekdays')[B.weekday(pre.date.gy, pre.date.gm, pre.date.gd)] || '|').split('|').map((y) => y.trim());
  return out([t(lang, 'fal.wd_title', { day: esc(day), date: typed(pre.date) }), '', rtl(lang, esc(text))], 'fun-weekday');
}

/* ---------- symbolic hours and the meaning of numbers ---------- */

const N = fun.numbers;
const HOUR_TYPES = ['mirror', 'reversed', 'triple', 'angel', 'sequence', 'repeat'];
/* digits in the language, leading zeros kept (12:05 → ۱۲:۰۵) */
const digitsIn = (lang, s) => String(s).replace(/[0-9]/g, (d) => num(lang, Number(d)));
const hourRows = (lang, s, priv) => pairs([...HOUR_TYPES, 'number'].filter((c) => priv || fun.conf(s, c).on).map((c) => btn(t(lang, `fal.hb_${c}`), `fn:f:${c}`)));
function timeMeaning(lang, h, m) {
  const k = N.timeKey(h, m);
  if (!k) return null;
  return { type: k.type, text: k.type === 'triple' ? flist(lang, 'angel3')[k.digit] : flist(lang, k.type)[k.i] };
}
/* The reading of a number as typed: its kinds, its own meaning (repeated, angel, sequence numbers), else its digits; its root. */
function numberLines(lang, d) {
  const lines = [t(lang, 'fal.nm_title', { n: digitsIn(lang, d) })];
  const kinds = N.kinds(d);
  if (kinds.length) lines.push(t(lang, 'fal.nm_kinds', { list: kinds.map((k) => t(lang, `fal.nk_${k}`)).join(t(lang, 'common.sep')) }));
  const own = N.own(d);
  const dg = N.digits(d);
  if (own) lines.push(rtl(lang, `💬 ${esc(flist(lang, own.list)[own.i])}`));
  else {
    lines.push(t(lang, 'fal.nm_digits'));
    for (const { digit, n } of dg.order) lines.push(rtl(lang, `• ${digitsIn(lang, digit)}${n > 1 ? ` ×${num(lang, n)}` : ''} — ${esc(flist(lang, 'digits')[digit])}`));
  }
  if (dg.sum && d.length > 1) {
    const title = String(flist(lang, 'numbers')[NUMBER_ROW[dg.root] ?? dg.root - 1] || '').split('|')[0];
    lines.push(t(lang, 'fal.nm_root', { sum: num(lang, dg.sum), root: num(lang, dg.root), title: esc(title) }));
  }
  return lines;
}

async function hours(ctx, x) {
  const { chatId, s, lang, pre, message, parsed, priv } = x;
  const r = reply(message);
  const code = parsed.code;
  const at = (h, m) => digitsIn(lang, `${N.pad2(h)}:${N.pad2(m)}`);
  const send0 = (lines, view) => say(ctx, chatId, s, [...lines, '', t(lang, 'fal.hr_note')].join('\n'), hourRows(lang, s, priv), view, r);
  if (pre.num) return send0(numberLines(lang, pre.num), 'fun-number');
  if (code === 'clock' || pre.time) {
    let h;
    let m;
    const now = !pre.time;
    if (pre.time) ({ h, m } = pre.time);
    else {
      const local = nowSec() + tzOf(s ? s.tz : 'auto', lang) * 60;
      h = Math.floor((local % 86400) / 3600);
      m = Math.floor((local % 3600) / 60);
    }
    const lines = [t(lang, now ? 'fal.hr_now' : 'fal.hr_time', { time: at(h, m) })];
    const mean = timeMeaning(lang, h, m);
    if (mean) lines.push(t(lang, `fal.hr_is_${mean.type}`), rtl(lang, `💬 ${esc(mean.text)}`));
    else lines.push(t(lang, 'fal.hr_none'));
    if (now) {
      const nx = N.next(h, m);
      if (nx.length) lines.push('', t(lang, 'fal.hr_next'), ...nx.map((n) => rtl(lang, `• ${digitsIn(lang, n.time)} — ${inline(lang, `fal.hr_t_${n.type}`)}`)));
      lines.push('', t(lang, 'fal.hr_types'), ...HOUR_TYPES.map((c) => t(lang, `fal.hr_ex_${c}`)));
    }
    return send0(lines, 'fun-clock');
  }
  const lines = [t(lang, `fal.hr_lt_${code}`), ''];
  const item = (key, text) => rtl(lang, `${key} — ${esc(text)}`);
  if (code === 'mirror') N.MIRROR.forEach((tm, i) => lines.push(item(digitsIn(lang, tm), flist(lang, 'mirror')[i])));
  if (code === 'reversed') N.REVERSED.forEach((tm, i) => lines.push(item(digitsIn(lang, tm), flist(lang, 'reversed')[i])));
  if (code === 'triple') {
    for (const dgt of [1, 2, 3, 4, 5, 0]) {
      const times = N.TRIPLE.filter((tm) => tm[4] === String(dgt)).map((tm) => digitsIn(lang, tm)).join(' · ');
      lines.push(item(times, flist(lang, 'angel3')[dgt]));
    }
  }
  if (code === 'angel') {
    for (let i = 0; i < 10; i += 1) lines.push(item(digitsIn(lang, String(i).repeat(3)), flist(lang, 'angel3')[i]));
    N.ANGEL_X.forEach((n, i) => lines.push(item(digitsIn(lang, n), flist(lang, 'angelx')[i])));
  }
  if (code === 'sequence') {
    N.SEQ_X.forEach((n, i) => lines.push(item(digitsIn(lang, n), flist(lang, 'seqx')[i])));
    lines.push('', t(lang, 'fal.hr_seq_note'));
  }
  if (code === 'repeat') {
    for (let i = 0; i < 10; i += 1) lines.push(item(digitsIn(lang, String(i).repeat(4)), flist(lang, 'rep4')[i]));
    lines.push('', t(lang, 'fal.hr_rep_note'));
  }
  if (code === 'number') {
    for (const [len, list, head] of [[2, 'rep2', 'nm_g2'], [3, 'angel3', 'nm_g3'], [4, 'rep4', 'nm_g4']]) {
      lines.push(t(lang, `fal.${head}`));
      for (let i = 0; i < 10; i += 1) lines.push(item(digitsIn(lang, String(i).repeat(len)), flist(lang, list)[i]));
      lines.push('');
    }
    lines.push(t(lang, 'fal.nm_how'));
  }
  return send0(lines, `fun-${code}`);
}

/* ---------- fonts ---------- */

/* Messages of at most `max` characters, cut between lines. */
/* ---------- films, books and music ---------- */

const C = fun.culture;
const REC_KIND = { movie: 'm', music: 'u', book: 'b' };
const REC_CODE = { m: 'movie', u: 'music', b: 'book' };
const ARABIC_SCRIPT = /[؀-ۿ]/;
const LATIN_SCRIPT = /[A-Za-z]/;
const PEOPLE_PAGE = 10;
const cultLine = (lang, key, i) => (t(lang, `cultlist.${key}`).split('\n')[i] || '').replace(RLM, '').trim();
const first = (lang, key) => inline(lang, key).split('|')[0].trim();
const matchKey = (s) => norm(s).replace(/\s+/g, '');
const SEP = { fa: '، ', zh: '、' };
const genreNames = (lang, list) => list.map((g) => first(lang, `fun.cg_${g}`)).join(SEP[lang] || ', ');
/* a name in the reader's language: Persian readers get the Persian form, the work's own language its original, others Latin letters */
function personOf(lang, x, orig, fa, lat) {
  if (lang === 'fa') return fa || (ARABIC_SCRIPT.test(orig) ? orig : (lat || orig));
  if (lang === x.l) return orig;
  return lat || orig;
}
function titleOf(lang, k, x) {
  if (k === 'u') return { main: x.t, alt: x.tl && lang !== x.l && !(lang === 'fa' && ARABIC_SCRIPT.test(x.t)) ? x.tl : '' };
  const main = lang === 'fa' ? (x.fa || x.en || x.t) : (lang === x.l ? x.t : (x.en || x.t));
  return { main, alt: main !== x.t ? x.t : '' };
}
const artistOf = (lang, x) => personOf(lang, x, x.a, x.a_fa, x.a_lat);
const directorOf = (lang, x) => (lang === 'fa' && x.by_fa ? x.by_fa : x.by);

/* A typed filter: a genre or a language name (in any of the five languages), or an artist / author. */
function recFind(lang, k, text) {
  const q = matchKey(text);
  if (q.length < 2) return null;
  const names = (key) => LANGS.flatMap((l) => t(l, key).replace(RLM, '').split('|')).map(matchKey);
  for (const [i, g] of C.genres(k).entries()) if (g === q || names(`fun.cg_${g}`).includes(q)) return { spec: `g${i}` };
  for (const [i, l] of C.langs(k).entries()) if (l === q || names(`fun.cl_${l}`).includes(q)) return { spec: `l${i}` };
  if (q.length >= 3) {
    for (const [i, p] of C.people(k).entries()) {
      const x = C.items(k).find((y) => y.a === p);
      if ([x.a, x.a_fa, x.a_lat].filter(Boolean).map(matchKey).some((n) => n.includes(q) || (n.length >= 4 && q.includes(n)))) return { spec: `a${i}` };
    }
  }
  return null;
}

/* The label of a filter (for the title of a pick). */
function specLabel(lang, k, spec) {
  const i = Number(spec.slice(1));
  if (spec[0] === 'g') return first(lang, `fun.cg_${C.genres(k)[i]}`);
  if (spec[0] === 'l') return first(lang, `fun.cl_${C.langs(k)[i]}`);
  if (spec[0] === 'a') return artistOf(lang, C.items(k).find((x) => x.a === C.people(k)[i]));
  return '';
}

/* The screens: menu · g (genres) · l (languages) · a:<page> (artists / authors) · p:<spec> a pick. */
function recScreen(lang, k, view, arg, user, note = '') {
  const code = REC_CODE[k];
  const base = `fn:r:${k}`;
  const back = [btn(inline(lang, 'fun.btn_rec_back'), base)];
  if (view === 'g' || view === 'l') {
    const list = view === 'g' ? C.genres(k) : C.langs(k);
    const rows = [];
    for (let i = 0; i < list.length; i += 3) {
      rows.push(list.slice(i, i + 3).map((v, j) => btn(first(lang, `fun.${view === 'g' ? 'cg' : 'cl'}_${v}`), `${base}:p:${view}${i + j}`)));
    }
    return { text: t(lang, `fun.rec_pick_${view === 'g' && k === 'u' ? 's' : view}`), rows: [...rows, back] };
  }
  if (view === 'a') {
    const list = C.people(k);
    const pages = Math.max(1, Math.ceil(list.length / PEOPLE_PAGE));
    const pg = Math.max(0, Math.min(pages - 1, toInt(arg) || 0));
    const shown = list.slice(pg * PEOPLE_PAGE, (pg + 1) * PEOPLE_PAGE);
    const rows = pairs(shown.map((p, j) => btn([...specLabel(lang, k, `a${pg * PEOPLE_PAGE + j}`)].slice(0, 30).join(''), `${base}:p:a${pg * PEOPLE_PAGE + j}`)));
    if (pages > 1) rows.push([btn('◀', `${base}:a:${(pg + pages - 1) % pages}`), btn(`${num(lang, pg + 1)}/${num(lang, pages)}`, 'nop'), btn('▶', `${base}:a:${(pg + 1) % pages}`)]);
    return { text: t(lang, `fun.rec_pick_${k === 'u' ? 'a' : 'w'}`), rows: [...rows, back] };
  }
  if (view === 'p') {
    const pool = C.select(k, arg);
    if (pool.length) {
      const x = pool[Math.floor(Math.random() * pool.length)];
      const label = specLabel(lang, k, arg);
      const { main, alt } = titleOf(lang, k, x);
      const lines = [t(lang, `fun.rec_title_${code}`, { user, filter: label ? inline(lang, 'fun.rec_filter', { v: esc(label) }) : '' }), '',
        rtl(lang, `<b>${esc(main)}</b>${alt ? ` (${esc(alt)})` : ''}${x.y ? ` · ${num(lang, x.y)}` : ''}`)];
      if (k === 'm') lines.push(t(lang, 'fun.rec_director', { by: esc(directorOf(lang, x)) }));
      if (k === 'u') lines.push(t(lang, 'fun.rec_artist', { by: esc(artistOf(lang, x)) }));
      if (k === 'b') lines.push(t(lang, 'fun.rec_author', { by: esc(personOf(lang, x, x.a, x.a_fa, x.a_lat)) }));
      lines.push(t(lang, 'fun.rec_tags', { genres: esc(genreNames(lang, x.g)), lang: esc(first(lang, `fun.cl_${x.l}`)) }));
      const q = (s) => encodeURIComponent(s);
      const link = k === 'm' ? urlBtn(inline(lang, 'fun.btn_imdb'), `https://www.imdb.com/find/?q=${q(`${x.en || x.t} ${x.y}`)}`)
        : k === 'u' ? urlBtn(inline(lang, 'fun.btn_rec_youtube'), `https://www.youtube.com/results?search_query=${q(`${x.a_lat || x.a} ${x.tl || x.t}`)}`)
          : urlBtn(inline(lang, 'fun.btn_rec_goodreads'), `https://www.goodreads.com/search?q=${q(`${x.en || x.t} ${x.a_lat || x.a}`)}`);
      return { text: lines.join('\n'), rows: [[btn(inline(lang, 'fun.btn_rec_again'), `${base}:p:${arg}`), link], back] };
    }
  }
  /* the menu */
  const by = (v) => btn(inline(lang, `fun.rec_by_${v}`), `${base}:${v === 'a' || v === 'w' ? 'a:0' : (v === 's' ? 'g' : v)}`);
  const rows = [[by(k === 'u' ? 's' : 'g'), by('l')]];
  if (k !== 'm') rows.push([by(k === 'u' ? 'a' : 'w')]);
  rows.push([btn(inline(lang, 'fun.rec_random'), `${base}:p:r`)]);
  const lines = [t(lang, `fun.rec_menu_${code}`, { n: num(lang, C.items(k).length) })];
  if (note) lines.push('', note);
  lines.push('', t(lang, `fun.rec_tip_${code}`));
  return { text: lines.join('\n'), rows };
}

async function recommend(ctx, x) {
  const { chatId, s, lang, pre, message, parsed } = x;
  const k = REC_KIND[parsed.code];
  const sc = pre.spec ? recScreen(lang, k, 'p', pre.spec, nameOf(message.from))
    : recScreen(lang, k, 'menu', null, null, pre.none ? t(lang, 'fun.rec_none', { q: iso(pre.none, 40) }) : '');
  return say(ctx, chatId, s, sc.text, sc.rows, `fun-${parsed.code}`, reply(message));
}

/* fn:r:<kind>[:<view>[:<arg>]] — only the one who asked moves through the lists (the message answers their command). */
async function recButton(ctx, cq, parts) {
  const k = parts[2];
  const msg = cq.message;
  if (!REC_CODE[k] || !msg || msg.chat.type === 'channel') return answer(ctx);
  const u = await users.get(cq.from.id);
  const mine = u ? u.lang : pickLang(cq.from.language_code);
  const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
  if (chat) {
    const s = await settings.all(ctx, chat.chat_id);
    if (!flag(s, 'fun_on') || !fun.conf(s, REC_CODE[k]).on) return answer(ctx);
  }
  const asker = msg.reply_to_message && msg.reply_to_message.from;
  if (asker && !asker.is_bot && asker.id !== cq.from.id) return answer(ctx, t(mine, 'fun.rec_not_yours').replace(RLM, ''), true);
  const lang = chat ? chat.lang : mine;
  const view = parts[3] || 'menu';
  if (!['menu', 'g', 'l', 'a', 'p'].includes(view) || (view === 'p' && !/^(r|[gla]\d{1,3})$/.test(parts[4] || ''))) return answer(ctx);
  const sc = recScreen(lang, k, view, parts[4], nameOf(cq.from));
  await edit(ctx, { chat_id: msg.chat.id, message_id: msg.message_id }, sc.text, sc.rows, `fun-${REC_CODE[k]}`);
  return answer(ctx);
}

/* A famous film line: the line as said, a translation in the chat's language, who says it, the film. */
async function dialogueReading(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const n = pre.n || fun.randInt(1, C.count('dialogues'));
  const d = C.dialogue(n);
  const fa = lang === 'fa';
  const who = fa ? (ARABIC_SCRIPT.test(d.who) ? d.who : d.who2) : (ARABIC_SCRIPT.test(d.who) ? d.who2 : d.who);
  const actor = fa ? (ARABIC_SCRIPT.test(d.actor) ? d.actor : d.actor2) : (ARABIC_SCRIPT.test(d.actor) ? d.actor2 : d.actor);
  const film = fa ? d.film_fa : (lang === d.lang ? d.film : (d.film_en || d.film));
  const filmAlt = film !== d.film && !(fa && ARABIC_SCRIPT.test(d.film)) ? ` (${d.film})` : '';
  const lines = [t(lang, 'fun.dlg_title', { user: nameOf(message.from) }), rtl(lang, `<blockquote>${esc(d.q)}</blockquote>`)];
  if (lang !== d.lang) lines.push(t(lang, 'fun.tr_line', { text: esc(cultLine(lang, 'dlg', n - 1)) }));
  lines.push(t(lang, 'fun.dlg_who', { who: esc(who), actor: esc(actor) }), t(lang, 'fun.dlg_film', { film: `${esc(film)}${esc(filmAlt)} · ${num(lang, d.year)}` }), '',
    t(lang, 'fun.dlg_note'));
  const rows = [[btn(inline(lang, 'fun.btn_dialogue'), 'fn:f:dialogue'),
    urlBtn(inline(lang, 'fun.btn_imdb'), `https://www.imdb.com/find/?q=${encodeURIComponent(`${d.film_en || d.film} ${d.year}`)}`)]];
  return say(ctx, chatId, s, lines.join('\n'), rows, 'fun-dialogue', reply(message));
}

/* An excerpt of a public-domain work: the text as written, a translation, the author, the work and its year. */
async function excerptReading(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const n = pre.n || fun.randInt(1, C.count('excerpts'));
  const e = C.excerpt(n);
  const author = lang === 'fa' ? e.author_fa : (lang === e.lang ? e.author : e.author_lat);
  const work = lang === 'fa' ? e.work_fa : (lang === e.lang ? e.work : (e.work_en || e.work));
  const text = e.q.split('\n').map((l) => `${lang === 'fa' ? '\u200F' : ''}${esc(l)}`).join('\n');
  const lines = [t(lang, 'fun.exc_title', { user: nameOf(message.from) }), `${lang === 'fa' ? '\u200F' : ''}<blockquote>${text}</blockquote>`];
  if (lang !== e.lang) lines.push(t(lang, 'fun.tr_line', { text: esc(cultLine(lang, 'exc', n - 1)) }));
  lines.push(t(lang, 'fun.exc_src', { author: esc(author), work: `${esc(work)}${e.year ? ` · ${num(lang, e.year)}` : ''}` }), '', t(lang, 'fun.exc_note'));
  const wiki = ['fa', 'en', 'ru', 'zh', 'fr'].includes(lang) ? lang : 'en';
  const rows = [[btn(inline(lang, 'fun.btn_bookquote'), 'fn:f:bookquote'),
    urlBtn(inline(lang, 'fun.btn_wiki'), `https://${wiki}.wikipedia.org/w/index.php?search=${encodeURIComponent(work.replace(/\s*\(.*\)\s*$/, ''))}`)]];
  return say(ctx, chatId, s, lines.join('\n'), rows, 'fun-bookquote', reply(message));
}

/* ---------- weekly horoscope, lottery, who is more likely, the decision helper ---------- */

/* This week's reading for a sign: the same for everyone of the sign all week (weeks start on Saturday in Persian, Monday otherwise). */
async function weeklyReading(ctx, x) {
  const { chatId, s, lang, pre, message, priv, day } = x;
  const r = reply(message);
  let sign = pre.sign;
  if (sign === null && !priv) {
    const b = await fun.birthdayOf(chatId, message.from.id);
    if (b) sign = fun.fal.signOf(b.cal, Number(b.month), Number(b.day));
  }
  if (sign === null) return say(ctx, chatId, s, t(lang, 'fun.weekly_pick'), signRows(lang, 'weekly'), 'fun-weekly-pick', r);
  const week = Math.floor((day + (lang === 'fa' ? 5 : 3)) / 7);
  const h = fun.hash(`weekly:${sign}:${week}`);
  const pick = (key, k, src = flist) => { const l = src(lang, key); return l[(h >>> k) % l.length]; };
  const text = [t(lang, 'fun.weekly_title', { symbol: fun.fal.SIGNS[sign], sign: esc(signName(lang, sign)) }), '',
    t(lang, 'fun.weekly_theme', { text: esc(pick('weekly', 0, list)) }),
    t(lang, 'fun.weekly_day', { day: esc(String(pick('weekdays', 4)).split('|')[0].trim()) }),
    t(lang, 'fun.weekly_advice', { text: esc(pick('horo_advice', 8)) }),
    t(lang, 'fun.weekly_lucky', { color: esc(pick('colors', 12)), n: num(lang, 1 + ((h >>> 16) % 9)) }), '', t(lang, 'fun.weekly_note')].join('\n');
  return say(ctx, chatId, s, text, [[btn(t(lang, 'fal.btn_signs'), 'fn:f:weekly:p')]], 'fun-weekly', r);
}

/* One or more members who wrote in the last 7 days, drawn at random. */
async function lottery(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const ids = (await fun.activeMembers(chatId, nowSec() - 7 * 86400)).map((row) => Number(row.user_id));
  if (ids.length < Math.max(2, pre.n)) return say(ctx, chatId, s, t(lang, 'fun.lottery_none', { n: num(lang, ids.length) }), null, 'fun-lottery', reply(message));
  const won = [...ids].sort(() => Math.random() - 0.5).slice(0, pre.n);
  const lines = [];
  for (const [i, id] of won.entries()) lines.push(rtl(lang, `${pre.n > 1 ? `${num(lang, i + 1)}. ` : '🏆 '}${iso(await users.displayName(id), 32)}`));
  const what = pre.what ? inline(lang, 'fun.lottery_what', { what: iso(pre.what, 80) }) : '';
  return say(ctx, chatId, s, t(lang, 'fun.lottery', { what, n: num(lang, ids.length), list: lines.join('\n') }), null, 'fun-lottery', reply(message));
}

/* A poll: who is more likely to …? The two of you (a reply), or up to four members who were active here. */
async function likely(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const from = message.from;
  const plain = (u) => [...fullName(u)].slice(0, 40).join('') || String(u.id);
  let names;
  if (pre.target) names = [plain(from), plain(pre.target)];
  else {
    const ids = (await fun.activeMembers(chatId, nowSec() - 7 * 86400)).map((row) => Number(row.user_id)).filter((id) => id !== from.id);
    const others = [...ids].sort(() => Math.random() - 0.5).slice(0, 3);
    names = [plain(from)];
    for (const id of others) names.push([...String(await users.displayName(id))].slice(0, 40).join(''));
  }
  if (names.length < 2) return say(ctx, chatId, s, t(lang, 'fun.likely_none'), null, 'fun-likely', reply(message));
  const what = fun.pick(list(lang, 'likely'));
  const m = await tryCall(ctx, 'sendPoll', { chat_id: chatId, question: inline(lang, 'fun.likely_q', { what }).slice(0, 300), options: names.map((n) => ({ text: n.slice(0, 100) })),
    is_anonymous: false, ...reply(message) }, 'fun-likely');
  if (m && s && Number(s.fun_clean)) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
  return m;
}

/* The decision helper: eight questions answered with buttons; the answers so far travel in callback_data (fn:d:<a|b|e…>). */
const DECIDE_WEIGHTS = [3, 3, 1, 1, 2, 2, 2, 2];
function decideScreen(lang, a, b, user, answers) {
  const head = t(lang, 'fun.decide_intro', { a: iso(a, 40), b: iso(b, 40), user });
  const label = (o) => [...o].slice(0, 30).join('');
  if (answers.length < DECIDE_WEIGHTS.length) {
    const i = answers.length;
    return { text: `${head}\n\n${t(lang, 'fun.decide_q', { i: num(lang, i + 1), q: esc(inline(lang, `fun.dq_${i + 1}`)) })}`,
      rows: [[btn(label(a), `fn:d:${answers}a`), btn(label(b), `fn:d:${answers}b`)], [btn(inline(lang, 'fun.decide_eq'), `fn:d:${answers}e`)]] };
  }
  let sa = 0;
  let sb = 0;
  [...answers].forEach((c, i) => { if (c === 'a') sa += DECIDE_WEIGHTS[i]; if (c === 'b') sb += DECIDE_WEIGHTS[i]; });
  const max = DECIDE_WEIGHTS.reduce((x, y) => x + y, 0);
  const lines = [head, ''];
  if (sa === sb) {
    lines.push(t(lang, 'fun.decide_tie'), t(lang, 'fun.coin', { user, side: t(lang, Math.random() < 0.5 ? 'fun.coin_heads' : 'fun.coin_tails') }));
  } else {
    const [win, lose] = sa > sb ? [a, b] : [b, a];
    lines.push(t(lang, 'fun.decide_result', { win: iso(win, 40), a: iso(a, 40), b: iso(b, 40), sa: num(lang, sa), sb: num(lang, sb), max: num(lang, max) }));
    if (answers[1] !== 'e') lines.push(t(lang, 'fun.decide_regret', { r: iso(answers[1] === 'a' ? a : b, 40) }));
    lines.push('', t(lang, 'fun.decide_devil', { win: iso(win, 40), lose: iso(lose, 40) }), t(lang, 'fun.decide_step', { win: iso(win, 40) }));
  }
  lines.push('', t(lang, 'fun.decide_note'));
  return { text: lines.join('\n'), rows: [] };
}

async function decideButton(ctx, cq, parts) {
  const msg = cq.message;
  const answers = String(parts[2] || '');
  if (!msg || !/^[abe]{1,8}$/.test(answers)) return answer(ctx);
  const u = await users.get(cq.from.id);
  const mine = u ? u.lang : pickLang(cq.from.language_code);
  const asker = msg.reply_to_message && msg.reply_to_message.from;
  if (asker && !asker.is_bot && asker.id !== cq.from.id) return answer(ctx, inline(mine, 'fun.decide_not_yours'), true);
  const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
  const lang = chat ? chat.lang : mine;
  const first = String(msg.text || '').split('\n')[0];
  const opts = [...first.matchAll(/\u2068([^\u2069]*)\u2069/g)].map((m) => m[1]);
  if (opts.length < 2) return answer(ctx, inline(mine, 'fun.decide_gone'), true);
  const sc = decideScreen(lang, opts[0], opts[1], nameOf(cq.from), answers);
  await edit(ctx, { chat_id: msg.chat.id, message_id: msg.message_id }, sc.text, sc.rows, 'fun-decide');
  return answer(ctx);
}

/* ---------- questionnaires: /ptest, /spirit, /match, /knowme ---------- */

const TQ = fun.tests;
const ptx = (lang, key) => inline(lang, `ptest.${key}`);
const ptList = (lang, key) => ptx(lang, key).split('|').map((x) => x.trim());
const ptName = (lang, code) => ptx(lang, `name_${code}`);
/* a result line from the locales: «name|text» */
const ptResult = (lang, code, i) => {
  const [name, text] = ptList(lang, `${code}_r${i}`);
  return { name: esc(name || ''), text: esc(text || '') };
};

function testMenu(lang, g) {
  const rows = pairs(TQ.inGroup(g).map((c) => btn(`${TQ.of(c).icon} ${ptName(lang, c)}`, `fn:q:${c}`)));
  return { text: t(lang, g === 'self' ? 'fun.pt_menu' : 'fun.sp_menu'), rows };
}

/* A question of a test with its answers as buttons, or the result when every question is answered. */
function testScreen(lang, code, answers, user) {
  const test = TQ.of(code);
  const i = answers.length;
  if (i < test.n) {
    const opts = test.scale ? ptList(lang, `scale${test.scale}`) : ptList(lang, `${code}_o${i + 1}`);
    const text = t(lang, 'fun.pt_q', { icon: test.icon, name: esc(ptName(lang, code)), i: num(lang, i + 1), n: num(lang, test.n), q: esc(ptx(lang, `${code}_q${i + 1}`)) });
    return { text, rows: opts.map((o, j) => [btn(o, `fn:q:${code}:${answers}${j}`)]) };
  }
  const res = TQ.result(code, answers);
  const lines = [t(lang, 'fun.pt_res', { icon: test.icon, name: esc(ptName(lang, code)), user }), ''];
  if (res.kind === 'axes') {
    lines.push(t(lang, 'fun.type_res', { code: res.type, nick: esc(ptx(lang, `type_n_${res.type}`)) }));
    for (const l of res.type) lines.push(t(lang, 'fun.type_letter', { l, text: esc(ptx(lang, `type_l_${l}`)) }));
  } else if (res.kind === 'top') {
    const top = ptResult(lang, code, res.top);
    if (code === 'love' && res.second !== null) {
      const sec = ptResult(lang, code, res.second);
      lines.push(t(lang, 'fun.two_res', { a: top.name, b: sec.name, text: `${top.text}\n${sec.text}` }));
    } else lines.push(t(lang, 'fun.top_res', { name: top.name, text: top.text }));
  } else if (res.kind === 'band') {
    const r = ptResult(lang, code, res.band);
    lines.push(t(lang, 'fun.top_res', { name: r.name, text: r.text }));
  } else if (res.kind === 'chakra') {
    lines.push(t(lang, 'fun.ch_strong', { name: ptResult(lang, code, res.strong).name }));
    const w = ptResult(lang, code, res.weak);
    lines.push(t(lang, 'fun.ch_weak', { name: w.name, text: w.text }));
  } else if (res.kind === 'story') {
    const piece = (k) => ptList(lang, `past_f${k + 1}`)[res.parts[k]] || '';
    const story = ptx(lang, 'past_tpl').replace(/\{(era|place|role|trait|lesson)\}/g, (m, k) => piece(['era', 'place', 'role', 'trait', 'lesson'].indexOf(k)));
    lines.push(rtl(lang, `🌀 ${esc(story)}`));
  }
  lines.push('', t(lang, test.g === 'spirit' ? 'fun.sp_note' : 'fun.pt_note'));
  const again = [btn(inline(lang, 'fun.btn_again'), `fn:q:${code}`), btn(inline(lang, test.g === 'spirit' ? 'fun.btn_spirits' : 'fun.btn_tests'), `fn:q:m:${test.g}`)];
  return { text: lines.join('\n'), rows: [again] };
}

/* fn:q:<code>[:<answers>] · fn:q:m:<self|spirit> — only the one who asked answers (the message replies to their command). */
async function testButton(ctx, cq, parts) {
  const msg = cq.message;
  if (!msg || msg.chat.type === 'channel') return answer(ctx);
  const u = await users.get(cq.from.id);
  const mine = u ? u.lang : pickLang(cq.from.language_code);
  const asker = msg.reply_to_message && msg.reply_to_message.from;
  if (asker && !asker.is_bot && asker.id !== cq.from.id) return answer(ctx, inline(mine, 'fun.pt_not_yours'), true);
  const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
  const lang = chat ? chat.lang : mine;
  let sc = null;
  if (parts[2] === 'm' && (parts[3] === 'self' || parts[3] === 'spirit')) sc = testMenu(lang, parts[3]);
  else {
    const test = TQ.of(parts[2]);
    const answers = parts[3] || '';
    if (!test || test.g === 'two' || !TQ.valid(test, answers)) return answer(ctx);
    sc = testScreen(lang, parts[2], answers, nameOf(cq.from));
  }
  await edit(ctx, { chat_id: msg.chat.id, message_id: msg.message_id }, sc.text, sc.rows, 'fun-test');
  return answer(ctx);
}

/*
 * /match and /knowme: the one who asked (A) answers first — fn:m:<A's answers>; then anyone else joins — fn:m:<A>:j — and answers in turn:
 * fn:m:<A>:<their id>:<their answers>. /knowme is the same with fn:k (the others guess A's answers).
 */
function pairScreen(lang, code, aAns, other, oAns, aName, oName) {
  const test = TQ.of(code);
  const head = code === 'match' ? 'm' : 'k';
  const q = (i, ans, prefix) => {
    const opts = ptList(lang, `${code}_o${i + 1}`);
    return { text: t(lang, 'fun.pt_q', { icon: test.icon, name: esc(ptName(lang, code)), i: num(lang, i + 1), n: num(lang, test.n), q: esc(ptx(lang, `${code}_q${i + 1}`)) }),
      rows: opts.map((o, j) => [btn(o, `${prefix}${ans}${j}`)]) };
  };
  if (aAns.length < test.n) return q(aAns.length, aAns, `fn:${head}:`);
  const join = [[btn(inline(lang, code === 'match' ? 'fun.btn_join_match' : 'fun.btn_join_know'), `fn:${head}:${aAns}:j`)]];
  if (!other) return { text: t(lang, code === 'match' ? 'fun.match_wait' : 'fun.know_wait', { a: aName }), rows: join };
  if (oAns.length < test.n) {
    const sc = q(oAns.length, oAns, `fn:${head}:${aAns}:${other}:`);
    return { text: `${oName}\n${sc.text}`, rows: sc.rows };
  }
  const same = TQ.same(aAns, oAns);
  const lines = [];
  if (code === 'match') {
    const pct = Math.round((same / test.n) * 100);
    lines.push(t(lang, 'fun.match_res', { a: aName, b: oName, pct: num(lang, pct), label: esc(ptList(lang, 'match_l')[pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0]) }));
    const diff = [...aAns].map((c, i) => (c === oAns[i] ? null : i)).filter((i) => i !== null);
    if (diff.length) {
      lines.push('', t(lang, 'fun.match_diff'));
      for (const i of diff) {
        const opts = ptList(lang, `${code}_o${i + 1}`);
        lines.push(rtl(lang, `• ${esc(ptx(lang, `${code}_q${i + 1}`))} ${esc(opts[Number(aAns[i])])} / ${esc(opts[Number(oAns[i])])}`));
      }
    } else lines.push('', t(lang, 'fun.match_same'));
  } else {
    lines.push(t(lang, 'fun.know_res', { a: aName, b: oName, n: num(lang, same), label: esc(ptList(lang, 'know_l')[same >= 6 ? 3 : same >= 4 ? 2 : same >= 2 ? 1 : 0]) }));
  }
  lines.push('', t(lang, 'fun.pt_note'));
  return { text: lines.join('\n'), rows: join };
}

async function pairButton(ctx, cq, parts) {
  const msg = cq.message;
  const code = parts[1] === 'm' ? 'match' : 'knowme';
  const test = TQ.of(code);
  if (!msg || msg.chat.type === 'channel') return answer(ctx);
  const aAns = parts[2] || '';
  if (!TQ.valid(test, aAns)) return answer(ctx);
  const u = await users.get(cq.from.id);
  const mine = u ? u.lang : pickLang(cq.from.language_code);
  const asker = msg.reply_to_message && msg.reply_to_message.from;
  if (!asker) return answer(ctx);
  const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
  const lang = chat ? chat.lang : mine;
  const aName = nameOf(asker);
  let sc;
  if (aAns.length < test.n || parts[3] === undefined) {
    /* A is still answering */
    if (asker.id !== cq.from.id) return answer(ctx, inline(mine, 'fun.pt_not_yours'), true);
    sc = pairScreen(lang, code, aAns, null, '', aName, null);
  } else if (parts[3] === 'j') {
    if (asker.id === cq.from.id) return answer(ctx, inline(mine, code === 'match' ? 'fun.match_self' : 'fun.know_self'), true);
    sc = pairScreen(lang, code, aAns, cq.from.id, '', aName, nameOf(cq.from));
  } else {
    const other = toInt(parts[3]);
    const oAns = parts[4] || '';
    if (other !== cq.from.id) return answer(ctx, inline(mine, 'fun.pt_not_yours'), true);
    if (!TQ.valid(test, oAns)) return answer(ctx);
    sc = pairScreen(lang, code, aAns, other, oAns, aName, nameOf(cq.from));
  }
  await edit(ctx, { chat_id: msg.chat.id, message_id: msg.message_id }, sc.text, sc.rows, `fun-${code}`);
  return answer(ctx);
}

/* ---------- /echo and fun special members ---------- */

/* The message a command really answers: not a forum topic's first message (every message in a topic «replies» to it). */
function repliedTo(message) {
  const r = message.reply_to_message;
  if (!r || r.forum_topic_created || (message.is_topic_message && r.message_id === message.message_thread_id)) return null;
  return r;
}

/* The formatting of the echoed part, moved to where it starts (no command, mention or custom-emoji entities). */
const ECHO_ENTITIES = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'pre', 'text_link', 'text_mention', 'blockquote',
  'expandable_blockquote']);
export function shiftEntities(entities, start, length) {
  const out = [];
  for (const e of Array.isArray(entities) ? entities : []) {
    if (!e || !ECHO_ENTITIES.has(e.type)) continue;
    const a = Math.max(e.offset, start) - start;
    const b = Math.min(e.offset + e.length, start + length) - start;
    if (b > a) out.push({ ...e, offset: a, length: b - a });
  }
  return out;
}

/*
 * /echo text («بگو»): Aegis deletes the command and says the text itself — as a reply to the message the
 * command replied to, else on its own (in the same forum topic). The chat's change log records who.
 */
async function echo(ctx, x) {
  const { message, chatId, priv, pre } = x;
  const target = repliedTo(message);
  if (await tryCall(ctx, 'deleteMessage', { chat_id: chatId, message_id: message.message_id }, 'fun-echo-delete')) ctx.deletedCommand = message.message_id;
  const params = { chat_id: chatId, text: pre.text, link_preview_options: { is_disabled: true } };
  const entities = shiftEntities(message.entities, pre.start, pre.text.length);
  if (entities.length) params.entities = entities;
  if (target) params.reply_parameters = { message_id: target.message_id, allow_sending_without_reply: true };
  else if (message.is_topic_message && message.message_thread_id) params.message_thread_id = message.message_thread_id;
  const m = await tryCall(ctx, 'sendMessage', params, 'fun-echo');
  if (m && !priv) await audit.log(message.from.id, 'fun.echo', { chatId, details: { message: m.message_id, length: [...pre.text].length } });
}

/* The member a /special command names: the replied message's author, or an id or @username (known to Aegis). */
async function specialTarget(ctx, message, parsed, chatId) {
  const r = repliedTo(message);
  if (r && r.from) return r.from;
  const a = String(parsed.args[0] || '');
  let id = /^\d{4,16}$/.test(asciiDigits(a)) ? toInt(asciiDigits(a)) : null;
  if (id === null && /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(a)) {
    const known = await users.byUsername(a.slice(1));
    if (known) id = Number(known.user_id);
  }
  if (id === null) return null;
  const member = await tryCall(ctx, 'getChatMember', { chat_id: chatId, user_id: id }, 'fun-special-target');
  return member && member.user ? member.user : { id, unknown: true };
}

/* /special and /unspecial (a reply, an id or @username): the chat's owner and admins mark who may use «special members» groups. */
async function special(ctx, message, chat, s, lang, parsed) {
  const chatId = chat.chat_id;
  const acc = await admins.liveAccess(ctx, chatId, message.from.id);
  if (!acc.member || !['creator', 'administrator'].includes(acc.member.status) || acc.level < admins.L.view) return;
  const out = (key, vars = {}) => say(ctx, chatId, s, t(lang, `fun.${key}`, vars), null, `fun-${parsed.code}`, reply(message));
  const target = await specialTarget(ctx, message, parsed, chatId);
  if (!target) return out('special_usage');
  if (target.unknown) return out('special_unknown');
  if (target.is_bot) return out('special_bot');
  const user = nameOf(target);
  if (parsed.code === 'special') {
    await users.remember(target);
    const r = await lists.upsert(chatId, 'fun', { ekey: String(target.id), value: fullName(target) || String(target.id), userId: target.id }, message.from.id);
    if (r === 'full') return out('special_full', { n: num(lang, LIST_MAX_ENTRIES) });
    return out(r === 'added' ? 'special_added' : 'special_already', { user });
  }
  return out((await lists.remove(chatId, 'fun', String(target.id), message.from.id)) ? 'special_removed' : 'special_not', { user });
}

function chunks(lines, max = 3800) {
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

/* Lines of one page of /font. tg: Telegram's styles (live); the others in copy-on-tap code boxes. */
const FONT_BLOCK = new Set(['pre', 'quote', 'fraktur_quote', 'fa_quote']);
const FONT_PREFIX = { uni: 'u', look: 'u', mark: 'm', fa: 'p', mix: 'x' };
function fontLines(lang, page, items) {
  const box = (x) => LRI(`<code>${esc(x)}</code>`);
  if (page === 'tg') {
    return items.map(([c, open, close, x]) => {
      const label = t(lang, fun.fonts.TELEGRAM.includes(c) ? `fal.t_${c}` : `fal.tc_${c}`);
      if (FONT_BLOCK.has(c)) return `${rtl(lang, `${label}:`)}\n${isRtl(lang) ? '\u200F' : ''}${open}${esc(x)}${close}`;
      return rtl(lang, `${label}: ${LRI(`${open}${esc(x)}${close}`)}`);
    });
  }
  if (page === 'combo' || page === 'frame') return items.map((x, i) => rtl(lang, `${num(lang, i + 1)}. ${box(x)}`));
  if (page === 'extra') {
    return items.map(([type, code, x, open, close], i) => {
      if (type === 'h') return `${i ? '\n' : ''}${t(lang, `fal.xh_${code}`)}`;
      if (type === 'tg') return `${rtl(lang, `${t(lang, `fal.tx_${code}`)}:`)}\n${isRtl(lang) ? '\u200F' : ''}${open}${esc(x)}${close}`;
      if (type === 'n') return rtl(lang, `${num(lang, code)}. ${box(x)}`);
      return rtl(lang, `${t(lang, `fal.${type}_${code}`)}: ${box(x)}`);
    });
  }
  return items.map(([c, x]) => rtl(lang, `${t(lang, `fal.${FONT_PREFIX[page]}_${c}`)}: ${box(x)}`));
}

/* One message for /font: the text's name, a page of styles, a button per page (and ◀ ▶ when a page is long). */
export function fontScreen(lang, text, page0, part0 = 0) {
  const r = fun.fonts.render(text);
  const pages = fun.fonts.PAGES.filter((p) => r.pages[p]);
  const page = pages.includes(page0) ? page0 : pages[0];
  const head = [t(lang, 'fal.font_head', { text: LRI(esc(text)) }), t(lang, `fal.fi_${page}`), ''];
  const lines = fontLines(lang, page, r.pages[page]);
  if (page === 'fa' && !r.hasLatin) lines.push('', t(lang, 'fal.font_uni_none'));
  const parts = chunks(lines, 3600 - head.join('\n').length);
  const n = Math.min(Math.max(0, part0), parts.length - 1);
  const body = [...head, parts[n]];
  if (page !== 'tg') body.push('', t(lang, 'fal.font_tap'));
  const rows = pairs(pages.map((p) => btn(`${p === page ? '• ' : ''}${t(lang, `fal.fp_${p}`)}`, `fn:t:${p}`)));
  if (parts.length > 1) {
    rows.push([btn('◀', `fn:t:${page}:${(n + parts.length - 1) % parts.length}`), btn(`${num(lang, n + 1)}/${num(lang, parts.length)}`, 'nop'),
      btn('▶', `fn:t:${page}:${(n + 1) % parts.length}`)]);
  }
  return { text: body.join('\n'), rows };
}

async function font(ctx, x) {
  const { chatId, s, lang, pre, message } = x;
  const sc = fontScreen(lang, pre.text, 'combo');
  return say(ctx, chatId, s, sc.text, sc.rows, 'fun-font', reply(message));
}

/* A page button of /font: the text is read back from the message's first line; only the one who asked turns pages. */
async function fontPage(ctx, cq, parts) {
  const msg = cq.message;
  const from = cq.from;
  const u = await users.get(from.id);
  const mine = u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
  const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
  if (chat) {
    const s = await settings.all(ctx, chat.chat_id);
    if (!flag(s, 'fun_on') || !fun.conf(s, 'font').on) return answer(ctx);
  }
  const asker = msg.reply_to_message && msg.reply_to_message.from;
  if (asker && !asker.is_bot && asker.id !== from.id) return answer(ctx, t(mine, 'fal.font_not_yours'), true);
  const m = /\u2068([^\u2069]*)\u2069/.exec(String(msg.text || '').split('\n')[0]);
  if (!m || !m[1].trim() || [...m[1]].length > FONT_MAX) return answer(ctx, t(mine, 'fal.font_gone'), true);
  const lang = chat ? chat.lang : (u ? u.lang : mine);
  const sc = fontScreen(lang, m[1], parts[2], toInt(parts[3]) || 0);
  await edit(ctx, { chat_id: msg.chat.id, message_id: msg.message_id }, sc.text, sc.rows, 'fun-font');
  return answer(ctx);
}

/* A button of a fortune: runs the command for whoever pressed it, as if they had typed it. */
const BUTTON_ARGS = { tarot: ['1', '3'], horo: [...Array(12).keys()].map(String), weekly: [...Array(12).keys()].map(String), birthmonth: [...Array(12).keys()].map(String), cards: ['1', '3'], runes: ['1', '3'],
  lenormand: ['1', '3'] };
async function falButton(ctx, cq, parts) {
  const code = parts[2];
  const f = fun.byCode(code);
  const msg = cq.message;
  if (!f || !(['fal', 'hours', 'numbers'].includes(f.cat) || code === 'dialogue' || code === 'bookquote') || msg.chat.type === 'channel') return answer(ctx);
  if ((code === 'horo' || code === 'birthmonth' || code === 'weekly') && parts[3] === 'p') {
    const u = await users.get(cq.from.id);
    const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
    const lang = chat ? chat.lang : (u ? u.lang : pickLang(cq.from.language_code));
    await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: markup(code === 'birthmonth' ? bmRows(lang) : signRows(lang, code)) },
      `fun-${code}-signs`);
    return answer(ctx);
  }
  const arg = parts[3] === undefined ? '' : parts[3];
  if (arg && !(BUTTON_ARGS[code] || []).includes(arg)) return answer(ctx);
  const text = `/${f.cmds[0]}${arg ? ` ${['horo', 'birthmonth', 'weekly'].includes(code) ? fun.fal.SIGNS[Number(arg)] : arg}` : ''}`;
  const message = { message_id: msg.message_id, chat: msg.chat, from: cq.from, date: msg.date, text };
  const press = { answered: false };
  const privUser = msg.chat.type === 'private' ? await users.get(cq.from.id) : null;
  await command(ctx, message, privUser, press);
  if (!press.answered) await answer(ctx);
  return null;
}

/* The couple / member of the day: the same all day, from members who wrote in the last 7 days. */
async function dailyPick(ctx, x) {
  const { chatId, s, lang, parsed, day, message } = x;
  const kind = parsed.code;
  let data = await fun.dailyPick(chatId, kind, day);
  if (!data) {
    const ids = (await fun.activeMembers(chatId, nowSec() - 7 * 86400)).map((r) => Number(r.user_id));
    const need = kind === 'couple' ? 2 : 1;
    if (ids.length < need) return say(ctx, chatId, s, t(lang, `fun.${kind}_none`), null, `fun-${kind}`, reply(message));
    const h = fun.hash(`${chatId}:${kind}:${day}`);
    const a = ids[h % ids.length];
    let b = ids[(h >>> 8) % ids.length];
    if (b === a) b = ids[(ids.indexOf(a) + 1) % ids.length];
    data = await fun.setDailyPick(chatId, kind, day, kind === 'couple' ? [a, b] : [a]);
  }
  const names = [];
  for (const id of data) names.push(iso(await users.displayName(Number(id)), 32));
  return say(ctx, chatId, s, t(lang, `fun.${kind}`, { a: names[0], b: names[1] || '' }), null, `fun-${kind}`, reply(message));
}

/* ---------- birthdays ---------- */

const calOf = (s, lang) => (s && s.bday_cal !== 'auto' ? s.bday_cal : (lang === 'fa' ? 'j' : 'g'));
function todayIn(cal, s, lang, now = nowSec()) {
  const d = dateOf(now, tzOf(s ? s.tz : 'auto', lang));
  if (cal !== 'j') return { y: d.y, m: d.m, d: d.d };
  const [y, m, dd] = toJalali(d.y, d.m, d.d);
  return { y, m, d: dd };
}
const dateText = (lang, cal, m, d) => t(lang, `fun.bday_date_${cal}`, { month: t(lang, `fun.month_${cal}_${m}`), day: num(lang, d) });

async function birthday(ctx, x) {
  const { chatId, s, lang, parsed, pre, message } = x;
  const cal = calOf(s, lang);
  const r = reply(message);
  const from = message.from;
  if (parsed.sub === 'birthdays') {
    const now = todayIn(cal, s, lang);
    const rows = await fun.upcoming(chatId, cal, now.m, now.d);
    if (!rows.length) return say(ctx, chatId, s, t(lang, 'fun.bdays_none'), null, 'fun-bdays', r);
    const lines = [t(lang, 'fun.bdays_title')];
    for (const b of rows) lines.push(`• ${iso(await users.displayName(Number(b.user_id)), 32)} — ${dateText(lang, cal, Number(b.month), Number(b.day))}`);
    return say(ctx, chatId, s, lines.join('\n'), null, 'fun-bdays', r);
  }
  const text = String(pre.text || '').trim();
  if (!text) {
    const mine = await fun.birthdayOf(chatId, from.id);
    const shown = mine ? t(lang, 'fun.bday_mine', { date: dateText(lang, mine.cal, Number(mine.month), Number(mine.day)) }) : t(lang, 'fun.bday_unset');
    return say(ctx, chatId, s, `${shown}\n${t(lang, `fun.bday_how_${cal}`)}`, null, 'fun-bday', r);
  }
  if (/^(off|remove|delete|حذف|پاک|удалить|删除|supprimer)$/i.test(text)) {
    await fun.removeBirthday(chatId, from.id);
    return say(ctx, chatId, s, t(lang, 'fun.bday_removed'), null, 'fun-bday', r);
  }
  const d = fun.parseBirthday(asciiDigits(text), cal);
  if (!d) return say(ctx, chatId, s, t(lang, `fun.bday_how_${cal}`), null, 'fun-bday', r);
  await users.remember(from);
  await fun.setBirthday(chatId, from.id, cal, d.month, d.day);
  return say(ctx, chatId, s, t(lang, 'fun.bday_saved', { user: nameOf(from), date: dateText(lang, cal, d.month, d.day) }), null, 'fun-bday', r);
}

/* On the first message of each local day: today's birthdays are greeted once. */
async function greetBirthdays(ctx, chat, s) {
  if (!fun.conf(s, 'bday').on) return;
  const lang = chat.lang;
  const day = dayOf(s, lang);
  if (!(await fun.claimGreetDay(chat.chat_id, day))) return;
  const cal = calOf(s, lang);
  const now = todayIn(cal, s, lang);
  const ids = await fun.claimBirthdays(chat.chat_id, cal, now.m, now.d, now.y);
  if (!ids.length) return;
  const names = [];
  for (const id of ids) names.push(iso(await users.displayName(id), 32));
  await say(ctx, chat.chat_id, s, t(lang, 'fun.bday_greet', { names: names.join(t(lang, 'common.sep')) }), null, 'fun-bday-greet');
}

/* ---------- games ---------- */

async function startGame(ctx, x) {
  const { message, chatId, s, lang, parsed, pre } = x;
  const kind = parsed.code;
  const r = reply(message);
  const from = message.from;
  const ttl = fun.GAME_TIME[kind];
  let state = {};
  let ans = null;
  let text;
  let rows = null;
  if (kind === 'guess') {
    ans = String(fun.randInt(1, 100));
    state = { tries: 0, last: {} };
    text = t(lang, 'fun.guess_start', { time: dur(lang, ttl) });
  } else if (kind === 'math') {
    const q = fun.mathQuestion();
    ans = String(q.answer);
    text = t(lang, 'fun.math_start', { q: q.text, time: dur(lang, ttl) });
  } else if (kind === 'scramble') {
    const word = fun.pick(list(lang, 'scramble'));
    ans = norm(word);
    text = t(lang, 'fun.scramble_start', { word: esc(fun.scramble(word).toUpperCase()), time: dur(lang, ttl) });
    state = { word };
  } else if (kind === 'typing') {
    const sentence = fun.pick(list(lang, 'typing'));
    ans = norm(sentence);
    state = { sentence, at: nowSec() };
    text = t(lang, 'fun.typing_start', { text: esc(fun.marked(sentence)), time: dur(lang, ttl) });
  } else if (kind === 'trivia') {
    return trivia(ctx, x);
  } else if (kind === 'click') {
    const pool = [...CLICK].sort(() => Math.random() - 0.5).slice(0, 9);
    const target = pool[fun.randInt(0, 8)];
    state = { pool, target, out: {} };
    text = t(lang, 'fun.click_start', { emoji: target });
  } else if (kind === 'rps') {
    state = pre.target ? { a: from.id, b: pre.target.id, accepted: false, picks: {} } : { a: from.id, b: 0, picks: {} };
    text = pre.target ? t(lang, 'fun.rps_challenge', { a: nameOf(from), b: nameOf(pre.target) }) : t(lang, 'fun.rps_bot', { user: nameOf(from) });
  } else if (kind === 'ttt') {
    state = { a: from.id, b: pre.target.id, accepted: false, board: Array(9).fill(''), turn: 'x' };
    text = t(lang, 'fun.ttt_challenge', { a: nameOf(from), b: nameOf(pre.target) });
  }
  const id = await fun.startGame(chatId, kind, { state, answer: ans, byId: from.id, ttl });
  if (!id) return say(ctx, chatId, s, t(lang, 'fun.game_busy'), null, 'fun-busy', r);
  if (kind === 'click') rows = clickRows(id, state.pool);
  else if (kind === 'rps') rows = state.b ? challengeRows(lang, id) : rpsRows(id);
  else if (kind === 'ttt') rows = challengeRows(lang, id);
  if (from) await users.remember(from);
  if (pre && pre.target) await users.remember(pre.target);
  const m = await say(ctx, chatId, s, text, rows, `fun-${kind}`, r);
  if (m) await fun.setMsg(id, m.message_id);
  else await fun.endGame(id, 'expired');
  return m;
}

async function trivia(ctx, x) {
  const { chatId, s, lang, message, f } = x;
  const line = fun.pick(list(lang, 'trivia'));
  const parts = line.split('|').map((y) => y.trim());
  const correct = Number(asciiDigits(parts[5])) - 1;
  if (parts.length < 6 || !(correct >= 0 && correct < 4)) return null;
  const m = await tryCall(ctx, 'sendPoll', { chat_id: chatId, question: parts[0].slice(0, 300), options: parts.slice(1, 5).map((o) => ({ text: o.slice(0, 100) })),
    type: 'quiz', correct_option_ids: [correct], is_anonymous: chatId > 0, open_period: 60, ...reply(message) }, 'fun-trivia');
  if (!m || !m.poll) return m;
  if (s && Number(s.fun_clean)) await msglog.add(chatId, m.message_id, 0, 'aegis', nowSec() + Number(s.fun_clean));
  if (chatId < 0) {
    const id = await fun.startGame(chatId, 'trivia', { state: { correct, reward: fun.conf(s, f.code).reward }, answer: m.poll.id, byId: message.from.id, ttl: 120 });
    if (id) await fun.setMsg(id, m.message_id);
  }
  return m;
}

const clickRows = (id, pool) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => btn(pool[r * 3 + c], `fn:${id}:c:${r * 3 + c}`)));
const rpsRows = (id) => [['r', 'p', 's'].map((k) => btn(RPS_ICON[k], `fn:${id}:${k}`))];
const challengeRows = (lang, id) => [[btn(t(lang, 'fun.btn_accept'), `fn:${id}:a`), btn(t(lang, 'fun.btn_cancel'), `fn:${id}:x`)]];
const tttRows = (id, board) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => {
  const v = board[r * 3 + c];
  return btn(v === 'x' ? '❌' : v === 'o' ? '⭕' : '▫\uFE0F', `fn:${id}:t:${r * 3 + c}`);
}));

/* Answers in the chat: guesses, sums, words, typed sentences. And the birthday greeting. */
export async function onMessage(ctx, chat, message) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel' || ctx.quiet) return;
  const from = message.from;
  if (!from || from.is_bot || message.sender_chat) return;
  const s = await settings.all(ctx, chat.chat_id);
  if (!flag(s, 'fun_on')) return;
  await greetBirthdays(ctx, chat, s);
  const text = String(message.text || '').trim();
  if (!text || text.length > 300) return;
  const games = await fun.running(chat.chat_id);
  if (!games.length) return;
  const lang = chat.lang;
  const now = nowSec();
  for (const g of games) {
    const st = fun.stateOf(g);
    const c = fun.conf(s, g.kind);
    let won = false;
    if (g.kind === 'guess') {
      const n = toInt(asciiDigits(text));
      if (n === null || n < 1 || n > 100) continue;
      if (Number(st.last[from.id] || 0) > now - 3) continue;
      const next = { ...st, tries: Number(st.tries) + 1, last: { ...st.last, [from.id]: now } };
      if (!(await fun.saveState(g, next))) continue;
      if (String(n) === g.answer) won = true;
      else {
        await say(ctx, chat.chat_id, s, t(lang, n < Number(g.answer) ? 'fun.guess_higher' : 'fun.guess_lower', { n: num(lang, n) }), null, 'fun-guess-hint', reply(message));
        continue;
      }
      if (won && (await fun.endGame(g.id, 'ended', from.id))) {
        await users.remember(from);
        const extra = await reward(chat.chat_id, s, from.id, c.reward, lang);
        await say(ctx, chat.chat_id, s, t(lang, 'fun.guess_win', { user: nameOf(from), n: num(lang, n), tries: num(lang, next.tries) }) + extra, null, 'fun-guess-win', reply(message));
      }
      continue;
    }
    if (g.kind === 'math') won = toInt(asciiDigits(text.replace(/\s/g, ''))) === Number(g.answer);
    else if (g.kind === 'scramble') won = norm(text) === g.answer;
    else if (g.kind === 'typing') won = !fun.pasted(text) && norm(text) === g.answer;
    else continue;
    if (!won || !(await fun.endGame(g.id, 'ended', from.id))) continue;
    await users.remember(from);
    const extra = await reward(chat.chat_id, s, from.id, c.reward, lang);
    const vars = { user: nameOf(from), answer: esc(g.kind === 'scramble' ? st.word : g.answer), time: dur(lang, Math.max(1, now - Number(st.at || g.at))) };
    await say(ctx, chat.chat_id, s, t(lang, `fun.${g.kind}_win`, vars) + extra, null, `fun-${g.kind}-win`, reply(message));
  }
}

/* A private chat's game answers (math, scramble, typing, guess) — the same games, keyed by the user. */
export async function onPrivateText(ctx, user, message) {
  const text = String(message.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  const games = await fun.running(user.user_id);
  if (!games.length) return false;
  const lang = user.lang;
  const now = nowSec();
  for (const g of games) {
    let won = false;
    if (g.kind === 'guess') {
      const n = toInt(asciiDigits(text));
      if (n === null || n < 1 || n > 100) continue;
      const st = fun.stateOf(g);
      const next = { ...st, tries: Number(st.tries) + 1 };
      await fun.saveState(g, next);
      if (String(n) !== g.answer) {
        await send(ctx, user.user_id, t(lang, n < Number(g.answer) ? 'fun.guess_higher' : 'fun.guess_lower', { n: num(lang, n) }), null, 'fun-guess-hint');
        return true;
      }
      if (await fun.endGame(g.id, 'ended', user.user_id)) {
        await send(ctx, user.user_id, t(lang, 'fun.guess_win', { user: iso(fullName(message.from), 32), n: num(lang, n), tries: num(lang, next.tries) }), null, 'fun-guess-win');
      }
      return true;
    }
    if (g.kind === 'math') won = toInt(asciiDigits(text.replace(/\s/g, ''))) === Number(g.answer);
    else if (g.kind === 'scramble') won = norm(text) === g.answer;
    else if (g.kind === 'typing') won = !fun.pasted(text) && norm(text) === g.answer;
    else continue;
    if (!won) {
      await send(ctx, user.user_id, t(lang, 'fun.solo_wrong'), null, 'fun-solo-wrong');
      return true;
    }
    if (await fun.endGame(g.id, 'ended', user.user_id)) {
      const st = fun.stateOf(g);
      await send(ctx, user.user_id, t(lang, `fun.${g.kind}_win`, { user: iso(fullName(message.from), 32), answer: esc(g.kind === 'scramble' ? st.word : g.answer),
        time: dur(lang, Math.max(1, now - Number(st.at || g.at))) }), null, `fun-${g.kind}-win`);
    }
    return true;
  }
  return false;
}

/* A trivia quiz answer: the first right one wins. */
export async function onPollAnswer(ctx, a) {
  if (!a || !a.user || !a.poll_id) return;
  const g = await fun.gameByAnswer('trivia', a.poll_id);
  if (!g) return;
  const st = fun.stateOf(g);
  if (!(a.option_ids || []).includes(Number(st.correct))) return;
  if (!(await fun.endGame(g.id, 'ended', a.user.id))) return;
  const chat = await chats.get(Number(g.chat_id));
  if (!chat) return;
  const s = await settings.all(ctx, chat.chat_id);
  await users.remember(a.user);
  const extra = await reward(chat.chat_id, s, a.user.id, Number(st.reward) || 0, chat.lang);
  await say(ctx, chat.chat_id, s, t(chat.lang, 'fun.trivia_win', { user: nameOf(a.user) }) + extra, null, 'fun-trivia-win',
    Number(g.msg_id) ? { reply_parameters: { message_id: Number(g.msg_id), allow_sending_without_reply: true } } : {});
}

/* ---------- buttons ---------- */

export async function callback(ctx, cq, parts) {
  if (parts[1] === 'f') return falButton(ctx, cq, parts);
  if (parts[1] === 'r') return recButton(ctx, cq, parts);
  if (parts[1] === 'd') return decideButton(ctx, cq, parts);
  if (parts[1] === 'q') return testButton(ctx, cq, parts);
  if (parts[1] === 'm' || parts[1] === 'k') return pairButton(ctx, cq, parts);
  if (parts[1] === 't') return fontPage(ctx, cq, parts);
  const from = cq.from;
  const u = await users.get(from.id);
  const lang0 = u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
  const g = await fun.game(toInt(parts[1]));
  if (!g || g.status !== 'running' || Number(g.ends_at) <= nowSec()) return answer(ctx, t(lang0, 'fun.game_over'), true);
  const chatId = Number(g.chat_id);
  const chat = chatId < 0 ? await chats.get(chatId) : null;
  const lang = chat ? chat.lang : lang0;
  const s = chat ? await settings.all(ctx, chatId) : null;
  const st = fun.stateOf(g);
  const place = { chat_id: chatId, message_id: Number(g.msg_id) || (cq.message && cq.message.message_id) };
  const act = parts[2];
  const c = fun.conf(s, g.kind);
  if (act === 'x') {
    if (from.id !== Number(st.a) || st.accepted) return answer(ctx, t(lang0, 'fun.not_yours'), true);
    if (await fun.endGame(g.id, 'expired')) await edit(ctx, place, t(lang, 'fun.challenge_cancelled'), null, 'fun-cancel');
    return answer(ctx);
  }
  if (act === 'a') {
    if (from.id !== Number(st.b)) return answer(ctx, t(lang0, 'fun.not_yours'), true);
    if (st.accepted) return answer(ctx);
    const next = { ...st, accepted: true };
    if (!(await fun.saveState(g, next, { extend: 300 }))) return answer(ctx);
    const a = iso(await users.displayName(Number(st.a)), 32);
    const b = iso(await users.displayName(Number(st.b)), 32);
    if (g.kind === 'rps') await edit(ctx, place, t(lang, 'fun.rps_pick', { a, b }), rpsRows(g.id), 'fun-rps');
    else await edit(ctx, place, t(lang, 'fun.ttt_turn', { a, b, turn: a }), tttRows(g.id, st.board), 'fun-ttt');
    return answer(ctx);
  }
  if (g.kind === 'click' && act === 'c') {
    if (st.out[from.id]) return answer(ctx, t(lang0, 'fun.click_out'), true);
    const i = toInt(parts[3]);
    if (st.pool[i] !== st.target) {
      await fun.saveState(g, { ...st, out: { ...st.out, [from.id]: 1 } });
      return answer(ctx, t(lang0, 'fun.click_wrong'), true);
    }
    if (!(await fun.endGame(g.id, 'ended', from.id))) return answer(ctx);
    await users.remember(from);
    const extra = await reward(chatId, s, from.id, c.reward, lang);
    await edit(ctx, place, t(lang, 'fun.click_win', { user: nameOf(from), emoji: st.target }) + extra, null, 'fun-click-win');
    return answer(ctx, t(lang0, 'fun.you_won'));
  }
  if (g.kind === 'rps' && fun.RPS.includes(act)) {
    if (from.id !== Number(st.a) && from.id !== Number(st.b)) return answer(ctx, t(lang0, 'fun.not_yours'), true);
    if (st.b && !st.accepted) return answer(ctx, t(lang0, 'fun.wait_accept'), true);
    if (st.picks[from.id]) return answer(ctx, t(lang0, 'fun.rps_saved'), true);
    const picks = { ...st.picks, [from.id]: act };
    if (!st.b) picks[0] = fun.pick(fun.RPS);
    if (!(await fun.saveState(g, { ...st, picks }))) return answer(ctx);
    const pa = picks[st.a];
    const pb = picks[st.b];
    if (!pa || !pb) return answer(ctx, t(lang0, 'fun.rps_saved'));
    const res = fun.rpsWinner(pa, pb);
    const winner = res === 1 ? Number(st.a) : res === -1 ? Number(st.b) : 0;
    if (!(await fun.endGame(g.id, 'ended', winner))) return answer(ctx);
    const a = iso(await users.displayName(Number(st.a)), 32);
    const b = st.b ? iso(await users.displayName(Number(st.b)), 32) : t(lang, 'fun.the_bot');
    const extra = winner ? await reward(chatId, s, winner, c.reward, lang) : '';
    const line = res === 0 ? t(lang, 'fun.rps_draw') : t(lang, 'fun.rps_won', { user: res === 1 ? a : b });
    await edit(ctx, place, `${t(lang, 'fun.rps_result', { a, b, pa: RPS_ICON[pa], pb: RPS_ICON[pb] })}\n${line}${extra}`, null, 'fun-rps-result');
    return answer(ctx);
  }
  if (g.kind === 'ttt' && act === 't') {
    if (!st.accepted) return answer(ctx, t(lang0, 'fun.wait_accept'), true);
    const mark = from.id === Number(st.a) ? 'x' : from.id === Number(st.b) ? 'o' : null;
    if (!mark) return answer(ctx, t(lang0, 'fun.not_yours'), true);
    if (st.turn !== mark) return answer(ctx, t(lang0, 'fun.ttt_not_turn'), true);
    const cell = toInt(parts[3]);
    if (cell === null || cell < 0 || cell > 8 || st.board[cell]) return answer(ctx, t(lang0, 'fun.ttt_taken'), true);
    const board = st.board.slice();
    board[cell] = mark;
    const next = { ...st, board, turn: mark === 'x' ? 'o' : 'x' };
    if (!(await fun.saveState(g, next, { extend: 120 }))) return answer(ctx);
    const a = iso(await users.displayName(Number(st.a)), 32);
    const b = iso(await users.displayName(Number(st.b)), 32);
    const w = fun.tttWinner(board);
    if (!w) {
      await edit(ctx, place, t(lang, 'fun.ttt_turn', { a, b, turn: next.turn === 'x' ? a : b }), tttRows(g.id, board), 'fun-ttt');
      return answer(ctx);
    }
    const winner = w === 'x' ? Number(st.a) : w === 'o' ? Number(st.b) : 0;
    if (!(await fun.endGame(g.id, 'ended', winner))) return answer(ctx);
    const extra = winner ? await reward(chatId, s, winner, c.reward, lang) : '';
    const line = w === 'draw' ? t(lang, 'fun.ttt_draw') : t(lang, 'fun.ttt_won', { user: w === 'x' ? a : b });
    await edit(ctx, place, `${t(lang, 'fun.ttt_end', { a, b })}\n${line}${extra}`, tttRows(g.id, board).map((row) => row.map((x) => ({ ...x, callback_data: 'nop' }))), 'fun-ttt-end');
    return answer(ctx);
  }
  return answer(ctx);
}

/* Timed endings, on the side of updates. */
export async function sweep(ctx) {
  for (const g of await fun.dueGames(nowSec())) {
    if (!(await fun.endGame(g.id, 'expired'))) continue;
    const chatId = Number(g.chat_id);
    const chat = chatId < 0 ? await chats.get(chatId) : null;
    const lang = chat ? chat.lang : ((await users.get(chatId)) || {}).lang || 'en';
    const st = fun.stateOf(g);
    const place = { chat_id: chatId, message_id: Number(g.msg_id) };
    if (g.kind === 'trivia') continue;
    if (['click', 'rps', 'ttt'].includes(g.kind)) {
      if (Number(g.msg_id)) await edit(ctx, place, t(lang, 'fun.timeout'), null, 'fun-timeout');
      continue;
    }
    const answerText = g.kind === 'scramble' ? st.word : g.kind === 'typing' ? st.sentence : g.answer;
    await send(ctx, chatId, t(lang, 'fun.game_timeout', { answer: esc(answerText || '') }), null, 'fun-timeout',
      Number(g.msg_id) ? { reply_parameters: { message_id: Number(g.msg_id), allow_sending_without_reply: true } } : {});
  }
}

/* ========== panelFun: the 🎮 Fun section of a group's panel ========== */

export const panelFun = (() => {
  const FIELDS = { o: 'on', w: 'who', c: 'cd', d: 'daily', r: 'reward' };
  const title = (g) => iso(g.chat.title || '', 48);
  const onOff = (lang, v) => t(lang, v ? 'common.on' : 'common.off');
  const limitsText = (lang, c) => t(lang, 'fun.limits', { who: t(lang, `fun.who_${c.who}`), cd: c.cd ? dur(lang, c.cd) : t(lang, 'common.off'),
    daily: c.daily ? num(lang, c.daily) : t(lang, 'fun.unlimited') });

  async function home(ctx, user, g, place) {
    const lang = user.lang;
    const c = g.chat.chat_id;
    const s = await settings.all(ctx, c);
    const on = fun.FEATURES.filter((f) => fun.conf(s, f.code).on).length;
    const lines = [t(lang, 'fun.panel_title', { title: title(g) }), t(lang, 'fun.panel_intro'), '',
      t(lang, 'fun.panel_count', { n: num(lang, on), total: num(lang, fun.FEATURES.length) })];
    const sb = (key) => btn(t(lang, 'chp.setting_btn', { name: t(lang, `chp.k_${key}`), value: valueOf(lang, key, s[key]) }), `g:${c}:fn:s:${key}`);
    const kb = [[sb('fun_on')], [sb('fun_rate'), sb('fun_clean')], [sb('fun_reward'), sb('fun_free')], [sb('bday_cal')]];
    kb.push(...pairs(fun.CATS.map((cat) => {
      const feats = fun.FEATURES.filter((f) => f.cat === cat);
      const n = feats.filter((f) => fun.conf(s, f.code).on).length;
      return btn(`${t(lang, `fun.cat_${cat}`)} ${num(lang, n)}/${num(lang, feats.length)}`, `g:${c}:fn:c:${cat}`);
    })));
    kb.push(back(lang, `g:${c}`));
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fun');
  }

  function valueOf(lang, key, v) {
    if (['fun_on', 'fun_reward', 'fun_free'].includes(key)) return onOff(lang, v === '1');
    if (key === 'fun_rate') return Number(v) ? t(lang, 'chp.v_per_min', { n: num(lang, Number(v)) }) : t(lang, 'common.off');
    if (key === 'fun_clean') return Number(v) ? dur(lang, Number(v)) : t(lang, 'common.off');
    return t(lang, `chp.v_${key}_${v}`);
  }

  async function category(ctx, user, g, cat, place) {
    const lang = user.lang;
    const c = g.chat.chat_id;
    const s = await settings.all(ctx, c);
    const mode = fun.catMode(s, cat);
    const lines = [t(lang, 'fun.cat_title', { cat: t(lang, `fun.cat_${cat}`), title: title(g) }), t(lang, 'fun.cat_mode', { v: t(lang, `fun.mode_${mode}`) }), ''];
    const kb = [[btn(t(lang, 'fun.btn_mode', { v: inline(lang, `fun.mode_${mode}`) }), `g:${c}:fn:m:${cat}`),
      btn(t(lang, 'fun.btn_special', { n: num(lang, await lists.count(c, 'fun')) }), `g:${c}:L:fun`)]];
    for (const f of fun.FEATURES.filter((x) => x.cat === cat)) {
      const cf = fun.conf(s, f.code);
      lines.push(`${cf.on ? '✅' : '▫\uFE0F'} ${f.emoji} ${t(lang, `fun.n_${f.code}`)} — ${limitsText(lang, cf)}`);
      kb.push([btn(`${cf.on ? '✅' : '▫\uFE0F'} ${f.emoji} ${t(lang, `fun.n_${f.code}`)}`, `g:${c}:fn:f:${f.code}`)]);
    }
    kb.push(back(lang, `g:${c}:fn`));
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fun-cat');
  }

  async function feature(ctx, user, g, code, place) {
    const lang = user.lang;
    const c = g.chat.chat_id;
    const s = await settings.all(ctx, c);
    const f = fun.byCode(code);
    const cf = fun.conf(s, code);
    const lines = [`${f.emoji} <b>${t(lang, `fun.n_${code}`)}</b>`, t(lang, `fun.d_${code}`), '', t(lang, 'fun.commands', { list: f.cmds.map((x) => `/${x}`).join(' ') }),
      limitsText(lang, cf)];
    if (f.game || f.cat === 'dice') lines.push(t(lang, 'fun.reward_line', { n: cf.reward ? num(lang, cf.reward) : t(lang, 'common.off') }));
    const p = `g:${c}:fn:f:${code}`;
    const kb = [[btn(t(lang, 'fun.btn_on', { v: onOff(lang, cf.on) }), `${p}:o`), btn(t(lang, 'fun.btn_who', { v: t(lang, `fun.who_${cf.who}`) }), `${p}:w`)],
      [btn(t(lang, 'fun.btn_cd', { v: cf.cd ? dur(lang, cf.cd) : t(lang, 'common.off') }), `${p}:c`),
        btn(t(lang, 'fun.btn_daily', { v: cf.daily ? num(lang, cf.daily) : t(lang, 'fun.unlimited') }), `${p}:d`)]];
    if (f.game || f.cat === 'dice') kb.push([btn(t(lang, 'fun.btn_reward', { v: cf.reward ? num(lang, cf.reward) : t(lang, 'common.off') }), `${p}:r`)]);
    kb.push(back(lang, `g:${c}:fn:c:${f.cat}`));
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-fun-feature');
  }

  async function callback(ctx, user, g, parts, place) {
    if (g.chat.type === 'channel') return null;
    const a = parts[3];
    if (a === 's') {
      await toggle(ctx, user, g, parts[4]);
      return home(ctx, user, g, place);
    }
    if (a === 'c' && fun.CATS.includes(parts[4])) return category(ctx, user, g, parts[4], place);
    if (a === 'm' && fun.CATS.includes(parts[4])) {
      if (!(await needLevel(ctx, user, g, admins.L.settings))) return null;
      const s = await settings.all(ctx, g.chat.chat_id);
      const modes = fun.CAT_MODES;
      await settings.set(ctx, g.chat.chat_id, `fcat_${parts[4]}`, modes[(modes.indexOf(fun.catMode(s, parts[4])) + 1) % modes.length], user.user_id);
      return category(ctx, user, g, parts[4], place);
    }
    if (a === 'f' && fun.byCode(parts[4])) {
      const code = parts[4];
      const field = FIELDS[parts[5]];
      if (field) {
        if (!(await needLevel(ctx, user, g, admins.L.settings))) return null;
        const s = await settings.all(ctx, g.chat.chat_id);
        const cf = fun.conf(s, code);
        const cycle = (list0, v) => list0[(list0.indexOf(v) + 1) % list0.length];
        if (field === 'on') cf.on = !cf.on;
        if (field === 'who') cf.who = cf.who === 'a' ? 'd' : 'a';
        if (field === 'cd') cf.cd = cycle(fun.COOLDOWNS, cf.cd);
        if (field === 'daily') cf.daily = cycle(fun.DAILIES, cf.daily);
        if (field === 'reward') cf.reward = cycle(fun.REWARDS, cf.reward);
        await settings.set(ctx, g.chat.chat_id, `fx_${code}`, fun.encodeConf(cf), user.user_id);
      }
      return feature(ctx, user, g, code, place);
    }
    return home(ctx, user, g, place);
  }

  return { callback };
})();
