/*
 * Social features at work (Phase 8). Panels: ui/panel_social.js; questions and appeals: the qa section below.
 *
 * onMessage(): every group message that passed the checks counts for the stats (stats_on) and earns
 *   points (pts_on: pts_msg points at most every pts_gap seconds, texts of 3+ characters or media;
 *   a reply that only thanks gives its author the points instead — the giver at most once a minute);
 *   level-ups and new badges are announced (pts_announce); running contests count messages (activity)
 *   or check the answer (quiz); replies in a channel's discussion group count as comments on its post.
 * command(): /me (level, points, rank, badges), /top (leaderboard) — members; /give /take N — admins.
 * callback(): ct:<id>:j joins a raffle.
 * Polls: sendPoll() (panel), onPoll() / onPollAnswer() keep the results; reactions on channel posts
 *   (message_reaction_count) are kept for the analytics.
 * sweep() (at most once a minute): contests whose time is up are ended and their winners announced;
 *   polls past their end are marked closed (Telegram closes them itself).
 */
import { APPEAL_MAX, CONTEST_ENTRIES_MAX, NOTIFY_ADMINS_MAX, QUESTION_GAP_SEC, QUESTION_MAX, TOP_N } from '../config.js';
import * as audit from '../core/audit.js';
import { answer, btn, call, me, send, tryCall, urlBtn } from '../core/tg.js';
import { asciiDigits, localMinutes, tzOf } from '../core/clock.js';
import { contentOf } from '../core/content.js';
import { autoEmoji, earned, isThanks, levelOf, pointsFor } from '../core/levels.js';
import { esc, fullName, iso, normalizeWord, nowSec, short, toInt } from '../core/util.js';
import { appeals, badges, contests, polls, questions, stats } from '../engines/social.js';
import * as chats from '../engines/chats.js';
import * as logs from '../engines/logs.js';
import * as posts from '../engines/posts.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, num, pickLang, t, wordCommand } from '../i18n/index.js';
import { isAdmin } from './enforce.js';
import * as state from '../core/state.js';
import * as admins from '../engines/admins.js';
import * as punish from '../engines/punish.js';
import { removeKeyboard } from './guard.js';

