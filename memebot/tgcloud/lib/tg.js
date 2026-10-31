/*
 * Bot API access for one update. Every call goes through call(), which records it in ctx.trace;
 * the handlers return that trace, so `npx tgcloud run` shows exactly what the bot sent and what
 * Telegram answered.
 */
import { api, BotApiError } from 'sdk';

/* Per-update context: who we talk to, where, in which language, and what was sent so far. */
export function createCtx(init = {}) {
  return { userId: null, chatId: null, callbackId: null, lang: 'fa', answered: false, trace: [], ...init };
}

export function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

export function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

function keyboardSummary(markup) {
  const rows = markup && markup.inline_keyboard;
  if (!rows) return undefined;
  return rows.map((row) => row.map((b) => {
    if (b.url) return `${b.text} -> ${b.url}`;
    if (b.switch_inline_query_current_chat !== undefined) return `${b.text} <inline: ${b.switch_inline_query_current_chat}>`;
    if (b.switch_inline_query !== undefined) return `${b.text} <inline>`;
    return `${b.text} [${b.callback_data}]`;
  }));
}

/* Calls a Bot API method, records it in the trace, rethrows failures. */
export async function call(ctx, method, params, view) {
  const entry = { m: method };
  if (view) entry.view = view;
  for (const k of ['chat_id', 'from_chat_id', 'message_id', 'user_id']) if (params[k] !== undefined) entry[k] = params[k];
  if (params.text !== undefined) entry.text = params.text;
  if (params.caption !== undefined) entry.caption = params.caption;
  const kb = keyboardSummary(params.reply_markup);
  if (kb) entry.kb = kb;
  if (method === 'answerInlineQuery') {
    entry.results = (params.results || []).map((r) => `${r.type}:${r.id}`);
    entry.next_offset = params.next_offset;
    entry.is_personal = params.is_personal;
    entry.cache_time = params.cache_time;
    if (params.button) entry.button = params.button;
  }
  ctx.trace.push(entry);
  try {
    const result = await api[method](params);
    entry.ok = true;
    if (result && result.message_id) entry.mid = result.message_id;
    return result;
  } catch (err) {
    entry.ok = false;
    entry.err = describeError(err);
    throw err;
  }
}

export const keyboard = (rows) => ({ inline_keyboard: rows });
const markup = (kb) => (kb ? { reply_markup: keyboard(kb) } : {});

/* Sends an HTML message. Failures are logged and return null (opts.rethrow to throw). */
export async function send(ctx, view, text, kb, opts = {}) {
  const params = { chat_id: opts.chatId || ctx.chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(kb) };
  if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
  try {
    return await call(ctx, 'sendMessage', params, view);
  } catch (err) {
    console.warn(`sendMessage(${view}) failed: ${describeError(err)}`);
    if (opts.rethrow) throw err;
    return null;
  }
}

const notModified = (err) => isApiError(err) && /message is not modified/i.test(err.description);

/* Edits a text message in place; "not modified" is not an error. Returns false on failure. */
export async function edit(ctx, view, messageId, text, kb, chatId = ctx.chatId) {
  try {
    await call(ctx, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(kb) }, view);
    return true;
  } catch (err) {
    if (notModified(err)) return true;
    console.warn(`editMessageText(${view}) failed: ${describeError(err)}`);
    return false;
  }
}

/* Replaces (or with kb = null, removes) a message's inline keyboard. */
export async function editKeyboard(ctx, view, messageId, kb, chatId = ctx.chatId) {
  try {
    await call(ctx, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard(kb || []) }, view);
    return true;
  } catch (err) {
    if (notModified(err)) return true;
    console.warn(`editMessageReplyMarkup(${view}) failed: ${describeError(err)}`);
    return false;
  }
}

export async function remove(ctx, view, messageId, chatId = ctx.chatId) {
  try {
    await call(ctx, 'deleteMessage', { chat_id: chatId, message_id: messageId }, view);
    return true;
  } catch (err) {
    console.warn(`deleteMessage(${view}) failed: ${describeError(err)}`);
    return false;
  }
}

/* Answers the update's callback query once (a toast, or an alert with alert = true). */
export async function answer(ctx, text, alert = false) {
  if (ctx.answered || !ctx.callbackId) return;
  ctx.answered = true;
  const params = { callback_query_id: ctx.callbackId };
  if (text) params.text = text;
  if (alert) params.show_alert = true;
  try {
    await call(ctx, 'answerCallbackQuery', params, 'answer');
  } catch (err) {
    console.warn(`answerCallbackQuery failed: ${describeError(err)}`);
  }
}

/* The send method, file field and whether a caption is allowed, for each meme kind. */
const MEDIA = {
  photo: ['sendPhoto', 'photo', true],
  animation: ['sendAnimation', 'animation', true],
  video: ['sendVideo', 'video', true],
  sticker: ['sendSticker', 'sticker', false],
  voice: ['sendVoice', 'voice', true],
};

export const captionable = (kind) => !!(MEDIA[kind] && MEDIA[kind][2]);

/* Sends a stored meme by file_id (caption ignored for stickers). Throws on failure. */
export async function sendMeme(ctx, view, chatId, kind, fileId, caption, kb, extra = {}) {
  const [method, field, withCaption] = MEDIA[kind];
  const params = { chat_id: chatId, [field]: fileId, ...markup(kb), ...extra };
  if (withCaption && caption) {
    params.caption = caption;
    params.parse_mode = 'HTML';
  }
  return call(ctx, method, params, view);
}
