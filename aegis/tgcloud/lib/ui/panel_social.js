/*
 * A chat's panel, Phase 8 part 1: statistics (with CSV exports), points and badges, contests and
 * polls. Behaviour: ui/social.js. Viewing needs View; changes Settings; resetting points Full.
 *
 * callback_data (chat id c):
 *   g:c:st[:s:<key>|:d|:m]      statistics; CSV of the days / of the members
 *   g:c:pt[:s:<key>]            points settings, leaderboard, the group's own badges
 *   g:c:pt:bn                   new badge (input)        g:c:pt:bd:<id>[:y]   remove a badge → confirm
 *   g:c:pt:ba:<id>              award a badge (input: the member)         g:c:pt:r[:y]   reset all points → confirm
 *   g:c:ct                      contests                 g:c:ct:n:<kind>      new contest (inputs)
 *   g:c:ct:d:<id>:t|w|go|x      a draft: duration, winners, publish, discard
 *   g:c:ct:i:<id>[:e|:ey|:c]    a contest: end now → confirm, cancel
 *   g:c:pl                      polls                    g:c:pl:n             new poll (inputs)
 *   g:c:pl:o:<a|m|q|t|c:<i>>    the draft's options: anonymous, multiple, quiz, time, the right answer
 *   g:c:pl:go                   send it                  g:c:pl:i:<id>[:s|:v] a poll: stop, voters CSV
 * Pending inputs: soc_input { chat, key, id?, step?, data? } — badge, award, contest, poll.
 */
import { InputFile } from 'sdk';
import { BADGE_NAME_MAX, CONTEST_ANSWER_MAX, CONTEST_TITLE_MAX, POLL_OPTION_MAX, POLL_OPTIONS_MAX, POLL_QUESTION_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import { csv, esc, iso, isoMinute, normalizeWord, nowSec, parseJson, short, toInt, utf8Bytes } from '../core/util.js';
import { healthScore, levelOf } from '../core/levels.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send, tryCall } from '../core/tg.js';
import * as admins from '../engines/admins.js';
import { appeals, badges, contests, polls, questions, stats } from '../engines/social.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';
import { settingBtn, toggle } from './panel_channel.js';
import { endContest, publishContest, qa, sendPoll } from './social.js';
import * as punish from '../engines/punish.js';
import { tzLabel, tzOf } from '../core/clock.js';
import * as channels from '../engines/channels.js';
import * as chats from '../engines/chats.js';
import * as crisis from '../engines/crisis.js';
import * as posts from '../engines/posts.js';
import { postLink } from './channel.js';

const { L } = admins;
export const INPUTS = new Set(['soc_input']);
export const KEYBOARD_INPUTS = new Set(['soc_input']);
const title = (g) => iso(g.chat.title || '', 48);
const DURS = [3600, 86400, 3 * 86400, 7 * 86400];
const WINNERS = [1, 3, 5, 10];
const POLL_DURS = [0, 3600, 86400, 3 * 86400, 7 * 86400];
const fmtDay = (day) => isoMinute(day * 86400).slice(0, 10);

async function sendCsv(ctx, user, rows, name) {
  await tryCall(ctx, 'sendDocument', { chat_id: user.user_id, document: new InputFile(utf8Bytes(csv(rows)), name, { type: 'text/csv' }) }, 'export');
}

/* ---------- statistics ---------- */

async function statsScreen(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const now = nowSec();
  const d1 = await stats.sum(c, 1);
  const d7 = await stats.sum(c, 7);
  const d30 = await stats.sum(c, 30);
  const lines = [t(lang, 'soc.st_title', { title: title(g) }), ''];
  if (!settings.flag(s, 'stats_on')) lines.push(t(lang, 'soc.st_off'), '');
  lines.push(t(lang, 'soc.st_messages', { d1: num(lang, d1.messages), d7: num(lang, d7.messages), d30: num(lang, d30.messages) }));
  lines.push(t(lang, 'soc.st_active', { d1: num(lang, await stats.activeSince(c, 1)), d7: num(lang, await stats.activeSince(c, 7)), d30: num(lang, await stats.activeSince(c, 30)) }));
  lines.push(t(lang, 'soc.st_media', { n: num(lang, d30.media), pct: num(lang, d30.messages ? Math.round((d30.media / d30.messages) * 100) : 0) }));
  lines.push(t(lang, 'soc.st_members', { joins: num(lang, d7.joins), leaves: num(lang, d7.leaves) }));
  lines.push(t(lang, 'soc.st_moderation', { n: num(lang, await appeals.decisionsCount(c, now - 30 * 86400)) }));
  const hrs = (await stats.hours(c)).slice(0, 3);
  if (hrs.length) lines.push(t(lang, 'soc.st_hours', { list: hrs.map((h) => `${String(h.hour).padStart(2, '0')}:00`).join(t(lang, 'common.sep')) }));
  const days = await stats.days(c, 7);
  if (days.length) {
    lines.push('', t(lang, 'soc.st_days'));
    for (const d of days) lines.push(t(lang, 'soc.st_day', { day: fmtDay(Number(d.day)), messages: num(lang, Number(d.messages)), active: num(lang, Number(d.active)),
      joins: num(lang, Number(d.joins)), leaves: num(lang, Number(d.leaves)) }));
  }
  const top = await stats.top(c, 'messages', 5);
  if (top.length) {
    lines.push('', t(lang, 'soc.st_top'));
    for (const [i, r] of top.entries()) lines.push(`${num(lang, i + 1)}. ${iso(await users.displayName(Number(r.user_id)), 32)} — ${num(lang, Number(r.messages))}`);
  }
  const kb = [[settingBtn(lang, c, s, 'stats_on', 'st')], [btn(t(lang, 'soc.btn_csv_days'), `g:${c}:st:d`), btn(t(lang, 'soc.btn_csv_members'), `g:${c}:st:m`)],
    back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-stats');
}

async function statsAction(ctx, user, g, parts, place) {
  const c = g.chat.chat_id;
  const a = parts[3];
  if (a === 's') await toggle(ctx, user, g, parts[4]);
  if (a === 'd' || a === 'm') {
    await answer(ctx, t(user.lang, 'soc.csv_sent'));
    if (a === 'd') {
      const rows = [['date', 'messages', 'media', 'active', 'joins', 'leaves']];
      for (const d of await stats.days(c, 90)) rows.push([fmtDay(Number(d.day)), d.messages, d.media, d.active, d.joins, d.leaves]);
      await sendCsv(ctx, user, rows, `aegis-stats-${String(c).replace('-', '')}.csv`);
    } else {
      const rows = [['user_id', 'name', 'username', 'messages', 'points', 'level', 'thanks', 'streak', 'first_seen', 'last_seen']];
      for (const m of await stats.members(c)) {
        const u = await users.get(Number(m.user_id));
        rows.push([m.user_id, u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : '', u && u.username ? `@${u.username}` : '', m.messages, m.points,
          levelOf(m.points), m.thanks_got, m.streak, Number(m.first_at) ? isoMinute(Number(m.first_at)) : '', Number(m.last_at) ? isoMinute(Number(m.last_at)) : '']);
      }
      await sendCsv(ctx, user, rows, `aegis-members-${String(c).replace('-', '')}.csv`);
    }
    await audit.log(user.user_id, 'stats.export', { chatId: c, details: { what: a } });
    return null;
  }
  return statsScreen(ctx, user, g, place);
}

/* ---------- points and badges ---------- */

async function pointsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'soc.pt_title', { title: title(g) }), t(lang, 'soc.pt_intro'), '');
  const top = await stats.top(c, 'points', 5);
  if (top.length) {
    lines.push(t(lang, 'soc.pt_top'));
    for (const [i, r] of top.entries()) lines.push(`${num(lang, i + 1)}. ${iso(await users.displayName(Number(r.user_id)), 32)} — ${t(lang, 'soc.top_pts', { n: num(lang, Number(r.points)), level: num(lang, levelOf(r.points)) })}`);
    lines.push('');
  }
  const defs = await badges.defs(c);
  lines.push(t(lang, 'soc.pt_badges', { n: num(lang, defs.length) }));
  for (const d of defs) lines.push(`• ${esc(d.emoji)} ${esc(d.name)} — ${num(lang, await badges.holders(c, `c${d.id}`))}`);
  const kb = [[settingBtn(lang, c, s, 'pts_on', 'pt')], [settingBtn(lang, c, s, 'pts_msg', 'pt'), settingBtn(lang, c, s, 'pts_gap', 'pt')],
    [settingBtn(lang, c, s, 'pts_thanks', 'pt'), settingBtn(lang, c, s, 'pts_announce', 'pt')]];
  for (const d of defs) kb.push([btn(t(lang, 'soc.btn_award', { badge: short(`${d.emoji} ${d.name}`, 30) }), `g:${c}:pt:ba:${d.id}`), btn('❌', `g:${c}:pt:bd:${d.id}`)]);
  kb.push([btn(t(lang, 'soc.btn_new_badge'), `g:${c}:pt:bn`), btn(t(lang, 'soc.btn_reset_points'), `g:${c}:pt:r`)], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-points');
}