const flag = settings.flag;
const inChat = (m) => !!m && (['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member === true));
const isContent = (m) => !!(m.text || m.caption || contentOf(m).kind !== 'other' || m.poll || m.contact || m.location || m.dice);
const reply = (message) => ({ reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
const BADGE_CHECK = new Set([1, 100, 1000, 10000]);

/* ---------- messages ---------- */

export async function onMessage(ctx, chat, message) {
  if (!chat || !Number(chat.registered) || chat.type === 'channel' || ctx.quiet) return;
  const rep = message.reply_to_message;
  const origin = rep && rep.forward_origin;
  if (Number(chat.linked_id) && rep && rep.is_automatic_forward && origin && origin.type === 'channel' && origin.message_id) {
    await posts.addComment(Number(chat.linked_id), Number(origin.message_id));
  }
  const user = message.from;
  if (!user || user.is_bot || message.sender_chat || !isContent(message)) return;
  const c = chat.chat_id;
  const s = await settings.all(ctx, c);
  const now = nowSec();
  let m = null;
  if (flag(s, 'stats_on') || flag(s, 'pts_on')) {
    const media = contentOf(message).kind !== 'text';
    m = await stats.count(c, user.id, { media, hour: Math.floor(localMinutes(now, tzOf(s.tz, chat.lang)) / 60), now });
  }
  if (flag(s, 'pts_on') && m) {
    const text = message.text || message.caption || '';
    const to = rep && rep.from;
    if (flag(s, 'pts_thanks') && to && !to.is_bot && to.id !== user.id && isThanks(text)) {
      await users.remember(to);
      const r = await stats.thank(c, user.id, to.id, Number(s.pts_msg), now);
      if (r) await afterPoints(ctx, chat, s, to, r, true);
    } else if ([...text.trim()].length >= 3 || contentOf(message).kind !== 'text') {
      const r = await stats.earn(c, user.id, Number(s.pts_msg), Number(s.pts_gap), now);
      if (r) await afterPoints(ctx, chat, s, user, r, BADGE_CHECK.has(Number(m.messages)) || [7, 30].includes(Number(m.streak)) || Number(m.messages) % 50 === 0);
    }
  }
  for (const row of await contests.live(c)) {
    if (Number(row.ends_at) <= now) continue;
    if (row.kind === 'raffle') continue;
    await contests.tally(row.id, user.id); /* activity: messages; quiz: attempts (who took part) */
    if (row.kind === 'quiz' && normalizeWord(message.text || '') === normalizeWord(row.answer || '')) {
      await users.remember(user);
      await endContest(ctx, chat, row, 0, [user.id], message);
    }
  }
}

/* A level-up or new badges are announced in the group (pts_announce). */
async function afterPoints(ctx, chat, s, user, r, checkBadges) {
  const c = chat.chat_id;
  const fresh = [];
  if (checkBadges || levelOf(r.after) > levelOf(r.before)) {
    const m = await stats.member(c, user.id);
    for (const code of earned(m, nowSec())) if (await badges.award(c, user.id, code)) fresh.push(code);
  }
  if (!flag(s, 'pts_announce')) return;
  const lang = chat.lang;
  const lines = [];
  if (levelOf(r.after) > levelOf(r.before)) lines.push(t(lang, 'soc.level_up', { user: iso(fullName(user)), level: num(lang, levelOf(r.after)) }));
  for (const code of fresh) lines.push(t(lang, 'soc.badge_new', { user: iso(fullName(user)), badge: `${autoEmoji(code)} ${t(lang, `soc.b_${code}`)}` }));
  if (lines.length) await send(ctx, c, lines.join('\n'), null, 'soc-announce');
}

/* ---------- member and admin commands ---------- */

const SLASH = ['me', 'top', 'give', 'take'];

export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 200) return null;
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) return SLASH.includes(m[1].toLowerCase()) ? { cmd: m[1].toLowerCase(), args: tokens.slice(1), mention: m[2] ? m[2].toLowerCase() : null } : null;
  /* Words only as the whole message ("my points"), or with the number for give/take ("give points 10"), so chat is never taken for a command. */
  const whole = wordCommand('soccmd', s);
  if (whole) return { cmd: whole, args: [], mention: null };
  const tail = asciiDigits(tokens[tokens.length - 1]);
  const last = tokens.length > 1 && /^\d{1,4}$/.test(tail) ? wordCommand('soccmd', tokens.slice(0, -1).join(' ')) : null;
  return last === 'give' || last === 'take' ? { cmd: last, args: [tail], mention: null } : null;
}

/* A member's card: level and progress, points and rank, messages, thanks, streak, badges. */
export async function card(lang, chat, userId, name) {
  const c = chat.chat_id;
  const m = (await stats.member(c, userId)) || { points: 0, messages: 0, thanks_got: 0, streak: 0 };
  const lvl = levelOf(m.points);
  const next = pointsFor(lvl + 1);
  const owned = await badges.of(c, userId);
  const defs = new Map((await badges.defs(c)).map((d) => [`c${d.id}`, d]));
  const shown = owned.map((b) => (defs.has(b.code) ? `${defs.get(b.code).emoji} ${esc(defs.get(b.code).name)}` : `${autoEmoji(b.code)} ${t(lang, `soc.b_${b.code}`)}`));
  return [t(lang, 'soc.card_title', { user: iso(name), title: iso(chat.title || '', 40) }),
    t(lang, 'soc.card_level', { level: num(lang, lvl), points: num(lang, Number(m.points)), next: num(lang, next) }),
    t(lang, 'soc.card_rank', { rank: num(lang, await stats.rank(c, Number(m.points))) }),
    t(lang, 'soc.card_activity', { messages: num(lang, Number(m.messages)), thanks: num(lang, Number(m.thanks_got)), streak: num(lang, Number(m.streak)) }),
    shown.length ? t(lang, 'soc.card_badges', { list: shown.join(t(lang, 'common.sep')) }) : t(lang, 'soc.card_no_badges')].join('\n');
}

export async function leaderboard(lang, chat, s) {
  const by = flag(s, 'pts_on') ? 'points' : 'messages';
  const rows = await stats.top(chat.chat_id, by, TOP_N);
  const lines = [t(lang, by === 'points' ? 'soc.top_points' : 'soc.top_messages', { title: iso(chat.title || '', 40) })];
  if (!rows.length) lines.push(t(lang, 'soc.top_none'));
  const medal = ['🥇', '🥈', '🥉'];
  for (const [i, r] of rows.entries()) {
    const value = by === 'points' ? t(lang, 'soc.top_pts', { n: num(lang, Number(r.points)), level: num(lang, levelOf(r.points)) }) : num(lang, Number(r.messages));
    lines.push(`${medal[i] || `${num(lang, i + 1)}.`} ${iso(await users.displayName(Number(r.user_id)), 32)} — ${value}`);
  }
  return lines.join('\n');
}

export async function command(ctx, message) {
  const parsed = parseCommand(message.text);
  const user = message.from;
  if (!parsed || !user || message.sender_chat) return false;
  const chat = await chats.get(message.chat.id);
  if (!chat || !Number(chat.registered)) return false;
  if (parsed.mention && parsed.mention !== String((await me(ctx)).username).toLowerCase()) return true;
  const s = await settings.all(ctx, chat.chat_id);
  const lang = chat.lang;
  const admin = await isAdmin(chat.chat_id, user.id);
  if (!flag(s, 'stats_on') && !flag(s, 'pts_on')) return parsed.cmd === 'me' || parsed.cmd === 'top';
  if (parsed.cmd === 'me' || parsed.cmd === 'top') {
    if (!flag(s, 'member_cmds') && !admin) return true;
    let text;
    if (parsed.cmd === 'top') text = await leaderboard(lang, chat, s);
    else {
      const target = message.reply_to_message && message.reply_to_message.from && !message.reply_to_message.from.is_bot ? message.reply_to_message.from : user;
      text = await card(lang, chat, target.id, fullName(target));
    }
    await send(ctx, chat.chat_id, text, null, `soc-${parsed.cmd}`, reply(message));
    return true;
  }
  if (!admin) return true;
  if (!flag(s, 'pts_on')) {
    await send(ctx, chat.chat_id, t(lang, 'soc.points_off'), null, 'soc-points-off', reply(message));
    return true;
  }
  const n = toInt(parsed.args.map(asciiDigits).find((a) => /^\d{1,4}$/.test(a)) || '');
  const target = message.reply_to_message && message.reply_to_message.from;
  if (!n || n > 1000 || !target || target.is_bot) {
    await send(ctx, chat.chat_id, t(lang, 'soc.give_usage'), null, 'soc-give-usage', reply(message));
    return true;
  }
  await users.remember(target);
  const r = await stats.adjust(chat.chat_id, target.id, parsed.cmd === 'give' ? n : -n);
  await audit.log(user.id, `points.${parsed.cmd}`, { chatId: chat.chat_id, target: target.id, details: { n, after: r.after } });
  await send(ctx, chat.chat_id, t(lang, parsed.cmd === 'give' ? 'soc.given' : 'soc.taken', { user: iso(fullName(target)), n: num(lang, n), total: num(lang, r.after) }), null,
    `soc-${parsed.cmd}`, reply(message));
  if (parsed.cmd === 'give') await afterPoints(ctx, chat, s, target, r, true);
  return true;
}

/* ---------- contests ---------- */

export function contestText(lang, chat, row) {
  const lines = [t(lang, `soc.ct_head_${row.kind}`, { title: iso(row.title, 120) })];
  if (row.kind === 'quiz') lines.push(t(lang, 'soc.ct_question', { question: iso(row.question || '', 300) }));
  lines.push(t(lang, `soc.ct_rule_${row.kind}`, { n: num(lang, Number(row.winners)) }));
  lines.push(t(lang, 'soc.ct_ends', { time: dur(lang, Math.max(60, Number(row.ends_at) - nowSec())) }));
  return lines.join('\n');
}

/* Posts a drafted contest in its group and starts it. Gives true when it runs. */
export async function publishContest(ctx, chat, row) {
  const lang = chat.lang;
  const rows = row.kind === 'raffle' ? [[btn(t(lang, 'soc.btn_ct_join'), `ct:${row.id}:j`)]] : null;
  const m = await send(ctx, chat.chat_id, contestText(lang, chat, row), rows, 'contest');
  if (!m) return false;
  await audit.log(Number(row.created_by), 'contest.start', { chatId: chat.chat_id, details: { id: Number(row.id), kind: row.kind } });
  return contests.start(row.id, m.message_id);
}

/* Ends a contest once and announces the winners (raffle: drawn; activity: the most messages; quiz: given). */
export async function endContest(ctx, chat, row, byId, given = null, message = null) {
  let winners = given || [];
  if (!given && row.kind === 'raffle') winners = contests.draw((await contests.allEntries(row.id)).map((e) => Number(e.user_id)), Number(row.winners));
  if (!given && row.kind === 'activity') winners = (await contests.leaders(row.id, Number(row.winners))).filter((e) => Number(e.n) > 0).map((e) => Number(e.user_id));
  if (!(await contests.finish(row.id, winners))) return null;
  const lang = chat.lang;
  const names = [];
  for (const id of winners) names.push(iso(await users.displayName(id), 32));
  const n = await contests.entries(row.id);
  const text = winners.length
    ? t(lang, 'soc.ct_winners', { title: iso(row.title, 120), list: names.join(t(lang, 'common.sep')), n: num(lang, n) })
    : t(lang, 'soc.ct_no_winner', { title: iso(row.title, 120), n: num(lang, n) });
  const at = message ? reply(message) : (Number(row.msg_id) ? { reply_parameters: { message_id: Number(row.msg_id), allow_sending_without_reply: true } } : {});
  if (!ctx.quiet) await send(ctx, chat.chat_id, text, null, 'contest-end', at);
  if (Number(row.msg_id) && row.kind === 'raffle') {
    await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: chat.chat_id, message_id: Number(row.msg_id), reply_markup: { inline_keyboard: [] } }, 'contest-close');
  }
  await logs.post(ctx, chat, 'admin', text);
  await audit.log(byId, 'contest.end', { chatId: chat.chat_id, details: { id: Number(row.id), winners } });
  return winners;
}

