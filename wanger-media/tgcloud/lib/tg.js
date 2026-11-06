// The only way the bot calls the Telegram Bot API. Every call is recorded in ctx.trace
// ({ view, method, ok, kind }) so `npm run tg -- run handlers/…` shows what the bot did, and every
// failure gets a `kind` from classify(). There are no timers on this platform, so a 429 is never
// waited out here: the caller gives up and the user can retry (broadcast batches store retry_after).
import { api } from 'sdk';

/** What a Bot API failure means for the caller. Pure. */
export function classify(err) {
  const code = err && typeof err.code === 'number' ? err.code : null;
  const d = String((err && (err.description || err.message)) || '').toLowerCase();
  if (code === 429) return { kind: 'rate', retryAfter: (err.parameters && err.parameters.retry_after) || null };
  if (code === 403) {
    if (/blocked by the user|user is deactivated|can't initiate conversation|bot was kicked from the private/.test(d)) return { kind: 'blocked' };
    return { kind: 'forbidden' };
  }
  if (code === 400) {
    if (/message is not modified/.test(d)) return { kind: 'not_modified' };
    if (/message to edit not found|message can't be edited|message to delete not found|query is too old|query id is invalid/.test(d)) return { kind: 'gone' };
    if (/member not found|participant_id_invalid/.test(d)) return { kind: 'member_not_found' };
    if (/chat not found|peer_id_invalid/.test(d)) return { kind: 'chat_not_found' };
    if (/user not found/.test(d)) return { kind: 'user_not_found' };
    return { kind: 'bad_request' };
  }
  if (code !== null && code >= 500) return { kind: 'server' };
  if (code === null) return { kind: 'network' };
  return { kind: 'other' };
}

/** Calls api[method](params); records the call; on failure rethrows the error with err.kind set. */
export async function call(ctx, view, method, params) {
  try {
    const result = await api[method](params);
    ctx.trace.push({ view, method, ok: true });
    return result;
  } catch (err) {
    const info = classify(err);
    if (err && typeof err === 'object') {
      err.kind = info.kind;
      if (info.retryAfter) err.retryAfter = info.retryAfter;
    }
    ctx.trace.push({ view, method, ok: false, kind: info.kind, code: (err && err.code) || null });
    throw err;
  }
}

const base = (extra) => ({ parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

/** sendMessage with Telegram HTML. `screen` is { text, reply_markup? } from lib/ui.js. */
export function send(ctx, view, chatId, screen, extra = {}) {
  return call(ctx, view, 'sendMessage', base({ chat_id: chatId, text: screen.text, reply_markup: screen.reply_markup, ...extra }));
}

/**
 * Shows `screen` in place of an existing bot message. "Not modified" counts as done; a message
 * that can't be edited any more (deleted, too old) gets a fresh message instead.
 */
export async function edit(ctx, view, message, screen) {
  try {
    return await call(ctx, view, 'editMessageText', base({
      chat_id: message.chat.id, message_id: message.message_id, text: screen.text, reply_markup: screen.reply_markup,
    }));
  } catch (err) {
    if (err && err.kind === 'not_modified') return null;
    if (err && (err.kind === 'gone' || err.kind === 'bad_request')) return send(ctx, view, message.chat.id, screen);
    throw err;
  }
}

/** answerCallbackQuery; never throws (an expired query id must not break the handler). */
export async function answer(ctx, callbackId, text, showAlert = false) {
  try {
    await call(ctx, 'answer', 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: showAlert } : {}) });
    return true;
  } catch {
    return false;
  }
}
