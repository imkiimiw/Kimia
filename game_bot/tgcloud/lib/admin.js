/*
 * The owner panel, in the bot's private chat only (/admin and its buttons). bot.js lets only
 * OWNER_ID reach these functions; everyone else gets no response at all.
 *
 * callback_data: ad (panel) · ad:st (stats) · ad:bc (broadcast) · ad:ch (channels) · ad:ca (add a
 * channel) · ad:cr:<id> (remove?) · ad:cy:<id> (remove!) · ad:ct (forced join on/off) · ad:x (cancel
 * an input) · bc:ok:<id> (send the draft) · bc:no:<id> (drop it) · bc:nx:<id> (next batch) ·
 * bc:r:<id> (refresh) · bc:x:<id> (stop).
 * What the owner types next is set by settings.owner_state: 'ch' (a channel) or 'bc' (a broadcast).
 */
import { APP_URL, GAMES, MAX_CHANNELS, OWNER_ID } from './config.js';
import { cancelBroadcast, createDraft, currentBroadcast, getBroadcast, progress, sendBatch, setPanel, startBroadcast } from './broadcast.js';
import { GAME_ICONS, num, t } from './i18n/index.js';
import { bumpJoinRev, channelRef, channelTitle } from './join.js';
import * as store from './store.js';
import { answer, appBtn, btn, call, edit, esc, send, tryCall } from './tg.js';

const back = (lang) => [btn(t(lang, 'admin_back'), 'ad')];

async function botId(ctx) {
  if (!ctx.botId) ctx.botId = (await call(ctx, 'getMe', {}, 'me')).id;
  return ctx.botId;
}

/* Shows a screen: edits the pressed message, or sends a new one when there is none. */
async function screen(ctx, place, text, rows, view) {
  if (place) return edit(ctx, place, text, rows, view);
  return send(ctx, OWNER_ID, text, rows, view);
}

export async function panel(ctx, lang, place = null) {
  await store.setSetting('owner_state', '');
  const rows = [[btn(t(lang, 'admin_stats'), 'ad:st')], [btn(t(lang, 'admin_broadcast'), 'ad:bc')], [btn(t(lang, 'admin_channels'), 'ad:ch')]];
  await screen(ctx, place, t(lang, 'admin_title'), rows, 'admin');
}

async function stats(ctx, lang, place) {
  const s = await store.ownerStats();
  const counts = {};
  for (const c of s.counters) counts[c.key] = Number(c.n);
  const games = GAMES.map((g) => `${GAME_ICONS[g]} ${t(lang, `game_${g}`)}: ${num(lang, counts[`played_${g}`] || 0)}`).join('\n');
  const text = t(lang, 'admin_stats_text', { users: s.users, d7: s.d7, d30: s.d30, blocked: s.blocked, rooms: s.rooms, games });
  await screen(ctx, place, text, [[btn(t(lang, 'admin_stats'), 'ad:st')], back(lang)], 'admin-stats');
}

/* ---------- broadcast ---------- */

function progressScreen(lang, row) {
  const p = progress(row);
  const status = t(lang, p.status === 'running' ? 'admin_bc_running' : (p.status === 'done' ? 'admin_bc_done' : 'admin_bc_stopped'));
  const text = t(lang, 'admin_bc_progress', { status, sent: p.sent, failed: p.failed, blocked: p.blocked, done: p.done, total: p.total });
  const rows = [];
  if (p.status === 'running') {
    rows.push([btn(t(lang, 'admin_bc_next'), `bc:nx:${p.id}`)]);
    if (APP_URL) rows.push([appBtn(t(lang, 'admin_bc_live'), `${APP_URL}#broadcast`)]);
    rows.push([btn(t(lang, 'admin_bc_refresh'), `bc:r:${p.id}`), btn(t(lang, 'admin_bc_stop'), `bc:x:${p.id}`)]);
  } else {
    rows.push(back(lang));
  }
  return { text, rows };
}

/* After a batch that completed the broadcast: the final report, once. */
export async function reportIfFinished(ctx, lang, result) {
  if (!result.finished) return;
  const p = progress(result.row);
  await send(ctx, OWNER_ID, t(lang, 'admin_bc_report', { sent: p.sent, failed: p.failed, blocked: p.blocked }), null, 'bc-report');
  if (result.row.panel_msg) {
    const s = progressScreen(lang, result.row);
    await edit(ctx, { chat_id: OWNER_ID, message_id: Number(result.row.panel_msg) }, s.text, s.rows, 'bc-progress');
  }
}

async function broadcastMenu(ctx, lang, place) {
  const cur = await currentBroadcast();
  if (cur && cur.status === 'running') {
    const s = progressScreen(lang, cur);
    await screen(ctx, place, s.text, s.rows, 'bc-progress');
    return;
  }
  await store.setSetting('owner_state', 'bc');
  await screen(ctx, place, t(lang, 'admin_bc_prompt'), [[btn(t(lang, 'admin_bc_cancel'), 'ad:x')]], 'bc-prompt');
}