async function pointsAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (!a) return pointsScreen(ctx, user, g, place);
  if (a === 's') {
    await toggle(ctx, user, g, parts[4]);
    return pointsScreen(ctx, user, g, place);
  }
  if (!(await needLevel(ctx, user, g, a === 'r' ? L.full : L.settings))) return null;
  if (a === 'bn' || a === 'ba') {
    await state.set(user.user_id, 'soc_input', { chat: c, key: a === 'bn' ? 'badge' : 'award', id: toInt(parts[4]) || 0 });
    await answer(ctx);
    if (a === 'bn') return send(ctx, user.user_id, t(lang, 'soc.badge_prompt', { max: BADGE_NAME_MAX }), null, 'soc-badge');
    const kb = { keyboard: [[{ text: t(lang, 'chat.pick_button'), request_users: { request_id: 81, max_quantity: 1 } }], [{ text: t(lang, 'common.cancel') }]],
      resize_keyboard: true, one_time_keyboard: true };
    return send(ctx, user.user_id, t(lang, 'soc.award_prompt'), null, 'soc-award', { reply_markup: kb });
  }
  if (a === 'bd') {
    const d = await badges.def(toInt(parts[4]));
    if (!d || Number(d.chat_id) !== c) return pointsScreen(ctx, user, g, place);
    if (parts[5] !== 'y') {
      const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:pt:bd:${d.id}:y`), btn(t(lang, 'common.back'), `g:${c}:pt`)]];
      return screen(ctx, user.user_id, place, t(lang, 'soc.badge_remove_q', { badge: `${esc(d.emoji)} ${esc(d.name)}` }), kb, 'badge-remove?');
    }
    await badges.removeDef(c, d.id);
    await audit.log(user.user_id, 'badge.remove', { chatId: c, details: { id: Number(d.id) } });
    return pointsScreen(ctx, user, g, place, t(lang, 'soc.badge_removed'));
  }
  if (a === 'r') {
    if (parts[4] !== 'y') {
      const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:pt:r:y`), btn(t(lang, 'common.back'), `g:${c}:pt`)]];
      return screen(ctx, user.user_id, place, t(lang, 'soc.reset_q'), kb, 'points-reset?');
    }
    const n = await stats.resetPoints(c);
    await audit.log(user.user_id, 'points.reset', { chatId: c, details: { n } });
    return pointsScreen(ctx, user, g, place, t(lang, 'soc.reset_done', { n: num(lang, n) }));
  }
  return pointsScreen(ctx, user, g, place);
}

/* ---------- contests ---------- */

