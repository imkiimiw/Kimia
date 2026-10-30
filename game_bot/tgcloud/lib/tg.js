/*
 * Bot API calls, each recorded in ctx.trace with its view name (what `npx tgcloud run` prints and
 * the tests compare against the calls made). Handlers return { trace } at the end.
 */
import { api, BotApiError } from 'sdk';

export function createCtx(extra = {}) {
  return { trace: [], callbackId: null, answered: false, ...extra };
}

export function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

export function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

/* Calls a Bot API method, records it, rethrows failures. */
export async function call(ctx, method, params, view) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (params.inline_message_id !== undefined) entry.inline = params.inline_message_id;
  if (params.text !== undefined) entry.text = params.text;
  ctx.trace.push(entry);
  try {
    const r = await api[method](params);
    entry.ok = true;
    if (r && r.message_id) entry.mid = r.message_id;
    return r;
  } catch (err) {
    entry.ok = false;
    entry.err = describeError(err);
    throw err;
  }
}

/* Like call(), but a failure is logged and gives null. */
export async function tryCall(ctx, method, params, view) {
  try {
    return await call(ctx, method, params, view);
  } catch (err) {
    console.warn(`${method} (${view || '-'}) failed: ${describeError(err)}`);
    return null;
  }
}

const markup = (rows) => (rows ? { inline_keyboard: rows } : undefined);

export async function send(ctx, chatId, text, rows, view, extra = {}) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
  if (rows) params.reply_markup = markup(rows);
  return tryCall(ctx, 'sendMessage', params, view);
}

/* Edits a message (place = { chat_id, message_id } or { inline_message_id }); "not modified" is fine. */
export async function edit(ctx, place, text, rows, view) {
  const params = { ...place, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (rows) params.reply_markup = markup(rows);
  try {
    await call(ctx, 'editMessageText', params, view);
    return true;
  } catch (err) {
    if (/message is not modified/i.test(String(err && err.description))) return true;
    console.warn(`editMessageText (${view}) failed: ${describeError(err)}`);
    return false;
  }
}

/* Answers the pressed button once; later calls do nothing. */
export async function answer(ctx, text = '', alert = false) {
  if (!ctx.callbackId || ctx.answered) return;
  ctx.answered = true;
  const params = { callback_query_id: ctx.callbackId };
  if (text) params.text = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  if (alert) params.show_alert = true;
  await tryCall(ctx, 'answerCallbackQuery', params, 'answer');
}

export const btn = (text, data) => ({ text, callback_data: data });
export const urlBtn = (text, url) => ({ text, url });
export const appBtn = (text, url) => ({ text, web_app: { url } });

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function short(s, max = 24) {
  const str = String(s == null ? '' : s).trim();
  if (str.length <= max) return str;
  let cut = max - 1;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${str.slice(0, cut)}…`;
}
