/*
 * A channel's panel, part 1 (Phase 7): join requests, members, invite links, impersonation and
 * fakes, admin alerts, the discussion group, direct messages and extras. Posts, crisis and backups
 * are in ui/panel_posts.js; the work itself in ui/channel.js. Viewing needs View; changes need
 * Settings; removing/banning members also needs «Ban users» (or the creator).
 *
 * callback_data (channel id c):
 *   g:c:J                 join requests             g:c:J:s:<key>       change a setting
 *   g:c:J:p[:page]        pending requests          g:c:J:a|d:<id>      approve / decline one
 *   g:c:J:A|D             approve / decline all → g:c:J:Ay|Dy           g:c:J:g             the guard bot
 *   g:c:M                 members                   g:c:M:f             find a member (input)
 *   g:c:M:u:<uid>[:k|b|n] a member: remove, ban, unban
 *   g:c:I                 invite links              g:c:I:n:<e>:<l>:<r> new link options → g:c:I:c:<e>:<l>:<r> create
 *   g:c:I:l:<id>[:r|q|x|xy]   a link: rename (input), join requests on/off, revoke → confirm
 *   g:c:I:P[:y]           the primary link, a new one → confirm
 *   g:c:Q[:s:<key>|:f|:r:<i>]   impersonation and known fakes (add: input, remove)
 *   g:c:A[:s:<key>]       alerts                    g:c:D[:s:<key>]     discussion group
 *   g:c:H[:s:<key>]       direct messages           g:c:E[:s:<key>|:i:footer|buttons]   extras
 * Pending input: ch_input { chat, key, id? } — key: member, fake, link_name, footer, buttons.
 */
