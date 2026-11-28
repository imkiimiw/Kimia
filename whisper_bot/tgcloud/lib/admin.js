// The panel (/admin) for the owner and the admins. The router calls these only after checking, in a
// private chat, that the numeric from.id is the owner or an admin with the permission the action needs
// (lib/staff.js) — for every command and every button. Stats are counts only: no whisper or anonymous
// content is shown here, except a message a user chose to report or a confession sent for review —
// and even then never who wrote it.
import {
  ADMIN_PERMS, BC_BATCH, LANGS, MAX_ADMINS, MAX_CHANNELS, OWNER_ID, RESTRICT_LONG_SEC,
} from './config.js';
import {
  getReport, listReports, restrict, setReportStatus,
} from './astore.js';
import { botInfo } from './bot.js';
import {
  finalReport, keepGoing, processBatch, progressView,
} from './broadcast.js';
import {
  ago, langOf, num, t,
} from './i18n.js';
import { confessionChannelStatus } from './confess.js';
import { countPendingConfessions } from './cstore.js';
import { channelRef } from './join.js';
import {
  addChannel, backfillBlang, bumpChannelVersion, clearState, countChannels, countReachable, createBroadcast, getBroadcast,
  getChannel, getChannels, getUser, getUserByUsername, removeChannel, runningBroadcast, setBanned,
  setBroadcastAudience as saveAudience, setBroadcastButton as saveButton, setBroadcastStatus, setKv,
  setBroadcastProgressMessage, setState, startBroadcast, stats,
} from './store.js';
import {
  answer, btn, call, describeError, isApiError, send, sendMedia, show,
} from './tg.js';
import {
  esc, nowSec, toAsciiDigits, truncate,
} from './util.js';
import {
  addAdmin, can, getStaff, listAdmins, removeAdmin, togglePerm,
} from './staff.js';
import { setWakeChat, wakeStatus } from './wake.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);
const toPanel = (ctx) => [btn(T(ctx, 'adm.btn_panel'), 'a')];

/** The panel: only the buttons the owner or this admin may use (lib/staff.js). */
export async function showPanel(ctx, kv, staff) {
  const n = await countChannels();
  const joinOn = kv.join !== '0';
  const running = kv.bc ? await getBroadcast(Number(kv.bc)) : null;
  const s = await stats();
  const pending = can(staff, 'cf') ? await countPendingConfessions() : 0;
  const kb = [];
  if (can(staff, 'ch')) {
    kb.push([btn(T(ctx, 'adm.btn_channels'), 'a:ch'), btn(T(ctx, 'adm.btn_add_channel'), 'a:add')]);
    kb.push([btn(T(ctx, joinOn ? 'adm.btn_join_on' : 'adm.btn_join_off'), 'a:j')]);
  }
  if (can(staff, 'ban')) kb.push([btn(T(ctx, 'adm.btn_ban'), 'a:ban'), btn(T(ctx, 'adm.btn_unban'), 'a:unban')]);
  const row = [];
  if (can(staff, 'st')) row.push(btn(T(ctx, 'adm.btn_stats'), 'a:st'));
  if (can(staff, 'rp')) row.push(btn(T(ctx, 'adm.btn_reports', { n: N(ctx, s.reports) }), 'a:rp'));
  if (row.length) kb.push(row);
  if (can(staff, 'cf')) kb.push([btn(T(ctx, 'adm.btn_confessions', { n: N(ctx, pending) }), 'a:cf')]);
  if (can(staff, 'bc')) {
    kb.push([running && running.status === 'running'
      ? btn(T(ctx, 'adm.btn_bc_running', { id: N(ctx, running.id) }), `a:bcp:${running.id}`)
      : btn(T(ctx, 'adm.btn_broadcast'), 'a:bc')]);
  }
  if (staff.owner) {
    kb.push([btn(T(ctx, 'adm.btn_admins'), 'a:ad'), btn(T(ctx, 'adm.btn_cf_settings'), 'a:cfs')]);
    kb.push([btn(T(ctx, 'adm.btn_clock'), 'a:wk'), btn(T(ctx, 'adm.btn_health'), 'a:hl')]);
  }
  const title = staff.owner ? T(ctx, 'adm.title_owner') : T(ctx, 'adm.title_admin', { perms: permNames(ctx, [...staff.perms]) });
  return show(ctx, 'admin_panel', `${title}\n\n${T(ctx, 'adm.panel', {
    join: T(ctx, joinOn ? 'common.on' : 'common.off'), n: N(ctx, n), max: N(ctx, MAX_CHANNELS), reports: N(ctx, s.reports),
  })}`, kb);
}

// ---------- channels ----------

