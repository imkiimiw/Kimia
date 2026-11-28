// Random anonymous chat. "🔎 Find someone" connects the user at once with the person who has waited
// longest for their language (rc_queue) — skipping anyone either of them blocked — or puts them in the
// queue. While connected (users.rc_partner on both rows) whatever they send is re-sent to the partner
// by the bot itself: never forwarded, never with a name, with protect_content so it can't be forwarded
// or saved on. Texts go through the partner's offensive and phone filters (links are never relayed:
// spam); photos, videos and files only if the partner accepts them. The controls are a reply keyboard
// (next / end / report) in each side's language. A report ends the chat, keeps the two apart for good
// (rc_blocks) and counts as a strike — three different people within a week restrict the sender
// (lib/astore.js addStrike).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import {
  RC_IDLE_SEC, RC_MAX_LEN, RC_MIN_GAP_SEC, RC_QUEUE_TTL_SEC,
} from './config.js';
import { addStrike } from './astore.js';
import {
  hasLink, hasPhone, isOffensive, normalize,
} from './filter.js';
import { langOf, t } from './i18n.js';
import {
  bump, getUser, markInactive, setUserField,
} from './store.js';
import {
  answer, btn, call, describeError, isApiError, send, show,
} from './tg.js';
import { esc, nowSec } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const LANGS = ['fa', 'en', 'ru'];
// Media kinds relayed only to someone who accepts them; the rest (stickers, GIFs, voice) always.
const GATED = new Set(['photo', 'video', 'document', 'audio']);
const RELAYED = ['sticker', 'animation', 'voice', 'video_note', 'photo', 'video', 'document', 'audio'];

