// The assistant: a user writes anything (a need, a bot's name, a question, a problem) and gets the right
// bot, the right feature and how to use it, from the catalog the team wrote. With an AI key the answer
// is written by Gemini, grounded in that catalog; without one (or when it fails) the keyword engine
// (lib/catalog.js search) builds it. Problems get troubleshooting tips and a "report it" button;
// unanswered questions can go to the team as a ticket.
import { ready, generate } from './ai.js';
import { recordView } from './activity.js';
import {
  STATUS, botLink, categoryOf, effectiveStatus, listBots, matchFixes, newestBots, search,
} from './catalog.js';
import { openIncidentOf } from './incidents.js';
import { isSubscribed, subButton } from './news.js';
import { isTeam, setState } from './store.js';
import { btn, urlBtn } from './tg.js';
import { esc, normalize, truncate } from './util.js';

const PROBLEM_RE = /(کار\s?نمی\s?(کنه|کند)|کار نمیکنه|خطا|ارور|error|باگ|bug|مشکل|خراب|جواب\s?نمی\s?(ده|دهد)|هنگ|قطع|نمیاد|نمی\s?آد|نمیشه|نمی\s?شه|نمی\s?فرسته|نمیفرسته)/;
const NEWEST_RE = /(جدید|تازه|اخیر|اخرین|آخرین|new)/;
const BOT_WORD_RE = /(ربات|بات|bot)/;
const STATUS_RE = /(وضعیت|status|انلاین|آنلاین|فعاله|قطعه)/;

export const looksLikeProblem = (text) => PROBLEM_RE.test(normalize(text));

function botButtons(bot, { sub = false, report = false } = {}) {
  const rows = [];
  const link = botLink(bot);
  if (link) rows.push([urlBtn(`🚀 باز کردن ${bot.name}`, link)]);
  rows.push([btn('📖 قابلیت‌ها و راهنما', `bf:${bot.key}`), btn('ℹ️ معرفی', `b:${bot.key}`)]);
  rows.push([subButton(sub, bot.key)]);
  if (report) rows.push([btn('🛠 گزارش خطا به تیم', `r:${bot.key}`)]);
  return rows;
}

/** Text for one bot in an answer. */
function botLine(bot) {
  return `${bot.emoji || '🤖'} <b>${esc(bot.name)}</b>${bot.username ? ` — @${esc(bot.username)}` : ''}\n${esc(bot.short || '')}`;
}

async function statusSuffix(bot) {
  const s = effectiveStatus(bot, await openIncidentOf(bot.key));
  if (s === 'ok') return '';
  return `\n${STATUS[s].emoji} الان: ${STATUS[s].name}${bot.status_note ? ` — ${esc(bot.status_note)}` : ''}`;
}

async function newestAnswer(bots) {
  const list = await newestBots(5);
  const lines = ['🆕 <b>تازه‌ترین ربات‌های Wanger:</b>', ''];
  for (const b of list) lines.push(`${botLine(b)}`, '');
  const kb = list.slice(0, 5).map((b) => [btn(`${b.emoji || '🤖'} ${b.name}`, `b:${b.key}`)]);
  kb.push([btn('🤖 همه‌ی ربات‌ها', 'b')]);
  return { text: lines.join('\n').trim(), kb, bots: list.map((b) => b.key), engine: 'intent' };
}

/** The keyword engine's answer. */
async function keywordAnswer(user, text, bots) {
  const problem = looksLikeProblem(text);
  const res = search(text, bots);
  const top = res.bots[0];
  if (!top || top.score < 1) return null;
  const bot = top.bot;
  const lines = [];
  if (problem) {
    lines.push(`🛠 مشکل با ${botLine(bot)}`);
    const status = await statusSuffix(bot);
    if (status) lines.push(status, '', 'این مشکل را می‌دانیم و تیم در حال رسیدگی است.');
    const fixes = matchFixes(text, bot);
    if (fixes.length) {
      lines.push('', '💡 <b>این‌ها را امتحان کن:</b>');
      for (const f of fixes) lines.push(`• <b>${esc(f.p)}</b>\n${esc(f.s)}`);
    }
    lines.push('', 'اگر حل نشد، «🛠 گزارش خطا به تیم» را بزن تا بررسی شود.');
  } else {
    lines.push(`🤖 برای این کار: ${botLine(bot)}${await statusSuffix(bot)}`);
    const feats = res.features.filter((x) => x.bot.key === bot.key && x.score >= 1.4).slice(0, 2);
    for (const x of feats) lines.push('', `📌 <b>${esc(x.f.t)}</b>`, esc(x.f.h));
    const faq = res.faq.find((x) => x.bot.key === bot.key && x.score >= 2);
    if (faq) lines.push('', `❓ <b>${esc(faq.f.q)}</b>`, esc(faq.f.a));
    if (!feats.length && !faq && bot.features.length) {
      lines.push('', '<b>چند قابلیت:</b>');
      for (const f of bot.features.slice(0, 3)) lines.push(`• ${esc(f.t)}`);
    }
    const others = res.bots.slice(1, 3).filter((x) => x.score >= top.score * 0.6);
    if (others.length) {
      lines.push('', '<b>این‌ها هم شاید به کارت بیاد:</b>');
      for (const o of others) lines.push(`${o.bot.emoji || '🤖'} ${esc(o.bot.name)}${o.bot.username ? ` — @${esc(o.bot.username)}` : ''}`);
    }
  }
  const kb = botButtons(bot, { sub: await isSubscribed(user.user_id, bot.key), report: problem });
  const others = res.bots.slice(1, 3).filter((x) => x.score >= top.score * 0.6);
  if (!problem && others.length) kb.push(others.map((o) => btn(`${o.bot.emoji || '🤖'} ${o.bot.name}`, `b:${o.bot.key}`)));
  return { text: lines.join('\n'), kb, bots: [bot.key], engine: 'keywords', problem };
}