/** Lists the channels with whether the bot is an admin there (one getChatMember each, in parallel). */
export async function showChannels(ctx, kv, note = '') {
  const channels = await getChannels(kv);
  const bot = await botInfo(ctx, kv);
  const status = await Promise.all(channels.map(async (ch) => {
    if (!bot.id) return '❓';
    try {
      const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: bot.id }, 'admin_check');
      return T(ctx, m.status === 'administrator' || m.status === 'creator' ? 'adm.ch_admin' : 'adm.ch_not_admin');
    } catch (err) {
      return `⚠️ ${esc(truncate(isApiError(err) ? err.description : describeError(err), 60))}`;
    }
  }));
  const lines = channels.map((ch, i) => `${N(ctx, i + 1)}. @${esc(ch.username)} — ${esc(truncate(ch.title, 40))}\n     ${status[i]} · ${T(ctx, 'hl.joins', { n: N(ctx, ch.joins) })}`);
  const kb = channels.map((ch) => [btn(`❌ @${ch.username}`.slice(0, 60), `a:rm:${ch.id}`)]);
  if (channels.length < MAX_CHANNELS) kb.push([btn(T(ctx, 'adm.btn_add_channel'), 'a:add')]);
  kb.push(toPanel(ctx));
  const off = kv.join === '0' ? `\n\n${T(ctx, 'adm.ch_join_off')}` : '';
  return show(ctx, 'admin_channels', `${note ? `${note}\n\n` : ''}${T(ctx, 'adm.ch_title', { n: N(ctx, channels.length), max: N(ctx, MAX_CHANNELS) })}\n\n${lines.join('\n') || T(ctx, 'adm.ch_none')}${off}`, kb);
}

export async function askChannel(ctx, user) {
  if ((await countChannels()) >= MAX_CHANNELS) return answer(ctx, T(ctx, 'adm.ch_full', { max: N(ctx, MAX_CHANNELS) }), { alert: true });
  await setState(user.id, 'add_channel');
  await answer(ctx);
  return show(ctx, 'admin_add_channel', T(ctx, 'adm.ch_ask'), [[btn(T(ctx, 'btn.cancel'), 'a:x')]]);
}

/** "@name", "name", "t.me/name", "https://telegram.me/s/name" → "name"; private links → null. */
export function normalizeChannel(input) {
  const s = toAsciiDigits(String(input || '').trim()).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  let m = /^(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:[?#].*)?$/i.exec(s);
  if (m) return m[1];
  m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
  return m ? m[1] : null;
}

export async function onChannelInput(ctx, user, kv, text) {
  const name = normalizeChannel(text);
  if (!name) return send(ctx, 'admin_channel_invalid', T(ctx, 'adm.ch_invalid'));
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: `@${name}` }, 'admin_get_chat');
  } catch (err) {
    return send(ctx, 'admin_channel_missing', T(ctx, 'adm.ch_missing', { name: esc(name), err: esc(describeError(err)) }));
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') return send(ctx, 'admin_channel_type', T(ctx, 'adm.ch_type', { name: esc(name) }));
  const bot = await botInfo(ctx, kv);
  let isAdmin = false;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: bot.id }, 'admin_check');
    isAdmin = m.status === 'administrator' || m.status === 'creator';
  } catch (err) {
    console.warn(`bot admin check failed: ${describeError(err)}`);
  }
  if (!isAdmin) return send(ctx, 'admin_channel_not_admin', T(ctx, 'adm.ch_need_admin', { name: esc(chat.username || name) }));
  const r = await addChannel({ username: chat.username || name, chatId: Number(chat.id), title: chat.title || name });
  await clearState(user.id);
  ctx.messageId = null;
  if (r === 'dup') return showChannels(ctx, kv, T(ctx, 'adm.ch_dup', { name: esc(name) }));
  if (r === 'full') return showChannels(ctx, kv, T(ctx, 'adm.ch_not_added', { name: esc(name), max: N(ctx, MAX_CHANNELS) }));
  await bumpChannelVersion(kv);
  return showChannels(ctx, kv, T(ctx, 'adm.ch_added', { name: esc(chat.username || name) }));
}

export async function confirmRemove(ctx, id) {
  const ch = await getChannel(Number(id));
  if (!ch) return answer(ctx, T(ctx, 'adm.ch_gone'), { alert: true });
  await answer(ctx);
  return show(ctx, 'admin_remove_confirm', T(ctx, 'adm.ch_remove_ask', { name: esc(ch.username) }),
    [[btn(T(ctx, 'adm.btn_yes_remove'), `a:rmy:${ch.id}`), btn(T(ctx, 'btn.no'), 'a:ch')]]);
}

