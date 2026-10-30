/*
 * The owner panel (private chat, OWNER_ID only — router.js checks before calling anything here):
 * the root screen, statistics and forced-join channel management. Broadcasts: owner_bc.js.
 *
 * callback_data: op (panel) · os (stats; refreshes stale member counts) · oj (forced-join list) ·
 * oj:a (add: asks for the channel) · oj:r:<id> (remove?) · oj:y:<id> (remove!) · oj:u:<id> / oj:d:<id>
 * (move up / down) · oj:t (on/off) · oj:c (re-check the bot's admin rights) · ox (cancel an input).
 * Pending input (aegis_states): join_add — the next message names a channel.
 */
import { MAX_JOIN_CHANNELS, MEMBER_COUNT_REFRESH, OWNER_ID, STATS_TZ_OFFSET_MIN } from '../config.js';
import * as audit from '../core/audit.js';
import { me } from '../core/bot.js';
import { countSince } from '../core/errors.js';
import * as kv from '../core/kv.js';
import * as state from '../core/state.js';
import { answer, btn, call, describeError, screen, send } from '../core/tg.js';
import { dayStart, esc, iso, nowSec, toInt } from '../core/util.js';
import * as bc from '../engines/broadcast.js';
import * as chats from '../engines/chats.js';
import * as join from '../engines/join.js';
import * as users from '../engines/users.js';
import { t } from '../i18n/index.js';

const back = (lang, data = 'op') => [btn(t(lang, 'common.back'), data)];
const cancelRow = (lang) => [btn(t(lang, 'common.cancel'), 'ox')];

/* ---------- root ---------- */

export async function panel(ctx, lang, place = null) {
  await state.clear(OWNER_ID);
  const s = await kv.all(ctx);
  const c = await chats.counts();
  const active = await bc.active();
  const lines = [
    t(lang, 'owner.title'),
    '',
    t(lang, 'owner.summary_users', { n: await users.countReachable() }),
    t(lang, 'owner.summary_chats', { groups: c.groups, channels: c.channels }),
    t(lang, 'owner.summary_join', { state: t(lang, join.enabled(s) ? 'common.on' : 'common.off'), n: await join.count() }),
  ];
  if (active) lines.push(t(lang, 'owner.summary_bc', { id: Number(active.id), status: t(lang, `bc.st_${active.status}`) }));
  if (s.shutdown === '1') lines.push('', t(lang, 'owner.summary_shutdown'));
  const rows = [
    [btn(t(lang, 'owner.btn_stats'), 'os'), btn(t(lang, 'owner.btn_status'), 'sy:st')],
    [btn(t(lang, 'owner.btn_join'), 'oj'), btn(t(lang, 'owner.btn_bc'), 'ob')],
    [btn(t(lang, 'owner.btn_main'), 'mm')],
  ];
  return screen(ctx, OWNER_ID, place, lines.join('\n'), rows, 'owner');
}

/* ---------- stats ---------- */

export async function stats(ctx, lang, place = null) {
  const now = nowSec();
  const stale = await chats.refreshStaleCounts(ctx, MEMBER_COUNT_REFRESH, 3000);
  const u = await users.counts(now, dayStart(now, STATS_TZ_OFFSET_MIN));
  const c = await chats.counts();
  const lines = [
    t(lang, 'stats.title'),
    '',
    t(lang, 'stats.started', { n: u.started }),
    t(lang, 'stats.reachable', { n: u.reachable }),
    t(lang, 'stats.blocked', { n: u.blocked }),
    t(lang, 'stats.new', { today: u.newToday, week: u.newWeek }),
    t(lang, 'stats.active', { d1: u.active24h, d7: u.active7d }),
    '',
    t(lang, 'stats.chats', { groups: c.groups, channels: c.channels }),
    t(lang, 'stats.members', { n: c.members }),
  ];
  if (stale > 0) lines.push(t(lang, 'stats.members_stale', { n: stale }));
  lines.push('', t(lang, 'stats.errors', { n: await countSince(now - 86400) }), '', t(lang, 'stats.note'));
  return screen(ctx, OWNER_ID, place, lines.join('\n'), [[btn(t(lang, 'common.refresh'), 'os')], back(lang)], 'owner-stats');
}

