/*
 * Admin panel (/admin, private chat). Staff = the owner + people the owner added, as one of two
 * roles: admin (approval queue, reports, user lookup and bans, stats) or mod (Phase 5: the approval
 * queue only — approve / reject). The owner also gets settings, forced-join channels, broadcast and
 * the staff list. lib/router.js checks the role (fresh from the database) before anything here
 * runs; owner-only codes are in OWNER_ONLY, the only codes a mod may use in MOD_ALLOWED.
 * Staff are added by numeric id, @username, or a forwarded message from them; they are told, and
 * get /admin in their own command menu.
 *
 * callback_data (besides lib/review.js and lib/broadcast.js):
 *   a:p panel | a:x cancel input | a:u ask for a user | a:uc:<uid> user card
 *   a:ub:<uid> ban | a:uu:<uid> unban | a:uh:<uid> → a:uhy:<uid> reject all their public memes
 *   a:bl:<page> banned users | a:ad staff | a:ada add admin | a:adm add moderator
 *   a:adt:<uid> switch admin ↔ moderator | a:adr:<uid> remove from staff | a:ss / a:sq / a:sm stats
 *   a:st settings | a:st:<name>:<+|-|t> change one | a:ch channels | a:cha add | a:chr:<chatId> remove
 * Text inputs (users.state): adm:user, adm:admin, adm:chan (and adm:bc in lib/broadcast.js).
 */
import { ENV } from './env.js';
import { ADMIN_PAGE, APPROVED, HIDDEN, MAX_CHANNELS, PENDING, ROLE_ADMIN, ROLE_MOD, SETTINGS } from './config.js';
import * as admin from './adminstore.js';
import { memeRemoved } from './backup.js';
import { ago, langOf, t } from './i18n.js';
import { LOCALES } from './locales/index.js';
import { staffMenu } from './owner.js';
import { banUser, isProtected } from './review.js';
import * as store from './store.js';
import { answer, call, edit, send } from './tg.js';
import { cut, esc, iso, parseJson } from './util.js';

export const OWNER_ONLY = ['ad', 'ada', 'adm', 'adt', 'adr', 'st', 'ch', 'cha', 'chr', 'bc', 'bcy', 'bcn', 'bcx', 'bcs'];
export const MOD_ALLOWED = ['p', 'x', 'q', 'qs', 'ok', 'no', 'qk'];
export const STATE_USER = 'adm:user';
export const STATE_ADMIN = 'adm:admin';
export const STATE_CHANNEL = 'adm:chan';

const back = (lang) => [{ text: t(lang, 'adm.back'), callback_data: 'a:p' }];
const cancelRow = (lang) => [{ text: t(lang, 'upload.cancel_btn'), callback_data: 'a:x' }];

/* Shows (or with messageId, edits into) the panel. */
export async function showPanel(ctx, role, messageId = null) {
  const pending = await admin.countStatus(PENDING);
  if (role === ROLE_MOD) {
    const kb = [[{ text: t(ctx.lang, 'adm.queue_btn', { n: pending }), callback_data: 'a:q' }]];
    const text = t(ctx.lang, 'adm.title_mod', { pending });
    if (messageId && (await edit(ctx, 'adm.panel', messageId, text, kb))) return;
    await send(ctx, 'adm.panel', text, kb);
    return;
  }
  const [reported, users, banned] = [await admin.countReported(), await admin.countUsers(), await admin.countBanned()];
  const text = t(ctx.lang, 'adm.title', { pending, reported, users, banned });
  const kb = [
    [{ text: t(ctx.lang, 'adm.queue_btn', { n: pending }), callback_data: 'a:q' }, { text: t(ctx.lang, 'adm.reports_btn', { n: reported }), callback_data: 'a:r' }],
    [{ text: t(ctx.lang, 'adm.users_btn'), callback_data: 'a:u' }, { text: t(ctx.lang, 'adm.banned_btn', { n: banned }), callback_data: 'a:bl:0' }],
    [{ text: t(ctx.lang, 'adm.stats_btn'), callback_data: 'a:ss' }],
  ];
  if (role === 'owner') {
    kb.push([{ text: t(ctx.lang, 'adm.channels_btn'), callback_data: 'a:ch' }, { text: t(ctx.lang, 'adm.broadcast_btn'), callback_data: 'a:bc' }]);
    kb.push([{ text: t(ctx.lang, 'adm.settings_btn'), callback_data: 'a:st' }, { text: t(ctx.lang, 'adm.admins_btn'), callback_data: 'a:ad' }]);
  }
  if (messageId && (await edit(ctx, 'adm.panel', messageId, text, kb))) return;
  await send(ctx, 'adm.panel', text, kb);
}

