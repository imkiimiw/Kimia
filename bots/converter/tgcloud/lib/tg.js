// The only way the bot calls the Telegram Bot API. Every call is recorded in ctx.trace
// ({ view, method, ok, kind }) so `npm run tg -- run handlers/…` shows what the bot did, and every
// failure gets a `kind` from classify(). There are no timers here, so a 429 is never waited out:
// the caller gives up and says so.
import { api, InputFile } from 'sdk';

/** What a Bot API failure means for the caller. Pure. */
export function classify(err) {
  const code = err && typeof err.code === 'number' ? err.code : null;
  const d = String((err && (err.description || err.message)) || '').toLowerCase();
  if (code === 429) return { kind: 'rate', retryAfter: (err.parameters && err.parameters.retry_after) || null };
  if (code === 403) {
    if (/blocked by the user|user is deactivated|can't initiate conversation|bot was kicked from the private/.test(d)) return { kind: 'blocked' };
    return { kind: 'forbidden' };
  }
  if (code === 413) return { kind: 'too_big' };
  if (code === 400) {
    if (/message is not modified/.test(d)) return { kind: 'not_modified' };
    if (/message to edit not found|message can't be edited|message to delete not found|message can't be deleted|query is too old|query id is invalid/.test(d)) return { kind: 'gone' };
    if (/file is too big/.test(d)) return { kind: 'too_big' };
    if (/member list is inaccessible|not enough rights|need administrator rights/.test(d)) return { kind: 'no_access' };
    if (/member not found|participant_id_invalid/.test(d)) return { kind: 'member_not_found' };
    if (/chat not found|peer_id_invalid/.test(d)) return { kind: 'chat_not_found' };
    if (/user not found/.test(d)) return { kind: 'user_not_found' };
    if (/wrong file|invalid file_id|file_id|temporarily unavailable/.test(d)) return { kind: 'bad_file' };
    return { kind: 'bad_request' };
  }
  if (code !== null && code >= 500) return { kind: 'server' };
  if (code === null) return { kind: 'network' };
  return { kind: 'other' };
}

/** Calls api[method](params); records the call; on failure rethrows with err.kind set. */
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

/** sendMessage with Telegram HTML. `screen` is { text, reply_markup? }. */
export function send(ctx, view, chatId, screen, extra = {}) {
  return call(ctx, view, 'sendMessage', base({ chat_id: chatId, text: screen.text, reply_markup: screen.reply_markup, ...extra }));
}

/**
 * Shows `screen` in place of a bot message (navigation edits the same message, spec §4).
 * "Not modified" counts as done; a message that can't be edited any more gets a fresh one.
 */
export async function edit(ctx, view, message, screen) {
  try {
    return await call(ctx, view, 'editMessageText', base({ chat_id: message.chat.id, message_id: message.message_id, text: screen.text, reply_markup: screen.reply_markup }));
  } catch (err) {
    if (err && err.kind === 'not_modified') return null;
    if (err && (err.kind === 'blocked' || err.kind === 'chat_not_found')) return null;
    if (err && (err.kind === 'gone' || err.kind === 'bad_request')) return send(ctx, view, message.chat.id, screen);
    throw err;
  }
}

/** Edits when there is a message to edit (a button press), sends otherwise (a command). */
export function show(ctx, view, chatId, screen, message = null) {
  return message ? edit(ctx, view, message, screen) : send(ctx, view, chatId, screen);
}

/** answerCallbackQuery; never throws (an expired query must not break the handler). */
export async function answer(ctx, callbackId, text, showAlert = false) {
  if (!callbackId) return false;
  try {
    await call(ctx, 'answer', 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text, show_alert: showAlert } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** sendChatAction; never throws (it's only a hint). */
export async function action(ctx, chatId, kind = 'upload_document') {
  try { await call(ctx, 'action', 'sendChatAction', { chat_id: chatId, action: kind }); } catch { /* hint only */ }
}

/** deleteMessage; never throws. */
export async function remove(ctx, view, chatId, messageId) {
  try { await call(ctx, view, 'deleteMessage', { chat_id: chatId, message_id: messageId }); return true; } catch { return false; }
}

/** Uploads bytes as a document (always a document: no recompression, no type guessing). */
export function sendBytes(ctx, view, chatId, bytes, name, mime, extra = {}) {
  return call(ctx, view, 'sendDocument', {
    chat_id: chatId,
    document: new InputFile(bytes, name, { type: mime || 'application/octet-stream' }),
    disable_content_type_detection: true,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Re-sends an existing file by file_id (result cache). */
export function sendFileId(ctx, view, chatId, fileId, extra = {}) {
  return call(ctx, view, 'sendDocument', { chat_id: chatId, document: fileId, parse_mode: 'HTML', ...extra });
}

/** Downloads a file (≤ 20 MB, Telegram's cap). */
export function download(ctx, view, fileId) {
  return call(ctx, view, 'getFileContent', fileId);
}