async function contestsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'soc.ct_title', { title: title(g) }), t(lang, 'soc.ct_intro'), '');
  const list = await contests.list(c);
  if (!list.length) lines.push(t(lang, 'soc.ct_none'));
  for (const r of list) {
    lines.push(t(lang, 'soc.ct_line', { kind: t(lang, `soc.ct_k_${r.kind}`), title: iso(r.title, 40), status: t(lang, `soc.ct_s_${r.status}`),
      n: num(lang, await contests.entries(r.id)) }));
  }
  const kb = pairs(list.filter((r) => r.status !== 'draft').map((r) => btn(`${t(lang, `soc.ct_icon_${r.kind}`)} ${short(r.title, 22)}`, `g:${c}:ct:i:${r.id}`)));
  kb.push([btn(t(lang, 'soc.btn_ct_raffle'), `g:${c}:ct:n:raffle`), btn(t(lang, 'soc.btn_ct_activity'), `g:${c}:ct:n:activity`)],
    [btn(t(lang, 'soc.btn_ct_quiz'), `g:${c}:ct:n:quiz`)], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-contests');
}

async function draftScreen(ctx, user, g, row, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [t(lang, 'soc.ct_draft', { kind: t(lang, `soc.ct_k_${row.kind}`), title: iso(row.title, 120) })];
  if (row.kind === 'quiz') lines.push(t(lang, 'soc.ct_question', { question: iso(row.question || '', 300) }), t(lang, 'soc.ct_answer', { answer: iso(row.answer || '', 64) }));
  const d = Number(row.ends_at);
  const p = `g:${c}:ct:d:${row.id}`;
  const kb = [[btn(t(lang, 'soc.btn_ct_time', { time: dur(lang, d) }), `${p}:t`)]];
  if (row.kind !== 'quiz') kb.push([btn(t(lang, 'soc.btn_ct_winners', { n: num(lang, Number(row.winners)) }), `${p}:w`)]);
  kb.push([btn(t(lang, 'soc.btn_ct_publish'), `${p}:go`), btn(t(lang, 'post.btn_discard'), `${p}:x`)]);
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'contest-draft');
}