/* ---------- users and bans ---------- */

export async function askInput(ctx, user, state, key, nowSec, data = null) {
  await store.setState(user.id, state, data, nowSec);
  await send(ctx, key, t(ctx.lang, key), [cancelRow(ctx.lang)]);
}

async function userCardView(ctx, u, nowSec) {
  const st = await admin.userStats(u.id);
  const settings = await admin.getSettings();
  const trusted = settings.trust > 0 && u.approved_n >= settings.trust;
  const text = t(ctx.lang, 'adm.user_card', {
    name: iso(cut(u.first_name || '—', 40)),
    username: u.username ? `@${esc(u.username)}` : '',
    id: String(u.id),
    lang: LOCALES[u.lang] ? LOCALES[u.lang]._name : '—',
    ago: ago(ctx.lang, u.created_at, nowSec),
    total: st.total, public: st.public, pending: st.pending,
    approved: u.approved_n,
    trusted: t(ctx.lang, trusted ? 'adm.trusted_yes' : 'adm.trusted_no'),
    banned: t(ctx.lang, u.banned ? 'adm.is_banned' : 'adm.not_banned'),
  });
  const kb = [
    [u.banned ? { text: t(ctx.lang, 'adm.unban'), callback_data: `a:uu:${u.id}` } : { text: t(ctx.lang, 'adm.ban'), callback_data: `a:ub:${u.id}` }],
    [{ text: t(ctx.lang, 'adm.hide_all'), callback_data: `a:uh:${u.id}` }],
    back(ctx.lang),
  ];
  return [text, kb];
}

export async function showUser(ctx, uid, nowSec, messageId = null) {
  const u = await store.getUser(uid);
  if (!u) return void (await send(ctx, 'adm.user_none', t(ctx.lang, 'adm.user_none'), [back(ctx.lang)]));
  const [text, kb] = await userCardView(ctx, u, nowSec);
  if (messageId && (await edit(ctx, 'adm.user', messageId, text, kb))) return;
  await send(ctx, 'adm.user', text, kb);
}

/* a:ub / a:uu */
export async function setBan(ctx, from, uid, ban, messageId, nowSec) {
  if (ban && (await isProtected(uid))) return void (await answer(ctx, t(ctx.lang, 'adm.cant_ban_admin'), true));
  if (ban) {
    const r = await banUser(uid, from.id, nowSec);
    await answer(ctx, r.changed ? t(ctx.lang, 'adm.banned_done', { n: r.rejected }) : t(ctx.lang, 'adm.done_already'), true);
  } else {
    const changed = await admin.setBanned(uid, false);
    await answer(ctx, t(ctx.lang, changed ? 'adm.unbanned_done' : 'adm.done_already'));
  }
  await showUser(ctx, uid, nowSec, messageId);
}

/* a:uh (ask) / a:uhy (do): reject every public meme of a user. */
export async function hideAll(ctx, from, uid, confirmed, messageId, nowSec) {
  if (!confirmed) {
    await edit(ctx, 'adm.user.confirm', messageId, t(ctx.lang, 'adm.hide_ask'), [[
      { text: t(ctx.lang, 'adm.hide_confirm'), callback_data: `a:uhy:${uid}` },
      { text: t(ctx.lang, 'adm.cancel'), callback_data: `a:uc:${uid}` },
    ]]);
    return answer(ctx);
  }
  for (const m of await admin.postedOf(uid, 100)) await memeRemoved(ctx, m);
  const n = await admin.rejectAllOf(uid, [APPROVED, PENDING, HIDDEN], from.id, nowSec);
  await answer(ctx, t(ctx.lang, 'adm.hidden_done', { n }), true);
  await showUser(ctx, uid, nowSec, messageId);
}