import { FAKES_MAX, FOOTER_MAX, INVITE_LINKS_MAX, INVITE_NAME_MAX } from '../config.js';
import * as audit from '../core/audit.js';
import { answer, btn, call, describeError, me, screen, send, tryCall, urlBtn } from '../core/tg.js';
import * as state from '../core/state.js';
import { esc, fullName, iso, normalizeWord, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import { parseButtons } from '../core/content.js';
import * as channels from '../engines/channels.js';
import * as chats from '../engines/chats.js';
import * as invites from '../engines/invites.js';
import * as members from '../engines/members.js';
import * as punish from '../engines/punish.js';
import { addToGroupUrl } from '../engines/rights.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { decideRequest } from './channel.js';
import { back, guard, needLevel, pairs, removeKeyboard } from './guard.js';

const { L } = admins;
export const INPUTS = new Set(['ch_input']);
export const KEYBOARD_INPUTS = new Set(['ch_input']);
const flag = settings.flag;
const title = (g) => iso(g.chat.title || '', 48);
const EXPIRES = [0, 3600, 86400, 7 * 86400];
const LIMITS = [0, 1, 10, 100, 1000];
const SECONDS = new Set(['ch_edit_grace', 'ch_post_ttl', 'pts_gap']);
const PER_MIN = new Set(['ch_jr_flood', 'dm_flood']);

/* ---------- shared by the channel screens ---------- */

export function show(lang, key, v) {
  if (settings.isFlag(key)) return t(lang, v === '1' ? 'common.on' : 'common.off');
  if (SECONDS.has(key)) return Number(v) ? dur(lang, Number(v)) : t(lang, 'common.off');
  if (PER_MIN.has(key)) return Number(v) ? t(lang, 'chp.v_per_min', { n: num(lang, Number(v)) }) : t(lang, 'common.off');
  if (key === 'pts_msg') return num(lang, Number(v));
  return t(lang, `chp.v_${key}_${v}`);
}

export const settingBtn = (lang, c, s, key, sec) => btn(t(lang, 'chp.setting_btn', { name: t(lang, `chp.k_${key}`), value: show(lang, key, s[key]) }),
  `g:${c}:${sec}:s:${key}`);

/* Switches a flag or moves a choice to its next value (Settings level). Gives false when not allowed. */
export async function toggle(ctx, user, g, key) {
  if (!(key in settings.DEFAULTS) || !(await needLevel(ctx, user, g, L.settings))) return false;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  let next;
  if (settings.isFlag(key)) next = s[key] === '1' ? '0' : '1';
  else if (settings.CHOICES[key]) {
    const list = settings.CHOICES[key].map(String);
    next = list[(list.indexOf(s[key]) + 1) % list.length];
  } else return false;
  if (key === 'ch_title_lock' && next === '1') {
    const info = await tryCall(ctx, 'getChat', { chat_id: c }, 'ch-title-read');
    await settings.set(ctx, c, 'ch_title_locked', (info && info.title) || g.chat.title || '', user.user_id);
  }
  return settings.set(ctx, c, key, next, user.user_id);
}

const isChannel = (g) => g.chat.type === 'channel';
const botRights = (g) => parseJson(g.chat.bot_rights, {}) || {};
const ago = (lang, at) => dur(lang, Math.max(0, nowSec() - Number(at)));

/* ---------- join requests ---------- */

async function guardBot(ctx, g) {
  const info = await tryCall(ctx, 'getChat', { chat_id: g.chat.chat_id }, 'ch-guard');
  return !!(info && info.guard_bot && info.guard_bot.id === (await me(ctx)).id);
}

async function joinScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const st = await channels.requestStats(c, nowSec() - 86400);
  const pend = await channels.pending(c, 0);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.title_j', { title: title(g) }), t(lang, 'chp.intro_j'), '');
  lines.push(t(lang, 'chp.jr_day', { approved: num(lang, st.approved), declined: num(lang, st.declined), pending: num(lang, pend.total) }));
  const fresh = await chats.get(c);
  if (Number(fresh.jr_hold_until) > nowSec()) lines.push(t(lang, 'chp.jr_hold', { time: dur(lang, Number(fresh.jr_hold_until) - nowSec()) }));
  lines.push(t(lang, (await guardBot(ctx, g)) ? 'chp.guard_on' : 'chp.guard_off'));
  if (botRights(g).can_invite_users !== true) lines.push('', t(lang, 'chp.need_invite'));
  const kb = [[settingBtn(lang, c, s, 'ch_jr_mode', 'J'), settingBtn(lang, c, s, 'ch_jr_captcha', 'J')],
    [settingBtn(lang, c, s, 'ch_jr_names', 'J'), settingBtn(lang, c, s, 'ch_jr_flood', 'J')],
    [btn(t(lang, 'chp.btn_pending', { n: num(lang, pend.total) }), `g:${c}:J:p`), btn(t(lang, 'chp.btn_guard'), `g:${c}:J:g`)], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-join');
}

async function pendingScreen(ctx, user, g, page, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const { total, rows } = await channels.pending(c, page);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.pending_title', { title: title(g), n: num(lang, total) }), '');
  if (!rows.length) lines.push(t(lang, 'chp.pending_none'));
  const kb = [];
  for (const r of rows) {
    const name = r.name || String(r.user_id);
    lines.push(t(lang, 'chp.pending_line', { name: iso(name, 40), username: r.username ? `@${esc(r.username)}` : '—', ago: ago(lang, r.at),
      link: r.link ? iso(r.link, 32) : '—', status: t(lang, `chp.rq_${r.status}`) }));
    if (r.bio) lines.push(t(lang, 'chp.pending_bio', { bio: iso(r.bio, 120) }));
    kb.push([btn(`✅ ${short(name, 20)}`, `g:${c}:J:a:${r.id}`), btn(`❌ ${short(name, 20)}`, `g:${c}:J:d:${r.id}`)]);
  }
  const nav = [];
  if (page > 0) nav.push(btn('◀\uFE0F', `g:${c}:J:p:${page - 1}`));
  if ((page + 1) * rows.length < total && rows.length) nav.push(btn('▶\uFE0F', `g:${c}:J:p:${page + 1}`));
  if (nav.length) kb.push(nav);
  if (total) kb.push([btn(t(lang, 'chp.btn_approve_all'), `g:${c}:J:A`), btn(t(lang, 'chp.btn_decline_all'), `g:${c}:J:D`)]);
  kb.push(back(lang, `g:${c}:J`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-pending');
}

async function joinAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (a === 's') {
    await toggle(ctx, user, g, parts[4]);
    return joinScreen(ctx, user, g, place);
  }
  if (a === 'p') return pendingScreen(ctx, user, g, toInt(parts[4]) || 0, place);
  if (a === 'g') {
    const on = await guardBot(ctx, g);
    const text = [t(lang, 'chp.guard_title'), '', t(lang, on ? 'chp.guard_on' : 'chp.guard_off'), '', t(lang, 'chp.guard_text')].join('\n');
    return screen(ctx, user.user_id, place, text, [back(lang, `g:${c}:J`)], 'channel-guard');
  }
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  if (a === 'a' || a === 'd') {
    const row = await channels.request(toInt(parts[4]));
    if (!row || Number(row.chat_id) !== c) return pendingScreen(ctx, user, g, 0, place);
    const r = await decideRequest(ctx, g.chat, row, a === 'a', user.user_id);
    const name = iso(row.name || String(row.user_id), 40);
    const notice = r === 'ok' ? t(lang, a === 'a' ? 'chp.rq_approved_one' : 'chp.rq_declined_one', { name })
      : (r === 'done' ? t(lang, 'chp.rq_gone') : t(lang, 'chat.tg_error', { error: esc(r) }));
    return pendingScreen(ctx, user, g, 0, place, notice);
  }
  if (a === 'A' || a === 'D') {
    const n = (await channels.pendingIds(c)).length;
    const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:J:${a}y`), btn(t(lang, 'common.back'), `g:${c}:J:p`)]];
    return screen(ctx, user.user_id, place, t(lang, a === 'A' ? 'chp.approve_all_q' : 'chp.decline_all_q', { n: num(lang, n) }), kb, 'channel-all?');
  }
  if (a === 'Ay' || a === 'Dy') {
    let n = 0;
    for (const row of await channels.pendingIds(c, 100)) {
      if ((await decideRequest(ctx, g.chat, await channels.request(Number(row.id)), a === 'Ay', user.user_id)) === 'ok') n += 1;
    }
    return pendingScreen(ctx, user, g, 0, place, t(lang, a === 'Ay' ? 'chp.done_approved' : 'chp.done_declined', { n: num(lang, n) }));
  }
  return joinScreen(ctx, user, g, place);
}

/* ---------- members ---------- */

async function membersScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const count = await tryCall(ctx, 'getChatMemberCount', { chat_id: c }, 'ch-count');
  if (typeof count === 'number') {
    await channels.setMembers(c, count);
    await chats.setCount(c, count);
  }
  const today = await channels.flow(c, 1);
  const week = await channels.flow(c, 7);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.title_m', { title: title(g) }), '');
  lines.push(t(lang, 'chp.m_count', { n: typeof count === 'number' ? num(lang, count) : '—' }));
  lines.push(t(lang, 'chp.m_today', { joins: num(lang, today.joins), leaves: num(lang, today.leaves) }));
  lines.push(t(lang, 'chp.m_week', { joins: num(lang, week.joins), leaves: num(lang, week.leaves), net: num(lang, week.joins - week.leaves) }));
  const recent = await members.recent(c, 8);
  if (recent.length) {
    lines.push('', t(lang, 'chp.m_recent'));
    for (const r of recent) lines.push(t(lang, 'chp.m_recent_line', { name: iso(await users.displayName(Number(r.user_id)), 32), ago: ago(lang, r.joined_at) }));
  }
  lines.push('', t(lang, 'chp.m_note'));
  const kb = [[btn(t(lang, 'chp.btn_find'), `g:${c}:M:f`)], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-members');
}

const STATUS = ['creator', 'administrator', 'member', 'restricted', 'left', 'kicked'];

async function memberCard(ctx, user, g, uid, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const m = await tryCall(ctx, 'getChatMember', { chat_id: c, user_id: uid }, 'ch-member');
  const name = m && m.user ? fullName(m.user) : await users.displayName(uid);
  if (m && m.user) await users.remember(m.user);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.member_title', { name: iso(name, 48), id: String(uid) }));
  lines.push(t(lang, 'chp.member_status', { status: t(lang, `chp.st_${m && STATUS.includes(m.status) ? m.status : 'left'}`) }));
  const joined = await members.joinedAt(c, uid);
  if (joined) lines.push(t(lang, 'chp.member_joined', { ago: ago(lang, joined) }));
  const kb = [];
  if (m && !['creator', 'administrator'].includes(m.status)) {
    if (m.status === 'kicked') kb.push([btn(t(lang, 'chp.btn_unban'), `g:${c}:M:u:${uid}:n`)]);
    else kb.push([btn(t(lang, 'chp.btn_remove'), `g:${c}:M:u:${uid}:k`), btn(t(lang, 'chp.btn_ban'), `g:${c}:M:u:${uid}:b`)]);
  } else if (m) lines.push('', t(lang, 'chp.member_admin'));
  kb.push(back(lang, `g:${c}:M`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-member');
}

const canBan = (g) => g.acc.level === L.creator || (!!g.acc.member && g.acc.member.can_restrict_members === true);

async function memberAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (a === 'f') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    await state.set(user.user_id, 'ch_input', { chat: c, key: 'member' });
    await answer(ctx);
    const kb = { keyboard: [[{ text: t(lang, 'chat.pick_button'), request_users: { request_id: 71, max_quantity: 1 } }], [{ text: t(lang, 'common.cancel') }]],
      resize_keyboard: true, one_time_keyboard: true };
    return send(ctx, user.user_id, t(lang, 'chp.find_prompt'), null, 'ch-find', { reply_markup: kb });
  }
  if (a === 'u') {
    const uid = toInt(parts[4]);
    if (!uid) return membersScreen(ctx, user, g, place);
    const act = parts[5];
    if (!act) return memberCard(ctx, user, g, uid, place);
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    if (!canBan(g)) {
      await answer(ctx, t(lang, 'chp.need_ban'), true);
      return null;
    }
    const name = await users.displayName(uid);
    let res;
    if (act === 'n') res = await punish.lift(ctx, g.chat, uid, ['ban', 'blacklist'], user.user_id);
    else res = await punish.apply(ctx, g.chat, { userId: uid, name, kind: act === 'b' ? 'ban' : 'kick', sec: 0, reason: null, actorId: user.user_id, source: 'panel' });
    const ok = act === 'n' ? !!res : !!(res && res.ok);
    const key = { k: 'chp.removed', b: 'chp.banned', n: 'chp.unbanned' }[act] || 'chp.removed';
    return memberCard(ctx, user, g, uid, place, ok ? t(lang, key, { name: iso(name, 40) }) : t(lang, 'chp.member_failed', { error: esc((res && res.error) || '—') }));
  }
  return membersScreen(ctx, user, g, place);
}

/* ---------- invite links ---------- */

function linkFlags(lang, r) {
  const out = [];
  if (Number(r.revoked)) out.push(t(lang, 'chp.i_revoked'));
  else if (invites.isExpired(r)) out.push(t(lang, 'chp.i_expired'));
  else if (Number(r.expire_at)) out.push(t(lang, 'chp.i_until', { time: dur(lang, Number(r.expire_at) - nowSec()) }));
  if (Number(r.member_limit)) out.push(t(lang, 'chp.i_limit', { n: num(lang, Number(r.member_limit)) }));
  if (Number(r.requests)) out.push(t(lang, 'chp.i_requests'));
  return out.join(t(lang, 'common.sep'));
}

async function linksScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const rows = await invites.list(c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.title_i', { title: title(g) }), t(lang, 'chp.intro_i'), '');
  if (!rows.length) lines.push(t(lang, 'chp.i_none'));
  for (const r of rows.slice(0, 15)) {
    lines.push(t(lang, 'chp.i_line', { name: iso(r.name || short(r.link, 40), 40), joins: num(lang, Number(r.joins)), asked: num(lang, Number(r.asked)) }));
    const f = linkFlags(lang, r);
    if (f) lines.push(`   ${f}`);
  }
  if (botRights(g).can_invite_users !== true) lines.push('', t(lang, 'chp.need_invite'));
  const kb = pairs(rows.slice(0, 15).map((r) => btn(`🔗 ${short(r.name || r.link.replace(/^https:\/\/t\.me\//, ''), 24)}`, `g:${c}:I:l:${r.id}`)));
  kb.push([btn(t(lang, 'chp.btn_new_link'), `g:${c}:I:n:0:0:0`), btn(t(lang, 'chp.btn_primary'), `g:${c}:I:P`)], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-links');
}

function newLinkScreen(ctx, user, g, e, l, r, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const vE = EXPIRES[e] ? dur(lang, EXPIRES[e]) : t(lang, 'chp.v_never');
  const vL = LIMITS[l] ? num(lang, LIMITS[l]) : t(lang, 'chp.v_unlimited');
  const lines = [t(lang, 'chp.new_link_title', { title: title(g) }), t(lang, 'chp.new_link_intro'), '',
    t(lang, 'chp.new_exp', { v: vE }), t(lang, 'chp.new_lim', { v: r ? t(lang, 'chp.v_unlimited') : vL }), t(lang, 'chp.new_req', { v: t(lang, r ? 'common.on' : 'common.off') })];
  const next = (i, n) => (i + 1) % n;
  const kb = [[btn(t(lang, 'chp.btn_exp', { v: vE }), `g:${c}:I:n:${next(e, EXPIRES.length)}:${l}:${r}`)],
    [btn(t(lang, 'chp.btn_lim', { v: r ? t(lang, 'chp.v_unlimited') : vL }), `g:${c}:I:n:${e}:${r ? 0 : next(l, LIMITS.length)}:${r}`)],
    [btn(t(lang, 'chp.btn_req', { v: t(lang, r ? 'common.on' : 'common.off') }), `g:${c}:I:n:${e}:0:${r ? 0 : 1}`)],
    [btn(t(lang, 'chp.btn_create'), `g:${c}:I:c:${e}:${r ? 0 : l}:${r}`)], back(lang, `g:${c}:I`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-new-link');
}

async function linkScreen(ctx, user, g, row, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.link_title', { name: iso(row.name || '—', 40) }), '', `<code>${esc(row.link)}</code>`, '');
  lines.push(t(lang, 'chp.link_stats', { joins: num(lang, Number(row.joins)), asked: num(lang, Number(row.asked)) }));
  lines.push(t(lang, 'chp.link_made', { ago: ago(lang, row.created_at), by: iso(await users.displayName(Number(row.created_by)), 32) }));
  const f = linkFlags(lang, row);
  if (f) lines.push(f);
  const kb = [];
  if (!Number(row.revoked)) {
    kb.push([btn(t(lang, 'chp.btn_rename'), `g:${c}:I:l:${row.id}:r`), btn(t(lang, Number(row.requests) ? 'chp.btn_req_off' : 'chp.btn_req_on'), `g:${c}:I:l:${row.id}:q`)]);
    kb.push([btn(t(lang, 'chp.btn_revoke'), `g:${c}:I:l:${row.id}:x`)]);
  }
  kb.push(back(lang, `g:${c}:I`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-link');
}

async function linkAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  const ints = parts.slice(4).map((x) => toInt(x) || 0);
  if (a === 'n') return newLinkScreen(ctx, user, g, ints[0] % EXPIRES.length, ints[1] % LIMITS.length, ints[2] ? 1 : 0, place);
  if (a === 'l') {
    const row = await invites.get(ints[0]);
    if (!row || Number(row.chat_id) !== c) return linksScreen(ctx, user, g, place);
    const act = parts[5];
    if (!act) return linkScreen(ctx, user, g, row, place);
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    if (act === 'r') {
      await state.set(user.user_id, 'ch_input', { chat: c, key: 'link_name', id: Number(row.id) });
      await answer(ctx);
      return send(ctx, user.user_id, t(lang, 'chp.rename_prompt', { max: INVITE_NAME_MAX }), null, 'ch-link-name');
    }
    if (act === 'q') {
      try {
        const link = await call(ctx, 'editChatInviteLink', { chat_id: c, invite_link: row.link, name: row.name || undefined,
          expire_date: Number(row.expire_at) || undefined, creates_join_request: !Number(row.requests), member_limit: undefined }, 'ch-link-edit');
        await invites.update(row.id, link);
        await audit.log(user.user_id, 'channel.link_edit', { chatId: c, details: { id: Number(row.id) } });
        return linkScreen(ctx, user, g, await invites.get(row.id), place, t(lang, 'chp.saved'));
      } catch (err) {
        return linkScreen(ctx, user, g, row, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
      }
    }
    if (act === 'x') {
      const kb = [[btn(t(lang, 'chp.btn_revoke_yes'), `g:${c}:I:l:${row.id}:xy`), btn(t(lang, 'common.back'), `g:${c}:I:l:${row.id}`)]];
      return screen(ctx, user.user_id, place, t(lang, 'chp.revoke_q', { name: iso(row.name || row.link, 40) }), kb, 'channel-revoke?');
    }
    if (act === 'xy') {
      try {
        await call(ctx, 'revokeChatInviteLink', { chat_id: c, invite_link: row.link }, 'ch-link-revoke');
      } catch (err) {
        if (!/INVITE_HASH_EXPIRED|not found|revoked/i.test(describeError(err))) {
          return linkScreen(ctx, user, g, row, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
        }
      }
      await invites.markRevoked(row.id);
      await audit.log(user.user_id, 'channel.link_revoke', { chatId: c, details: { id: Number(row.id) } });
      return linksScreen(ctx, user, g, place, t(lang, 'chp.revoked', { name: iso(row.name || row.link, 40) }));
    }
    return linkScreen(ctx, user, g, row, place);
  }
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  if (a === 'c') {
    if (await invites.countLive(c) >= INVITE_LINKS_MAX) return linksScreen(ctx, user, g, place, t(lang, 'chp.i_full', { max: INVITE_LINKS_MAX }));
    const e = EXPIRES[ints[0] % EXPIRES.length];
    const r = !!ints[2];
    const l = r ? 0 : LIMITS[ints[1] % LIMITS.length];
    const n = (await invites.list(c, { live: false })).length + 1;
    try {
      const link = await call(ctx, 'createChatInviteLink', { chat_id: c, name: `Aegis ${n}`, ...(e ? { expire_date: nowSec() + e } : {}),
        ...(l ? { member_limit: l } : {}), ...(r ? { creates_join_request: true } : {}) }, 'ch-link-create');
      const id = await invites.add(c, link, user.user_id);
      await audit.log(user.user_id, 'channel.link_create', { chatId: c, details: { id } });
      return linkScreen(ctx, user, g, await invites.get(id), place, t(lang, 'chp.link_created'));
    } catch (err) {
      return linksScreen(ctx, user, g, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
    }
  }
  if (a === 'P') {
    if (parts[4] === 'y') {
      try {
        const link = await call(ctx, 'exportChatInviteLink', { chat_id: c }, 'ch-primary-new');
        await audit.log(user.user_id, 'channel.primary_link', { chatId: c });
        return screen(ctx, user.user_id, place, [t(lang, 'chp.primary_done'), '', `<code>${esc(link)}</code>`].join('\n'), [back(lang, `g:${c}:I`)], 'channel-primary');
      } catch (err) {
        return linksScreen(ctx, user, g, place, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
      }
    }
    const info = await tryCall(ctx, 'getChat', { chat_id: c }, 'ch-primary');
    const cur = info && info.invite_link;
    const lines = [t(lang, 'chp.primary_title', { title: title(g) }), '', cur ? `<code>${esc(cur)}</code>` : t(lang, 'chp.primary_none'), '', t(lang, 'chp.primary_q')];
    const kb = [[btn(t(lang, 'chp.btn_new_primary'), `g:${c}:I:P:y`)], back(lang, `g:${c}:I`)];
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-primary?');
  }
  return linksScreen(ctx, user, g, place);
}

/* ---------- impersonation and fakes ---------- */

async function fraudScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const fakes = parseJson(s.ch_fakes, []) || [];
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.title_q', { title: title(g) }), t(lang, 'chp.intro_q'), '', t(lang, 'chp.fakes_title', { n: num(lang, fakes.length), max: FAKES_MAX }));
  if (!fakes.length) lines.push(t(lang, 'chp.fakes_none'));
  fakes.forEach((f) => lines.push(`• ${iso(f, 40)}`));
  const kb = [[settingBtn(lang, c, s, 'ch_imp', 'Q'), settingBtn(lang, c, s, 'ch_imp_action', 'Q')]];
  kb.push(...pairs(fakes.map((f, i) => btn(`❌ ${short(f, 24)}`, `g:${c}:Q:r:${i}`))));
  if (fakes.length < FAKES_MAX) kb.push([btn(t(lang, 'chp.btn_add_fake'), `g:${c}:Q:f`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-fraud');
}

async function fraudAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const a = parts[3];
  if (a === 's') await toggle(ctx, user, g, parts[4]);
  else if (a === 'f') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    await state.set(user.user_id, 'ch_input', { chat: c, key: 'fake' });
    await answer(ctx);
    return send(ctx, user.user_id, t(lang, 'chp.fake_prompt'), null, 'ch-fake');
  } else if (a === 'r') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    const s = await settings.all(ctx, c);
    const list = parseJson(s.ch_fakes, []) || [];
    list.splice(toInt(parts[4]) || 0, 1);
    await settings.set(ctx, c, 'ch_fakes', JSON.stringify(list), user.user_id);
  }
  return fraudScreen(ctx, user, g, place);
}

/* ---------- alerts, discussion group, direct messages, extras ---------- */

async function alertsScreen(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const n = await audit.countSince(c, 'channel.alert', nowSec() - 86400);
  const lines = [t(lang, 'chp.title_a', { title: title(g) }), t(lang, 'chp.intro_a'), '', t(lang, 'chp.a_count', { n: num(lang, n) })];
  lines.push(t(lang, s.log_chat !== '0' && flag(s, 'log_on') ? 'chp.a_where_log' : 'chp.a_where_owner'));
  if (flag(s, 'ch_title_lock') && s.ch_title_locked) lines.push(t(lang, 'chp.a_title_locked', { title: iso(s.ch_title_locked, 48) }));
  const kb = [[settingBtn(lang, c, s, 'ch_al_admins', 'A'), settingBtn(lang, c, s, 'ch_al_info', 'A')],
    [settingBtn(lang, c, s, 'ch_al_edits', 'A'), settingBtn(lang, c, s, 'ch_al_bot', 'A')],
    [settingBtn(lang, c, s, 'ch_title_lock', 'A')], [btn(t(lang, 'chat.btn_betray'), `g:${c}:B`), btn(t(lang, 'chat.btn_logs'), `g:${c}:O`)], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-alerts');
}

/* The channel's discussion group, from Telegram (getChat) — kept in aegis_chats.linked_id. */
export async function linkedGroup(ctx, chat) {
  const info = await tryCall(ctx, 'getChat', { chat_id: chat.chat_id }, 'ch-linked');
  if (info) {
    const id = Number(info.linked_chat_id) || 0;
    if (id !== Number(chat.linked_id)) await channels.setLinked(chat.chat_id, id);
    if (id && await chats.get(id)) await channels.setLinked(id, chat.chat_id);
    return id;
  }
  return Number(chat.linked_id) || 0;
}

async function discussionScreen(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const gid = await linkedGroup(ctx, g.chat);
  const grp = gid ? await chats.get(gid) : null;
  const lines = [t(lang, 'chp.title_d', { title: title(g) }), t(lang, 'chp.intro_d'), ''];
  const kb = [];
  if (!gid) lines.push(t(lang, 'chp.d_none'));
  else {
    lines.push(t(lang, 'chp.d_group', { title: iso((grp && grp.title) || String(gid), 48) }));
    const ready = grp && Number(grp.active) && Number(grp.registered) && grp.bot_status === 'administrator';
    lines.push(t(lang, ready ? 'chp.d_ready' : 'chp.d_missing'));
    if (ready) kb.push([btn(t(lang, 'chp.btn_open_group'), `g:${gid}`)]);
    else kb.push([urlBtn(t(lang, 'chp.btn_add_group'), addToGroupUrl((await me(ctx)).username))]);
  }
  kb.push([settingBtn(lang, c, s, 'dg_members', 'D'), settingBtn(lang, c, s, 'dg_as_channel', 'D')],
    [settingBtn(lang, c, s, 'dg_imp', 'D'), settingBtn(lang, c, s, 'dg_first', 'D')], back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-discussion');
}

async function dmScreen(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const lines = [t(lang, 'chp.title_h', { title: title(g) }), t(lang, 'chp.intro_h'), ''];
  lines.push(t(lang, Number(g.chat.dm_chat) ? 'chp.h_seen' : 'chp.h_unseen'));
  if (botRights(g).can_manage_direct_messages !== true) lines.push(t(lang, 'chp.h_need_right'));
  const kb = [[settingBtn(lang, c, s, 'dm_on', 'H')], [settingBtn(lang, c, s, 'dm_links', 'H'), settingBtn(lang, c, s, 'dm_scam', 'H')],
    [settingBtn(lang, c, s, 'dm_fakes', 'H'), settingBtn(lang, c, s, 'dm_flood', 'H')], [settingBtn(lang, c, s, 'dm_suggest', 'H')], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-dms');
}

async function extrasScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const s = await settings.all(ctx, c);
  const nb = ((parseButtons(s.ch_buttons || '').rows) || []).flat().length;
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chp.title_e', { title: title(g) }), t(lang, 'chp.intro_e'), '');
  lines.push(t(lang, 'chp.e_footer', { text: s.ch_footer ? iso(s.ch_footer, 100) : t(lang, 'chp.v_none') }));
  lines.push(t(lang, 'chp.e_buttons', { n: num(lang, nb) }));
  if (botRights(g).can_edit_messages !== true) lines.push('', t(lang, 'chp.need_edit'));
  const kb = [[btn(t(lang, 'chp.btn_footer'), `g:${c}:E:i:footer`), btn(t(lang, 'chp.btn_buttons'), `g:${c}:E:i:buttons`)],
    [settingBtn(lang, c, s, 'ch_post_ttl', 'E')], [settingBtn(lang, c, s, 'ch_protect', 'E'), settingBtn(lang, c, s, 'ch_silent', 'E')], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'channel-extras');
}

/* ---------- entry points ---------- */

export async function callback(ctx, user, g, parts, place) {
  if (!isChannel(g)) return null;
  const sec = parts[2];
  const sub = parts[3];
  switch (sec) {
    case 'J': return joinAction(ctx, user, g, parts, place);
    case 'M': return memberAction(ctx, user, g, parts, place);
    case 'I': return sub ? linkAction(ctx, user, g, parts, place) : linksScreen(ctx, user, g, place);
    case 'Q': return sub ? fraudAction(ctx, user, g, parts, place) : fraudScreen(ctx, user, g, place);
    case 'A':
      if (sub === 's') await toggle(ctx, user, g, parts[4]);
      return alertsScreen(ctx, user, { ...g, chat: await chats.get(g.chat.chat_id) }, place);
    case 'D':
      if (sub === 's') await toggle(ctx, user, g, parts[4]);
      return discussionScreen(ctx, user, g, place);
    case 'H':
      if (sub === 's') await toggle(ctx, user, g, parts[4]);
      return dmScreen(ctx, user, g, place);
    case 'E':
      if (sub === 's') await toggle(ctx, user, g, parts[4]);
      if (sub === 'i' && ['footer', 'buttons'].includes(parts[4])) {
        if (!(await needLevel(ctx, user, g, L.settings))) return null;
        await state.set(user.user_id, 'ch_input', { chat: g.chat.chat_id, key: parts[4] });
        await answer(ctx);
        return send(ctx, user.user_id, t(user.lang, `chp.prompt_${parts[4]}`, { max: FOOTER_MAX }), null, `ch-${parts[4]}`);
      }
      return extrasScreen(ctx, user, g, place);
    default: return null;
  }
}

/* A user (shared, forwarded, numeric id or a @username Aegis has met), or an error key. */
async function userOf(message) {
  const text = String(message.text || '').trim();
  const origin = message.forward_origin;
  if (message.users_shared && Array.isArray(message.users_shared.users) && message.users_shared.users.length) return { id: message.users_shared.users[0].user_id };
  if (origin && origin.type === 'hidden_user') return { error: 'chat.pick_hidden' };
  if (origin && origin.type === 'user' && origin.sender_user) return { id: origin.sender_user.id };
  if (/^\d{4,16}$/.test(text)) return { id: toInt(text) };
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) {
    const known = await users.byUsername(text.slice(1));
    return known ? { id: Number(known.user_id) } : { error: 'chat.pick_username_unknown' };
  }
  return { error: 'chat.pick_bad' };
}

/* A fake: @username, t.me/username, a -100… id, or a forwarded post / message from it. */
function fakeOf(message) {
  const o = message.forward_origin;
  if (o && o.type === 'channel' && o.chat) return o.chat.username ? `@${o.chat.username}` : String(o.chat.id);
  if (o && o.type === 'user' && o.sender_user) return o.sender_user.username ? `@${o.sender_user.username}` : String(o.sender_user.id);
  const text = String(message.text || '').trim();
  const m = /^(?:https?:\/\/)?(?:t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(text);
  if (m) return `@${m[1]}`;
  if (/^-?\d{5,16}$/.test(text)) return text;
  return null;
}

export async function input(ctx, user, message, pending) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'input-cancelled', removeKeyboard);
  }
  return handleInput(ctx, user, message, pending, pending.data.key, text);
}

async function handleInput(ctx, user, message, pending, key, text) {
  const lang = user.lang;
  const g = await guard(ctx, user, pending.data.chat, L.settings, null);
  if (!g || !isChannel(g)) {
    await state.clear(user.user_id);
    return null;
  }
  const c = g.chat.chat_id;
  const again = (k, vars = {}) => send(ctx, user.user_id, t(lang, k, vars), null, `ch-${key}-again`);
  if (key === 'member') {
    const r = await userOf(message);
    if (r.error) return again(r.error);
    await state.clear(user.user_id);
    await send(ctx, user.user_id, t(lang, 'chp.found'), null, 'ch-find-done', removeKeyboard);
    return memberCard(ctx, user, g, r.id, null);
  }
  if (key === 'fake') {
    const f = fakeOf(message);
    if (!f) return again('chp.fake_bad');
    const s = await settings.all(ctx, c);
    const list = parseJson(s.ch_fakes, []) || [];
    if (!list.map((x) => x.toLowerCase()).includes(f.toLowerCase())) list.push(f);
    if (list.length > FAKES_MAX || !(await settings.set(ctx, c, 'ch_fakes', JSON.stringify(list), user.user_id))) return again('chp.fakes_full', { max: FAKES_MAX });
    await state.clear(user.user_id);
    return fraudScreen(ctx, user, g, null, t(lang, 'chp.fake_added', { name: iso(f, 40) }));
  }
  if (key === 'link_name') {
    const row = await invites.get(Number(pending.data.id));
    if (!row || Number(row.chat_id) !== c) {
      await state.clear(user.user_id);
      return linksScreen(ctx, user, g, null);
    }
    if (!text || [...text].length > INVITE_NAME_MAX) return again('chp.rename_prompt', { max: INVITE_NAME_MAX });
    await state.clear(user.user_id);
    try {
      const link = await call(ctx, 'editChatInviteLink', { chat_id: c, invite_link: row.link, name: text, expire_date: Number(row.expire_at) || undefined,
        member_limit: Number(row.member_limit) || undefined, creates_join_request: Number(row.requests) ? true : undefined }, 'ch-link-rename');
      await invites.update(row.id, link);
      return linkScreen(ctx, user, g, await invites.get(row.id), null, t(lang, 'chp.saved'));
    } catch (err) {
      return linkScreen(ctx, user, g, row, null, t(lang, 'chat.tg_error', { error: esc(describeError(err)) }));
    }
  }
  if (key === 'footer' || key === 'buttons') {
    if (!text) return again(`chp.prompt_${key}`, { max: FOOTER_MAX });
    const value = text === '-' ? '' : text;
    if (key === 'buttons' && value) {
      const p = parseButtons(value);
      if (p.error) return again(`bc.buttons_err_${p.error}`, { line: p.line });
    }
    if (!(await settings.set(ctx, c, key === 'footer' ? 'ch_footer' : 'ch_buttons', value, user.user_id))) return again('adv.too_long');
    await state.clear(user.user_id);
    return extrasScreen(ctx, user, g, null, t(lang, 'chp.saved'));
  }
  await state.clear(user.user_id);
  return null;
}