async function contestScreen(ctx, user, g, row, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'soc.ct_item', { kind: t(lang, `soc.ct_k_${row.kind}`), title: iso(row.title, 120), status: t(lang, `soc.ct_s_${row.status}`) }));
  lines.push(t(lang, 'soc.ct_entries', { n: num(lang, await contests.entries(row.id)) }));
  if (row.status === 'running') lines.push(t(lang, 'soc.ct_ends', { time: dur(lang, Math.max(0, Number(row.ends_at) - nowSec())) }));
  if (row.kind === 'activity' && row.status === 'running') {
    for (const [i, e] of (await contests.leaders(row.id, 5)).entries()) lines.push(`${num(lang, i + 1)}. ${iso(await users.displayName(Number(e.user_id)), 32)} — ${num(lang, Number(e.n))}`);
  }
  const winners = contests.winnersOf(row);
  if (row.status === 'ended') {
    const names = [];
    for (const id of winners) names.push(iso(await users.displayName(Number(id)), 32));
    lines.push(names.length ? t(lang, 'soc.ct_won', { list: names.join(t(lang, 'common.sep')) }) : t(lang, 'soc.ct_nobody'));
  }
  const kb = [];
  if (row.status === 'running') kb.push([btn(t(lang, 'soc.btn_ct_end'), `g:${c}:ct:i:${row.id}:e`), btn(t(lang, 'soc.btn_ct_cancel'), `g:${c}:ct:i:${row.id}:c`)]);
  kb.push(back(lang, `g:${c}:ct`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-contest');
}

async function contestsAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (!a) return contestsScreen(ctx, user, g, place);
  if (a === 'i') {
    const row = await contests.get(toInt(parts[4]));
    if (!row || Number(row.chat_id) !== c) return contestsScreen(ctx, user, g, place);
    const act = parts[5];
    if (!act) return contestScreen(ctx, user, g, row, place);
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    if (act === 'e') {
      const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:ct:i:${row.id}:ey`), btn(t(lang, 'common.back'), `g:${c}:ct:i:${row.id}`)]];
      return screen(ctx, user.user_id, place, t(lang, 'soc.ct_end_q'), kb, 'contest-end?');
    }
    if (act === 'ey') await endContest(ctx, g.chat, row, user.user_id);
    if (act === 'c' && await contests.finish(row.id, [], 'cancelled')) {
      await audit.log(user.user_id, 'contest.cancel', { chatId: c, details: { id: Number(row.id) } });
      if (Number(row.msg_id)) await tryCall(ctx, 'editMessageReplyMarkup', { chat_id: c, message_id: Number(row.msg_id), reply_markup: { inline_keyboard: [] } }, 'contest-close');
    }
    return contestScreen(ctx, user, g, await contests.get(row.id), place);
  }
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  if (a === 'n' && contests.KINDS.includes(parts[4])) {
    await state.set(user.user_id, 'soc_input', { chat: c, key: 'contest', step: 'title', data: { kind: parts[4] } });
    await answer(ctx);
    return send(ctx, user.user_id, t(lang, 'soc.ct_prompt_title', { max: CONTEST_TITLE_MAX }), null, 'contest-title');
  }
  if (a === 'd') {
    const row = await contests.get(toInt(parts[4]));
    if (!row || Number(row.chat_id) !== c || row.status !== 'draft') return contestsScreen(ctx, user, g, place, t(lang, 'post.gone'));
    const act = parts[5];
    if (act === 't') await contests.update(row.id, { ends_at: DURS[(DURS.indexOf(Number(row.ends_at)) + 1) % DURS.length] });
    if (act === 'w') await contests.update(row.id, { winners: WINNERS[(WINNERS.indexOf(Number(row.winners)) + 1) % WINNERS.length] });
    if (act === 'x') {
      await contests.finish(row.id, [], 'cancelled');
      return contestsScreen(ctx, user, g, place);
    }
    if (act === 'go') {
      await contests.update(row.id, { ends_at: nowSec() + Number(row.ends_at) });
      const ok = await publishContest(ctx, g.chat, await contests.get(row.id));
      return contestsScreen(ctx, user, g, place, t(lang, ok ? 'soc.ct_published' : 'soc.ct_failed'));
    }
    return draftScreen(ctx, user, g, await contests.get(row.id), place);
  }
  return contestsScreen(ctx, user, g, place);
}

/* ---------- polls ---------- */

async function pollsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'soc.pl_title', { title: title(g) }), t(lang, 'soc.pl_intro'), '');
  const list = await polls.list(c);
  if (!list.length) lines.push(t(lang, 'soc.pl_none'));
  for (const p of list) lines.push(t(lang, 'soc.pl_line', { question: iso(p.question, 50), n: num(lang, Number(p.total)), status: t(lang, `soc.pl_s_${p.status}`) }));
  const kb = pairs(list.map((p) => btn(`🗳 ${short(p.question, 24)}`, `g:${c}:pl:i:${p.id}`)));
  kb.push([btn(t(lang, 'soc.btn_pl_new'), `g:${c}:pl:n`)], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-polls');
}

function bar(n, total) {
  const w = total ? Math.round((n / total) * 10) : 0;
  return `${'▓'.repeat(w)}${'░'.repeat(10 - w)}`;
}

async function pollScreen(ctx, user, g, p, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const opts = polls.optionsOf(p);
  const counts = polls.countsOf(p);
  const sum = counts.reduce((a, b) => a + b, 0);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'soc.pl_item', { question: iso(p.question, 300), status: t(lang, `soc.pl_s_${p.status}`) }));
  lines.push(t(lang, Number(p.anonymous) ? 'soc.pl_anon' : 'soc.pl_public'), '');
  opts.forEach((o, i) => lines.push(`${Number(p.correct) === i ? '✅ ' : ''}${iso(o, 60)}\n${bar(counts[i] || 0, sum)} ${num(lang, counts[i] || 0)}`));
  lines.push('', t(lang, 'soc.pl_total', { n: num(lang, Number(p.total)) }));
  if (Number(p.closes_at) && p.status === 'open') lines.push(t(lang, 'soc.pl_closes', { time: dur(lang, Math.max(0, Number(p.closes_at) - nowSec())) }));
  const kb = [];
  if (p.status === 'open') kb.push([btn(t(lang, 'soc.btn_pl_stop'), `g:${c}:pl:i:${p.id}:s`)]);
  if (!Number(p.anonymous)) kb.push([btn(t(lang, 'soc.btn_pl_voters'), `g:${c}:pl:i:${p.id}:v`)]);
  kb.push(back(lang, `g:${c}:pl`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-poll');
}

async function pollDraftScreen(ctx, user, g, d, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const onOff = (v) => t(lang, v ? 'common.on' : 'common.off');
  const lines = [t(lang, 'soc.pl_draft', { question: iso(d.question, 300) })];
  d.options.forEach((o, i) => lines.push(`${d.correct === i ? '✅' : '▫\uFE0F'} ${iso(o, 60)}`));
  const kb = [];
  if (g.chat.type !== 'channel') kb.push([btn(t(lang, 'soc.btn_pl_anon', { v: onOff(d.anonymous) }), `g:${c}:pl:o:a`)]);
  kb.push([btn(t(lang, 'soc.btn_pl_multi', { v: onOff(d.multiple) }), `g:${c}:pl:o:m`), btn(t(lang, 'soc.btn_pl_quiz', { v: onOff(d.correct >= 0) }), `g:${c}:pl:o:q`)]);
  if (d.correct >= 0) kb.push(...pairs(d.options.map((o, i) => btn(`${d.correct === i ? '✅' : '▫\uFE0F'} ${short(o, 20)}`, `g:${c}:pl:o:c:${i}`))));
  kb.push([btn(t(lang, 'soc.btn_pl_time', { time: d.dur ? dur(lang, d.dur) : t(lang, 'soc.pl_no_end') }), `g:${c}:pl:o:t`)]);
  kb.push([btn(t(lang, 'soc.btn_pl_send'), `g:${c}:pl:go`), back(lang, `g:${c}:pl`)[0]]);
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'poll-draft');
}

async function pollsAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (!a) return pollsScreen(ctx, user, g, place);
  if (a === 'i') {
    const p = await polls.get(toInt(parts[4]));
    if (!p || Number(p.chat_id) !== c) return pollsScreen(ctx, user, g, place);
    if (parts[5] === 'v') {
      await answer(ctx, t(lang, 'soc.csv_sent'));
      const opts = polls.optionsOf(p);
      const rows = [['user_id', 'name', 'answers', 'time']];
      for (const v of await polls.votes(Number(p.id))) {
        rows.push([v.user_id, await users.displayName(Number(v.user_id)), (parseJson(v.options, []) || []).map((i) => opts[i]).join(' | '), isoMinute(Number(v.at))]);
      }
      await sendCsv(ctx, user, rows, `aegis-poll-${p.id}.csv`);
      return null;
    }
    if (parts[5] === 's') {
      if (!(await needLevel(ctx, user, g, L.settings))) return null;
      try {
        const res = await call(ctx, 'stopPoll', { chat_id: c, message_id: Number(p.msg_id) }, 'poll-stop');
        if (res && res.options) await polls.setCounts(p.poll_id, res.options.map((o) => Number(o.voter_count) || 0), Number(res.total_voter_count) || 0, true);
      } catch (err) {
        if (!/already closed/i.test(describeError(err))) return pollScreen(ctx, user, g, p, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
      }
      await polls.close(Number(p.id));
      await audit.log(user.user_id, 'poll.stop', { chatId: c, details: { id: Number(p.id) } });
      return pollScreen(ctx, user, g, await polls.get(p.id), place);
    }
    return pollScreen(ctx, user, g, p, place);
  }
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  if (a === 'n') {
    await state.set(user.user_id, 'soc_input', { chat: c, key: 'poll', step: 'question' });
    await answer(ctx);
    return send(ctx, user.user_id, t(lang, 'soc.pl_prompt_question', { max: POLL_QUESTION_MAX }), null, 'poll-question');
  }
  const st = await state.get(user.user_id);
  const d = st && st.kind === 'soc_input' && st.data.key === 'poll' && st.data.step === 'draft' && st.data.chat === c ? st.data.data : null;
  if (!d) return pollsScreen(ctx, user, g, place, t(lang, 'post.gone'));
  if (a === 'o') {
    const o = parts[4];
    if (o === 'a') d.anonymous = !d.anonymous;
    if (o === 'm') d.multiple = !d.multiple;
    if (o === 'q') d.correct = d.correct >= 0 ? -1 : 0;
    if (o === 'c') d.correct = Math.min(d.options.length - 1, toInt(parts[5]) || 0);
    if (o === 't') d.dur = POLL_DURS[(POLL_DURS.indexOf(d.dur) + 1) % POLL_DURS.length];
    if (d.correct >= 0) d.multiple = false;
    await state.set(user.user_id, 'soc_input', { ...st.data, data: d });
    return pollDraftScreen(ctx, user, g, d, place);
  }
  if (a === 'go') {
    await state.clear(user.user_id);
    try {
      await sendPoll(ctx, g.chat, { question: d.question, options: d.options, anonymous: d.anonymous, multiple: d.multiple, correct: d.correct,
        closesAt: d.dur ? nowSec() + d.dur : 0 }, user.user_id);
      return pollsScreen(ctx, user, g, place, t(lang, 'soc.pl_sent'));
    } catch (err) {
      return pollsScreen(ctx, user, g, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
    }
  }
  return pollsScreen(ctx, user, g, place);
}

/* ---------- entry points ---------- */

export async function callback(ctx, user, g, parts, place) {
  switch (parts[2]) {
    case 'st': return statsAction(ctx, user, g, parts, place);
    case 'pt': return pointsAction(ctx, user, g, parts, place);
    case 'ct': return contestsAction(ctx, user, g, parts, place);
    case 'pl': return pollsAction(ctx, user, g, parts, place);
    default: return null;
  }
}

export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const d = pending.data;
  const g = await guard(ctx, user, d.chat, L.settings, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const c = g.chat.chat_id;
  const again = (key, vars = {}) => send(ctx, user.user_id, t(lang, key, vars), null, `soc-${d.key}-again`);
  if (d.key === 'badge') {
    const m = /^(\S+)\s+(.+)$/u.exec(text);
    if (!m || [...m[1]].length > 8 || [...m[2]].length > BADGE_NAME_MAX) return again('soc.badge_prompt', { max: BADGE_NAME_MAX });
    await state.clear(user.user_id);
    const id = await badges.addDef(c, m[1], m[2], user.user_id);
    if (!id) return pointsScreen(ctx, user, g, null, t(lang, 'soc.badges_full'));
    await audit.log(user.user_id, 'badge.create', { chatId: c, details: { id } });
    return pointsScreen(ctx, user, g, null, t(lang, 'soc.badge_created', { badge: `${esc(m[1])} ${esc(m[2])}` }));
  }
  if (d.key === 'award') {
    const def = await badges.def(Number(d.id));
    let uid = null;
    if (message.users_shared && message.users_shared.users && message.users_shared.users.length) uid = message.users_shared.users[0].user_id;
    else if (message.forward_origin && message.forward_origin.type === 'user') uid = message.forward_origin.sender_user.id;
    else if (/^\d{4,16}$/.test(text)) uid = toInt(text);
    else if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) {
      const known = await users.byUsername(text.slice(1));
      uid = known ? Number(known.user_id) : null;
    }
    if (!def || Number(def.chat_id) !== c) {
      await state.clear(user.user_id);
      return pointsScreen(ctx, user, g, null);
    }
    if (!uid) return again('chat.pick_bad');
    await state.clear(user.user_id);
    const isNew = await badges.award(c, uid, `c${def.id}`, user.user_id);
    await audit.log(user.user_id, 'badge.award', { chatId: c, target: uid, details: { id: Number(def.id) } });
    const name = iso(await users.displayName(uid), 40);
    if (isNew) await send(ctx, c, t(g.chat.lang, 'soc.badge_new', { user: name, badge: `${esc(def.emoji)} ${esc(def.name)}` }), null, 'soc-announce');
    await send(ctx, user.user_id, t(lang, isNew ? 'soc.awarded' : 'soc.award_had', { user: name }), null, 'soc-awarded', removeKeyboard);
    return pointsScreen(ctx, user, g, null);
  }
  if (d.key === 'contest') {
    const data = d.data || {};
    if (d.step === 'title') {
      if (!text || [...text].length > CONTEST_TITLE_MAX) return again('soc.ct_prompt_title', { max: CONTEST_TITLE_MAX });
      data.title = text;
      if (data.kind === 'quiz') {
        await state.set(user.user_id, 'soc_input', { ...d, step: 'question', data });
        return send(ctx, user.user_id, t(lang, 'soc.ct_prompt_question'), null, 'contest-question');
      }
    } else if (d.step === 'question') {
      if (!text || [...text].length > 300) return again('soc.ct_prompt_question');
      data.question = text;
      await state.set(user.user_id, 'soc_input', { ...d, step: 'answer', data });
      return send(ctx, user.user_id, t(lang, 'soc.ct_prompt_answer', { max: CONTEST_ANSWER_MAX }), null, 'contest-answer');
    } else if (d.step === 'answer') {
      if (!text || [...text].length > CONTEST_ANSWER_MAX) return again('soc.ct_prompt_answer', { max: CONTEST_ANSWER_MAX });
      data.answer = text;
    }
    await state.clear(user.user_id);
    const id = await contests.create(c, { kind: data.kind, title: data.title, winners: 1, endsAt: 86400, question: data.question, answer: data.answer }, user.user_id);
    return draftScreen(ctx, user, g, await contests.get(id), null);
  }
  if (d.key === 'poll') {
    if (d.step === 'question') {
      if (!text || [...text].length > POLL_QUESTION_MAX) return again('soc.pl_prompt_question', { max: POLL_QUESTION_MAX });
      await state.set(user.user_id, 'soc_input', { ...d, step: 'options', data: { question: text } });
      return send(ctx, user.user_id, t(lang, 'soc.pl_prompt_options', { max: POLL_OPTIONS_MAX }), null, 'poll-options');
    }
    if (d.step === 'options') {
      const options = [...new Set(text.split('\n').map((x) => x.trim()).filter(Boolean))];
      if (options.length < 2 || options.length > POLL_OPTIONS_MAX || options.some((o) => [...o].length > POLL_OPTION_MAX)) {
        return again('soc.pl_prompt_options', { max: POLL_OPTIONS_MAX });
      }
      const draft = { question: d.data.question, options, anonymous: true, multiple: false, correct: -1, dur: 0 };
      await state.set(user.user_id, 'soc_input', { ...d, step: 'draft', data: draft });
      return pollDraftScreen(ctx, user, g, draft, null);
    }
    return null;
  }
  await state.clear(user.user_id);
  return null;
}

/* ========== panelQa (was ui/panel_qa.js) ========== */
/*
 * A chat's panel, Phase 8 part 2: questions (private and anonymous) and appeals with the review of
 * decisions. Behaviour: the qa section of ui/social.js. Viewing needs View; settings Settings; reviewing decisions Full.
 *
 * callback_data (chat id c):
 *   g:c:qa[:s:<key>]          questions and their settings        g:c:qa:b      post the «Ask us» buttons in the group
 *   g:c:qa:m:<id>             send me this question with its buttons
 *   g:c:qa:u[:y]              unblock every blocked anonymous sender → confirm (Full)
 *   g:c:ap[:s:<key>]          appeals, decisions, the moderators' record
 *   g:c:ap:m:<id>             send me this appeal with its buttons
 *   g:c:ap:d:<punishment>[:u|:o]   a decision: uphold / overturn (Full)
 */
export const panelQa = (() => {
const { L } = admins;
const INPUTS = new Set();
const KEYBOARD_INPUTS = new Set();
const title = (g) => iso(g.chat.title || '', 48);
const ago = (lang, at) => dur(lang, Math.max(0, nowSec() - Number(at)));
const MONTH = 30 * 86400;

/* ---------- questions ---------- */

async function questionsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const k = await questions.counts(c, nowSec() - MONTH);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'qa.panel_title', { title: title(g) }), t(lang, 'qa.panel_intro'), '');
  lines.push(t(lang, 'qa.panel_counts', { total: num(lang, k.total), open: num(lang, k.open), answered: num(lang, k.answered), published: num(lang, k.published),
    anon: num(lang, k.anon) }));
  const blocked = await questions.blocks(c);
  if (blocked) lines.push(t(lang, 'qa.panel_blocked', { n: num(lang, blocked) }));
  const open = await questions.open(c, 8);
  if (open.length) lines.push('', t(lang, 'qa.panel_open'));
  for (const q of open) lines.push(t(lang, Number(q.anon) ? 'qa.panel_item_anon' : 'qa.panel_item', { text: iso(q.text, 60), ago: ago(lang, q.at) }));
  const kb = [[settingBtn(lang, c, s, 'qa_on', 'qa'), settingBtn(lang, c, s, 'anon_on', 'qa')]];
  kb.push(...pairs(open.map((q) => btn(`${Number(q.anon) ? '🕶' : '❓'} ${short(q.text, 22)}`, `g:${c}:qa:m:${q.id}`))));
  kb.push([btn(t(lang, 'qa.btn_post_buttons'), `g:${c}:qa:b`)]);
  if (blocked) kb.push([btn(t(lang, 'qa.btn_unblock'), `g:${c}:qa:u`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-questions');
}

const qaRows = (lang, q) => (Number(q.anon)
  ? [[btn(t(lang, 'qa.btn_publish'), `qa:${q.id}:p`), btn(t(lang, 'qa.btn_publish_answer'), `qa:${q.id}:pa`)],
    [btn(t(lang, 'qa.btn_reject'), `qa:${q.id}:x`), btn(t(lang, 'qa.btn_block'), `qa:${q.id}:b`)]]
  : [[btn(t(lang, 'qa.btn_answer'), `qa:${q.id}:r`), btn(t(lang, 'qa.btn_close'), `qa:${q.id}:x`)]]);

async function questionsAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (a === 's') await toggle(ctx, user, g, parts[4]);
  if (a === 'm') {
    const q = await questions.get(toInt(parts[4]));
    if (!q || Number(q.chat_id) !== c || q.status !== 'open') return questionsScreen(ctx, user, g, place, t(lang, 'qa.done_already'));
    await answer(ctx, t(lang, 'post.shown'));
    const text = Number(q.anon) ? t(lang, 'qa.admin_anon', { title: title(g), text: iso(q.text, 1000) })
      : t(lang, 'qa.admin_question', { title: title(g), user: iso(await users.displayName(Number(q.user_id)), 40), text: iso(q.text, 1000) });
    await send(ctx, user.user_id, text, qaRows(lang, q), 'qa-admin');
    return null;
  }
  if (a === 'b') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const m = await qa.postButtons(ctx, g.chat, await settings.all(ctx, c));
    return questionsScreen(ctx, user, g, place, t(lang, m ? 'qa.buttons_posted' : 'qa.buttons_none'));
  }
  if (a === 'u') {
    if (!(await needLevel(ctx, user, g, L.full))) return null;
    if (parts[4] !== 'y') {
      const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:qa:u:y`), btn(t(lang, 'common.back'), `g:${c}:qa`)]];
      return screen(ctx, user.user_id, place, t(lang, 'qa.unblock_q'), kb, 'qa-unblock?');
    }
    const n = await questions.unblockAll(c);
    await audit.log(user.user_id, 'qa.unblock', { chatId: c, details: { n } });
    return questionsScreen(ctx, user, g, place, t(lang, 'qa.unblocked', { n: num(lang, n) }));
  }
  return questionsScreen(ctx, user, g, place);
}