/** The chat controls under the message box, in `lang`. */
function controls(lang) {
  return {
    keyboard: [[{ text: t(lang, 'rc.k_next') }, { text: t(lang, 'rc.k_end') }], [{ text: t(lang, 'rc.k_report') }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: t(lang, 'rc.placeholder'),
  };
}
const REMOVE = { remove_keyboard: true };

/** 'next' | 'end' | 'report' when the text is one of the control buttons (in any language). */
function controlOf(text) {
  for (const key of ['next', 'end', 'report']) if (LANGS.some((l) => t(l, `rc.k_${key}`) === text)) return key;
  return null;
}

/** A tap on the chat controls: handled before anything else the user was in the middle of. */
export const isControl = (message) => typeof message.text === 'string' && !!controlOf(message.text.trim());

async function blockedPair(a, b) {
  const x = await db.get(sql`SELECT 1 AS x FROM rc_blocks WHERE user_id = ${a} AND blocked_id = ${b}`);
  if (x) return true;
  return !!(await db.get(sql`SELECT 1 AS x FROM rc_blocks WHERE user_id = ${b} AND blocked_id = ${a}`));
}

async function inQueue(userId) {
  return !!(await db.get(sql`SELECT 1 AS x FROM rc_queue WHERE user_id = ${userId}`));
}

async function leaveQueue(userId) {
  await db.run(sql`DELETE FROM rc_queue WHERE user_id = ${userId}`);
}

/** Connects `user` with the longest-waiting free person of their language, or returns null. */
async function claimPartner(user, now) {
  const lang = user.blang;
  await db.run(sql`
    DELETE FROM rc_queue WHERE user_id IN (
      SELECT user_id FROM rc_queue WHERE lang = ${lang} AND since < ${now - RC_QUEUE_TTL_SEC} ORDER BY since LIMIT 20)`);
  const rows = await db.all(sql`
    SELECT user_id FROM rc_queue WHERE lang = ${lang} AND user_id != ${user.id} ORDER BY since LIMIT 10`);
  for (const r of rows) {
    const pid = Number(r.user_id);
    if (await blockedPair(user.id, pid)) continue;
    if (!(await db.run(sql`DELETE FROM rc_queue WHERE user_id = ${pid}`)).rowsAffected) continue; // taken meanwhile
    const mine = await db.run(sql`
      UPDATE users SET rc_partner = ${pid}, rc_since = ${now}, rc_last = ${now} WHERE user_id = ${user.id} AND rc_partner = 0`);
    if (!mine.rowsAffected) { // this user got connected meanwhile: give the other their place back
      await db.run(sql`INSERT INTO rc_queue (user_id, lang, since) VALUES (${pid}, ${lang}, ${now}) ON CONFLICT(user_id) DO NOTHING`);
      return null;
    }
    const theirs = await db.run(sql`
      UPDATE users SET rc_partner = ${user.id}, rc_since = ${now}, rc_last = ${now}
      WHERE user_id = ${pid} AND rc_partner = 0 AND banned = 0`);
    if (theirs.rowsAffected) return pid;
    await db.run(sql`UPDATE users SET rc_partner = 0 WHERE user_id = ${user.id} AND rc_partner = ${pid}`);
  }
  return null;
}

/** Ends the chat on both rows (only while they are still each other's partner). */
async function disconnect(a, b) {
  await db.run(sql`UPDATE users SET rc_partner = 0 WHERE user_id = ${a} AND rc_partner = ${b}`);
  await db.run(sql`UPDATE users SET rc_partner = 0 WHERE user_id = ${b} AND rc_partner = ${a}`);
}

// ---------- screens ----------

export async function showHome(ctx, user, note = '') {
  if (user.rcPartner) return show(ctx, 'rc_in_chat', `${note ? `${note}\n\n` : ''}${T(ctx, 'rc.in_chat')}`, [[btn(T(ctx, 'rc.btn_end'), 'rc:e')]]);
  if (await inQueue(user.id)) return show(ctx, 'rc_waiting', T(ctx, 'rc.waiting'), [[btn(T(ctx, 'rc.btn_cancel'), 'rc:x')]]);
  const kb = [
    [btn(T(ctx, 'rc.btn_find'), 'rc:go')],
    [btn(T(ctx, user.rcMedia ? 'rc.btn_media_on' : 'rc.btn_media_off'), 'rc:m')],
    [btn(T(ctx, 'btn.home'), 'm')],
  ];
  return show(ctx, 'rc_home', `${note ? `${note}\n\n` : ''}${T(ctx, 'rc.home')}`, kb);
}

export async function toggleMedia(ctx, user) {
  user.rcMedia = !user.rcMedia;
  await setUserField(user.id, 'rc_media', user.rcMedia ? 1 : 0);
  await answer(ctx, T(ctx, user.rcMedia ? 'rc.media_on' : 'rc.media_off'));
  return showHome(ctx, user);
}

/** "🔎": a partner now, or a place in the queue (they're told when someone comes). */
export async function find(ctx, user) {
  const now = nowSec();
  if (user.restrictedUntil > now) return answer(ctx, T(ctx, 'rc.restricted'), { alert: true });
  if (user.rcPartner) {
    const partner = await getUser(user.rcPartner);
    // a chat the other side abandoned long ago ends here; a live one stays
    if (partner && partner.rcPartner === user.id && now - Math.max(partner.rcLast, user.rcLast) < RC_IDLE_SEC) {
      return answer(ctx, T(ctx, 'rc.already'), { alert: true });
    }
    await disconnect(user.id, user.rcPartner);
    user.rcPartner = 0;
  }
  await answer(ctx);
  const pid = await claimPartner(user, now);
  if (!pid) {
    await db.run(sql`
      INSERT INTO rc_queue (user_id, lang, since) VALUES (${user.id}, ${user.blang}, ${now})
      ON CONFLICT(user_id) DO UPDATE SET lang = excluded.lang, since = excluded.since`);
    return show(ctx, 'rc_waiting', T(ctx, 'rc.waiting'), [[btn(T(ctx, 'rc.btn_cancel'), 'rc:x')]]);
  }
  await leaveQueue(user.id);
  await bump('n_rchats', 1);
  const partner = await getUser(pid);
  const plang = langOf(partner);
  try {
    await call(ctx, 'sendMessage', {
      chat_id: pid, text: t(plang, 'rc.connected'), parse_mode: 'HTML', reply_markup: controls(plang),
    }, 'rc_connected');
  } catch (err) {
    await disconnect(user.id, pid);
    if (isApiError(err) && err.code === 403) await markInactive(pid);
    user.rcPartner = 0;
    return showHome(ctx, user, T(ctx, 'rc.partner_gone'));
  }
  user.rcPartner = pid;
  ctx.messageId = null;
  return send(ctx, 'rc_connected', T(ctx, 'rc.connected'), null, ctx.chatId, { replyMarkup: controls(ctx.lang) });
}

export async function cancelSearch(ctx, user) {
  await leaveQueue(user.id);
  await answer(ctx, T(ctx, 'rc.search_cancelled'));
  return showHome(ctx, user);
}

/** Ends the chat for both; `report` also strikes the partner and keeps the two apart for good. */
export async function end(ctx, user, { next = false, report = false } = {}) {
  const pid = user.rcPartner;
  if (!pid) {
    await leaveQueue(user.id);
    if (ctx.callbackId) await answer(ctx);
    ctx.messageId = null;
    await send(ctx, 'rc_ended', T(ctx, 'rc.not_in_chat'), null, ctx.chatId, { replyMarkup: REMOVE });
    return next ? find(ctx, user) : showHome(ctx, user);
  }
  await disconnect(user.id, pid);
  user.rcPartner = 0;
  if (report) {
    await db.run(sql`INSERT INTO rc_blocks (user_id, blocked_id, at) VALUES (${user.id}, ${pid}, ${nowSec()}) ON CONFLICT DO NOTHING`);
    await addStrike(pid, user.id);
  }
  const partner = await getUser(pid);
  if (partner && partner.active) {
    const plang = langOf(partner);
    await send(ctx, 'rc_partner_left', t(plang, 'rc.partner_left'), null, pid, { replyMarkup: REMOVE });
    await send(ctx, 'rc_home', t(plang, 'rc.again'), [[btn(t(plang, 'rc.btn_find'), 'rc:go')], [btn(t(plang, 'btn.home'), 'm')]], pid);
  }
  if (ctx.callbackId) await answer(ctx, report ? T(ctx, 'rc.reported') : undefined, report ? { alert: true } : {});
  ctx.messageId = null;
  await send(ctx, 'rc_ended', T(ctx, report ? 'rc.reported_text' : 'rc.you_left'), null, ctx.chatId, { replyMarkup: REMOVE });
  return next ? find(ctx, user) : showHome(ctx, user);
}

export async function askReport(ctx, user) {
  if (!user.rcPartner) return end(ctx, user);
  if (ctx.callbackId) await answer(ctx);
  ctx.messageId = null;
  return send(ctx, 'rc_report_ask', T(ctx, 'rc.report_ask'), [[btn(T(ctx, 'rc.btn_report_yes'), 'rc:ry'), btn(T(ctx, 'btn.no'), 'rc:rn')]]);
}

// ---------- relaying ----------

/**
 * A message from someone in a chat (lib/router.js: no pending state, not a command). The control
 * buttons are handled here; anything else goes to the partner, re-sent by the bot.
 */
export async function onMessage(ctx, user, message) {
  const control = typeof message.text === 'string' ? controlOf(message.text.trim()) : null;
  if (control === 'end') return end(ctx, user);
  if (control === 'next') return end(ctx, user, { next: true });
  if (control === 'report') return askReport(ctx, user);
  const partner = await getUser(user.rcPartner);
  if (!partner || partner.rcPartner !== user.id || partner.banned) {
    await disconnect(user.id, user.rcPartner);
    user.rcPartner = 0;
    await send(ctx, 'rc_ended', T(ctx, 'rc.partner_gone'), null, ctx.chatId, { replyMarkup: REMOVE });
    return showHome(ctx, user);
  }
  const now = nowSec();
  if (now - user.rcLast < RC_MIN_GAP_SEC) return send(ctx, 'rc_slow', T(ctx, 'rc.slow'));
  const text = typeof message.text === 'string' ? message.text : String(message.caption || '');
  const kind = typeof message.text === 'string' ? 'text' : RELAYED.find((k) => message[k]);
  if (!kind) return send(ctx, 'rc_unsupported', T(ctx, 'rc.unsupported'));
  if (kind === 'text' && text.length > RC_MAX_LEN) return send(ctx, 'rc_too_long', T(ctx, 'rc.too_long'));
  if (GATED.has(kind) && !partner.rcMedia) return send(ctx, 'rc_media_blocked', T(ctx, 'rc.media_blocked'));
  if (text) {
    const why = (partner.aFilter && isOffensive(normalize(text)) && 'offensive')
      || (hasLink(text, message.entities || message.caption_entities) && 'link')
      || (partner.aPhone && hasPhone(text) && 'phone');
    if (why) return send(ctx, 'rc_filtered', T(ctx, `rc.filtered_${why}`));
  }
  await db.run(sql`UPDATE users SET rc_last = ${now} WHERE user_id = ${user.id}`);
  try {
    if (kind === 'text') {
      await call(ctx, 'sendMessage', { chat_id: partner.id, text: esc(text), parse_mode: 'HTML', protect_content: true }, 'rc_relay', { secret: true });
    } else {
      await call(ctx, 'copyMessage', {
        chat_id: partner.id, from_chat_id: user.id, message_id: message.message_id, protect_content: true,
      }, 'rc_relay');
    }
  } catch (err) {
    if (isApiError(err) && err.code === 403) {
      await markInactive(partner.id);
      await disconnect(user.id, partner.id);
      user.rcPartner = 0;
      await send(ctx, 'rc_ended', T(ctx, 'rc.partner_gone'), null, ctx.chatId, { replyMarkup: REMOVE });
      return showHome(ctx, user);
    }
    console.warn(`random chat relay failed: ${describeError(err)}`);
    return send(ctx, 'rc_failed', T(ctx, 'rc.failed'));
  }
  return null;
}
