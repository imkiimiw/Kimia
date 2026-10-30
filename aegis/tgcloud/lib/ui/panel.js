/*
 * The private panel of one group or channel, and «پیکربندی» (the list of a user's chats).
 * Every action re-checks the person live (getChatMember): someone who is no longer an admin is
 * revoked and sent back; the needed access level is checked per action (engines/admins.js).
 *
 * callback_data (chat id c, user id u):
 *   cl[:page]            my chats
 *   g:c                  panel root               g:c:x        re-check admins and the bot's rights
 *   g:c:p[:r]            the bot's permissions (r: re-check)
 *   g:c:a                admins                   g:c:a:n      appoint: asks for the member
 *   g:c:a:e:u            edit an Aegis admin      g:c:a:t:u:i  toggle right i in the editor
 *   g:c:a:s:u            save → confirm           g:c:a:b:u    back to the editor
 *   g:c:a:y:u            confirmed: promote/edit  g:c:a:d:u    remove admin? → g:c:a:dy:u
 *   g:c:a:i:u            why an admin appointed outside Aegis can't be managed
 *   g:c:l                access levels            g:c:l:u      choose a level → g:c:l:u:<0-3|d|3y>
 *   g:c:g[:lang]         the chat's language      g:c:r        reminder on/off
 *   g:c:h                change log
 *   g:c:K…               locks — ui/panel_locks.js
 *   g:c:S…  g:c:F…       security, federation — ui/panel_security.js, ui/panel_fed.js
 *   g:c:V…  g:c:T…       advanced settings, forum topics — ui/panel_adv.js, ui/panel_topics.js
 *   g:c:L… g:c:P… g:c:W… g:c:B… g:c:U… g:c:O…   lists, punishments, warnings and steps,
 *                        anti-betrayal, Audit Mode, log channel — ui/panel_mod.js
 * Pending inputs (aegis_states): adm_pick { chat } — the member to appoint (shared user, forwarded
 * message, numeric id or a known @username); adm_edit { chat, target, mode, rights, name } — the
 * rights being edited.
 */
import { CHATS_PAGE, LANGS, LOG_PAGE } from '../config.js';
import * as audit from '../core/audit.js';
import { me } from '../core/bot.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send, urlBtn } from '../core/tg.js';
import { esc, iso, normalizeWord, nowSec, parseJson, short, toInt } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as chats from '../engines/chats.js';
import * as settings from '../engines/settings.js';
import { addToChannelUrl, addToGroupUrl, canManageAdmins as typeCanManage, grantable, rightsOf } from '../engines/rights.js';
import * as users from '../engines/users.js';
import { dur, has, langFlag, langName, t } from '../i18n/index.js';
import { grantLink, rightsLines } from './group.js';
import { back, guard, levelName, pairs, removeKeyboard, rowName, typeIcon } from './guard.js';
import * as advPanel from './panel_adv.js';
import * as fedPanel from './panel_fed.js';
import * as lockPanel from './panel_locks.js';
import * as mod from './panel_mod.js';
import * as secPanel from './panel_security.js';
import * as topicPanel from './panel_topics.js';

const { L } = admins;
const PRESET = {
  group: ['can_delete_messages', 'can_restrict_members', 'can_invite_users', 'can_pin_messages'],
  channel: ['can_post_messages', 'can_edit_messages', 'can_delete_messages', 'can_invite_users'],
};

/* ---------- my chats ---------- */

