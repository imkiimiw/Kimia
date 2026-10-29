// Bot API access for one update. Every call goes through `call`, which also records it in
// ctx.trace; the handlers return that trace, so `npx tgcloud run` shows exactly what the bot sent
// (and what Telegram answered) for a test payload. Whisper text is never put in the trace.
import { api, BotApiError } from 'sdk';
import { ALERT_MAX } from './config.js';
import { truncate, utf8Length } from './util.js';

/** Per-update context: who we talk to, where, and what we have sent so far. */
export function createCtx({ userId = null, chatId = null, messageId = null, callbackId = null } = {}) {
  return { userId, chatId, messageId, callbackId, answered: false, trace: [] };
}

function keyboardSummary(markup) {
  const rows = markup && markup.inline_keyboard;
  if (!rows) return undefined;
  return rows.map((row) => row.map((b) => {
    if (b.url) return `${b.text} -> ${b.url}`;
    if (b.switch_inline_query !== undefined) return `${b.text} <inline>`;
    return `${b.text} [${b.callback_data}]`;
  }));
}

/** True for a failed Bot API call (BotApiError carries .code and .description). */
export function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

export function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

/**
 * Calls a Bot API method, records it in the trace, rethrows failures.
 * `secret: true` keeps the text out of the trace (it is a whisper's content); `meta` adds
 * content-free facts to the trace entry (ids, counts) so tests can check secret screens.
 */
export async function call(ctx, method, params, view, { secret = false, meta = null } = {}) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (meta) entry.meta = meta;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (params.user_id !== undefined) entry.user = params.user_id;
  if (params.inline_message_id !== undefined) entry.inline = params.inline_message_id;
  if (params.text !== undefined) entry.text = secret ? `<${String(params.text).length} chars, hidden>` : params.text;
  if (params.show_alert) entry.alert = true;
  if (params.url !== undefined) entry.url = params.url;
  const kb = keyboardSummary(params.reply_markup);
  if (kb) entry.kb = kb;
  if (method === 'answerInlineQuery') {
    entry.results = (params.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      message: r.input_message_content && r.input_message_content.message_text,
      kb: keyboardSummary(r.reply_markup),
    }));
    if (params.button) entry.button = params.button;
    entry.cache_time = params.cache_time;
    entry.is_personal = params.is_personal;
  }
  ctx.trace.push(entry);
  try {
    const result = await api[method](params);
    entry.ok = true;
    if (result && result.status) entry.status = result.status;
    if (result && result.message_id) entry.mid = result.message_id;
    return result;
  } catch (err) {
    entry.ok = false;
    entry.err = describeError(err);
    throw err;
  }
}

const markup = (kb) => (kb ? { reply_markup: { inline_keyboard: kb } } : {});

/** Sends a new HTML message. Failures are recorded and logged, not thrown; returns null then. */
export async function send(ctx, view, text, kb, chatId = ctx.chatId, opts = {}) {
  try {
    return await call(ctx, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(kb),
    }, view, opts);
  } catch (err) {
    console.warn(`sendMessage(${view}) failed: ${describeError(err)}`);
    if (opts.rethrow) throw err;
    return null;
  }
}

const EDIT_FALLBACK = /message to edit not found|message can't be edited|there is no text in the message|message_id_invalid/i;

/**
 * Shows a screen: in a button press it replaces the pressed message, otherwise it sends a new one.
 * If the old message can't be edited (too old, deleted, a photo), a new message is sent instead.
 */
export async function show(ctx, view, text, kb, opts = {}) {
  if (!ctx.messageId) return send(ctx, view, text, kb, ctx.chatId, opts);
  try {
    return await call(ctx, 'editMessageText', {
      chat_id: ctx.chatId,
      message_id: ctx.messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(kb),
    }, view, opts);
  } catch (err) {
    const desc = isApiError(err) ? err.description : '';
    if (/message is not modified/i.test(desc)) return null;
    if (EDIT_FALLBACK.test(desc)) return send(ctx, view, text, kb, ctx.chatId, opts);
    console.warn(`editMessageText(${view}) failed: ${describeError(err)}`);
    return null;
  }
}

/** Edits a message posted in inline mode (whisper status). Never throws. */
export async function editInline(ctx, view, inlineMessageId, text, kb) {
  if (!inlineMessageId) return false;
  try {
    await call(ctx, 'editMessageText', {
      inline_message_id: inlineMessageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(kb),
    }, view);
    return true;
  } catch (err) {
    if (!/message is not modified/i.test(isApiError(err) ? err.description : '')) {
      console.warn(`editMessageText(${view}) failed: ${describeError(err)}`);
    }
    return false;
  }
}

/** Replaces only the buttons of a message in a private chat. Never throws. */
export async function editMarkup(ctx, view, chatId, messageId, kb) {
  if (!chatId || !messageId) return false;
  try {
    await call(ctx, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, ...markup(kb) }, view);
    return true;
  } catch (err) {
    if (!/message is not modified/i.test(isApiError(err) ? err.description : '')) {
      console.warn(`editMessageReplyMarkup(${view}) failed: ${describeError(err)}`);
    }
    return false;
  }
}

/**
 * Answers the pressed button, once per update. `text` is cut to Telegram's 200-character limit.
 * `secret` keeps the text out of the trace. With `url`, Telegram opens that t.me link instead.
 */
export async function answer(ctx, text, { alert = false, secret = false, url = null, meta = null } = {}) {
  if (!ctx.callbackId || ctx.answered) return;
  ctx.answered = true;
  const params = { callback_query_id: ctx.callbackId };
  if (text) {
    params.text = truncate(text, ALERT_MAX);
    if (alert) params.show_alert = true;
  }
  if (url) params.url = url;
  try {
    await call(ctx, 'answerCallbackQuery', params, null, { secret, meta });
  } catch (err) {
    console.warn(`answerCallbackQuery failed: ${describeError(err)}`);
    if (url && isApiError(err) && /url/i.test(err.description)) {
      // A rejected url must not leave the button spinning: answer again without it.
      ctx.answered = false;
      await answer(ctx, text, { alert, secret });
    }
  }
}

// ---------- keyboard buttons ----------

/** A callback button. callback_data is ASCII by construction; Telegram allows 1-64 bytes. */
export function btn(text, data) {
  if (!data || utf8Length(data) > 64 || /[^\x20-\x7e]/.test(data)) throw new Error(`bad callback_data: ${data}`);
  return { text, callback_data: data };
}

export function urlBtn(text, url) {
  return { text, url };
}

/** Opens the chat picker with "@bot " typed, ready for a whisper. */
export function inlineBtn(text, query = '') {
  return { text, switch_inline_query: query };
}
