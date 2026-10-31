/*
 * Fun features at work (Phase 9): the 30 features as commands (slash or the words of the funcmd
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
 * callback_data: fn:<game>:c:<i> quick click · fn:<game>:a accept · fn:<game>:x cancel (the challenger)
 *   · fn:<game>:r|p|s rock-paper-scissors · fn:<game>:t:<cell> tic-tac-toe
 * Panel: g:c:fn  ·  g:c:fn:s:<key>  ·  g:c:fn:c:<cat>  ·  g:c:fn:f:<code>[:o|w|c|d|r]
 */
import { asciiDigits, dateOf, toJalali, tzOf } from '../core/clock.js';
import { answer, btn, edit, me, screen, send, tryCall } from '../core/tg.js';
import { esc, fullName, iso, normalizeWord, nowSec, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import * as fun from '../engines/fun.js';
import * as msglog from '../engines/msglog.js';
import * as settings from '../engines/settings.js';
import { stats } from '../engines/social.js';
import * as users from '../engines/users.js';
import { dur, num, pickLang, t, wordCommand } from '../i18n/index.js';
import { isAdmin } from './enforce.js';
import { back, needLevel, pairs } from './guard.js';
import { toggle } from './panel_channel.js';

const flag = settings.flag;
const RLM = /[\u200F\u200E]/g;
/* A content list from funlist (one item per line), without direction marks. */
const list = (lang, key) => t(lang, `funlist.${key}`).split('\n').map((x) => x.replace(RLM, '').trim()).filter(Boolean);
const norm = (s) => normalizeWord(String(s || '').replace(RLM, '').replace(new RegExp(fun.PASTE_MARK, 'g'), ''));
const PRIVATE_OK = new Set(['dice', 'darts', 'basket', 'football', 'bowling', 'slot', 'coin', 'rand', 'choose', 'ball8', 'fortune', 'rate', 'truth', 'dare',
  'quote', 'math', 'scramble', 'typing', 'guess', 'trivia', 'rps']);
const KEY_CODE = { hug: 'act', pat: 'act', highfive: 'act', wave: 'act', cheer: 'act', birthday: 'bday', birthdays: 'bday', fun: 'fun' };
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
    const code = name === 'fun' ? 'fun' : fun.SLASH[name];
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

/* Gives true when the message was a fun command (handled, or ignored on purpose). */
export async function command(ctx, message, privUser = null) {
  const parsed = parseCommand(message.text);
  const from = message.from;
  if (!parsed || !from || from.is_bot || message.sender_chat) return false;
  const priv = message.chat.type === 'private';
  let chat = null;
  let s = null;
  let lang;
  if (priv) {
    lang = privUser ? privUser.lang : pickLang(from.language_code);
    if (parsed.code !== 'fun' && !PRIVATE_OK.has(parsed.code)) {
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
  const c = fun.conf(s, parsed.code);
  if (!c.on) return parsed.slash;
  const admin = !priv && (await isAdmin(chatId, from.id));
  if (c.who === 'd' && !admin) return parsed.slash;
  const f = fun.byCode(parsed.code);
  const pre = prepare(parsed, message, lang);
  if (pre && pre.bad) {
    if (parsed.slash) await say(ctx, chatId, s, t(lang, `fun.usage_${parsed.code}`), null, 'fun-usage', reply(message));
    return parsed.slash;
  }
  const free = admin && flag(s, 'fun_free');
  if (!priv && !free && !(await fun.claimRate(chatId, Number(s.fun_rate)))) return true;
  const day = dayOf(s, lang);
  const limits = parsed.code === 'daily' ? { ...c, cd: 0, daily: 1 } : c;
  const use = await fun.claimUse(priv ? 0 : chatId, from.id, parsed.code, limits, day, { free: free && parsed.code !== 'daily' });
  if (use !== 'ok') {
    const text = use === 'daily' ? t(lang, parsed.code === 'daily' ? 'fun.daily_done' : 'fun.limit_daily', { n: num(lang, c.daily) })
      : t(lang, 'fun.limit_wait', { time: dur(lang, use.wait) });
    await say(ctx, chatId, s, text, null, 'fun-limit', reply(message));
    return true;
  }
  await run(ctx, { message, chat, chatId, s, lang, priv, parsed, f, c, pre, day });
  return true;
}

/* Arguments checked before anything is counted. Gives { bad } or the parsed values. */
function prepare(parsed, message, lang) {
  const a = parsed.args;
  const text = a.join(' ');
  const target = message.reply_to_message && message.reply_to_message.from;
  const human = target && !target.is_bot && target.id !== message.from.id ? target : null;
  switch (parsed.code) {
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

function funList(lang, s, priv) {
  const lines = [t(lang, 'fun.list_title')];
  for (const cat of fun.CATS) {
    const feats = fun.FEATURES.filter((f) => f.cat === cat && (priv ? PRIVATE_OK.has(f.code) : fun.conf(s, f.code).on));
    if (!feats.length) continue;
    lines.push('', t(lang, `fun.cat_${cat}`));
    for (const f of feats) lines.push(`${f.emoji} ${f.cmds.map((c) => `/${c}`).join(' ')} — ${t(lang, `fun.n_${f.code}`)}`);
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