export async function chatsList(ctx, user, page = 0, place = null) {
  const lang = user.lang;
  const list = await admins.chatsOf(user.user_id);
  const pages = Math.max(1, Math.ceil(list.length / CHATS_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const text = [t(lang, 'chat.list_title'), '', t(lang, list.length ? 'chat.list_intro' : 'chat.list_empty')].join('\n');
  const rows = list.slice(p * CHATS_PAGE, (p + 1) * CHATS_PAGE)
    .map((c) => [btn(`${typeIcon(c.type)} ${short(c.title || c.chatId, 36)} · ${levelName(lang, c.level)}`, `g:${c.chatId}`)]);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(btn('◀️', `cl:${p - 1}`));
    nav.push(btn(`${p + 1}/${pages}`, `cl:${p}`));
    if (p < pages - 1) nav.push(btn('▶️', `cl:${p + 1}`));
    rows.push(nav);
  }
  const bot = (await me(ctx)).username;
  rows.push([urlBtn(t(lang, 'start.btn_add_group'), addToGroupUrl(bot)), urlBtn(t(lang, 'start.btn_add_channel'), addToChannelUrl(bot))]);
  rows.push(back(lang, 'mm'));
  return screen(ctx, user.user_id, place, text, rows, 'my-chats');
}

/* ---------- root, permissions, re-check ---------- */

async function root(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const { chat, acc } = g;
  const c = chat.chat_id;
  const botId = (await me(ctx)).id;
  const missing = parseJson(chat.missing, null);
  const outside = admins.notViaAegis(await admins.listRows(c), botId);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chat.root_title', { title: iso(chat.title || '', 48), type: t(lang, `chat.type_${chat.type}`) }));
  lines.push(t(lang, 'chat.root_level', { level: levelName(lang, acc.level) }));
  if (missing === null) lines.push(t(lang, 'chat.root_rights_unknown'));
  else if (missing.length) lines.push(t(lang, 'chat.root_rights_missing', { list: missing.map((m) => t(lang, `rights.req_${m}`)).join(t(lang, 'common.sep')) }));
  else lines.push(t(lang, 'chat.root_rights_ok'));
  if (outside.length) lines.push(t(lang, 'chat.root_outside', { n: outside.length }));
  if (chat.type === 'group') lines.push('', t(lang, 'group.basic_group'));
  const s = await settings.all(ctx, c);
  if (settings.flag(s, 'audit')) lines.push('', t(lang, 'chat.root_audit'));
  const rows = [
    [btn(t(lang, 'chat.btn_locks'), `g:${c}:K`), btn(t(lang, 'chat.btn_security'), `g:${c}:S`)],
    [btn(t(lang, 'chat.btn_lists'), `g:${c}:L`), btn(t(lang, 'chat.btn_punish'), `g:${c}:P`)],
    [btn(t(lang, 'chat.btn_warns'), `g:${c}:W`), btn(t(lang, 'chat.btn_betray'), `g:${c}:B`)],
    [btn(t(lang, 'chat.btn_fed'), `g:${c}:F`), btn(t(lang, settings.flag(s, 'audit') ? 'chat.btn_audit_on' : 'chat.btn_audit_off'), `g:${c}:U`)],
    [btn(t(lang, 'chat.btn_adv'), `g:${c}:V`), btn(t(lang, 'chat.btn_topics'), `g:${c}:T`)],
    [btn(t(lang, 'chat.btn_logs'), `g:${c}:O`)],
    [btn(t(lang, 'chat.btn_perms'), `g:${c}:p`), btn(t(lang, 'chat.btn_admins'), `g:${c}:a`)],
    [btn(t(lang, 'chat.btn_access'), `g:${c}:l`), btn(t(lang, 'chat.btn_lang'), `g:${c}:g`)],
    [btn(t(lang, Number(chat.reminder) ? 'chat.btn_reminder_on' : 'chat.btn_reminder_off'), `g:${c}:r`), btn(t(lang, 'chat.btn_log'), `g:${c}:h`)],
    [btn(t(lang, 'chat.btn_recheck'), `g:${c}:x`)],
    [btn(t(lang, 'chat.btn_my_chats'), 'cl')],
  ];
  return screen(ctx, user.user_id, place, lines.join('\n'), rows, 'panel');
}

async function refreshBotRights(ctx, chat) {
  const botId = (await me(ctx)).id;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.chat_id, user_id: botId }, 'bot-rights');
    await chats.setBotRights(chat.chat_id, chat.type, m);
  } catch (err) {
    console.warn(`bot rights ${chat.chat_id}: ${describeError(err)}`);
  }
}