/* The owner sent the message to broadcast: preview it and ask to confirm. */
async function broadcastInput(ctx, lang, message) {
  const markup = message.reply_markup && message.reply_markup.inline_keyboard ? message.reply_markup : null;
  const id = await createDraft(OWNER_ID, message.message_id, markup);
  const params = { chat_id: OWNER_ID, from_chat_id: OWNER_ID, message_id: message.message_id };
  if (markup) params.reply_markup = markup;
  const copy = await tryCall(ctx, 'copyMessage', params, 'bc-preview');
  if (!copy) {
    await cancelBroadcast(id);
    await send(ctx, OWNER_ID, t(lang, 'admin_bc_cant_copy'), null, 'bc-cant-copy');
    return;
  }
  await store.setSetting('owner_state', '');
  const n = await store.countRecipients();
  await send(ctx, OWNER_ID, t(lang, 'admin_bc_preview', { n }), [[btn(t(lang, 'admin_bc_confirm'), `bc:ok:${id}`), btn(t(lang, 'admin_bc_cancel'), `bc:no:${id}`)]], 'bc-confirm');
}

/* ---------- channels ---------- */

async function channelsScreen(ctx, lang, place, notice) {
  const settings = await store.getSettings();
  const chans = await store.listChannels();
  const me = await botId(ctx);
  const lines = [];
  for (const ch of chans) {
    const m = await tryCall(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: me }, 'bot-admin?');
    const ok = m && (m.status === 'administrator' || m.status === 'creator');
    lines.push(`${ok ? '✅' : '⚠️'} ${esc(channelTitle(ch))}${ch.username ? ` — @${esc(ch.username)}` : ''}`);
  }
  const on = settings.join !== '0';
  const head = t(lang, 'admin_ch_title', { n: chans.length, max: MAX_CHANNELS, state: t(lang, on ? 'admin_ch_on' : 'admin_ch_off') });
  const text = `${notice ? `${notice}\n\n` : ''}${head}\n\n${lines.length ? lines.join('\n') : t(lang, 'admin_ch_empty')}`;
  const rows = chans.map((ch) => [btn(`🗑 ${channelTitle(ch)}`, `ad:cr:${ch.id}`)]);
  rows.push([btn(t(lang, 'admin_ch_add'), 'ad:ca')]);
  rows.push([btn(t(lang, on ? 'admin_ch_toggle_off' : 'admin_ch_toggle_on'), 'ad:ct')]);
  rows.push(back(lang));
  await screen(ctx, place, text, rows, 'admin-channels');
}

/* @name, t.me/name, https://t.me/name, -100…, a numeric id → a chat_id for getChat; null if none. */
export function parseChannelInput(text) {
  const s = String(text || '').trim();
  let m = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
  if (m) return `@${m[1]}`;
  m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(s);
  if (m) return `@${m[1]}`;
  m = /^-?\d{5,20}$/.exec(s);
  if (m) return s.startsWith('-') ? Number(s) : Number(`-100${s}`);
  return null;
}

async function addChannelInput(ctx, lang, message) {
  let ref = null;
  const origin = message.forward_origin;
  if (origin && origin.type === 'channel' && origin.chat) ref = origin.chat.id;
  else ref = parseChannelInput(message.text);
  if (ref === null) {
    await send(ctx, OWNER_ID, t(lang, 'admin_ch_bad_input'), [[btn(t(lang, 'admin_bc_cancel'), 'ad:x')]], 'ch-bad');
    return;
  }
  if (await store.countChannels() >= MAX_CHANNELS) {
    await store.setSetting('owner_state', '');
    await send(ctx, OWNER_ID, t(lang, 'admin_ch_limit', { max: MAX_CHANNELS }), null, 'ch-limit');
    return;
  }
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'ch-get');
  } catch (err) {
    await send(ctx, OWNER_ID, t(lang, 'admin_ch_not_found'), [[btn(t(lang, 'admin_bc_cancel'), 'ad:x')]], 'ch-not-found');
    return;
  }
  const title = chat.title || (chat.username ? `@${chat.username}` : String(chat.id));
  if (chat.type !== 'channel' && chat.type !== 'supergroup') {
    await send(ctx, OWNER_ID, t(lang, 'admin_ch_bad_input'), [[btn(t(lang, 'admin_bc_cancel'), 'ad:x')]], 'ch-bad');
    return;
  }
  let admin = false;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: await botId(ctx) }, 'ch-admin?');
    admin = m.status === 'administrator' || m.status === 'creator';
  } catch (err) {
    admin = false;
  }
  if (!admin) {
    await send(ctx, OWNER_ID, t(lang, 'admin_ch_not_admin', { title: esc(title) }), [[btn(t(lang, 'admin_bc_cancel'), 'ad:x')]], 'ch-not-admin');
    return;
  }
  const existing = (await store.channelByChatId(chat.id)) || (await store.listChannels()).find((c) => chat.username && c.uname === chat.username.toLowerCase());
  if (existing) {
    await store.updateChannel(existing.id, { chatId: chat.id, title });
    await store.setSetting('owner_state', '');
    await channelsScreen(ctx, lang, null, t(lang, 'admin_ch_exists'));
    return;
  }
  let link = chat.username ? null : chat.invite_link || null;
  if (!chat.username && !link) {
    try {
      link = await call(ctx, 'exportChatInviteLink', { chat_id: chat.id }, 'ch-link');
    } catch (err) {
      link = null;
    }
  }
  await store.addChannel({ username: chat.username || null, chatId: chat.id, title, link });
  await bumpJoinRev();
  await store.setSetting('owner_state', '');
  await channelsScreen(ctx, lang, null, t(lang, 'admin_ch_added', { title: esc(title) }));
}