/* ---------- forced join ---------- */

async function refreshStale(ctx, chans, all) {
  const botId = (await me(ctx)).id;
  const limit = nowSec() - 600;
  for (const ch of chans) if (all || Number(ch.checked_at) < limit) await join.refreshChannel(ctx, ch, botId);
}

export async function joinScreen(ctx, lang, place = null, { notice = '', recheck = false } = {}) {
  const s = await kv.all(ctx);
  const chans = await join.list();
  await refreshStale(ctx, chans, recheck);
  const on = join.enabled(s);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'join.admin_title', { state: t(lang, on ? 'common.on' : 'common.off'), n: chans.length, max: MAX_JOIN_CHANNELS }), '');
  const bad = chans.filter((ch) => Number(ch.bot_admin) !== 1);
  if (bad.length) lines.push(t(lang, 'join.admin_warn', { n: bad.length }), '');
  if (!chans.length) lines.push(t(lang, 'join.admin_empty'));
  chans.forEach((ch, i) => {
    const ok = Number(ch.bot_admin) === 1;
    const vars = { i: i + 1, title: iso(join.channelTitle(ch), 40), uname: ch.username ? `@${esc(ch.username)}` : t(lang, 'join.private') };
    lines.push(t(lang, ok ? 'join.admin_item' : 'join.admin_item_bad', vars));
  });
  lines.push('', t(lang, 'join.admin_hint'));
  const rows = chans.map((ch, i) => [
    btn('⬆️', `oj:u:${ch.id}`), btn('⬇️', `oj:d:${ch.id}`), btn(t(lang, 'join.btn_remove', { i: i + 1 }), `oj:r:${ch.id}`),
  ]);
  if (chans.length < MAX_JOIN_CHANNELS) rows.push([btn(t(lang, 'join.btn_add'), 'oj:a')]);
  rows.push([btn(t(lang, on ? 'join.btn_turn_off' : 'join.btn_turn_on'), 'oj:t'), btn(t(lang, 'join.btn_recheck'), 'oj:c')]);
  rows.push(back(lang));
  return screen(ctx, OWNER_ID, place, lines.join('\n'), rows, 'owner-join');
}

/* @name, t.me/name, https://t.me/name, -100…, or a bare id → a chat_id for getChat; null if none. */
export function parseChannelInput(text) {
  const s = String(text || '').trim();
  let m = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
  if (m) return `@${m[1]}`;
  m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(s);
  if (m) return `@${m[1]}`;
  if (/^-100\d{6,16}$/.test(s)) return toInt(s);
  if (/^\d{6,16}$/.test(s)) return toInt(`-100${s}`);
  return null;
}