async function permissions(ctx, user, g, place, recheck) {
  const lang = user.lang;
  let { chat } = g;
  if (recheck) {
    await refreshBotRights(ctx, chat);
    chat = await chats.get(chat.chat_id);
  }
  const missing = parseJson(chat.missing, []);
  const lines = [t(lang, 'chat.perms_title', { title: iso(chat.title || '', 48) }), '', ...rightsLines(lang, missing), '',
    t(lang, missing.length ? 'chat.perms_fix' : 'chat.perms_all_ok'), '', t(lang, 'group.rule')];
  const rows = [];
  if (missing.length) rows.push([urlBtn(t(lang, 'group.btn_grant'), grantLink((await me(ctx)).username, chat))]);
  rows.push([btn(t(lang, 'chat.btn_recheck'), `g:${chat.chat_id}:p:r`)], back(lang, `g:${chat.chat_id}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), rows, 'panel-perms');
}

/* ---------- admins ---------- */

async function adminsScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const { chat, acc } = g;
  const c = chat.chat_id;
  const botId = (await me(ctx)).id;
  const rows = (await admins.listRows(c)).filter((r) => Number(r.user_id) !== botId);
  const ov = await admins.overrides(c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chat.admins_title', { title: iso(chat.title || '', 48) }), '');
  const buttons = [];
  let outside = 0;
  for (const r of rows) {
    const m = admins.memberOfRow(r);
    const o = ov.get(Number(r.user_id));
    const level = levelName(lang, admins.effectiveLevel(m, o ? o.level : null));
    const vars = { name: iso(rowName(r)), level };
    if (r.status === 'creator') lines.push(t(lang, 'chat.admin_creator', vars));
    else if (Number(r.via_aegis)) {
      lines.push(t(lang, 'chat.admin_aegis', vars));
      buttons.push(btn(`✏️ ${short(rowName(r), 24)}`, `g:${c}:a:e:${r.user_id}`));
    } else {
      outside += 1;
      lines.push(t(lang, Number(r.is_bot) ? 'chat.admin_bot' : 'chat.admin_outside', vars));
      buttons.push(btn(`ℹ️ ${short(rowName(r), 24)}`, `g:${c}:a:i:${r.user_id}`));
    }
  }
  lines.push('', t(lang, 'chat.admins_legend'));
  if (outside) lines.push('', t(lang, 'chat.admins_outside_hint', { n: outside }));
  if (!typeCanManage(chat.type)) lines.push('', t(lang, 'chat.basic_no_admins'));
  const kb = pairs(buttons.slice(0, 20));
  if (typeCanManage(chat.type) && admins.canManageAdmins(acc)) kb.push([btn(t(lang, 'chat.btn_appoint'), `g:${c}:a:n`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-admins');
}

/* Why `g.acc` can't manage admins here (a locale key), or null. */
function appointBlock(g) {
  const botRights = parseJson(g.chat.bot_rights, {});
  if (!typeCanManage(g.chat.type)) return 'chat.basic_no_admins';
  if (!admins.canManageAdmins(g.acc)) return 'chat.block_no_rights';
  if (botRights.can_promote_members !== true) return 'chat.bot_cant_promote';
  return null;
}

async function startAppoint(ctx, user, g) {
  const lang = user.lang;
  const why = appointBlock(g);
  if (why) {
    await answer(ctx, t(lang, why), true);
    return null;
  }
  await state.set(user.user_id, 'adm_pick', { chat: g.chat.chat_id });
  await answer(ctx);
  const keyboard = {
    keyboard: [[{ text: t(lang, 'chat.pick_button'), request_users: { request_id: 1, max_quantity: 1 } }], [{ text: t(lang, 'common.cancel') }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  return send(ctx, user.user_id, t(lang, 'chat.pick_prompt', { title: iso(g.chat.title || '', 48) }), null, 'appoint-pick', { reply_markup: keyboard });
}

/* Live target info: { member, level, promoter } (member null when Telegram can't tell). */
async function targetInfo(ctx, chatId, targetId) {
  let member = null;
  try {
    member = await call(ctx, 'getChatMember', { chat_id: chatId, user_id: targetId }, 'target');
    await admins.cacheMember(chatId, member);
  } catch (err) {
    return { member: null, level: 0, promoter: 0 };
  }
  return { member, level: admins.effectiveLevel(member, await admins.overrideOf(chatId, targetId)), promoter: await admins.promoterOf(chatId, targetId) };
}

const nameOf = (member, fallback) => (member && member.user ? (member.user.first_name || (member.user.username ? `@${member.user.username}` : String(member.user.id))) : String(fallback));

function allowedRights(g) {
  return admins.grantableBy(g.chat.type, g.acc, parseJson(g.chat.bot_rights, {}));
}

/* The member to appoint, while adm_pick is pending. */
export async function pickInput(ctx, user, message, data) {
  const lang = user.lang;
  const text = String(message.text || '').trim();
  if (text && normalizeWord(text) === normalizeWord(t(lang, 'common.cancel'))) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, 'common.cancelled'), null, 'appoint-cancelled', removeKeyboard);
  }
  let targetId = null;
  const origin = message.forward_origin;
  if (message.users_shared && Array.isArray(message.users_shared.users) && message.users_shared.users.length) targetId = message.users_shared.users[0].user_id;
  else if (origin && origin.type === 'hidden_user') return send(ctx, user.user_id, t(lang, 'chat.pick_hidden'), null, 'appoint-hidden');
  else if (origin && origin.type === 'user' && origin.sender_user) targetId = origin.sender_user.id;
  else if (/^\d{4,16}$/.test(text)) targetId = toInt(text);
  else if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) {
    const known = await users.byUsername(text.slice(1));
    if (!known) return send(ctx, user.user_id, t(lang, 'chat.pick_username_unknown'), null, 'appoint-username');
    targetId = Number(known.user_id);
  } else return send(ctx, user.user_id, t(lang, 'chat.pick_bad'), null, 'appoint-bad');
  const g = await guard(ctx, user, data.chat, L.full, null);
  if (!g) {
    await state.clear(user.user_id);
    return null;
  }
  const why = appointBlock(g);
  if (why) {
    await state.clear(user.user_id);
    return send(ctx, user.user_id, t(lang, why), null, 'appoint-blocked', removeKeyboard);
  }
  const target = await targetInfo(ctx, g.chat.chat_id, targetId);
  const m = target.member;
  let error = null;
  if (!m || m.status === 'left' || m.status === 'kicked' || (m.status === 'restricted' && m.is_member === false)) error = 'chat.pick_not_member';
  else if (m.status === 'creator') error = 'chat.block_creator';
  else if (m.status === 'administrator' && !m.can_be_edited) error = 'chat.block_not_via_aegis';
  if (error) return send(ctx, user.user_id, t(lang, error, { name: iso(nameOf(m, targetId)) }), null, 'appoint-target-bad');
  const name = nameOf(m, targetId);
  await send(ctx, user.user_id, t(lang, 'chat.pick_selected', { name: iso(name) }), null, 'appoint-selected', removeKeyboard);
  const allowed = allowedRights(g);
  if (m.status === 'administrator') {
    const block = admins.manageBlock(g.acc, target);
    if (block) {
      await state.clear(user.user_id);
      return send(ctx, user.user_id, t(lang, `chat.block_${block}`, { name: iso(name) }), [back(lang, `g:${g.chat.chat_id}:a`)], 'appoint-block');
    }
    const current = Object.keys(rightsOf(m)).filter((r) => grantable(g.chat.type).includes(r));
    await state.set(user.user_id, 'adm_edit', { chat: g.chat.chat_id, target: targetId, mode: 'edit', rights: current, name });
  } else {
    const preset = PRESET[g.chat.type === 'channel' ? 'channel' : 'group'].filter((r) => allowed.includes(r));
    await state.set(user.user_id, 'adm_edit', { chat: g.chat.chat_id, target: targetId, mode: 'promote', rights: preset, name });
  }
  return editor(ctx, user, g, await state.get(user.user_id), null);
}

async function editor(ctx, user, g, st, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const all = grantable(g.chat.type);
  const allowed = allowedRights(g);
  const lines = [t(lang, st.data.mode === 'promote' ? 'chat.edit_title_promote' : 'chat.edit_title_edit', { name: iso(st.data.name), title: iso(g.chat.title || '', 48) }),
    '', t(lang, 'chat.edit_hint')];
  if (allowed.includes('can_promote_members')) lines.push('', t(lang, 'chat.edit_promote_warning'));
  const buttons = all.map((r, i) => {
    const on = st.data.rights.includes(r);
    const mark = !allowed.includes(r) ? (on ? '🔒✅' : '🔒') : (on ? '✅' : '▫️');
    return btn(`${mark} ${t(lang, `rights.${r}`)}`, `g:${c}:a:t:${st.data.target}:${i}`);
  });
  const kb = pairs(buttons);
  kb.push([btn(t(lang, 'chat.btn_save'), `g:${c}:a:s:${st.data.target}`)]);
  if (st.data.mode === 'edit') kb.push([btn(t(lang, 'chat.btn_demote'), `g:${c}:a:d:${st.data.target}`)]);
  kb.push([btn(t(lang, 'common.cancel'), `g:${c}:a`)]);
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'admin-editor');
}

/* The pending editor for (chat, target), or null (then the user is told it expired). */
async function editorState(ctx, user, c, targetId) {
  const st = await state.get(user.user_id);
  if (st && st.kind === 'adm_edit' && st.data.chat === c && st.data.target === targetId) return st;
  await answer(ctx, t(user.lang, 'chat.edit_expired'), true);
  return null;
}

async function adminAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const [, , , action, a, b] = parts;
  if (!action) return adminsScreen(ctx, user, g, place);
  if (action === 'n') return startAppoint(ctx, user, g);
  const targetId = toInt(a);
  if (targetId === null) return adminsScreen(ctx, user, g, place);
  if (action === 'i') {
    const r = await admins.getRow(c, targetId);
    return screen(ctx, user.user_id, place, t(lang, 'chat.outside_info', { name: iso(r ? rowName(r) : targetId) }), [back(lang, `g:${c}:a`)], 'admin-outside');
  }
  if (g.acc.level < L.full) {
    await answer(ctx, t(lang, 'chat.need_level', { level: levelName(lang, L.full), yours: levelName(lang, g.acc.level) }), true);
    return null;
  }
  const target = await targetInfo(ctx, c, targetId);
  const name = nameOf(target.member, targetId);
  const blocked = async (code) => {
    await answer(ctx, t(lang, `chat.block_${code}`, { name }), true);
    return adminsScreen(ctx, user, g, place);
  };
  if (action === 'e') {
    const block = admins.manageBlock(g.acc, target);
    if (block) return blocked(block);
    const current = Object.keys(rightsOf(target.member)).filter((r) => grantable(g.chat.type).includes(r));
    await state.set(user.user_id, 'adm_edit', { chat: c, target: targetId, mode: 'edit', rights: current, name });
    return editor(ctx, user, g, await state.get(user.user_id), place);
  }
  if (action === 'd' || action === 'dy') {
    const block = admins.manageBlock(g.acc, target);
    if (block) return blocked(block);
    if (action === 'd') {
      const kb = [[btn(t(lang, 'chat.btn_demote_yes'), `g:${c}:a:dy:${targetId}`), btn(t(lang, 'common.back'), `g:${c}:a:e:${targetId}`)]];
      return screen(ctx, user.user_id, place, t(lang, 'chat.demote_q', { name: iso(name), title: iso(g.chat.title || '', 48) }), kb, 'admin-demote?');
    }
    try {
      await admins.demote(ctx, g.chat, user.user_id, targetId);
    } catch (err) {
      return screen(ctx, user.user_id, place, t(lang, 'chat.tg_error', { error: describeError(err) }), [back(lang, `g:${c}:a`)], 'admin-error');
    }
    await state.clear(user.user_id);
    return adminsScreen(ctx, user, g, place, t(lang, 'chat.done_demote', { name: iso(name) }));
  }
  const st = await editorState(ctx, user, c, targetId);
  if (!st) return adminsScreen(ctx, user, g, place);
  const allowed = allowedRights(g);
  if (action === 't') {
    const right = grantable(g.chat.type)[toInt(b)];
    if (!right) return editor(ctx, user, g, st, place);
    if (!allowed.includes(right)) {
      await answer(ctx, t(lang, 'chat.right_locked'), true);
      return null;
    }
    const set = new Set(st.data.rights);
    if (set.has(right)) set.delete(right);
    else set.add(right);
    st.data.rights = [...set];
    await state.set(user.user_id, 'adm_edit', st.data);
    return editor(ctx, user, g, st, place);
  }
  if (action === 'b') return editor(ctx, user, g, st, place);
  /* Rights the editor can't grant keep the target's live value: they can be neither given nor taken. */
  const liveRights = st.data.mode === 'edit' ? rightsOf(target.member) : {};
  const chosen = grantable(g.chat.type).filter((r) => (allowed.includes(r) ? st.data.rights.includes(r) : liveRights[r] === true));
  if (!chosen.length) {
    await answer(ctx, t(lang, 'chat.edit_empty'), true);
    return null;
  }
  if (action === 's') {
    const list = chosen.map((r) => t(lang, 'group.right_item', { name: t(lang, `rights.${r}`) }));
    const key = st.data.mode === 'promote' ? 'chat.confirm_promote' : 'chat.confirm_edit';
    const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:a:y:${targetId}`), btn(t(lang, 'common.back'), `g:${c}:a:b:${targetId}`)]];
    return screen(ctx, user.user_id, place, [t(lang, key, { name: iso(st.data.name), title: iso(g.chat.title || '', 48) }), '', ...list].join('\n'), kb, 'admin-confirm');
  }
  if (action !== 'y') return editor(ctx, user, g, st, place);
  const why = appointBlock(g);
  if (why) {
    await answer(ctx, t(lang, why), true);
    return null;
  }
  const m = target.member;
  if (st.data.mode === 'promote') {
    if (!m || !['member', 'restricted'].includes(m.status) || (m.status === 'restricted' && m.is_member === false)) {
      await state.clear(user.user_id);
      return blocked(m && m.status === 'administrator' ? 'not_via_aegis' : 'not_admin');
    }
  } else {
    const block = admins.manageBlock(g.acc, target);
    if (block) {
      await state.clear(user.user_id);
      return blocked(block);
    }
  }
  try {
    await admins.applyRights(ctx, g.chat, user.user_id, targetId, chosen, st.data.mode);
  } catch (err) {
    return screen(ctx, user.user_id, place, t(lang, 'chat.tg_error', { error: describeError(err) }), [back(lang, `g:${c}:a`)], 'admin-error');
  }
  await state.clear(user.user_id);
  return adminsScreen(ctx, user, g, place, t(lang, st.data.mode === 'promote' ? 'chat.done_promote' : 'chat.done_edit', { name: iso(st.data.name) }));
}

