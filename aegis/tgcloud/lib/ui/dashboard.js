/*
 * The channels dashboard (Phase 7), in the private chat: every channel the person manages with its
 * subscribers, today's joins and leaves, pending join requests, posts waiting, alerts of the last
 * day, crisis mode and missing rights — and posting to several channels at once (each channel's
 * rules apply: Full access publishes, Settings sends it to that channel's approvers).
 *
 * callback_data: db[:page]   the dashboard
 *                xp          choose channels       xp:t:<chat>  add / remove one   xp:s   write the post (input)
 * Pending inputs: xp_pick { chats } (the choice while pressing), xp_input { chats } (the post).
 */
import { DASH_PAGE, XPOST_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import { canPublish, contentOf } from '../core/content.js';
import * as state from '../core/state.js';
import { answer, btn, screen, send, tryCall } from '../core/tg.js';
import { iso, normalizeWord, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as channels from '../engines/channels.js';
import * as chats from '../engines/chats.js';
import * as crisis from '../engines/crisis.js';
import * as posts from '../engines/posts.js';
import { num, t } from '../i18n/index.js';
import { notifyApprovers, publishItem } from './channel.js';
import { removeKeyboard } from './guard.js';

const { L } = admins;
export const INPUTS = new Set(['xp_input']);
export const KEYBOARD_INPUTS = new Set();

async function myChannels(userId) {
  return (await admins.chatsOf(userId)).filter((c) => c.type === 'channel');
}

/* A member count no older than an hour (a few are refreshed per view). */
async function count(ctx, chat, budget) {
  if (Number(chat.count_at) > nowSec() - 3600 || budget.n <= 0) return Number(chat.member_count);
  budget.n -= 1;
  const n = await tryCall(ctx, 'getChatMemberCount', { chat_id: chat.chat_id }, 'dash-count');
  if (typeof n !== 'number') return Number(chat.member_count);
  await chats.setCount(chat.chat_id, n);
  await channels.setMembers(chat.chat_id, n);
  return n;
}

export async function show(ctx, user, page = 0, place = null) {
  const lang = user.lang;
  const list = await myChannels(user.user_id);
  const pages = Math.max(1, Math.ceil(list.length / DASH_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const lines = [t(lang, 'dash.title'), ''];
  if (!list.length) lines.push(t(lang, 'dash.none'));
  const budget = { n: 5 };
  const kb = [];
  for (const it of list.slice(p * DASH_PAGE, (p + 1) * DASH_PAGE)) {
    const chat = await chats.get(it.chatId);
    if (!chat) continue;
    const c = chat.chat_id;
    const flow = await channels.flow(c, 1);
    const pend = (await channels.pending(c, 0)).total;
    const waiting = await posts.countWaiting(c);
    const alerts = await audit.countSince(c, 'channel.alert', nowSec() - 86400);
    const marks = [];
    if (await crisis.active(c)) marks.push('🆘');
    if ((parseJson(chat.missing, []) || []).length) marks.push('⚠\uFE0F');
    lines.push(t(lang, 'dash.line', { title: iso(chat.title || '', 32), marks: marks.length ? ` ${marks.join(' ')}` : '', members: num(lang, await count(ctx, chat, budget)),
      joins: num(lang, flow.joins), leaves: num(lang, flow.leaves), requests: num(lang, pend), waiting: num(lang, waiting), alerts: num(lang, alerts) }));
    kb.push([btn(`📢 ${short(chat.title || String(c), 28)}`, `g:${c}`)]);
  }
  const nav = [];
  if (p > 0) nav.push(btn('◀\uFE0F', `db:${p - 1}`));
  if (p < pages - 1) nav.push(btn('▶\uFE0F', `db:${p + 1}`));
  if (nav.length) kb.push(nav);
  if (list.length) kb.push([btn(t(lang, 'dash.btn_xpost'), 'xp')]);
  kb.push([btn(t(lang, 'chat.btn_my_chats'), 'cl')]);
  if (list.length) lines.push('', t(lang, 'dash.legend'));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'dashboard');
}

async function pickScreen(ctx, user, chosen, place, notice = '') {
  const lang = user.lang;
  const list = (await myChannels(user.user_id)).filter((c) => c.level >= L.settings);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'dash.xp_title'), t(lang, 'dash.xp_intro', { max: XPOST_MAX }), '', t(lang, 'dash.xp_chosen', { n: num(lang, chosen.length) }));
  const kb = list.slice(0, 30).map((c) => [btn(`${chosen.includes(c.chatId) ? '✅' : '▫\uFE0F'} ${short(c.title || String(c.chatId), 28)}`, `xp:t:${c.chatId}`)]);
  if (chosen.length) kb.push([btn(t(lang, 'dash.btn_xp_write'), 'xp:s')]);
  kb.push([btn(t(lang, 'common.back'), 'db')]);
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'dashboard-xpost');
}

export async function callback(ctx, user, parts, place) {
  const lang = user.lang;
  if (parts[0] === 'db') return show(ctx, user, toInt(parts[1]) || 0, place);
  const st = await state.get(user.user_id);
  let chosen = st && st.kind === 'xp_pick' ? (st.data.chats || []) : [];
  if (parts[1] === 't') {
    const id = toInt(parts[2]);
    if (chosen.includes(id)) chosen = chosen.filter((x) => x !== id);
    else if (chosen.length < XPOST_MAX) chosen = [...chosen, id];
    else await answer(ctx, t(lang, 'dash.xp_max', { max: XPOST_MAX }), true);
    await state.set(user.user_id, 'xp_pick', { chats: chosen });
    return pickScreen(ctx, user, chosen, place);
  }
  if (parts[1] === 's' && chosen.length) {
    await state.set(user.user_id, 'xp_input', { chats: chosen });
    await answer(ctx);
    return send(ctx, user.user_id, t(lang, 'dash.xp_prompt', { n: num(lang, chosen.length) }), null, 'xpost-ask');
  }
  await state.set(user.user_id, 'xp_pick', { chats: chosen });
  return pickScreen(ctx, user, chosen, place);
}

/* The post for several channels: each one checked live; published or sent for approval there. */
export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  const { kind, c } = contentOf(message);
  if (!canPublish(kind) || message.media_group_id) return send(ctx, user.user_id, t(lang, 'post.compose_bad'), null, 'xpost-bad');
  await state.clear(user.user_id);
  const lines = [t(lang, 'dash.xp_done_title')];
  for (const id of (pending.data.chats || []).slice(0, XPOST_MAX)) {
    const chat = await chats.get(id);
    const acc = chat && chat.type === 'channel' && Number(chat.active) ? await admins.liveAccess(ctx, id, user.user_id) : { level: 0 };
    const name = iso((chat && chat.title) || String(id), 32);
    if (!acc.member || acc.level < L.settings) {
      lines.push(t(lang, 'dash.xp_no_access', { title: name }));
      continue;
    }
    const qid = await posts.enqueue(id, kind, c, { authorId: user.user_id, status: 'draft' });
    let r;
    if (acc.level >= L.full) {
      await posts.claim(qid, 'draft', 'publishing', user.user_id);
      r = await publishItem(ctx, chat, await posts.item(qid), user.user_id);
    } else {
      await posts.claim(qid, 'draft', 'pending', 0);
      await notifyApprovers(ctx, chat, qid, user.user_id);
      r = 'pending';
    }
    lines.push(t(lang, `dash.xp_${r === 'published' || r === 'pending' ? r : 'failed'}`, { title: name }));
  }
  return send(ctx, user.user_id, lines.join('\n'), [[btn(t(lang, 'dash.btn_back_dash'), 'db')]], 'xpost-done');
}
