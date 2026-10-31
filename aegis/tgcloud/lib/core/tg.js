/*
 * Bot API calls. Each call is recorded in ctx.trace with a view name, and the entry points return
 * { trace } so `npx tgcloud run` shows exactly what the bot sent. Messages use parse_mode HTML.
 * A 403 when writing to a user means they blocked the bot: the user is marked blocked right here.
 */
import { api, BotApiError } from 'sdk';
import { markBlocked } from '../engines/users.js';
import { APP_URL } from '../config.js';
import * as kv from './kv.js';

export function createCtx(extra = {}) {
  return { trace: [], callbackId: null, answered: false, kv: null, ...extra };
}

export function isApiError(err) {
  return err instanceof BotApiError || (!!err && typeof err.code === 'number' && typeof err.description === 'string');
}

export function describeError(err) {
  if (isApiError(err)) return `${err.code} ${err.description}`;
  return String((err && err.message) || err);
}

export const isForbidden = (err) => isApiError(err) && err.code === 403;
export const isFlood = (err) => isApiError(err) && err.code === 429;
export const retryAfter = (err) => Math.max(1, Number((err && err.parameters && err.parameters.retry_after) || 5));

/* Calls a Bot API method, records it, rethrows failures. */
export async function call(ctx, method, params, view) {
  const entry = { m: method };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
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
    if (isForbidden(err) && typeof params.chat_id === 'number' && params.chat_id > 0) await markBlocked(params.chat_id);
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

export const markup = (rows) => ({ inline_keyboard: rows });

export async function send(ctx, chatId, text, rows, view, extra = {}) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
  if (rows && rows.length) params.reply_markup = markup(rows);
  return tryCall(ctx, 'sendMessage', params, view);
}

/* Edits a message ({ chat_id, message_id }); "not modified" counts as done. */
export async function edit(ctx, place, text, rows, view) {
  const params = { chat_id: place.chat_id, message_id: place.message_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  params.reply_markup = markup(rows && rows.length ? rows : []);
  try {
    await call(ctx, 'editMessageText', params, view);
    return true;
  } catch (err) {
    if (/message is not modified/i.test(String(err && err.description))) return true;
    console.warn(`editMessageText (${view}) failed: ${describeError(err)}`);
    return false;
  }
}

/* Shows a screen: edits `place` when given (falls back to a new message), else sends. */
export async function screen(ctx, chatId, place, text, rows, view) {
  if (place && (await edit(ctx, place, text, rows, view))) return place;
  const m = await send(ctx, chatId, text, rows, view);
  return m ? { chat_id: chatId, message_id: m.message_id } : null;
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

/* ========== merged from core/bot.js ========== */
/*
 * The bot's own identity (getMe, cached in aegis_kv) and the Mini App address derived from it.
 */
export async function me(ctx) {
  const s = await kv.all(ctx);
  if (s.bot_id && s.bot_username) return { id: Number(s.bot_id), username: s.bot_username };
  const r = await call(ctx, 'getMe', {}, 'me');
  await kv.set(ctx, 'bot_id', r.id);
  await kv.set(ctx, 'bot_username', r.username);
  return { id: r.id, username: r.username };
}

/* The Mini App's URL: APP_URL from config, else https://app<bot id>.tgcloud.ai/. */
export async function appUrl(ctx) {
  if (APP_URL) return APP_URL;
  const b = await me(ctx);
  return `https://app${b.id}.tgcloud.ai/`;
}