/* ct:<id>:j — a member joins a raffle. */
export async function callback(ctx, cq, parts) {
  const from = cq.from;
  const u = await users.get(from.id);
  const lang = u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
  const row = await contests.get(toInt(parts[1]));
  if (!row || row.status !== 'running' || row.kind !== 'raffle' || Number(row.ends_at) <= nowSec()) return answer(ctx, t(lang, 'soc.ct_closed'), true);
  if (from.is_bot) return answer(ctx);
  const m = await tryCall(ctx, 'getChatMember', { chat_id: Number(row.chat_id), user_id: from.id }, 'contest-member');
  if (!inChat(m)) return answer(ctx, t(lang, 'soc.ct_members_only'), true);
  await users.remember(from);
  const r = await contests.enter(row.id, from.id);
  const n = await contests.entries(row.id);
  return answer(ctx, t(lang, `soc.ct_${r}`, { n: num(lang, n), max: num(lang, CONTEST_ENTRIES_MAX) }), r !== 'joined');
}

/* ---------- polls ---------- */

/* Sends a poll (p: question, options, anonymous, multiple, correct, closesAt). Gives the poll row id. */
export async function sendPoll(ctx, chat, p, byId) {
  const quiz = p.correct !== undefined && p.correct >= 0;
  const params = { chat_id: chat.chat_id, question: p.question, options: p.options.map((text) => ({ text })),
    is_anonymous: chat.type === 'channel' ? true : !!p.anonymous, type: quiz ? 'quiz' : 'regular' };
  if (quiz) params.correct_option_ids = [p.correct];
  else if (p.multiple) params.allows_multiple_answers = true;
  if (p.closesAt) params.close_date = p.closesAt;
  const m = await call(ctx, 'sendPoll', params, 'poll');
  const id = await polls.create(chat.chat_id, { ...p, anonymous: params.is_anonymous, msgId: m.message_id, pollId: m.poll ? m.poll.id : null }, byId);
  await audit.log(byId, 'poll.create', { chatId: chat.chat_id, details: { id } });
  return id;
}