/* ---------- access levels ---------- */

async function accessScreen(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const { chat, acc } = g;
  const c = chat.chat_id;
  const botId = (await me(ctx)).id;
  const rows = (await admins.listRows(c)).filter((r) => Number(r.user_id) !== botId && !Number(r.is_bot));
  const ov = await admins.overrides(c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'chat.access_title', { title: iso(chat.title || '', 48) }), t(lang, 'chat.access_yours', { level: levelName(lang, acc.level) }), '');
  const buttons = [];
  for (const r of rows) {
    const uid = Number(r.user_id);
    const m = admins.memberOfRow(r);
    const o = ov.get(uid);
    const level = admins.effectiveLevel(m, o ? o.level : null);
    if (r.status === 'creator') {
      lines.push(t(lang, 'chat.access_item_creator', { name: iso(rowName(r)) }));
      continue;
    }
    lines.push(t(lang, o ? 'chat.access_item_manual' : 'chat.access_item_default', { name: iso(rowName(r)), level: levelName(lang, level) }));
    const changeable = uid !== acc.id && [L.full, L.settings, L.view, L.none, null].some((n) => admins.canSetLevel(acc.level, level, n, false));
    if (changeable) buttons.push(btn(`🔑 ${short(rowName(r), 24)}`, `g:${c}:l:${uid}`));
  }
  lines.push('', t(lang, 'chat.access_legend'));
  const kb = pairs(buttons.slice(0, 20));
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-access');
}

