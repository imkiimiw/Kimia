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
 *   · fn:t:<page>[:<part>] a page of /font (combo, tg, uni, look, mark, fa, frame, extra), for the one who asked
 * Panel: g:c:fn  ·  g:c:fn:s:<key>  ·  g:c:fn:c:<cat>  ·  g:c:fn:f:<code>[:o|w|c|d|r]
 */
import { asciiDigits, dateOf, toJalali, tzOf } from '../core/clock.js';
import { answer, btn, edit, markup, me, screen, send, tryCall, urlBtn } from '../core/tg.js';
import { esc, fullName, iso, normalizeWord, nowSec, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import * as fun from '../engines/fun.js';
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
const flist = (lang, key) => t(lang, `fallist.${key}`).split('\n').map((x) => x.replace(RLM, '').trim()).filter(Boolean);
const norm = (s) => normalizeWord(String(s || '').replace(RLM, '').replace(new RegExp(fun.PASTE_MARK, 'g'), ''));
/* features that need a group (members, replies, the group's own lists); the rest also work in private */
const GROUP_ONLY = new Set(['love', 'wyr', 'act', 'couple', 'motd', 'bday', 'daily', 'click', 'ttt']);
const PRIVATE_OK = new Set(fun.CODES.filter((c) => !GROUP_ONLY.has(c)));
const KEY_CODE = { hug: 'act', pat: 'act', highfive: 'act', wave: 'act', cheer: 'act', birthday: 'bday', birthdays: 'bday', fun: 'fun', fal: 'fal' };
const MENUS = new Set(['fun', 'fal']);
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
  if (!s || s.length > 300) return null;
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) {
    const name = m[1].toLowerCase();
    const code = MENUS.has(name) ? name : fun.SLASH[name];
    if (!code) return null;
    return { code, sub: name, args: tokens.slice(1), slash: true, mention: m[2] ? m[2].toLowerCase() : null };
  }
  for (let n = Math.min(4, tokens.length); n >= 1; n -= 1) {
    const key = wordCommand('funcmd', tokens.slice(0, n).join(' '));
    if (!key) continue;
    const code = KEY_CODE[key] || key;
    const args = tokens.slice(n);
    const f = fun.byCode(code);
    if (args.length && !(f && f.args) && !(code === 'bday' && key === 'birthday')) continue;
    return { code, sub: key, args, slash: false, mention: null };
  }
  return null;
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
  const notice = async (text, view) => {
    if (!press) return say(ctx, chatId, s, text, null, view, reply(message));
    press.answered = true;
    return answer(ctx, text.replace(RLM, '').replace(/<[^>]+>/g, '').slice(0, 190), true);
  };
  const c = fun.conf(s, parsed.code);
  if (!c.on) return parsed.slash;
  const admin = !priv && (await isAdmin(chatId, from.id));
  if (c.who === 'd' && !admin) return parsed.slash;
  const f = fun.byCode(parsed.code);
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
  if (['horo', 'birthmonth'].includes(parsed.code) && pre.sign === null) return priv || !(await fun.birthdayOf(chatId, userId));
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
    if (MENU_CAT[cat]) {
      lines.push('', t(lang, 'fun.list_menu', { cat: t(lang, `fun.cat_${cat}`), cmd: MENU_CAT[cat], n: num(lang, feats.length) }));
      continue;
    }
    lines.push('', t(lang, `fun.cat_${cat}`));
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
    case 'coin':
      return say(ctx, chatId, s, t(lang, 'fun.coin', { user: me, side: t(lang, Math.random() < 0.5 ? 'fun.coin_heads' : 'fun.coin_tails') }), null, 'fun-coin', r);
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
    return [btn(label(f), `fn:f:${f.code}${f.code === 'horo' ? ':p' : ''}`)];
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
const signRows = (lang) => [0, 1, 2, 3].map((r) => [0, 1, 2].map((c) => {
  const i = r * 3 + c;
  return btn(`${fun.fal.SIGNS[i]} ${signName(lang, i)}`, `fn:f:horo:${i}`);
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
      if (nx.length) lines.push('', t(lang, 'fal.hr_next'), ...nx.map((n) => rtl(lang, `• ${digitsIn(lang, n.time)} — ${t(lang, `fal.hr_t_${n.type}`)}`)));
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
const FONT_PREFIX = { uni: 'u', look: 'u', mark: 'm', fa: 'p' };
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
const BUTTON_ARGS = { tarot: ['1', '3'], horo: [...Array(12).keys()].map(String), birthmonth: [...Array(12).keys()].map(String) };
async function falButton(ctx, cq, parts) {
  const code = parts[2];
  const f = fun.byCode(code);
  const msg = cq.message;
  if (!f || !['fal', 'hours', 'numbers'].includes(f.cat) || msg.chat.type === 'channel') return answer(ctx);
  if ((code === 'horo' || code === 'birthmonth') && parts[3] === 'p') {
    const u = await users.get(cq.from.id);
    const chat = msg.chat.id < 0 ? await chats.get(msg.chat.id) : null;
    const lang = chat ? chat.lang : (u ? u.lang : pickLang(cq.from.language_code));
    await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: markup(code === 'horo' ? signRows(lang) : bmRows(lang)) },
      `fun-${code}-signs`);
    return answer(ctx);
  }
  const arg = parts[3] === undefined ? '' : parts[3];
  if (arg && !(BUTTON_ARGS[code] || []).includes(arg)) return answer(ctx);
  const text = `/${f.cmds[0]}${arg ? ` ${code === 'horo' || code === 'birthmonth' ? fun.fal.SIGNS[Number(arg)] : arg}` : ''}`;
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
    const lines = [t(lang, 'fun.cat_title', { cat: t(lang, `fun.cat_${cat}`), title: title(g) }), ''];
    const kb = [];
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