export async function onPoll(ctx, poll) {
  if (!poll || !poll.id) return;
  const counts = (poll.options || []).map((o) => Number(o.voter_count) || 0);
  await polls.setCounts(poll.id, counts, Number(poll.total_voter_count) || 0, !!poll.is_closed);
}

export async function onPollAnswer(ctx, a) {
  if (!a || !a.user) return;
  const row = await polls.byPollId(a.poll_id);
  if (!row) return;
  await users.remember(a.user);
  await polls.vote(Number(row.id), a.user.id, a.option_ids || []);
}

/* Reactions on a channel post (anonymous counts). */
export async function onReactionCount(ctx, upd) {
  if (!upd || !upd.chat) return;
  const total = (upd.reactions || []).reduce((n, r) => n + (Number(r.total_count) || 0), 0);
  await posts.setReactions(upd.chat.id, upd.message_id, total);
}

/* ---------- joins, timed work ---------- */

export async function memberChange(chat, joined) {
  if (!chat || chat.type === 'channel' || !Number(chat.registered)) return;
  await stats.bump(chat.chat_id, joined ? 'joins' : 'leaves');
}

export async function sweep(ctx) {
  const now = nowSec();
  for (const row of await contests.due(now)) {
    const chat = await chats.get(Number(row.chat_id));
    if (!chat || !Number(chat.active)) await contests.finish(row.id, [], 'cancelled');
    else await endContest(ctx, chat, row, 0);
  }
  for (const p of await polls.due(now)) await polls.close(Number(p.id));
}

/* ========== qa (was ui/qa.js) ========== */
/*
 * Questions, anonymous Q&A, appeals and the review of decisions (Phase 8). Panel: the panelQa section of ui/panel_social.js.
 *
 * Questions to the admins (qa_on): /ask in a group gives a button to the bot's private chat
 *   (/start q_<chat>); the question goes privately to the admins (who started Aegis) with «Answer»
 *   (the answer goes back privately) and «Close».
 * Anonymous questions (anon_on): /anon → /start a_<chat>; the admins see the question without a name
 *   and «Publish» it in the group (with or without an answer), «Reject» it, or «Block sender» (Full
 *   access; the sender stays unknown to them). One question per member and chat every 5 minutes.
 * Appeals (appeals_on): a punished member appeals once per punishment — from the notice's button
 *   (/start ap_<id>) or /appeal in private (a list of what can be appealed); admins who may ban get
 *   it with «Accept» (the punishment is undone) and «Reject»; the member hears the decision.
 * Review (review_all): punishments given by admins below Full access go to the Full admins with
 *   «Uphold» / «Overturn» (undone; the moderator is told). The panel reviews any decision.
 *
 * callback_data (any chat): qa:<id>:r|x|p|pa|b   apl:<id>:y|n   apc:<punishment>   rv:<punishment>:u|o
 * Pending inputs: qa_input { chat, anon }, qa_reply { id, mode: r | pa }, ap_input { punish }.
 */