/* a:bl:<page> */
export async function showBanned(ctx, page, messageId) {
  const n = await admin.countBanned();
  if (!n) return void (await edit(ctx, 'adm.banned', messageId, t(ctx.lang, 'adm.banned_empty'), [back(ctx.lang)]));
  const pages = Math.ceil(n / ADMIN_PAGE);
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = await admin.bannedPage(ADMIN_PAGE, p * ADMIN_PAGE);
  const kb = rows.map((u) => [{ text: `🚫 ${cut(u.first_name || '—', 24)}${u.username ? ` @${u.username}` : ''} · ${u.id}`, callback_data: `a:uc:${u.id}` }]);
  const nav = [];
  if (p > 0) nav.push({ text: t(ctx.lang, 'my.prev'), callback_data: `a:bl:${p - 1}` });
  if (p < pages - 1) nav.push({ text: t(ctx.lang, 'my.next'), callback_data: `a:bl:${p + 1}` });
  if (nav.length) kb.push(nav);
  kb.push(back(ctx.lang));
  await edit(ctx, 'adm.banned', messageId, t(ctx.lang, 'adm.banned_title', { n, p: p + 1, pages }), kb);
}

/* ---------- admins (owner) ---------- */

const roleName = (lang, role) => t(lang, role === ROLE_MOD ? 'adm.role_mod' : 'adm.role_admin');

export async function showAdmins(ctx, messageId) {
  const list = await admin.listAdmins();
  const lines = list.map((a) => `• ${iso(cut(a.first_name || '—', 30))}${a.username ? ` @${esc(a.username)}` : ''} · <code>${a.user_id}</code> · ${roleName(ctx.lang, a.role)}`);
  const kb = list.map((a) => [
    { text: `🔁 ${cut(a.first_name || String(a.user_id), 18)} → ${roleName(ctx.lang, a.role === ROLE_MOD ? ROLE_ADMIN : ROLE_MOD)}`, callback_data: `a:adt:${a.user_id}` },
    { text: '❌', callback_data: `a:adr:${a.user_id}` },
  ]);
  kb.push([{ text: t(ctx.lang, 'adm.mod_add'), callback_data: 'a:adm' }, { text: t(ctx.lang, 'adm.admin_add'), callback_data: 'a:ada' }]);
  kb.push(back(ctx.lang));
  const text = t(ctx.lang, 'adm.admins_title', { list: lines.length ? lines.join('\n') : t(ctx.lang, 'adm.admins_none') });
  if (messageId && (await edit(ctx, 'adm.admins', messageId, text, kb))) return;
  await send(ctx, 'adm.admins', text, kb);
}

/* Tells a (former) staff member about their role, in their language, and sets their menu. */
async function tellStaff(ctx, uid, role) {
  const u = await store.getUser(uid);
  const lang = langOf(u, null);
  await staffMenu(ctx, uid, lang, !!role);
  if (!u || u.blocked) return;
  const key = !role ? 'staff.removed' : role === ROLE_MOD ? 'staff.now_mod' : 'staff.now_admin';
  await send(ctx, key, t(lang, key), null, { chatId: uid });
}

export async function removeAdmin(ctx, uid, messageId) {
  const removed = await admin.removeAdmin(uid);
  if (removed) await tellStaff(ctx, uid, null);
  await answer(ctx, t(ctx.lang, removed ? 'adm.admin_removed' : 'adm.done_already'));
  await showAdmins(ctx, messageId);
}

/* a:adt:<uid> — admin ↔ moderator. */
export async function switchRole(ctx, uid, messageId) {
  const role = await admin.switchRole(uid);
  if (role) await tellStaff(ctx, uid, role);
  await answer(ctx, role ? t(ctx.lang, 'adm.role_now', { role: roleName(ctx.lang, role) }) : t(ctx.lang, 'adm.done_already'));
  await showAdmins(ctx, messageId);
}

/* Who an "add staff" message points at: a forwarded message from them, a numeric id or @username. */
async function staffTarget(msg) {
  const o = msg.forward_origin;
  if (o && o.type === 'user' && o.sender_user && !o.sender_user.is_bot) return { id: o.sender_user.id, name: o.sender_user.first_name };
  if (msg.forward_from && !msg.forward_from.is_bot) return { id: msg.forward_from.id, name: msg.forward_from.first_name };
  if (o && o.type === 'hidden_user') return { hidden: true };
  const u = await admin.findUser(msg.text);
  if (u) return { id: u.id, name: u.first_name };
  const s = String(msg.text || '').trim();
  return /^\d{4,15}$/.test(s) ? { id: Number(s), name: s } : null;
}

