// Owner panel. The router calls these only after checking from.id === OWNER_ID in a private chat,
// for every command and every button. Stats are counts only: no whisper or anonymous content is shown
// here, except a message a user chose to report — and even then never who sent it.
import {
  BC_BATCH, MAX_CHANNELS, OWNER_ID, RESTRICT_LONG_SEC,
} from './config.js';
import {
  getReport, listReports, restrict, setReportStatus,
} from './astore.js';
import { botInfo } from './bot.js';
import { finalReport, processBatch, progressView } from './broadcast.js';
import { num, t } from './i18n.js';
import { channelRef } from './join.js';
import {
  addChannel, bumpChannelVersion, clearState, countChannels, createBroadcast, getBroadcast, getChannel,
  getChannels, getUser, removeChannel, runningBroadcast, setBanned, setBroadcastStatus, setKv,
  setBroadcastProgressMessage, setState, startBroadcast, stats,
} from './store.js';
import {
  answer, btn, call, describeError, isApiError, send, sendMedia, show,
} from './tg.js';
import {
  esc, nowSec, toAsciiDigits, truncate,
} from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);
const toPanel = (ctx) => [btn(T(ctx, 'adm.btn_panel'), 'a')];

export async function showPanel(ctx, kv) {
  const n = await countChannels();
  const joinOn = kv.join !== '0';
  const running = kv.bc ? await getBroadcast(Number(kv.bc)) : null;
  const s = await stats();
  const kb = [
    [btn(T(ctx, 'adm.btn_channels'), 'a:ch'), btn(T(ctx, 'adm.btn_add_channel'), 'a:add')],
    [btn(T(ctx, joinOn ? 'adm.btn_join_on' : 'adm.btn_join_off'), 'a:j')],
    [btn(T(ctx, 'adm.btn_ban'), 'a:ban'), btn(T(ctx, 'adm.btn_unban'), 'a:unban')],
    [btn(T(ctx, 'adm.btn_stats'), 'a:st'), btn(T(ctx, 'adm.btn_reports', { n: N(ctx, s.reports) }), 'a:rp')],
    [running && running.status === 'running'
      ? btn(T(ctx, 'adm.btn_bc_running', { id: N(ctx, running.id) }), `a:bcp:${running.id}`)
      : btn(T(ctx, 'adm.btn_broadcast'), 'a:bc')],
  ];
  return show(ctx, 'admin_panel', T(ctx, 'adm.panel', {
    join: T(ctx, joinOn ? 'common.on' : 'common.off'), n: N(ctx, n), max: N(ctx, MAX_CHANNELS), reports: N(ctx, s.reports),
  }), kb);
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
  const lines = channels.map((ch, i) => `${N(ctx, i + 1)}. @${esc(ch.username)} — ${esc(truncate(ch.title, 40))}\n     ${status[i]}`);
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

export async function toggleJoin(ctx, kv) {
  const on = kv.join === '0';
  await setKv('join', on ? '1' : '0');
  kv.join = on ? '1' : '0';
  await answer(ctx, T(ctx, on ? 'adm.join_turned_on' : 'adm.join_turned_off'));
  return showPanel(ctx, kv);
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

async function recipientsCount() {
  const s = await stats();
  const owner = await getUser(OWNER_ID);
  return Math.max(0, s.active - (owner && owner.started && owner.active && !owner.banned ? 1 : 0));
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

/** The owner sent the message to broadcast: show a preview and ask for confirmation. */
export async function onBroadcastMessage(ctx, user, message) {
  await clearState(user.id);
  try {
    await call(ctx, 'copyMessage', { chat_id: user.id, from_chat_id: message.chat.id, message_id: message.message_id }, 'broadcast_preview');
  } catch (err) {
    return send(ctx, 'broadcast_uncopyable', T(ctx, 'bc.uncopyable', { err: esc(describeError(err)) }), [toPanel(ctx)]);
  }
  const id = await createBroadcast(Number(message.chat.id), Number(message.message_id));
  const n = await recipientsCount();
  const album = message.media_group_id ? `\n${T(ctx, 'bc.album')}` : '';
  return send(ctx, 'broadcast_confirm', `${T(ctx, 'bc.confirm', { id: N(ctx, id), n: N(ctx, n) })}${album}`,
    [[btn(T(ctx, 'bc.btn_confirm'), `a:bcy:${id}`), btn(T(ctx, 'btn.cancel'), `a:bcn:${id}`)]]);
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
  const total = await recipientsCount();
  if (!(await startBroadcast(b.id, total, ctx.chatId, ctx.messageId))) return answer(ctx, T(ctx, 'bc.one_at_a_time'), { alert: true });
  await setKv('bc', b.id);
  await answer(ctx, T(ctx, 'bc.started'));
  return runBatch(ctx, b.id);
}

/** "▶️ ادامه ارسال": one batch, then the progress message (and the final report when done). */
export async function runBatch(ctx, id) {
  const r = await processBatch(ctx, Number(id), BC_BATCH);
  if (!r.ran) {
    if (r.reason === 'wait') await answer(ctx, T(ctx, 'bc.wait', { n: N(ctx, r.b.nextAt - nowSec()) }), { alert: true });
    else if (r.reason === 'locked') await answer(ctx, T(ctx, 'bc.locked'));
    else await answer(ctx);
    return r.b ? showProgress(ctx, r.b) : null;
  }
  await answer(ctx);
  if (ctx.messageId) await setBroadcastProgressMessage(r.b.id, ctx.chatId, ctx.messageId);
  await showProgress(ctx, r.b);
  if (r.done) await finalReport(ctx, r.b);
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
  return b ? showProgress(ctx, b) : null;
}