export const qa = (() => {
const { L } = admins;
const INPUTS = new Set(['qa_input', 'qa_reply', 'ap_input']);
const KEYBOARD_INPUTS = new Set();
const HEADS = new Set(['qa', 'apl', 'apc', 'rv']);
const flag = settings.flag;
const title = (chat) => iso(chat.title || '', 48);
const inChat = (m) => !!m && (['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member === true));
const APPEALABLE = new Set(['warn', 'mute', 'restrict', 'quarantine', 'ban', 'blacklist']);

async function langOf(from) {
  const u = await users.get(from.id);
  return u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
}

const reachable = async (id) => {
  const u = await users.get(id);
  return u && Number(u.started) && !Number(u.blocked) ? u : null;
};

/* Admins of a chat who can be told privately, filtered by `need` (a member → bool), at most NOTIFY_ADMINS_MAX. */
async function adminsFor(chatId, need) {
  const rows = await admins.listRows(chatId);
  const ov = await admins.overrides(chatId);
  const out = [];
  for (const r of rows) {
    if (Number(r.is_bot)) continue;
    const m = admins.memberOfRow(r);
    const o = ov.get(Number(r.user_id));
    if (admins.effectiveLevel(m, o ? o.level : null) < L.view || !need(m, admins.effectiveLevel(m, o ? o.level : null))) continue;
    const u = await reachable(Number(r.user_id));
    if (u) out.push(u);
    if (out.length >= NOTIFY_ADMINS_MAX) break;
  }
  return out;
}

const canBan = (m) => !!m && (m.status === 'creator' || m.can_restrict_members === true);

async function dropButtons(ctx, msg) {
  if (msg && msg.reply_markup) await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, 'drop-buttons');
}

/* ---------- group commands: /ask /anon ---------- */

function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 100) return null;
  const m = /^\/(ask|anon)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(s);
  if (m) return { cmd: m[1].toLowerCase(), mention: m[2] ? m[2].toLowerCase() : null };
  const w = wordCommand('qacmd', s);
  return w ? { cmd: w, mention: null } : null;
}

async function command(ctx, message) {
  const parsed = parseCommand(message.text);
  if (!parsed || !message.from || message.sender_chat) return false;
  const chat = await chats.get(message.chat.id);
  if (!chat || !Number(chat.registered)) return false;
  const bot = (await me(ctx)).username;
  if (parsed.mention && parsed.mention !== String(bot).toLowerCase()) return true;
  const s = await settings.all(ctx, chat.chat_id);
  const anon = parsed.cmd === 'anon';
  if (!flag(s, anon ? 'anon_on' : 'qa_on')) return true;
  const rows = [[urlBtn(t(chat.lang, anon ? 'qa.btn_anon' : 'qa.btn_ask'), `https://t.me/${bot}?start=${anon ? 'a' : 'q'}_${chat.chat_id}`)]];
  await send(ctx, chat.chat_id, t(chat.lang, anon ? 'qa.group_anon' : 'qa.group_ask', { title: title(chat) }), rows, `qa-${parsed.cmd}`,
    { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
  return true;
}

/* The «Ask us» buttons for the group (posted from the panel). */
async function postButtons(ctx, chat, s) {
  const bot = (await me(ctx)).username;
  const row = [];
  if (flag(s, 'qa_on')) row.push(urlBtn(t(chat.lang, 'qa.btn_ask'), `https://t.me/${bot}?start=q_${chat.chat_id}`));
  if (flag(s, 'anon_on')) row.push(urlBtn(t(chat.lang, 'qa.btn_anon'), `https://t.me/${bot}?start=a_${chat.chat_id}`));
  if (!row.length) return null;
  return send(ctx, chat.chat_id, t(chat.lang, 'qa.buttons_text', { title: title(chat) }), [row], 'qa-buttons');
}

/* ---------- questions (private chat) ---------- */

/* /start q_<chat> or a_<chat>: asks for the question. */
async function startQuestion(ctx, user, chatId, anon) {
  const lang = user.lang;
  const chat = await chats.get(chatId);
  const say = (key, vars = {}) => send(ctx, user.user_id, t(lang, key, vars), null, `qa-${key}`);
  if (!chat || !Number(chat.registered) || !Number(chat.active) || chat.type === 'channel') return say('qa.gone');
  const s = await settings.all(ctx, chatId);
  if (!flag(s, anon ? 'anon_on' : 'qa_on')) return say('qa.off', { title: title(chat) });
  const m = await tryCall(ctx, 'getChatMember', { chat_id: chatId, user_id: user.user_id }, 'qa-member');
  if (!inChat(m)) return say('qa.members_only', { title: title(chat) });
  if (anon && await questions.blocked(chatId, user.user_id)) return say('qa.blocked');
  const last = await questions.lastAt(chatId, user.user_id);
  if (last > nowSec() - QUESTION_GAP_SEC) return say('qa.wait', { time: dur(lang, last + QUESTION_GAP_SEC - nowSec()) });
  await state.set(user.user_id, 'qa_input', { chat: chatId, anon: !!anon });
  return say(anon ? 'qa.prompt_anon' : 'qa.prompt', { title: title(chat), max: QUESTION_MAX });
}

const qaRows = (lang, q) => (Number(q.anon)
  ? [[btn(t(lang, 'qa.btn_publish'), `qa:${q.id}:p`), btn(t(lang, 'qa.btn_publish_answer'), `qa:${q.id}:pa`)],
    [btn(t(lang, 'qa.btn_reject'), `qa:${q.id}:x`), btn(t(lang, 'qa.btn_block'), `qa:${q.id}:b`)]]
  : [[btn(t(lang, 'qa.btn_answer'), `qa:${q.id}:r`), btn(t(lang, 'qa.btn_close'), `qa:${q.id}:x`)]]);

async function notifyQuestion(ctx, chat, q) {
  let n = 0;
  const asker = Number(q.anon) ? null : await users.displayName(Number(q.user_id));
  for (const u of await adminsFor(chat.chat_id, () => true)) {
    const text = Number(q.anon)
      ? t(u.lang, 'qa.admin_anon', { title: title(chat), text: iso(q.text, QUESTION_MAX) })
      : t(u.lang, 'qa.admin_question', { title: title(chat), user: iso(asker, 40), text: iso(q.text, QUESTION_MAX) });
    if (await send(ctx, Number(u.user_id), text, qaRows(u.lang, q), 'qa-admin')) n += 1;
  }
  return n;
}

/* qa:<id>:… — an admin acts on a question. */
async function questionPress(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const q = await questions.get(toInt(parts[1]));
  const chat = q ? await chats.get(Number(q.chat_id)) : null;
  if (!q || !chat) return answer(ctx, t(lang, 'qa.gone'), true);
  const act = parts[2];
  const acc = await admins.liveAccess(ctx, chat.chat_id, from.id);
  const need = act === 'b' ? L.full : (act === 'p' || act === 'pa' ? L.settings : L.view);
  if (!acc.member || acc.level < need) return answer(ctx, t(lang, 'qa.denied'), true);
  if (q.status !== 'open') {
    await dropButtons(ctx, cq.message);
    return answer(ctx, t(lang, 'qa.done_already'), true);
  }
  if (act === 'r' || act === 'pa') {
    await state.set(from.id, 'qa_reply', { id: Number(q.id), mode: act });
    await answer(ctx);
    return send(ctx, from.id, t(lang, 'qa.reply_prompt', { title: title(chat) }), null, 'qa-reply-ask');
  }
  if (act === 'p') {
    const m = await send(ctx, chat.chat_id, t(chat.lang, 'qa.published', { text: iso(q.text, QUESTION_MAX) }), null, 'qa-published');
    if (!m || !(await questions.settle(q.id, 'published', from.id, null, m.message_id))) return answer(ctx, t(lang, 'qa.failed'), true);
    await tellAsker(ctx, chat, q, 'qa.asker_published');
  } else if (act === 'x') {
    if (!(await questions.settle(q.id, Number(q.anon) ? 'rejected' : 'closed', from.id))) return answer(ctx, t(lang, 'qa.done_already'), true);
    if (Number(q.anon)) await tellAsker(ctx, chat, q, 'qa.asker_rejected');
  } else if (act === 'b') {
    await questions.block(chat.chat_id, Number(q.user_id), from.id);
    await questions.settle(q.id, 'rejected', from.id);
    await audit.log(from.id, 'qa.block', { chatId: chat.chat_id, details: { question: Number(q.id) } });
  } else return answer(ctx);
  await audit.log(from.id, `qa.${act === 'p' ? 'publish' : (act === 'b' ? 'reject' : 'close')}`, { chatId: chat.chat_id, details: { id: Number(q.id) } });
  await dropButtons(ctx, cq.message);
  return answer(ctx, t(lang, `qa.done_${act}`), true);
}

async function tellAsker(ctx, chat, q, key, vars = {}) {
  const u = await reachable(Number(q.user_id));
  if (u) await send(ctx, Number(u.user_id), t(u.lang, key, { title: title(chat), ...vars }), null, 'qa-asker');
}

/* ---------- appeals ---------- */

/* /appeal (or «اعتراض») in private: what can be appealed, or (punishId) straight to the reason. */
async function startAppeal(ctx, user, punishId = null) {
  const lang = user.lang;
  if (punishId) return askAppeal(ctx, user, punishId);
  const list = [];
  for (const p of await appeals.appealable(user.user_id)) {
    const chat = await chats.get(Number(p.chat_id));
    if (chat && flag(await settings.all(ctx, chat.chat_id), 'appeals_on')) list.push({ p, chat });
  }
  if (!list.length) return send(ctx, user.user_id, t(lang, 'qa.ap_none'), null, 'appeal-none');
  const rows = list.map(({ p, chat }) => [btn(`${t(lang, `pun.k_${p.kind}`)} · ${short(chat.title || '', 24)}`, `apc:${p.id}`)]);
  return send(ctx, user.user_id, t(lang, 'qa.ap_choose'), rows, 'appeal-list');
}

async function askAppeal(ctx, user, punishId) {
  const lang = user.lang;
  const p = await punish.get(punishId);
  const chat = p ? await chats.get(Number(p.chat_id)) : null;
  const say = (key, vars = {}) => send(ctx, user.user_id, t(lang, key, vars), null, `appeal-${key}`);
  if (!p || !chat || Number(p.user_id) !== user.user_id || !APPEALABLE.has(p.kind) || !punish.isActive(p)) return say('qa.ap_gone');
  if (!flag(await settings.all(ctx, chat.chat_id), 'appeals_on')) return say('qa.ap_off', { title: title(chat) });
  if (await appeals.ofPunishment(punishId)) return say('qa.ap_once');
  await state.set(user.user_id, 'ap_input', { punish: Number(punishId) });
  return say('qa.ap_prompt', { kind: t(lang, `pun.k_${p.kind}`), title: title(chat), max: APPEAL_MAX });
}

const apRows = (lang, id) => [[btn(t(lang, 'qa.btn_ap_accept'), `apl:${id}:y`), btn(t(lang, 'qa.btn_ap_reject'), `apl:${id}:n`)]];

async function notifyAppeal(ctx, chat, ap, p) {
  let n = 0;
  const who = iso(await users.displayName(Number(ap.user_id)), 40);
  const by = Number(p.actor_id) ? iso(await users.displayName(Number(p.actor_id)), 40) : null;
  for (const u of await adminsFor(chat.chat_id, canBan)) {
    const lines = [t(u.lang, 'qa.ap_admin', { title: title(chat), user: who, kind: t(u.lang, `pun.k_${p.kind}`) }),
      t(u.lang, 'qa.ap_by', { by: by || t(u.lang, 'log.system') })];
    if (p.reason) lines.push(t(u.lang, 'pun.notice_reason', { reason: iso(p.reason, 200) }));
    lines.push(t(u.lang, 'qa.ap_text', { text: iso(ap.text, APPEAL_MAX) }));
    if (await send(ctx, Number(u.user_id), lines.join('\n'), apRows(u.lang, ap.id), 'appeal-admin')) n += 1;
  }
  return n;
}

/* Accepts (undoes the punishment) or rejects an appeal, once. Gives accepted, rejected, done or an error text. */
async function decideAppeal(ctx, chat, ap, accept, byId) {
  if (ap.status !== 'open') return 'done';
  if (accept) {
    const r = await punish.undo(ctx, chat, Number(ap.punish_id), byId);
    if (r !== 'ok' && r !== 'not_active') return typeof r === 'object' ? r.error : r;
  }
  if (!(await appeals.decide(ap.id, accept ? 'accepted' : 'rejected', byId))) return 'done';
  await audit.log(byId, accept ? 'appeal.accepted' : 'appeal.rejected', { chatId: chat.chat_id, target: Number(ap.user_id), details: { id: Number(ap.id) } });
  const u = await reachable(Number(ap.user_id));
  if (u) await send(ctx, Number(u.user_id), t(u.lang, accept ? 'qa.ap_member_accepted' : 'qa.ap_member_rejected', { title: title(chat) }), null, 'appeal-member');
  return accept ? 'accepted' : 'rejected';
}

async function appealPress(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const ap = await appeals.get(toInt(parts[1]));
  const chat = ap ? await chats.get(Number(ap.chat_id)) : null;
  if (!ap || !chat) return answer(ctx, t(lang, 'qa.gone'), true);
  const acc = await admins.liveAccess(ctx, chat.chat_id, from.id);
  if (!acc.member || acc.level < L.view || !canBan(acc.member)) return answer(ctx, t(lang, 'qa.ap_denied'), true);
  const r = await decideAppeal(ctx, chat, ap, parts[2] === 'y', from.id);
  await dropButtons(ctx, cq.message);
  if (r === 'accepted' || r === 'rejected' || r === 'done') return answer(ctx, t(lang, `qa.ap_${r}`), true);
  return answer(ctx, t(lang, 'pun.undo_failed', { error: esc(r) }), true);
}

/* ---------- review ---------- */

/* A punishment by an admin below Full access goes to the Full admins for review (review_all). */
async function reviewRequest(ctx, chat, res, actorId) {
  if (!res || !res.ok || res.auditOnly || !actorId || ctx.quiet) return 0;
  const s = await settings.all(ctx, chat.chat_id);
  if (!flag(s, 'review_all')) return 0;
  const row = await admins.getRow(chat.chat_id, actorId);
  const level = row ? admins.effectiveLevel(admins.memberOfRow(row), await admins.overrideOf(chat.chat_id, actorId)) : L.none;
  if (level >= L.full) return 0;
  const p = res.row;
  const by = iso(await users.displayName(actorId), 40);
  const target = iso(await users.displayName(Number(p.user_id)), 40);
  let n = 0;
  for (const u of await adminsFor(chat.chat_id, (m, lvl) => lvl >= L.full)) {
    if (Number(u.user_id) === actorId) continue;
    const lines = [t(u.lang, 'qa.rv_admin', { title: title(chat), by, target, kind: t(u.lang, `pun.k_${p.kind}`) })];
    if (p.reason) lines.push(t(u.lang, 'pun.notice_reason', { reason: iso(p.reason, 200) }));
    const rows = [[btn(t(u.lang, 'qa.btn_uphold'), `rv:${p.id}:u`), btn(t(u.lang, 'qa.btn_overturn'), `rv:${p.id}:o`)]];
    if (await send(ctx, Number(u.user_id), lines.join('\n'), rows, 'review-admin')) n += 1;
  }
  return n;
}

/* Upholds or overturns (undoes) a decision, once. Gives upheld, overturned, done or an error text. */
async function decideReview(ctx, chat, punishId, overturn, byId) {
  const p = await punish.get(punishId);
  if (!p || Number(p.chat_id) !== chat.chat_id) return 'done';
  if (await appeals.reviewOf(punishId)) return 'done';
  if (overturn) {
    const r = await punish.undo(ctx, chat, punishId, byId);
    if (r !== 'ok' && r !== 'not_active' && r !== 'not_undoable') return typeof r === 'object' ? r.error : r;
  }
  if (!(await appeals.review(chat.chat_id, punishId, byId, overturn ? 'overturned' : 'upheld'))) return 'done';
  await audit.log(byId, overturn ? 'review.overturned' : 'review.upheld', { chatId: chat.chat_id, target: Number(p.user_id), details: { id: punishId } });
  if (overturn && Number(p.actor_id) && Number(p.actor_id) !== byId) {
    const u = await reachable(Number(p.actor_id));
    if (u) {
      await send(ctx, Number(u.user_id), t(u.lang, 'qa.rv_moderator', { title: title(chat), kind: t(u.lang, `pun.k_${p.kind}`),
        target: iso(await users.displayName(Number(p.user_id)), 40), by: iso(await users.displayName(byId), 40) }), null, 'review-moderator');
    }
  }
  return overturn ? 'overturned' : 'upheld';
}

async function reviewPress(ctx, cq, parts) {
  const from = cq.from;
  const lang = await langOf(from);
  const p = await punish.get(toInt(parts[1]));
  const chat = p ? await chats.get(Number(p.chat_id)) : null;
  if (!p || !chat) return answer(ctx, t(lang, 'qa.gone'), true);
  const acc = await admins.liveAccess(ctx, chat.chat_id, from.id);
  if (!acc.member || acc.level < L.full) return answer(ctx, t(lang, 'qa.rv_denied'), true);
  const r = await decideReview(ctx, chat, Number(p.id), parts[2] === 'o', from.id);
  await dropButtons(ctx, cq.message);
  if (['upheld', 'overturned', 'done'].includes(r)) return answer(ctx, t(lang, `qa.rv_${r}`), true);
  return answer(ctx, t(lang, 'pun.undo_failed', { error: esc(r) }), true);
}

/* ---------- buttons and inputs ---------- */

async function callback(ctx, cq, parts) {
  if (parts[0] === 'qa') return questionPress(ctx, cq, parts);
  if (parts[0] === 'apl') return appealPress(ctx, cq, parts);
  if (parts[0] === 'rv') return reviewPress(ctx, cq, parts);
  /* apc:<punishment> — the member chose what to appeal (private chat) */
  const from = cq.from;
  const user = await users.get(from.id);
  await answer(ctx);
  if (!user) return null;
  return askAppeal(ctx, user, toInt(parts[1]));
}

async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const d = pending.data;
  const again = (key, vars = {}) => send(ctx, user.user_id, t(lang, key, vars), null, `qa-${key}-again`);
  if (pending.kind === 'qa_input') {
    if (!text || [...text].length > QUESTION_MAX) return again('qa.too_long', { max: QUESTION_MAX });
    await state.clear(user.user_id);
    const chat = await chats.get(Number(d.chat));
    if (!chat) return again('qa.gone');
    const id = await questions.add(chat.chat_id, user.user_id, text, d.anon);
    await audit.log(d.anon ? 0 : user.user_id, d.anon ? 'qa.anon' : 'qa.ask', { chatId: chat.chat_id, details: { id } });
    const n = await notifyQuestion(ctx, chat, await questions.get(id));
    return send(ctx, user.user_id, t(lang, n ? (d.anon ? 'qa.sent_anon' : 'qa.sent') : 'qa.sent_none', { title: title(chat) }), null, 'qa-sent');
  }
  if (pending.kind === 'qa_reply') {
    const q = await questions.get(Number(d.id));
    const chat = q ? await chats.get(Number(q.chat_id)) : null;
    if (!q || !chat || q.status !== 'open') {
      await state.clear(user.user_id);
      return again('qa.done_already');
    }
    const acc = await admins.liveAccess(ctx, chat.chat_id, user.user_id);
    if (!acc.member || acc.level < (d.mode === 'pa' ? L.settings : L.view)) {
      await state.clear(user.user_id);
      return again('qa.denied');
    }
    if (!text || [...text].length > QUESTION_MAX) return again('qa.too_long', { max: QUESTION_MAX });
    await state.clear(user.user_id);
    if (d.mode === 'pa') {
      const m = await send(ctx, chat.chat_id, t(chat.lang, 'qa.published_answer', { text: iso(q.text, QUESTION_MAX), answer: iso(text, QUESTION_MAX) }), null, 'qa-published');
      if (!m || !(await questions.settle(q.id, 'published', user.user_id, text, m.message_id))) return again('qa.failed');
      await tellAsker(ctx, chat, q, 'qa.asker_published');
    } else {
      if (!(await questions.settle(q.id, 'answered', user.user_id, text))) return again('qa.done_already');
      await tellAsker(ctx, chat, q, 'qa.asker_answer', { answer: iso(text, QUESTION_MAX) });
    }
    await audit.log(user.user_id, 'qa.answer', { chatId: chat.chat_id, details: { id: Number(q.id) } });
    return send(ctx, user.user_id, t(lang, 'qa.reply_sent'), null, 'qa-reply-sent');
  }
  if (pending.kind === 'ap_input') {
    const p = await punish.get(Number(d.punish));
    const chat = p ? await chats.get(Number(p.chat_id)) : null;
    if (!p || !chat || !punish.isActive(p)) {
      await state.clear(user.user_id);
      return again('qa.ap_gone');
    }
    if (!text || [...text].length > APPEAL_MAX) return again('qa.too_long', { max: APPEAL_MAX });
    await state.clear(user.user_id);
    const id = await appeals.add(chat.chat_id, Number(p.id), user.user_id, text);
    if (!id) return again('qa.ap_once');
    await audit.log(user.user_id, 'appeal.new', { chatId: chat.chat_id, details: { id, punishment: Number(p.id) } });
    const n = await notifyAppeal(ctx, chat, await appeals.get(id), p);
    return send(ctx, user.user_id, t(lang, n ? 'qa.ap_sent' : 'qa.ap_sent_none', { title: title(chat) }), null, 'appeal-sent');
  }
  await state.clear(user.user_id);
  return null;
}

/* The appeal button under a punishment notice (when appeals are on). */
async function appealButton(ctx, chat, res, lang) {
  if (!res || !res.ok || res.auditOnly || !APPEALABLE.has(res.row.kind)) return null;
  if (!flag(await settings.all(ctx, chat.chat_id), 'appeals_on')) return null;
  return urlBtn(t(lang, 'qa.btn_appeal'), `https://t.me/${(await me(ctx)).username}?start=ap_${res.id}`);
}

  return { INPUTS, KEYBOARD_INPUTS, HEADS, APPEALABLE, parseCommand, command, postButtons, startQuestion, startAppeal, decideAppeal, reviewRequest,
    decideReview, callback, input, appealButton };
})();