/* ---------- appeals and decisions ---------- */

const mark = (d) => {
  if (d.verdict === 'overturned') return '↩\uFE0F';
  if (d.verdict === 'upheld') return '✅';
  if (d.appeal === 'open') return '⚖\uFE0F';
  return '▫\uFE0F';
};

async function appealsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const since = nowSec() - MONTH;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'qa.ap_title', { title: title(g) }), t(lang, 'qa.ap_intro'), '');
  const open = await appeals.open(c, 6);
  lines.push(t(lang, 'qa.ap_open', { n: num(lang, open.length) }));
  for (const ap of open) lines.push(t(lang, 'qa.ap_item', { user: iso(await users.displayName(Number(ap.user_id)), 32), text: iso(ap.text, 60), ago: ago(lang, ap.at) }));
  const dec = await appeals.decisions(c, since, 10);
  if (dec.length) lines.push('', t(lang, 'qa.dec_title'));
  for (const d of dec) {
    lines.push(t(lang, 'qa.dec_line', { mark: mark(d), kind: t(lang, `pun.k_${d.kind}`), target: iso(await users.displayName(Number(d.user_id)), 24),
      by: Number(d.actor_id) ? iso(await users.displayName(Number(d.actor_id)), 24) : t(lang, 'log.system'), ago: ago(lang, d.created_at) }));
  }
  const rec = await appeals.record(c, since);
  if (rec.length) lines.push('', t(lang, 'qa.rec_title'));
  for (const r of rec) {
    lines.push(t(lang, 'qa.rec_line', { name: iso(await users.displayName(Number(r.actor)), 32), n: num(lang, Number(r.n)), appealed: num(lang, Number(r.appealed)),
      accepted: num(lang, Number(r.accepted)), overturned: num(lang, Number(r.overturned)) }));
  }
  lines.push('', t(lang, 'qa.dec_legend'));
  const kb = [[settingBtn(lang, c, s, 'appeals_on', 'ap'), settingBtn(lang, c, s, 'review_all', 'ap')]];
  kb.push(...pairs(open.map((ap) => btn(`⚖\uFE0F ${short(ap.text, 22)}`, `g:${c}:ap:m:${ap.id}`))));
  kb.push(...pairs(dec.filter((d) => !d.verdict).slice(0, 8).map((d) => btn(`${mark(d)} ${t(lang, `pun.k_${d.kind}`)} #${d.id}`, `g:${c}:ap:d:${d.id}`))));
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-appeals');
}