/* ---------- settings (owner) ---------- */

const onOff = (lang, v) => t(lang, v ? 'adm.on' : 'adm.off');

export async function showSettings(ctx, messageId) {
  const s = await admin.getSettings();
  const trust = s.trust ? t(ctx.lang, 'adm.trust_n', { n: s.trust }) : t(ctx.lang, 'adm.never');
  const hide = s.hide ? t(ctx.lang, 'adm.hide_n', { n: s.hide }) : t(ctx.lang, 'adm.never');
  const text = t(ctx.lang, 'adm.settings_title', { moderation: onOff(ctx.lang, s.moderation), trust, hide, join: onOff(ctx.lang, s.join), likebtn: onOff(ctx.lang, s.likebtn), motd: onOff(ctx.lang, s.motd) });
  const step = (name, shown) => [
    { text: '➖', callback_data: `a:st:${name}:-` },
    { text: shown, callback_data: 'nop' },
    { text: '➕', callback_data: `a:st:${name}:+` },
  ];
  const kb = [
    [{ text: t(ctx.lang, 'adm.toggle_moderation', { v: onOff(ctx.lang, s.moderation) }), callback_data: 'a:st:moderation:t' }],
    step('trust', `⭐\uFE0F ${trust}`),
    step('hide', `🙈 ${hide}`),
    [{ text: t(ctx.lang, 'adm.toggle_join', { v: onOff(ctx.lang, s.join) }), callback_data: 'a:st:join:t' }],
    [{ text: t(ctx.lang, 'adm.toggle_likebtn', { v: onOff(ctx.lang, s.likebtn) }), callback_data: 'a:st:likebtn:t' }],
    [{ text: t(ctx.lang, 'adm.toggle_motd', { v: onOff(ctx.lang, s.motd) }), callback_data: 'a:st:motd:t' }],
    back(ctx.lang),
  ];
  if (messageId && (await edit(ctx, 'adm.settings', messageId, text, kb))) return;
  await send(ctx, 'adm.settings', text, kb);
}

export async function changeSetting(ctx, name, op, messageId) {
  const def = SETTINGS[name];
  if (!def || !['+', '-', 't'].includes(op)) return answer(ctx);
  const s = await admin.getSettings();
  let v = s[name];
  if (op === 't') v = v ? 0 : 1;
  else v = Math.min(def.max, Math.max(def.min, v + (op === '+' ? 1 : -1)));
  if (v !== s[name]) {
    await admin.setSetting(name, v);
    if (name === 'join') await admin.bumpJoinVersion();
  }
  await showSettings(ctx, messageId);
  await answer(ctx);
}

/* ---------- forced-join channels (owner) ---------- */

export async function showChannels(ctx, messageId) {
  const [list, s] = [await admin.listChannels(), await admin.getSettings()];
  const lines = list.map((c) => `• ${iso(c.title || String(c.chat_id))}${c.username ? ` @${esc(c.username)}` : ''}`);
  const kb = list.map((c) => [{ text: `❌ ${cut(c.title || String(c.chat_id), 30)}`, callback_data: `a:chr:${c.chat_id}` }]);
  if (list.length < MAX_CHANNELS) kb.push([{ text: t(ctx.lang, 'adm.channel_add'), callback_data: 'a:cha' }]);
  kb.push([{ text: t(ctx.lang, 'adm.toggle_join', { v: onOff(ctx.lang, s.join) }), callback_data: 'a:st:join:t' }]);
  kb.push(back(ctx.lang));
  const text = t(ctx.lang, 'adm.channels_title', { state: onOff(ctx.lang, s.join), list: lines.length ? lines.join('\n') : t(ctx.lang, 'adm.channels_none'), max: MAX_CHANNELS });
  if (messageId && (await edit(ctx, 'adm.channels', messageId, text, kb))) return;
  await send(ctx, 'adm.channels', text, kb);
}

export async function removeChannel(ctx, chatId, messageId) {
  const ok = await admin.removeChannel(chatId);
  if (ok) await admin.bumpJoinVersion();
  await answer(ctx, t(ctx.lang, ok ? 'adm.channel_removed' : 'adm.done_already'));
  await showChannels(ctx, messageId);
}

