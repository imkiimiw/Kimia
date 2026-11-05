// Bot API access for one update. Every call goes through `call`, which also records it in
// ctx.trace; the handlers return that trace, so `npx tgcloud run` shows exactly what the bot
// sent (and what Telegram answered) for a test payload. Files are summarized, never dumped.
import { api, BotApiError, InputFile } from 'sdk';

/**
 * Per-update context: who we talk to, where, and what we have sent so far.
 * `simulate` comes only from `npx tgcloud run --ctx` (real updates never carry it): it lets the
 * cloud tests force an API outage, see lib/x_api.js.
 */
export function createCtx({ userId, chatId, firstName = '', messageId = null, callbackId = null, fromMedia = false, simulate = null }) {
  return { userId, chatId, firstName, messageId, callbackId, fromMedia, simulate, answered: false, trace: [], apiLog: [] };
}

function keyboardSummary(markup) {
  const rows = markup && markup.inline_keyboard;
  if (!rows) return undefined;
  return rows.map((row) => row.map((b) => (b.url ? `${b.text} -> ${b.url}` : `${b.text} [${b.callback_data}]`)));
}

/** "upload 4.7MB" / "file_id" / "url" for a file parameter. */
function fileSummary(v) {
  if (v instanceof InputFile) return `upload ${v.bytes ? v.bytes.length : 0}B`;
  if (typeof v === 'string') return /^https?:/.test(v) ? 'url' : 'file_id';
  return undefined;
}

const FILE_PARAMS = ['video', 'photo', 'animation', 'document'];

/** True for a failed Bot API call (BotApiError carries .code and .description). */
export function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

export function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

/** Calls a Bot API method; records it in the trace; rethrows failures. `extra` adds fields to the trace entry. */
export async function call(ctx, method, params, view, extra) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (params.user_id !== undefined) entry.user = params.user_id;
  if (params.text !== undefined) entry.text = params.text;
  if (params.caption !== undefined) entry.caption = params.caption;
  for (const k of FILE_PARAMS) if (params[k] !== undefined) entry[k] = fileSummary(params[k]);
  if (Array.isArray(params.media)) entry.media = params.media.map((m) => `${m.type}:${fileSummary(m.media)}`);
  const kb = keyboardSummary(params.reply_markup);
  if (kb) entry.kb = kb;
  if (extra) Object.assign(entry, extra);
  ctx.trace.push(entry);
  const started = Date.now();
  try {
    const result = await api[method](params);
    entry.ok = true;
    entry.ms = Date.now() - started;
    if (result && result.status) entry.status = result.status;
    if (result && result.message_id) entry.mid = result.message_id;
    return result;
  } catch (err) {
    entry.ok = false;
    entry.ms = Date.now() - started;
    entry.err = describeError(err);
    throw err;
  }
}

export const markup = (kb) => (kb ? { reply_markup: { inline_keyboard: kb } } : {});

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

/** Edits a message the bot sent earlier; false if it can't be edited (then the caller sends a new one). */
export async function edit(ctx, view, chatId, messageId, text, kb) {
  try {
    await call(ctx, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(kb),
    }, view);
    return true;
  } catch (err) {
    const desc = isApiError(err) ? err.description : '';
    if (/message is not modified/i.test(desc)) return true;
    if (!EDIT_FALLBACK.test(desc)) console.warn(`editMessageText(${view}) failed: ${describeError(err)}`);
    return false;
  }
}

/**
 * Shows a screen: in a button press on a text message it replaces that message, otherwise
 * (a new message, or a button under a video/photo) it sends a new one.
 */
export async function show(ctx, view, text, kb) {
  if (ctx.messageId && !ctx.fromMedia && (await edit(ctx, view, ctx.chatId, ctx.messageId, text, kb))) return true;
  return send(ctx, view, text, kb);
}

export async function remove(ctx, chatId, messageId) {
  try {
    await call(ctx, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    return true;
  } catch {
    return false;
  }
}

export async function action(ctx, kind) {
  try {
    await call(ctx, 'sendChatAction', { chat_id: ctx.chatId, action: kind });
  } catch {
    // only a typing indicator
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