async function appealsAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (a === 's') await toggle(ctx, user, g, parts[4]);
  if (a === 'm') {
    const ap = await appeals.get(toInt(parts[4]));
    if (!ap || Number(ap.chat_id) !== c || ap.status !== 'open') return appealsScreen(ctx, user, g, place, t(lang, 'qa.ap_done'));
    const p = await punish.get(Number(ap.punish_id));
    await answer(ctx, t(lang, 'post.shown'));
    const lines = [t(lang, 'qa.ap_admin', { title: title(g), user: iso(await users.displayName(Number(ap.user_id)), 40), kind: t(lang, `pun.k_${p ? p.kind : 'warn'}`) }),
      t(lang, 'qa.ap_text', { text: iso(ap.text, 1000) })];
    await send(ctx, user.user_id, lines.join('\n'), [[btn(t(lang, 'qa.btn_ap_accept'), `apl:${ap.id}:y`), btn(t(lang, 'qa.btn_ap_reject'), `apl:${ap.id}:n`)]], 'appeal-admin');
    return null;
  }
  if (a === 'd') {
    const p = await punish.get(toInt(parts[4]));
    if (!p || Number(p.chat_id) !== c) return appealsScreen(ctx, user, g, place);
    const act = parts[5];
    if (act === 'u' || act === 'o') {
      if (!(await needLevel(ctx, user, g, L.full))) return null;
      const r = await qa.decideReview(ctx, g.chat, Number(p.id), act === 'o', user.user_id);
      return appealsScreen(ctx, user, g, place, ['upheld', 'overturned', 'done'].includes(r) ? t(lang, `qa.rv_${r}`) : t(lang, 'pun.undo_failed', { error: iso(r, 100) }));
    }
    const lines = [t(lang, 'qa.dec_item', { kind: t(lang, `pun.k_${p.kind}`), target: iso(await users.displayName(Number(p.user_id)), 40),
      by: Number(p.actor_id) ? iso(await users.displayName(Number(p.actor_id)), 40) : t(lang, 'log.system'), ago: ago(lang, p.created_at),
      status: t(lang, `pun.s_${punish.isActive(p) ? 'active' : (p.status === 'undone' ? 'undone' : (p.status === 'audit' ? 'audit' : 'expired'))}`) })];
    if (p.reason) lines.push(t(lang, 'pun.notice_reason', { reason: iso(p.reason, 200) }));
    const ap = await appeals.ofPunishment(Number(p.id));
    if (ap) lines.push(t(lang, 'qa.dec_appeal', { status: t(lang, `qa.ap_s_${ap.status}`), text: iso(ap.text, 200) }));
    const kb = [[btn(t(lang, 'qa.btn_uphold'), `g:${c}:ap:d:${p.id}:u`), btn(t(lang, 'qa.btn_overturn'), `g:${c}:ap:d:${p.id}:o`)], back(lang, `g:${c}:ap`)];
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-decision');
  }
  return appealsScreen(ctx, user, g, place);
}

