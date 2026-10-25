// Bot API access for one update. Every call goes through `call`, which also records it in
// ctx.trace; the handlers return that trace, so `npx tgcloud run` shows exactly what the bot
// sent (and what Telegram answered) for a test payload.
import { api, BotApiError } from 'sdk';

/** Per-update context: who we talk to, where, and what we have sent so far. */
export function createCtx({ userId, chatId, firstName = '', messageId = null, callbackId = null }) {
  return { userId, chatId, firstName, messageId, callbackId, answered: false, trace: [] };
}

function keyboardSummary(markup) {
  const rows = markup && markup.inline_keyboard;
  if (!rows) return undefined;
  return rows.map((row) => row.map((b) => (b.url ? `${b.text} -> ${b.url}` : `${b.text} [${b.callback_data}]`)));
}

/** True for a failed Bot API call (BotApiError carries .code and .description). */
export function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

export function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

/** Calls a Bot API method; records it in the trace; rethrows failures. */
export async function call(ctx, method, params, view) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (params.user_id !== undefined) entry.user = params.user_id;
  if (params.text !== undefined) entry.text = params.text;
  const kb = keyboardSummary(params.reply_markup);
  if (kb) entry.kb = kb;
  ctx.trace.push(entry);
  try {
    const result = await api[method](params);
    entry.ok = true;
    if (result && result.status) entry.status = result.status;
    return result;
  } catch (err) {
    entry.ok = false;
    entry.err = describeError(err);
    throw err;
  }
}

const markup = (kb) => (kb ? { reply_markup: { inline_keyboard: kb } } : {});

/** Sends a new HTML message. Failures (e.g. the user blocked the bot) are logged, not thrown. */
export async function send(ctx, view, text, kb, chatId = ctx.chatId) {
  try {
    return await call(ctx, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(kb),
    }, view);
  } catch (err) {
    console.warn(`sendMessage(${view}) failed: ${describeError(err)}`);
    return null;
  }
}

const EDIT_FALLBACK = /message to edit not found|message can't be edited|there is no text in the message|message_id_invalid/i;

/**
 * Shows a screen: in a button press it replaces the pressed message, otherwise it sends a new one.
 * If the old message can't be edited (too old, deleted), a new message is sent instead.
 */
export async function show(ctx, view, text, kb) {
  if (!ctx.messageId) return send(ctx, view, text, kb);
  try {
    return await call(ctx, 'editMessageText', {
      chat_id: ctx.chatId,
      message_id: ctx.messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(kb),
    }, view);
  } catch (err) {
    const desc = isApiError(err) ? err.description : '';
    if (/message is not modified/i.test(desc)) return null;
    if (EDIT_FALLBACK.test(desc)) return send(ctx, view, text, kb);
    console.warn(`editMessageText(${view}) failed: ${describeError(err)}`);
    return null;
  }
}

/** Answers the pressed button (once per update). */
export async function answer(ctx, text, alert = false) {
  if (!ctx.callbackId || ctx.answered) return;
  ctx.answered = true;
  const params = { callback_query_id: ctx.callbackId };
  if (text) {
    params.text = text;
    if (alert) params.show_alert = true;
  }
  try {
    await call(ctx, 'answerCallbackQuery', params);
  } catch (err) {
    console.warn(`answerCallbackQuery failed: ${describeError(err)}`);
  }
}

// ---------- keyboard buttons ----------

/** A callback button. callback_data is ASCII by construction; Telegram allows 1-64 bytes. */
export function btn(text, data) {
  if (data.length < 1 || data.length > 64 || /[^\x20-\x7e]/.test(data)) throw new Error(`bad callback_data: ${data}`);
  return { text, callback_data: data };
}

export function urlBtn(text, url) {
  return { text, url };
}