async function accessAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const [, , , a, b] = parts;
  if (a === undefined) return accessScreen(ctx, user, g, place);
  const targetId = toInt(a);
  if (targetId === null || targetId === user.user_id) return accessScreen(ctx, user, g, place);
  if (g.acc.level < L.full) {
    await answer(ctx, t(lang, 'chat.need_level', { level: levelName(lang, L.full), yours: levelName(lang, g.acc.level) }), true);
    return null;
  }
  const target = await targetInfo(ctx, c, targetId);
  const m = target.member;
  const name = nameOf(m, targetId);
  if (!m || !['administrator', 'creator'].includes(m.status) || (m.user && m.user.is_bot)) {
    await answer(ctx, t(lang, 'chat.block_not_admin', { name }), true);
    return accessScreen(ctx, user, g, place);
  }
  const isCreator = m.status === 'creator';
  const override = await admins.overrideOf(c, targetId);
  if (b === undefined) {
    const options = [L.full, L.settings, L.view, L.none].filter((n) => admins.canSetLevel(g.acc.level, target.level, n, isCreator));
    const kb = pairs(options.map((n) => btn(`${override === n ? '✓ ' : ''}${levelName(lang, n)}`, `g:${c}:l:${targetId}:${n}`)));
    if (override !== null && admins.canSetLevel(g.acc.level, target.level, null, isCreator)) kb.push([btn(t(lang, 'chat.btn_level_default'), `g:${c}:l:${targetId}:d`)]);
    kb.push(back(lang, `g:${c}:l`));
    const text = t(lang, 'chat.access_choose', { name: iso(name), level: levelName(lang, target.level),
      source: t(lang, override === null ? 'chat.access_source_default' : 'chat.access_source_manual') });
    return screen(ctx, user.user_id, place, text, kb, 'access-choose');
  }
  const confirmed = b === '3y';
  const next = b === 'd' ? null : toInt(confirmed ? '3' : b);
  if (next !== null && (next < L.none || next > L.full)) return accessScreen(ctx, user, g, place);
  if (!admins.canSetLevel(g.acc.level, target.level, next, isCreator)) {
    const why = isCreator ? 'chat.block_creator' : (target.level >= g.acc.level ? 'chat.block_higher' : 'chat.block_level');
    await answer(ctx, t(lang, why, { name }), true);
    return accessScreen(ctx, user, g, place);
  }
  if (next === L.full && !confirmed) {
    const kb = [[btn(t(lang, 'chat.btn_confirm'), `g:${c}:l:${targetId}:3y`), btn(t(lang, 'common.back'), `g:${c}:l:${targetId}`)]];
    return screen(ctx, user.user_id, place, t(lang, 'chat.access_full_q', { name: iso(name) }), kb, 'access-full?');
  }
  await admins.setLevel(c, targetId, next, user.user_id);
  const shown = next === null ? admins.defaultLevel(m) : next;
  return accessScreen(ctx, user, g, place, t(lang, 'chat.access_done', { name: iso(name), level: levelName(lang, shown) }));
}

