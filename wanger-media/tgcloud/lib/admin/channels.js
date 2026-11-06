// Admin › Forced-join channels — owner only (brief §4; lib/admin/index.js checks canManageChannels
// on every button and input). Add (by @username, t.me link, numeric id or a forwarded post), switch
// on/off, re-check, remove; at most MAX_CHANNELS; the bot must be an admin of a channel before it is
// added (getChatMember on a channel only works then). Changes reach users within JOIN_PASS_S, when
// their cached membership pass runs out (invalidating every pass at once would touch every user row).
import { MAX_CHANNELS } from '../config.js';
import * as admin from '../db/admin.js';
import * as channels from '../db/channels.js';
import * as system from '../db/system.js';
import { t, tp } from '../i18n/index.js';
import { botStanding } from '../join.js';
import * as tg from '../tg.js';
import * as ui from '../ui.js';
import { errorText } from '../util.js';

const ICON = { ok: '🟢', not_admin: '🔴', error: '🔴', unknown: '⚪' };
const label = (ch) => (ch.username ? '@' + ch.username : ch.title || String(ch.chat_id));

export async function listScreen(user, notice = null) {
  const lang = user.lang;
  const list = await admin.channelsAll();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.ch.title', { n: list.length, max: MAX_CHANNELS }), '', t(lang, 'adm.ch.legend'));
  const kb = list.map((ch) => [ui.button(`${ch.enabled ? ICON[ch.bot_status] || '⚪' : '⏸'} ${label(ch)}`, 'A:c:' + ch.id)]);
  if (list.length < MAX_CHANNELS) kb.push([ui.button(tp(lang, 'adm.btn.add_channel'), 'A:ca')]);
  kb.push(ui.navRow(lang, 'A'));
  return { view: 'admin_channels', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export async function channelScreen(user, id, notice = null) {
  const lang = user.lang;
  const ch = await admin.channelGet(id);
  if (!ch) return listScreen(user);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'adm.ch.detail', {
    label: label(ch), title: ch.title || '—', id: ch.chat_id || '—',
    state: tp(lang, ch.enabled ? 'adm.on' : 'adm.off'), status: tp(lang, 'adm.ch.status.' + (ch.bot_status || 'unknown')),
    checked: ch.checked_at ? ui.formatTime(ch.checked_at) : '—',
  }));
  if (ch.status_detail) lines.push(t(lang, 'adm.ch.detail_error', { detail: ch.status_detail }));
  const kb = [
    [ui.button(tp(lang, ch.enabled ? 'adm.btn.disable' : 'adm.btn.enable'), 'A:ct:' + id), ui.button(tp(lang, 'adm.btn.recheck'), 'A:cr:' + id)],
    [ui.button(tp(lang, 'adm.btn.delete'), 'A:cd:' + id)],
    ui.navRow(lang, 'A:c'),
  ];
  return { view: 'admin_channel', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export function addPrompt(user) {
  return { view: 'admin_channels', input: { k: 'ca' }, screen: { text: t(user.lang, 'adm.ch.add_prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } };
}

/** "@name", "t.me/name", "https://t.me/name", "-100…", or a post forwarded from the channel → a chat_id for getChat. */
export function channelRef(msg) {
  const origin = msg && msg.forward_origin;
  if (origin && origin.type === 'channel' && origin.chat) return origin.chat.id;
  if (msg && msg.forward_from_chat && msg.forward_from_chat.type === 'channel') return msg.forward_from_chat.id;
  const s = String((msg && msg.text) || '').trim();
  let m = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
  if (m) return '@' + m[1];
  m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(s);
  if (m) return '@' + m[1];
  if (/^-100\d{6,16}$/.test(s)) return Number(s);
  return null;
}

export async function onInput(ctx, user, msg) {
  const lang = user.lang;
  const list = await admin.channelsAll();
  if (list.length >= MAX_CHANNELS) return { error: t(lang, 'adm.ch.full', { max: MAX_CHANNELS }), done: true };
  const ref = channelRef(msg);
  if (!ref) return { error: t(lang, 'adm.ch.bad_ref') };
  let chat;
  try {
    chat = await tg.call(ctx, 'admin_channel', 'getChat', { chat_id: ref });
  } catch (err) {
    return { error: t(lang, 'adm.ch.not_found', { detail: errorText(err) }) };
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') return { error: t(lang, 'adm.ch.not_channel') };
  const standing = await botStanding(ctx, chat.id);
  if (standing.status !== 'ok') return { error: t(lang, 'adm.ch.not_admin', { detail: standing.detail || standing.status }) };
  const id = await admin.channelAdd({
    chatId: chat.id, username: chat.username || null, title: chat.title || null,
    inviteLink: chat.username ? null : chat.invite_link || null, botStatus: 'ok', detail: null,
  }, user.id, ctx.now);
  if (!id) return { error: t(lang, 'adm.ch.exists'), done: true };
  await system.audit(ctx.now, user.id, 'channel.add', String(chat.id), { username: chat.username || null });
  return channelScreen(user, id, t(lang, 'adm.ch.added'));
}

export async function toggle(ctx, user, id) {
  const ch = await admin.channelGet(id);
  if (!ch) return listScreen(user);
  await admin.channelSetEnabled(id, !ch.enabled);
  await system.audit(ctx.now, user.id, ch.enabled ? 'channel.disable' : 'channel.enable', String(ch.chat_id || ch.username), null);
  return channelScreen(user, id);
}

export async function recheck(ctx, user, id) {
  const ch = await admin.channelGet(id);
  if (!ch) return listScreen(user);
  let info;
  try {
    const chat = await tg.call(ctx, 'admin_channel', 'getChat', { chat_id: ch.chat_id || '@' + ch.username });
    const standing = await botStanding(ctx, chat.id);
    info = { chatId: chat.id, title: chat.title || null, botStatus: standing.status, detail: standing.detail || null };
  } catch (err) {
    info = { botStatus: 'error', detail: errorText(err) };
  }
  await channels.setInfo(id, info, ctx.now);
  return channelScreen(user, id, t(user.lang, info.botStatus === 'ok' ? 'adm.ch.check_ok' : 'adm.ch.check_bad'));
}

export async function deleteAsk(user, id) {
  const ch = await admin.channelGet(id);
  if (!ch) return listScreen(user);
  return {
    view: 'admin_channel',
    screen: {
      text: t(user.lang, 'adm.ch.delete_ask', { label: label(ch) }),
      reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.delete_yes'), 'A:cD:' + id), ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:c:' + id)]]),
    },
  };
}

export async function deleteNow(ctx, user, id) {
  const ch = await admin.channelGet(id);
  if (ch) {
    await admin.channelDelete(id);
    await system.audit(ctx.now, user.id, 'channel.remove', String(ch.chat_id || ch.username), null);
  }
  return listScreen(user, ch ? t(user.lang, 'adm.ch.removed', { label: label(ch) }) : null);
}