async function callback(ctx, user, g, parts, place) {
  if (g.chat.type === 'channel') return null;
  if (parts[2] === 'qa') return questionsAction(ctx, user, g, parts, place);
  if (parts[2] === 'ap') return appealsAction(ctx, user, g, parts, place);
  return null;
}

async function input() {
  return null;
}

  return { INPUTS, KEYBOARD_INPUTS, callback, input };
})();

/* ========== panelAnalytics (was ui/panel_analytics.js) ========== */
/*
 * A channel's analytics and health score (Phase 8): subscribers and their flow, posts, reactions
 * (Telegram's anonymous reaction counts) and comments (replies in the discussion group), the best
 * hours and posts, a 0–100 health score with its reasons (healthScore in lib/core/levels.js), and a CSV per day.
 *
 * callback_data: g:c:an          the analytics           g:c:an:x      CSV of the last 90 days
 */
export const panelAnalytics = (() => {
const DAY = 86400;

/* The health score of a channel and the numbers behind it. */
async function healthOf(ctx, chat) {
  const c = chat.chat_id;
  const now = nowSec();
  const s = await settings.all(ctx, c);
  const flow = await channels.flow(c, 7, now);
  const eng = await posts.engagement(c, now - 14 * DAY);
  const rows = await admins.listRows(c);
  const outside = rows.filter((r) => r.status === 'administrator' && !Number(r.via_aegis) && !Number(r.is_bot)).length;
  const h = healthScore({
    members: Number(chat.member_count), net7: flow.joins - flow.leaves, posts14: eng.posts, reactions14: eng.reactions, comments14: eng.comments, postDays14: eng.days,
    rightsOk: !(parseJson(chat.missing, []) || []).length, outside: outside > 0, crisis: !!(await crisis.active(c)),
    protected: ['ch_jr_captcha', 'ch_imp', 'ch_approval', 'ch_edit_lock'].some((k) => settings.flag(s, k)),
  });
  return { ...h, flow, eng, outside };
}

async function show(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const now = nowSec();
  const count = await tryCall(ctx, 'getChatMemberCount', { chat_id: c }, 'an-count');
  if (typeof count === 'number') {
    await chats.setCount(c, count);
    await channels.setMembers(c, count);
  }
  const chat = await chats.get(c);
  const h = await healthOf(ctx, chat);
  const f30 = await channels.flow(c, 30, now);
  const lines = [t(lang, 'an.title', { title: iso(chat.title || '', 48) }), ''];
  lines.push(t(lang, 'an.health', { score: num(lang, h.score), grade: h.grade }));
  for (const p of h.parts) lines.push(t(lang, 'an.part', { name: t(lang, `an.p_${p.key}`), got: num(lang, p.got), max: num(lang, p.max) }));
  lines.push('', t(lang, 'an.members', { n: num(lang, Number(chat.member_count)) }));
  lines.push(t(lang, 'an.flow', { j7: num(lang, h.flow.joins), l7: num(lang, h.flow.leaves), j30: num(lang, f30.joins), l30: num(lang, f30.leaves) }));
  lines.push(t(lang, 'an.posts', { n: num(lang, h.eng.posts), days: num(lang, h.eng.days), reactions: num(lang, h.eng.reactions), comments: num(lang, h.eng.comments),
    per: num(lang, h.perPost) }));
  const s = await settings.all(ctx, c);
  const tz = tzOf(s.tz, chat.lang);
  const hours = (await posts.byHour(c, now - 30 * DAY)).filter((x) => Number(x.n) > 0);
  if (hours.length) {
    const best = [...hours].sort((a, b) => Number(b.e) / Number(b.n) - Number(a.e) / Number(a.n))[0];
    const local = (((Number(best.h) * 60 + Number(tz)) % 1440) + 1440) % 1440;
    lines.push(t(lang, 'an.best_hour', { hour: `${String(Math.floor(local / 60)).padStart(2, '0')}:00`, tz: tzLabel(tz) }));
  }
  const top = await posts.best(c, now - 30 * DAY, 3);
  if (top.length && top.some((p) => Number(p.reactions) + Number(p.comments) > 0)) {
    lines.push('', t(lang, 'an.top'));
    for (const p of top) {
      lines.push(t(lang, 'an.top_line', { link: postLink(chat, Number(p.msg_id)), reactions: num(lang, Number(p.reactions)), comments: num(lang, Number(p.comments)) }));
    }
  }
  lines.push('', t(lang, 'an.note'));
  const kb = [[btn(t(lang, 'an.btn_csv'), `g:${c}:an:x`)], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-analytics');
}

async function callback(ctx, user, g, parts, place) {
  if (g.chat.type !== 'channel') return null;
  if (parts[3] === 'x') {
    const c = g.chat.chat_id;
    await answer(ctx, t(user.lang, 'soc.csv_sent'));
    const days = new Map();
    for (const d of await channels.series(c, 90)) days.set(Number(d.day), { members: d.members, joins: d.joins, leaves: d.leaves, posts: 0, reactions: 0, comments: 0 });
    for (const p of await posts.all(c, 5000)) {
      const day = Math.floor(Number(p.posted_at) / DAY);
      if (day < channels.today() - 90) continue;
      const row = days.get(day) || { members: 0, joins: 0, leaves: 0, posts: 0, reactions: 0, comments: 0 };
      row.posts += 1;
      row.reactions += Number(p.reactions);
      row.comments += Number(p.comments);
      days.set(day, row);
    }
    const rows = [['date', 'subscribers', 'joins', 'leaves', 'posts', 'reactions', 'comments']];
    for (const day of [...days.keys()].sort((a, b) => b - a)) {
      const r = days.get(day);
      rows.push([isoMinute(day * DAY).slice(0, 10), r.members || '', r.joins, r.leaves, r.posts, r.reactions, r.comments]);
    }
    await tryCall(ctx, 'sendDocument', { chat_id: user.user_id, document: new InputFile(utf8Bytes(csv(rows)), `aegis-channel-${String(c).replace('-', '')}.csv`, { type: 'text/csv' }) },
      'export');
    await audit.log(user.user_id, 'stats.export', { chatId: c, details: { what: 'channel' } });
    return null;
  }
  return show(ctx, user, g, place);
}

  return { healthOf, callback };
})();