export async function doRemove(ctx, kv, id) {
  const ch = await getChannel(Number(id));
  const ok = ch ? await removeChannel(ch.id) : false;
  if (ok) await bumpChannelVersion(kv);
  await answer(ctx, T(ctx, ok ? 'adm.ch_removed_short' : 'adm.ch_gone'));
  return showChannels(ctx, kv, ok ? T(ctx, 'adm.ch_removed', { name: esc(ch.username) }) : '');
}

export async function toggleJoin(ctx, kv, staff) {
  const on = kv.join === '0';
  await setKv('join', on ? '1' : '0');
  kv.join = on ? '1' : '0';
  await answer(ctx, T(ctx, on ? 'adm.join_turned_on' : 'adm.join_turned_off'));
  return showPanel(ctx, kv, staff);
}

// ---------- ban / unban ----------

export async function askBan(ctx, user, ban) {
  await setState(user.id, ban ? 'ban' : 'unban');
  await answer(ctx);
  return show(ctx, ban ? 'admin_ban_ask' : 'admin_unban_ask', T(ctx, ban ? 'adm.ban_ask' : 'adm.unban_ask'), [[btn(T(ctx, 'btn.cancel'), 'a:x')]]);
}

export async function onBanInput(ctx, user, text, ban) {
  const s = toAsciiDigits(String(text || '').trim());
  if (!/^[1-9][0-9]{4,15}$/.test(s)) return send(ctx, 'admin_ban_invalid', T(ctx, 'adm.ban_invalid'));
  const id = Number(s);
  await clearState(user.id);
  if (id === OWNER_ID) return send(ctx, 'admin_ban_owner', T(ctx, 'adm.ban_owner'), [toPanel(ctx)]);
  // An admin is the owner's to remove, not another admin's to ban.
  if (user.id !== OWNER_ID && (await getStaff(id))) return send(ctx, 'admin_ban_owner', T(ctx, 'adm.ban_staff'), [toPanel(ctx)]);
  await setBanned(id, ban);
  const u = await getUser(id);
  const who = u && u.username ? ` (@${esc(u.username)})` : '';
  return send(ctx, ban ? 'admin_banned' : 'admin_unbanned', T(ctx, ban ? 'adm.banned' : 'adm.unbanned', { id, who }), [toPanel(ctx)]);
}

// ---------- stats ----------

export async function showStats(ctx) {
  const s = await stats();
  return show(ctx, 'admin_stats', T(ctx, 'adm.stats', {
    users: N(ctx, s.users),
    active: N(ctx, s.active),
    banned: N(ctx, s.banned),
    today: N(ctx, s.today),
    whispers: N(ctx, s.whispers),
    anon: N(ctx, s.anon),
    reports: N(ctx, s.reports),
    channels: N(ctx, s.channels),
    rchats: N(ctx, s.rchats),
    cf: N(ctx, s.confessions),
    cfp: N(ctx, s.posted),
  }), [toPanel(ctx)]);
}

// ---------- reports (moderation without identities) ----------

export async function showReports(ctx) {
  const list = await listReports('open', 10);
  const kb = list.map((r) => [btn(T(ctx, 'adm.rp_item', { id: N(ctx, r.id), kind: T(ctx, `kind.${r.kind}`) }), `a:rv:${r.id}`)]);
  kb.push(toPanel(ctx));
  return show(ctx, 'admin_reports', list.length ? T(ctx, 'adm.rp_title', { n: N(ctx, list.length) }) : T(ctx, 'adm.rp_none'), kb);
}

export async function showReport(ctx, id) {
  const r = await getReport(Number(id));
  if (!r) return answer(ctx, T(ctx, 'common.invalid'), { alert: true });
  await answer(ctx);
  const text = `${T(ctx, 'adm.rp_head', { id: N(ctx, r.id), status: T(ctx, `adm.rp_status_${r.status}`) })}\n\n${r.body ? esc(r.body) : `<i>${T(ctx, `kind.${r.kind}`)}</i>`}\n\n${T(ctx, 'adm.rp_privacy')}`;
  const kb = r.status === 'open'
    ? [[btn(T(ctx, 'adm.btn_rp_ban'), `a:rb:${r.id}`), btn(T(ctx, 'adm.btn_rp_restrict'), `a:rr:${r.id}`)], [btn(T(ctx, 'adm.btn_rp_dismiss'), `a:rd:${r.id}`), btn(T(ctx, 'btn.back'), 'a:rp')]]
    : [[btn(T(ctx, 'btn.back'), 'a:rp')]];
  if (r.kind !== 'text' && r.fileId) {
    ctx.messageId = null;
    return sendMedia(ctx, 'admin_report', r.kind, r.fileId, truncate(text, 1000), kb, ctx.chatId, { secret: true });
  }
  return show(ctx, 'admin_report', text, kb, { secret: true });
}