/* ---------- entry points (owner only; bot.js checks) ---------- */

/* A private message from the owner while an input is expected. True if it was consumed. */
export async function ownerMessage(ctx, lang, message, command) {
  const settings = await store.getSettings();
  const state = settings.owner_state || '';
  if (!state) return false;
  if (command === 'cancel') {
    await store.setSetting('owner_state', '');
    await send(ctx, OWNER_ID, t(lang, 'admin_cancelled'), [back(lang)], 'admin-cancelled');
    return true;
  }
  if (command) return false;
  if (state === 'bc') await broadcastInput(ctx, lang, message);
  else if (state === 'ch') await addChannelInput(ctx, lang, message);
  else return false;
  return true;
}

export async function ownerCallback(ctx, lang, data, place) {
  const [kind, action, arg] = data.split(':');
  const id = Number(arg);
  if (kind === 'ad') {
    await answer(ctx);
    if (!action) await panel(ctx, lang, place);
    else if (action === 'st') await stats(ctx, lang, place);
    else if (action === 'bc') await broadcastMenu(ctx, lang, place);
    else if (action === 'ch') await channelsScreen(ctx, lang, place);
    else if (action === 'x') await panel(ctx, lang, place);
    else if (action === 'ca') {
      if (await store.countChannels() >= MAX_CHANNELS) {
        await channelsScreen(ctx, lang, place, t(lang, 'admin_ch_limit', { max: MAX_CHANNELS }));
        return;
      }
      await store.setSetting('owner_state', 'ch');
      await screen(ctx, place, t(lang, 'admin_ch_prompt'), [[btn(t(lang, 'admin_bc_cancel'), 'ad:x')]], 'ch-prompt');
    } else if (action === 'cr') {
      const ch = await store.getChannel(id);
      if (!ch) return channelsScreen(ctx, lang, place);
      await screen(ctx, place, t(lang, 'admin_ch_remove_q', { title: esc(channelTitle(ch)) }),
        [[btn(t(lang, 'admin_ch_yes'), `ad:cy:${id}`), btn(t(lang, 'admin_ch_no'), 'ad:ch')]], 'ch-remove?');
    } else if (action === 'cy') {
      const ch = await store.getChannel(id);
      if (ch) {
        await store.removeChannel(id);
        await bumpJoinRev();
      }
      await channelsScreen(ctx, lang, place, ch ? t(lang, 'admin_ch_removed', { title: esc(channelTitle(ch)) }) : '');
    } else if (action === 'ct') {
      const s = await store.getSettings();
      await store.setSetting('join', s.join === '0' ? '1' : '0');
      await bumpJoinRev();
      await channelsScreen(ctx, lang, place);
    }
    return;
  }
  if (kind !== 'bc') return;
  if (action === 'ok') {
    if (!(await startBroadcast(id, place.message_id))) {
      await answer(ctx, t(lang, 'admin_bc_busy'), true);
      return;
    }
    await answer(ctx);
    const r = await sendBatch(ctx, id);
    const s = progressScreen(lang, r.row);
    await edit(ctx, place, s.text, s.rows, 'bc-progress');
    await reportIfFinished(ctx, lang, r);
  } else if (action === 'no' || action === 'x') {
    await cancelBroadcast(id);
    await answer(ctx, t(lang, 'admin_bc_cancelled'));
    const row = await getBroadcast(id);
    if (action === 'x' && row) {
      const s = progressScreen(lang, row);
      await edit(ctx, place, s.text, s.rows, 'bc-progress');
    } else {
      await edit(ctx, place, t(lang, 'admin_bc_cancelled'), [back(lang)], 'bc-cancelled');
    }
  } else if (action === 'nx' || action === 'r') {
    await answer(ctx);
    let row = await getBroadcast(id);
    if (!row) return;
    if (action === 'nx' && row.status === 'running') {
      await setPanel(id, place.message_id);
      const r = await sendBatch(ctx, id);
      row = r.row;
      await reportIfFinished(ctx, lang, r);
    }
    const s = progressScreen(lang, row);
    await edit(ctx, place, s.text, s.rows, 'bc-progress');
  }
}

export const isAdminData = (data) => /^(ad|bc)(:|$)/.test(data);