/* The channel a message points at: a forwarded channel post, @username, a t.me link or -100… id. */
function channelRef(msg) {
  const o = msg.forward_origin;
  if (o && o.type === 'channel' && o.chat) return o.chat.id;
  if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') return msg.forward_from_chat.id;
  const s = String(msg.text || '').trim();
  if (/^-100\d{5,15}$/.test(s)) return Number(s);
  const m = /^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/|@)?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(s);
  return m ? `@${m[1]}` : null;
}

async function addChannelFrom(ctx, msg, nowSec) {
  const ref = channelRef(msg);
  if (!ref) return t(ctx.lang, 'adm.channel_not_found');
  if ((await admin.listChannels()).length >= MAX_CHANNELS) return t(ctx.lang, 'adm.channel_max', { n: MAX_CHANNELS });
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'adm.channel.chat');
  } catch (err) {
    return t(ctx.lang, 'adm.channel_not_found');
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') return t(ctx.lang, 'adm.channel_type');
  const me = await call(ctx, 'getMe', {}, 'adm.channel.me');
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: me.id }, 'adm.channel.member');
    if (m.status !== 'administrator' && m.status !== 'creator') return t(ctx.lang, 'adm.channel_not_admin');
  } catch (err) {
    return t(ctx.lang, 'adm.channel_not_admin');
  }
  let link = chat.username ? `https://t.me/${chat.username}` : null;
  if (!link) {
    try {
      link = (await call(ctx, 'createChatInviteLink', { chat_id: chat.id, name: 'memebot' }, 'adm.channel.link')).invite_link;
    } catch (err) {
      return t(ctx.lang, 'adm.channel_no_link');
    }
  }
  if (!(await admin.addChannel({ chatId: chat.id, username: chat.username, title: chat.title, link }, nowSec))) return t(ctx.lang, 'adm.channel_exists');
  await admin.bumpJoinVersion();
  await send(ctx, 'adm.channel_added', t(ctx.lang, 'adm.channel_added', { title: iso(chat.title || String(chat.id)) }));
  return null;
}

/* ---------- text inputs ---------- */

/* A message while an admin input is pending. Returns true if it was handled. */
export async function onInput(ctx, user, role, msg, nowSec) {
  const state = user.state;
  if (state === STATE_USER) {
    const u = await admin.findUser(msg.text);
    await store.clearState(user.id);
    if (u) await showUser(ctx, u.id, nowSec);
    else await send(ctx, 'adm.user_none', t(ctx.lang, 'adm.user_none'), [back(ctx.lang)]);
    return true;
  }
  if (state === STATE_ADMIN && role === 'owner') {
    const want = (parseJson(user.state_data) || {}).role === ROLE_MOD ? ROLE_MOD : ROLE_ADMIN;
    const who = await staffTarget(msg);
    await store.clearState(user.id);
    if (!who || who.hidden) {
      await send(ctx, 'adm.user_none', t(ctx.lang, who ? 'adm.staff_hidden' : 'adm.user_none'));
    } else if (who.id === Number(ENV.ownerId) || !(await admin.addAdmin(who.id, user.id, nowSec, want))) {
      await send(ctx, 'adm.admin_exists', t(ctx.lang, 'adm.admin_exists'));
    } else {
      await send(ctx, 'adm.admin_added', t(ctx.lang, 'adm.staff_added', { name: iso(who.name || String(who.id)), role: roleName(ctx.lang, want) }));
      await tellStaff(ctx, who.id, want);
    }
    await showAdmins(ctx);
    return true;
  }
  if (state === STATE_CHANNEL && role === 'owner') {
    await store.clearState(user.id);
    const err = await addChannelFrom(ctx, msg, nowSec);
    if (err) await send(ctx, 'adm.channel_bad', t(ctx.lang, 'adm.channel_bad', { err }));
    await showChannels(ctx);
    return true;
  }
  return false;
}

/* a:x — cancel whatever admin input was pending. */
export async function cancelInput(ctx, user, messageId) {
  await store.clearState(user.id);
  await edit(ctx, 'adm.cancel', messageId, t(ctx.lang, 'adm.input_cancelled'), null);
  await answer(ctx);
}