/** b = ban the sender, r = restrict them from anonymous messages for a week, d = dismiss. */
export async function actOnReport(ctx, id, action) {
  const r = await getReport(Number(id));
  if (!r || r.status !== 'open') return answer(ctx, T(ctx, 'adm.rp_done_already'), { alert: true });
  const status = { b: 'banned', r: 'restricted', d: 'dismissed' }[action];
  if (!status) return answer(ctx);
  if (action === 'b' && r.senderId !== OWNER_ID) await setBanned(r.senderId, true);
  if (action === 'r') await restrict(r.senderId, RESTRICT_LONG_SEC);
  await setReportStatus(r.id, status);
  await answer(ctx, T(ctx, `adm.rp_status_${status}`), { alert: true });
  return showReports(ctx);
}

// ---------- broadcast ----------

const AUDIENCES = ['all', ...LANGS];
const LANG_NAMES = { fa: '🇮🇷 فارسی', en: '🇬🇧 English', ru: '🇷🇺 Русский' };

/** How many a draft would reach: the reachable users (of its language), minus whoever started it. */
async function recipientsCount(lang, creatorId) {
  const creator = await getUser(creatorId);
  const counted = !!(creator && creator.started && creator.active && !creator.banned && (!lang || creator.blang === lang));
  const n = lang ? await countReachable(lang) : (await stats()).active;
  return Math.max(0, n - (counted ? 1 : 0));
}

export async function askBroadcast(ctx, user) {
  const running = await runningBroadcast();
  if (running) {
    await answer(ctx, T(ctx, 'bc.one_at_a_time'), { alert: true });
    const { text, kb } = progressView(running, ctx.lang);
    return show(ctx, 'broadcast_progress', text, kb);
  }
  await setState(user.id, 'bc_wait');
  await answer(ctx);
  return show(ctx, 'broadcast_ask', T(ctx, 'bc.ask'), [[btn(T(ctx, 'btn.cancel'), 'a:x')]]);
}

/** The draft's screen: who it goes to, the link button, and confirm / cancel. */
async function confirmView(ctx, b, note = '') {
  const n = await recipientsCount(b.lang, b.fromChat);
  const lines = [T(ctx, 'bc.confirm', { id: N(ctx, b.id), n: N(ctx, n) }), ''];
  lines.push(T(ctx, 'bc.audience', { who: b.lang ? LANG_NAMES[b.lang] : T(ctx, 'bc.aud_all') }));
  lines.push(b.btnText ? T(ctx, 'bc.button_line', { text: esc(b.btnText), url: esc(b.btnUrl) }) : T(ctx, 'bc.no_button'));
  const aud = (a) => btn(`${(b.lang || 'all') === a ? '✅ ' : ''}${a === 'all' ? T(ctx, 'bc.aud_all') : LANG_NAMES[a]}`, `a:bca:${b.id}:${a}`);
  const kb = [
    [aud('all'), aud('fa')],
    [aud('en'), aud('ru')],
    [b.btnText ? btn(T(ctx, 'bc.btn_remove_button'), `a:bcbx:${b.id}`) : btn(T(ctx, 'bc.btn_add_button'), `a:bcb:${b.id}`)],
    [btn(T(ctx, 'bc.btn_confirm'), `a:bcy:${b.id}`), btn(T(ctx, 'btn.cancel'), `a:bcn:${b.id}`)],
  ];
  return { text: `${note ? `${note}\n\n` : ''}${lines.join('\n')}`, kb };
}

/** The message to broadcast arrived: a preview (an exact copy) and the draft's screen. */
export async function onBroadcastMessage(ctx, user, message) {
  await clearState(user.id);
  try {
    await call(ctx, 'copyMessage', { chat_id: user.id, from_chat_id: message.chat.id, message_id: message.message_id }, 'broadcast_preview');
  } catch (err) {
    return send(ctx, 'broadcast_uncopyable', T(ctx, 'bc.uncopyable', { err: esc(describeError(err)) }), [toPanel(ctx)]);
  }
  const id = await createBroadcast(Number(message.chat.id), Number(message.message_id));
  const { text, kb } = await confirmView(ctx, await getBroadcast(id));
  const album = message.media_group_id ? `\n\n${T(ctx, 'bc.album')}` : '';
  return send(ctx, 'broadcast_confirm', `${text}${album}`, kb);
}

async function draftOrRefuse(ctx, id) {
  const b = await getBroadcast(Number(id));
  if (b && b.status === 'draft') return b;
  await answer(ctx, T(ctx, 'bc.not_startable'), { alert: true });
  return null;
}