/* The owner's message while join_add is pending. */
export async function joinAddInput(ctx, lang, message) {
  const origin = message.forward_origin;
  let ref = null;
  if (origin && origin.type === 'channel' && origin.chat) ref = origin.chat.id;
  else if (message.forward_from_chat) ref = message.forward_from_chat.id;
  else ref = parseChannelInput(message.text);
  const retry = [cancelRow(lang)];
  if (ref === null) return send(ctx, OWNER_ID, t(lang, 'join.add_bad_input'), retry, 'join-add-bad');
  if (await join.count() >= MAX_JOIN_CHANNELS) {
    await state.clear(OWNER_ID);
    return joinScreen(ctx, lang, null, { notice: t(lang, 'join.add_limit', { max: MAX_JOIN_CHANNELS }) });
  }
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'join-add-chat');
  } catch (err) {
    return send(ctx, OWNER_ID, t(lang, 'join.add_not_found', { error: esc(describeError(err)) }), retry, 'join-add-missing');
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') return send(ctx, OWNER_ID, t(lang, 'join.add_bad_type'), retry, 'join-add-type');
  const title = chat.title || (chat.username ? `@${chat.username}` : String(chat.id));
  if (await join.findDuplicate(chat.id, chat.username)) {
    await state.clear(OWNER_ID);
    return joinScreen(ctx, lang, null, { notice: t(lang, 'join.add_exists', { title: iso(title) }) });
  }
  let admin = false;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: (await me(ctx)).id }, 'join-add-admin');
    admin = m.status === 'administrator' || m.status === 'creator';
  } catch (err) {
    admin = false;
  }
  let link = null;
  if (!chat.username) {
    link = chat.invite_link || null;
    if (!link && admin) {
      try {
        link = await call(ctx, 'exportChatInviteLink', { chat_id: chat.id }, 'join-add-link');
      } catch (err) {
        link = null;
      }
    }
    if (!link) return send(ctx, OWNER_ID, t(lang, 'join.add_need_link', { title: iso(title) }), retry, 'join-add-link-missing');
  }
  const id = await join.add({ chatId: chat.id, username: chat.username || null, title, inviteLink: link, botAdmin: admin });
  await state.clear(OWNER_ID);
  if (!id) return joinScreen(ctx, lang, null, { notice: t(lang, 'join.add_exists', { title: iso(title) }) });
  await join.bumpRev(ctx);
  await audit.log(OWNER_ID, 'join.add', { chatId: chat.id, target: id, details: { title, username: chat.username || null, admin } });
  const notice = t(lang, admin ? 'join.added' : 'join.added_not_admin', { title: iso(title) });
  return joinScreen(ctx, lang, null, { notice });
}

export async function joinCallback(ctx, lang, parts, place) {
  const [, action, arg] = parts;
  const id = toInt(arg);
  if (!action) return joinScreen(ctx, lang, place);
  if (action === 'c') return joinScreen(ctx, lang, place, { recheck: true });
  if (action === 'a') {
    if (await join.count() >= MAX_JOIN_CHANNELS) {
      await answer(ctx, t(lang, 'join.add_limit', { max: MAX_JOIN_CHANNELS }), true);
      return null;
    }
    await state.set(OWNER_ID, 'join_add');
    return screen(ctx, OWNER_ID, place, t(lang, 'join.add_prompt'), [cancelRow(lang)], 'join-add');
  }
  if (action === 't') {
    const on = join.enabled(await kv.all(ctx));
    await kv.set(ctx, 'join_enabled', on ? '0' : '1');
    await join.bumpRev(ctx);
    await audit.log(OWNER_ID, 'join.toggle', { details: { enabled: !on } });
    return joinScreen(ctx, lang, place, { notice: t(lang, on ? 'join.turned_off' : 'join.turned_on') });
  }
  if (id === null) return joinScreen(ctx, lang, place);
  const ch = await join.get(id);
  if (!ch) return joinScreen(ctx, lang, place, { notice: t(lang, 'join.gone') });
  if (action === 'u' || action === 'd') {
    if (await join.move(id, action === 'u' ? -1 : 1)) await audit.log(OWNER_ID, 'join.move', { target: id, details: { dir: action } });
    return joinScreen(ctx, lang, place);
  }
  if (action === 'r') {
    const rows = [[btn(t(lang, 'common.yes_remove'), `oj:y:${id}`), btn(t(lang, 'common.no'), 'oj')]];
    return screen(ctx, OWNER_ID, place, t(lang, 'join.remove_q', { title: iso(join.channelTitle(ch)) }), rows, 'join-remove?');
  }
  if (action === 'y') {
    await join.remove(id);
    await join.bumpRev(ctx);
    await audit.log(OWNER_ID, 'join.remove', { chatId: Number(ch.chat_id) || 0, target: id, details: { title: join.channelTitle(ch) } });
    return joinScreen(ctx, lang, place, { notice: t(lang, 'join.removed', { title: iso(join.channelTitle(ch)) }) });
  }
  return joinScreen(ctx, lang, place);
}