/* ---------- language, reminder, change log ---------- */

async function langAction(ctx, user, g, parts, place) {
  const lang = user.lang;
  const { chat } = g;
  const c = chat.chat_id;
  const pick = parts[3];
  if (pick && LANGS.includes(pick)) {
    if (g.acc.level < L.settings) {
      await answer(ctx, t(lang, 'chat.need_level', { level: levelName(lang, L.settings), yours: levelName(lang, g.acc.level) }), true);
      return null;
    }
    if (pick !== chat.lang) {
      await chats.setLang(c, pick);
      await audit.log(user.user_id, 'chat.lang', { chatId: c, details: { from: chat.lang, to: pick } });
    }
    return root(ctx, user, { ...g, chat: await chats.get(c) }, place, t(lang, 'chat.lang_done', { name: langName(pick) }));
  }
  const b = (l) => btn(`${l === chat.lang ? '✓ ' : ''}${langFlag(l)} ${langName(l)}`, `g:${c}:g:${l}`);
  const kb = [[b('fa'), b('en')], [b('ru'), b('zh')], [b('fr')], back(lang, `g:${c}`)];
  return screen(ctx, user.user_id, place, t(lang, 'chat.lang_title', { title: iso(chat.title || '', 48), name: langName(chat.lang) }), kb, 'panel-lang');
}