/** "a:bca:<id>:<all|fa|en|ru>": everyone, or only the users of one language. */
export async function setBroadcastAudience(ctx, id, audience) {
  const b = await draftOrRefuse(ctx, id);
  if (!b) return null;
  if (!AUDIENCES.includes(audience)) return answer(ctx, T(ctx, 'e.old_button'));
  const lang = audience === 'all' ? null : audience;
  if (lang) { // every user's language must be known first (rows from before users.blang)
    let done = false;
    for (let i = 0; i < 20 && !done; i += 1) done = await backfillBlang();
  }
  await saveAudience(b.id, lang);
  await answer(ctx);
  const { text, kb } = await confirmView(ctx, { ...b, lang });
  return show(ctx, 'broadcast_confirm', text, kb);
}

export async function askBroadcastButton(ctx, user, id) {
  const b = await draftOrRefuse(ctx, id);
  if (!b) return null;
  await setState(user.id, 'bc_btn', { id: b.id });
  await answer(ctx);
  return show(ctx, 'broadcast_button_ask', T(ctx, 'bc.button_ask'), [[btn(T(ctx, 'btn.cancel'), `a:bcp:${b.id}`)]]);
}

/** "Text | link" (or the text, then the link on the next line). A t.me/… link or @channel gets https://. */
export function parseButton(input) {
  const m = /^([^|\n]+?)\s*(?:\||\n)\s*(\S+)\s*$/.exec(String(input || '').trim());
  if (!m) return null;
  const text = m[1].trim();
  let url = m[2];
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(url)) url = `https://t.me/${url.slice(1)}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (!text || text.length > 64 || url.length > 512) return null;
  if (!/^(https?:\/\/[^\s/?#@]+\.[^\s/?#@]+(?:[/?#]\S*)?|tg:\/\/\S+)$/i.test(url)) return null;
  return { text, url };
}

/** The button arrived (state bc_btn): a preview with it — Telegram checks the link here — then the draft. */
export async function onBroadcastButton(ctx, user, input, data) {
  const b = await getBroadcast(Number(data && data.id));
  if (!b || b.status !== 'draft') {
    await clearState(user.id);
    return send(ctx, 'broadcast_not_draft', T(ctx, 'bc.not_startable'), [toPanel(ctx)]);
  }
  const parsed = parseButton(input);
  if (!parsed) return send(ctx, 'broadcast_button_invalid', T(ctx, 'bc.button_invalid'));
  try {
    await call(ctx, 'copyMessage', {
      chat_id: user.id, from_chat_id: b.fromChat, message_id: b.messageId,
      reply_markup: { inline_keyboard: [[{ text: parsed.text, url: parsed.url }]] },
    }, 'broadcast_preview');
  } catch (err) {
    if (isApiError(err) && err.code === 400) return send(ctx, 'broadcast_button_invalid', T(ctx, 'bc.button_invalid'));
    throw err;
  }
  await saveButton(b.id, parsed.text, parsed.url);
  await clearState(user.id);
  const { text, kb } = await confirmView(ctx, { ...b, btnText: parsed.text, btnUrl: parsed.url }, T(ctx, 'bc.button_saved'));
  return send(ctx, 'broadcast_confirm', text, kb);
}

export async function removeBroadcastButton(ctx, id) {
  const b = await draftOrRefuse(ctx, id);
  if (!b) return null;
  await saveButton(b.id, null, null);
  await answer(ctx, T(ctx, 'bc.button_removed'));
  const { text, kb } = await confirmView(ctx, { ...b, btnText: null, btnUrl: null });
  return show(ctx, 'broadcast_confirm', text, kb);
}

async function showProgress(ctx, b) {
  const { text, kb } = progressView(b, ctx.lang);
  return show(ctx, 'broadcast_progress', text, kb);
}

export async function confirmBroadcast(ctx, id) {
  const b = await getBroadcast(Number(id));
  if (!b || b.status !== 'draft') {
    await answer(ctx, T(ctx, 'bc.not_startable'), { alert: true });
    return b ? showProgress(ctx, b) : null;
  }
  const total = await recipientsCount(b.lang, b.fromChat);
  if (!(await startBroadcast(b.id, total, ctx.chatId, ctx.messageId))) return answer(ctx, T(ctx, 'bc.one_at_a_time'), { alert: true });
  await setKv('bc', b.id);
  await answer(ctx, T(ctx, 'bc.started'));
  return runBatch(ctx, b.id);
}

/**
 * "▶️ ادامه ارسال" (and the start): one batch, then the progress message (and the final report when
 * done). The bot then wakes itself for the next batches (lib/wake.js), so one press is enough.
 */
export async function runBatch(ctx, id) {
  const r = await processBatch(ctx, Number(id), BC_BATCH);
  if (!r.ran) {
    if (r.reason === 'wait') await answer(ctx, T(ctx, 'bc.wait', { n: N(ctx, r.b.nextAt - nowSec()) }), { alert: true });
    else if (r.reason === 'locked') await answer(ctx, T(ctx, 'bc.locked'));
    else await answer(ctx);
    await keepGoing(ctx, r);
    return r.b ? showProgress(ctx, r.b) : null;
  }
  await answer(ctx);
  if (ctx.messageId) await setBroadcastProgressMessage(r.b.id, ctx.chatId, ctx.messageId);
  await showProgress(ctx, r.b);
  if (r.done) await finalReport(ctx, r.b);
  else await keepGoing(ctx, r);
  return null;
}

export async function stopBroadcast(ctx, id) {
  const ok = await setBroadcastStatus(Number(id), 'running', 'stopped');
  const b = await getBroadcast(Number(id));
  if (ok) await setKv('bc', null);
  await answer(ctx, T(ctx, ok ? 'bc.stopped' : 'bc.not_running'));
  if (!b) return null;
  await showProgress(ctx, b);
  if (ok) await finalReport(ctx, b);
  return null;
}

export async function cancelBroadcast(ctx, id) {
  const ok = await setBroadcastStatus(Number(id), 'draft', 'cancelled');
  await answer(ctx, T(ctx, ok ? 'bc.cancelled_short' : 'bc.not_cancellable'));
  return show(ctx, 'broadcast_cancelled', T(ctx, ok ? 'bc.cancelled' : 'bc.not_cancellable'), [toPanel(ctx)]);
}

export async function showBroadcast(ctx, id) {
  const b = await getBroadcast(Number(id));
  await answer(ctx);
  if (b && b.status === 'draft') {
    const { text, kb } = await confirmView(ctx, b);
    return show(ctx, 'broadcast_confirm', text, kb);
  }
  return b ? showProgress(ctx, b) : null;
}

// ---------- scheduler (lib/wake.js) ----------

/** Where the bot wakes itself up, and when it last did; the outside clock's last tick. */
export async function showClock(ctx, note = '') {
  const w = await wakeStatus();
  const now = nowSec();
  const lines = [T(ctx, 'wk.title'), '', T(ctx, 'wk.how'), ''];
  lines.push(w.chatId ? T(ctx, 'wk.where_channel', { name: esc(w.chatTitle || String(w.chatId)) }) : T(ctx, 'wk.where_private'));
  lines.push(T(ctx, 'wk.last_wake', {
    ago: w.lastWake ? ago(ctx.lang, w.lastWake, now) : T(ctx, 'wk.never'), n: N(ctx, w.thisHour), cap: N(ctx, w.cap),
  }));
  lines.push(w.lastTick ? T(ctx, 'wk.tick_last', { ago: ago(ctx.lang, w.lastTick, now) }) : T(ctx, 'wk.tick_none'));
  const kb = [
    [btn(T(ctx, 'wk.btn_channel'), 'a:wkc')],
    ...(w.chatId ? [[btn(T(ctx, 'wk.btn_private'), 'a:wkp')]] : []),
    [btn(T(ctx, 'wk.btn_guide'), 'a:wkg')],
    toPanel(ctx),
  ];
  return show(ctx, 'admin_clock', `${note ? `${note}\n\n` : ''}${lines.join('\n')}`, kb);
}

export async function askWakeChat(ctx, user) {
  await setState(user.id, 'wake_chat');
  await answer(ctx);
  return show(ctx, 'admin_clock_ask', T(ctx, 'wk.ask'), [[btn(T(ctx, 'btn.cancel'), 'a:wk')]]);
}

/** A post forwarded from the channel, its numeric id, or @name: the bot must post and delete there. */
export async function onWakeChatInput(ctx, user, kv, message) {
  const origin = message.forward_origin || {};
  const fromForward = (origin.type === 'channel' && origin.chat) || message.forward_from_chat || null;
  const text = toAsciiDigits(String(message.text || '').trim());
  const ref = fromForward ? fromForward.id : /^-100\d{5,}$/.test(text) ? Number(text) : normalizeChannel(text) ? `@${normalizeChannel(text)}` : null;
  if (!ref) return send(ctx, 'admin_clock_invalid', T(ctx, 'wk.invalid'));
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'admin_get_chat');
  } catch (err) {
    return send(ctx, 'admin_clock_invalid', T(ctx, 'wk.invalid'));
  }
  if (chat.type !== 'channel') return send(ctx, 'admin_clock_invalid', T(ctx, 'wk.invalid'));
  const bot = await botInfo(ctx, kv);
  let ok = false;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: bot.id }, 'admin_check');
    ok = m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false && m.can_delete_messages !== false);
  } catch (err) {
    console.warn(`wake channel check failed: ${describeError(err)}`);
  }
  const name = esc(chat.title || String(chat.id));
  if (!ok) return send(ctx, 'admin_clock_not_admin', T(ctx, 'wk.not_admin', { name }));
  await setWakeChat(chat.id, chat.title);
  await clearState(user.id);
  ctx.messageId = null;
  return showClock(ctx, T(ctx, 'wk.saved', { name }));
}

export async function resetWakeChat(ctx) {
  await setWakeChat(null);
  await answer(ctx);
  return showClock(ctx, T(ctx, 'wk.reset'));
}

/** How to connect an outside clock: a helper bot posting in the wake channel on a cron schedule. */
export async function showClockGuide(ctx) {
  const w = await wakeStatus();
  await answer(ctx);
  const kb = [[btn(T(ctx, 'btn.back'), 'a:wk')]];
  if (!w.chatId) return show(ctx, 'admin_clock_guide', T(ctx, 'wk.guide_need_channel'), kb);
  return show(ctx, 'admin_clock_guide', T(ctx, 'wk.guide', { chat: String(w.chatId) }), kb);
}

// ---------- admins (the owner only) ----------

const sep = (ctx) => (ctx.lang === 'fa' ? '، ' : ', ');

/** "confessions، reports" — what these permissions are called, in the reader's language. */
export function permNames(ctx, perms) {
  const names = ADMIN_PERMS.filter((p) => perms.includes(p)).map((p) => T(ctx, `ad.perm_${p}`));
  return names.length ? names.join(sep(ctx)) : T(ctx, 'ad.perm_none');
}

async function personLabel(id, { html = true } = {}) {
  const u = await getUser(id);
  const name = u && u.username ? `@${u.username}` : u && u.firstName ? u.firstName : '';
  if (!html) return truncate(name || String(id), 30);
  return name ? `${esc(name)} (<code>${id}</code>)` : `<code>${id}</code>`;
}

export async function showAdmins(ctx, note = '') {
  const admins = await listAdmins();
  const lines = [T(ctx, 'ad.title', { n: N(ctx, admins.length), max: N(ctx, MAX_ADMINS) }), ''];
  const kb = [];
  for (const a of admins) {
    lines.push(`• ${await personLabel(a.id)} — ${permNames(ctx, a.perms)}`);
    kb.push([btn(`✏️ ${await personLabel(a.id, { html: false })}`, `a:adv:${a.id}`)]);
  }
  if (!admins.length) lines.push(T(ctx, 'ad.none'));
  if (admins.length < MAX_ADMINS) kb.push([btn(T(ctx, 'ad.btn_add'), 'a:adn')]);
  kb.push(toPanel(ctx));
  return show(ctx, 'admin_admins', `${note ? `${note}\n\n` : ''}${lines.join('\n')}`, kb);
}

export async function askAdmin(ctx, user) {
  await setState(user.id, 'admin_add');
  await answer(ctx);
  return show(ctx, 'admin_admin_ask', T(ctx, 'ad.ask'), [[btn(T(ctx, 'btn.cancel'), 'a:ad')]]);
}

/** A forwarded message from the person, their numeric id, or the @username of someone the bot knows. */
export async function onAdminInput(ctx, user, message) {
  const origin = message.forward_origin || {};
  if (origin.type === 'hidden_user') return send(ctx, 'admin_admin_invalid', T(ctx, 'ad.hidden'));
  let id = null;
  if (origin.type === 'user' && origin.sender_user) id = Number(origin.sender_user.id);
  else if (message.forward_from) id = Number(message.forward_from.id);
  else {
    const text = toAsciiDigits(String(message.text || '').trim());
    if (/^[1-9][0-9]{4,15}$/.test(text)) id = Number(text);
    else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) {
      const u = await getUserByUsername(text.replace(/^@/, '').toLowerCase());
      if (u) id = u.id;
    }
  }
  if (!id) return send(ctx, 'admin_admin_invalid', T(ctx, 'ad.invalid'));
  const r = await addAdmin(id);
  await clearState(user.id);
  ctx.messageId = null;
  if (r === 'owner') return showAdmins(ctx, T(ctx, 'ad.is_owner'));
  if (r === 'full') return showAdmins(ctx, T(ctx, 'ad.full', { max: N(ctx, MAX_ADMINS) }));
  const who = await personLabel(id);
  if (r === 'dup') return showAdmin(ctx, id, T(ctx, 'ad.already', { who }));
  const u = await getUser(id);
  if (u && u.started && u.active) {
    const lang = langOf(u);
    try {
      await send(ctx, 'admin_welcome', t(lang, 'ad.welcome'), [[btn(t(lang, 'ad.btn_open_panel'), 'a')]], id);
    } catch (err) {
      // they'll find /admin when they come
    }
  }
  return showAdmin(ctx, id, T(ctx, 'ad.added', { who }));
}

/** One admin: what they may do (toggles), and removing them. */
export async function showAdmin(ctx, id, note = '') {
  const staff = await getStaff(id);
  if (!staff || staff.owner) return showAdmins(ctx, T(ctx, 'ad.gone'));
  const kb = ADMIN_PERMS.map((p) => [btn(`${staff.perms.has(p) ? '✅' : '▫️'} ${T(ctx, `ad.perm_${p}`)}`, `a:adp:${staff.id}:${p}`)]);
  kb.push([btn(T(ctx, 'ad.btn_remove'), `a:adx:${staff.id}`)]);
  kb.push([btn(T(ctx, 'btn.back'), 'a:ad')]);
  const text = `${note ? `${note}\n\n` : ''}${T(ctx, 'ad.edit', { who: await personLabel(staff.id) })}`;
  return show(ctx, 'admin_admin', text, kb);
}

export async function toggleAdminPerm(ctx, id, perm) {
  const perms = await togglePerm(Number(id), perm);
  if (!perms) return answer(ctx, T(ctx, 'ad.gone'), { alert: true });
  await answer(ctx, T(ctx, perms.includes(perm) ? 'ad.perm_on' : 'ad.perm_off', { p: T(ctx, `ad.perm_${perm}`) }));
  return showAdmin(ctx, Number(id));
}

export async function askRemoveAdmin(ctx, id) {
  if (!(await getStaff(id))) return answer(ctx, T(ctx, 'ad.gone'), { alert: true });
  await answer(ctx);
  return show(ctx, 'admin_admin_remove', T(ctx, 'ad.remove_ask', { who: await personLabel(Number(id)) }),
    [[btn(T(ctx, 'ad.btn_remove_yes'), `a:adxy:${id}`), btn(T(ctx, 'btn.no'), `a:adv:${id}`)]]);
}

export async function doRemoveAdmin(ctx, id) {
  const who = await personLabel(Number(id));
  const ok = await removeAdmin(Number(id));
  await answer(ctx, T(ctx, ok ? 'ad.removed_short' : 'ad.gone'));
  return showAdmins(ctx, ok ? T(ctx, 'ad.removed', { who }) : '');
}

// ---------- health (the owner only) ----------

/** What the bot needs from Telegram and the channels, checked now: the 🩺 page. */
export async function showHealth(ctx, kv) {
  const bot = await botInfo(ctx, kv);
  const lines = [T(ctx, 'hl.title'), ''];
  let me = null;
  try {
    me = await call(ctx, 'getMe', {}, 'health_me');
  } catch (err) {
    console.warn(`getMe failed: ${describeError(err)}`);
  }
  lines.push(T(ctx, me && me.supports_inline_queries ? 'hl.inline_on' : 'hl.inline_off'));
  const channels = await getChannels(kv);
  const checks = await Promise.all(channels.map(async (ch) => {
    if (!bot.id) return false;
    try {
      const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: bot.id }, 'admin_check');
      return m.status === 'administrator' || m.status === 'creator';
    } catch (err) {
      return false;
    }
  }));
  lines.push('', T(ctx, 'hl.channels', { ok: N(ctx, checks.filter(Boolean).length), n: N(ctx, channels.length) }));
  channels.forEach((ch, i) => lines.push(`${checks[i] ? '✅' : '❌'} @${esc(ch.username)} · ${T(ctx, 'hl.joins', { n: N(ctx, ch.joins || 0) })}`));
  if (kv.join === '0') lines.push(T(ctx, 'adm.ch_join_off'));
  else if (channels.length && checks.some((x) => !x)) lines.push(T(ctx, 'hl.need_admin'));
  const cf = await confessionChannelStatus(ctx, kv, bot);
  lines.push('', cf);
  const w = await wakeStatus();
  lines.push('', T(ctx, 'hl.wake', { ago: w.lastWake ? ago(ctx.lang, w.lastWake, nowSec()) : T(ctx, 'wk.never') }));
  const s = await stats();
  lines.push(T(ctx, 'hl.users', { users: N(ctx, s.users), active: N(ctx, s.active) }));
  return show(ctx, 'admin_health', lines.join('\n'), [[btn(T(ctx, 'hl.btn_refresh'), 'a:hl')], toPanel(ctx)]);
}