// ---------- AI ----------

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    bots: { type: 'ARRAY', items: { type: 'STRING' } },
    problem: { type: 'BOOLEAN' },
    unknown: { type: 'BOOLEAN' },
  },
  required: ['answer', 'bots', 'problem', 'unknown'],
};

/** The catalog as plain text for the prompt (status included), at most ~14k characters. */
export async function catalogContext(bots) {
  const parts = [];
  for (const b of bots) {
    const s = effectiveStatus(b, await openIncidentOf(b.key));
    const lines = [`[${b.key}] ${b.name}${b.username ? ` (@${b.username})` : ' (username not public yet)'} — ${categoryOf(b.category).name} — status: ${STATUS[s].name}${b.status_note ? ` (${b.status_note})` : ''}${b.mode === 'closed' && b.mode_msg ? ` (${b.mode_msg})` : ''}`];
    lines.push(`  ${b.short || ''} ${b.description || ''}`.trimEnd());
    if (b.langs) lines.push(`  Languages: ${b.langs}`);
    for (const f of b.features) lines.push(`  Feature: ${f.t}: ${f.h}`);
    for (const f of b.faq) lines.push(`  FAQ: ${f.q} → ${f.a}`);
    for (const f of b.fixes) lines.push(`  Fix: ${f.p} → ${f.s}`);
    parts.push(lines.join('\n'));
  }
  return truncate(parts.join('\n\n'), 14000);
}

const PROMPT = `You are the help assistant of "Wanger", a family of Telegram bots. Users write in Persian (sometimes
Finglish or English). Answer in Persian (Farsi), friendly and short (at most 8 lines), using ONLY the catalog below.
- If they ask which bot does something, name the bot and its @username.
- If they ask how to use a feature, give the steps from the catalog.
- If they describe a problem or an error with a bot, set problem=true; give matching "Fix" steps if any, and say that if
  it is not solved they can report it to the team with the button.
- If the bot's status is not active, mention it.
- If the catalog doesn't answer the question, set unknown=true and say so honestly; never invent features, commands,
  prices, links or usernames.
- bots: the [keys] of the bots your answer is about, most relevant first (at most 3).
- Plain text only: no Markdown, no HTML.

Catalog:
`;

async function aiAnswer(user, text, bots, key) {
  const out = await generate(key, user, `${PROMPT}${await catalogContext(bots)}\n\nUser: ${truncate(text, 1500)}`, SCHEMA);
  if (!out || typeof out.answer !== 'string' || !out.answer.trim()) return null;
  const keys = (Array.isArray(out.bots) ? out.bots : []).filter((k) => bots.some((b) => b.key === k)).slice(0, 3);
  const first = keys.length ? bots.find((b) => b.key === keys[0]) : null;
  const kb = first ? botButtons(first, { sub: await isSubscribed(user.user_id, first.key), report: !!out.problem }) : [];
  const rest = keys.slice(1).map((k) => bots.find((b) => b.key === k)).filter(Boolean);
  if (rest.length) kb.push(rest.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `b:${b.key}`)));
  if (out.unknown) kb.push([btn('✉️ سؤالم را برای تیم بفرست', 'qt')]);
  return {
    text: `💬 ${esc(truncate(out.answer.trim(), 1500))}`, kb, bots: keys, engine: 'ai', problem: !!out.problem, unknown: !!out.unknown,
  };
}

/**
 * Answers a free-text message. Returns { text, kb, bots, engine, problem, unknown }.
 * Remembers the question (state q_pending) so "send it to the team" can make a ticket of it.
 */
export async function answerQuestion(user, text) {
  const team = isTeam(user);
  const bots = await listBots({ team });
  const norm = normalize(text);
  let ans = null;
  if (NEWEST_RE.test(norm) && BOT_WORD_RE.test(norm) && !looksLikeProblem(text)) ans = await newestAnswer(bots);
  if (!ans && STATUS_RE.test(norm) && !search(text, bots).bots.length) {
    ans = { text: '📶 وضعیت همه‌ی ربات‌ها را این‌جا ببین:', kb: [[btn('📶 وضعیت ربات‌ها', 'st')]], bots: [], engine: 'intent' };
  }
  if (!ans) {
    const key = await ready(user);
    if (key) ans = await aiAnswer(user, text, bots, key);
  }
  if (!ans) ans = await keywordAnswer(user, text, bots);
  if (!ans) {
    ans = {
      text: '🤔 متوجه نشدم دنبال چه هستی.\n\nمی‌توانی اسم ربات یا کاری که می‌خواهی انجام بدهی را بنویسی (مثلاً «دانلود از اینستاگرام» یا «چطور نجوا بفرستم»)، فهرست ربات‌ها را ببینی، یا سؤالت را برای تیم بفرستی.',
      kb: [[btn('🤖 همه‌ی ربات‌ها', 'b')], [btn('✉️ سؤالم را برای تیم بفرست', 'qt')]],
      bots: [],
      engine: 'none',
      unknown: true,
    };
  }
  ans.kb.push([btn('🏠 منوی اصلی', 'm')]);
  for (const k of ans.bots.slice(0, 1)) await recordView(user.user_id, k);
  await setState(user.user_id, 'q_pending', { q: truncate(text, 1500), bot: ans.bots[0] || null });
  return ans;
}