async function reminderToggle(ctx, user, g, place) {
  const lang = user.lang;
  if (g.acc.level < L.settings) {
    await answer(ctx, t(lang, 'chat.need_level', { level: levelName(lang, L.settings), yours: levelName(lang, g.acc.level) }), true);
    return null;
  }
  const on = !Number(g.chat.reminder);
  await chats.setReminder(g.chat.chat_id, on);
  await audit.log(user.user_id, 'chat.reminder', { chatId: g.chat.chat_id, details: { on } });
  return root(ctx, user, { ...g, chat: await chats.get(g.chat.chat_id) }, place, t(lang, on ? 'chat.reminder_on' : 'chat.reminder_off'));
}

async function nameMap(chatId, ids) {
  const out = new Map();
  for (const r of await admins.listRows(chatId)) out.set(Number(r.user_id), rowName(r));
  for (const id of ids) {
    if (!id || out.has(id)) continue;
    const u = await users.get(id);
    if (u) out.set(id, u.first_name || (u.username ? `@${u.username}` : String(id)));
  }
  return out;
}

async function logScreen(ctx, user, g, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const rows = await audit.forChat(c, LOG_PAGE);
  const ids = [];
  for (const r of rows) ids.push(Number(r.actor_id), Number(r.target) || 0);
  const names = await nameMap(c, ids);
  const who = (id) => (id ? iso(names.get(id) || String(id)) : t(lang, 'log.system'));
  const lines = [t(lang, 'log.title', { title: iso(g.chat.title || '', 48) }), ''];
  if (!rows.length) lines.push(t(lang, 'log.empty'));
  const now = nowSec();
  for (const r of rows) {
    const details = parseJson(r.details, {}) || {};
    const key = `log.${String(r.action).replace(/\./g, '_')}`;
    const vars = {
      target: who(Number(r.target) || 0),
      level: details.to === null || details.to === undefined ? t(lang, 'chat.access_source_default') : levelName(lang, Number(details.to)),
      lang: details.to && LANGS.includes(details.to) ? langName(details.to) : '',
      state: t(lang, details.on ? 'common.on' : 'common.off'),
      status: details.to ? String(details.to) : '',
      key: esc(String(r.target || '')),
      lock: has(`locks.n_${r.target}`) ? t(lang, `locks.n_${r.target}`) : esc(String(r.target || '')),
      module: has(`sec.m_${r.target}`) ? t(lang, `sec.m_${r.target}`) : esc(String(r.target || '')),
    };
    const what = has(key) ? t(lang, key, vars) : t(lang, 'log.other', { action: esc(r.action) });
    lines.push(t(lang, 'log.line', { ago: dur(lang, now - Number(r.at)), who: who(Number(r.actor_id)), what }));
  }
  return screen(ctx, user.user_id, place, lines.join('\n'), [back(lang, `g:${c}`)], 'panel-log');
}

/* ---------- entry points ---------- */

/* /start c_<chat id> (the group's «open panel» button), or a chat picked from the list. */
export async function open(ctx, user, chatId, place = null) {
  const g = await guard(ctx, user, chatId, L.view, place);
  if (!g) return null;
  return root(ctx, user, g, place);
}

export async function callback(ctx, user, parts, place) {
  if (parts[0] === 'cl') return chatsList(ctx, user, toInt(parts[1]) || 0, place);
  const chatId = toInt(parts[1]);
  const section = parts[2];
  const g = await guard(ctx, user, chatId, L.view, place);
  if (!g) return null;
  switch (section) {
    case undefined: return root(ctx, user, g, place);
    case 'x': {
      await admins.refresh(ctx, g.chat.chat_id);
      await refreshBotRights(ctx, g.chat);
      return root(ctx, user, { ...g, chat: await chats.get(g.chat.chat_id) }, place, t(user.lang, 'chat.rechecked'));
    }
    case 'p': return permissions(ctx, user, g, place, parts[3] === 'r');
    case 'a': return adminAction(ctx, user, g, parts, place);
    case 'l': return accessAction(ctx, user, g, parts, place);
    case 'g': return langAction(ctx, user, g, parts, place);
    case 'r': return reminderToggle(ctx, user, g, place);
    case 'h': return logScreen(ctx, user, g, place);
    case 'K': return lockPanel.callback(ctx, user, g, parts, place);
    case 'S': return secPanel.callback(ctx, user, g, parts, place);
    case 'F': return fedPanel.callback(ctx, user, g, parts, place);
    case 'V': return advPanel.callback(ctx, user, g, parts, place);
    case 'T': return topicPanel.callback(ctx, user, g, parts, place);
    case 'L': case 'P': case 'W': case 'B': case 'U': case 'O': return mod.callback(ctx, user, g, parts, place);
    default: return root(ctx, user, g, place);
  }
}
