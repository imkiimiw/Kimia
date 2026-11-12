// The one path for outbound Bot API calls. HTML defaults, a trace of every call (handlers return
// it, so `tgcloud run` shows what the bot sent), "not modified" counts as success, 403 "blocked"
// reported through onBlocked. (Adapted from wanger-music lib/telegram/client.js.)
import { api as sdkApi, InputFile } from 'sdk';
import { classify } from './core/errors.js';
import { BOT_ID } from './config.js';

/** @param {{log: any, onBlocked?: (chatId: number) => Promise<any>, api?: any}} deps */
export function createTelegram({ log, onBlocked, api = sdkApi }) {
  /** @type {{method: string, view?: string, chat_id?: any, ok: boolean, code?: number, kind?: string}[]} */
  const trace = [];

  async function call(method, params, view) {
    try {
      const result = await api[method](params);
      trace.push({ method, view, chat_id: params.chat_id ?? params.user_id, ok: true });
      return result;
    } catch (e) {
      const c = classify(e);
      trace.push({ method, view, chat_id: params.chat_id ?? params.user_id, ok: false, code: c.code, kind: c.kind });
      if (c.kind === 'blocked' && Number(params.chat_id) > 0 && onBlocked) {
        try {
          await onBlocked(Number(params.chat_id));
        } catch (hookErr) {
          log.warn('blocked_hook_failed', { chat_id: params.chat_id, error: String(hookErr && hookErr.message) });
        }
      }
      throw e;
    }
  }

  /** @param {{text: string, keyboard?: any}} v */
  const body = (v) => ({ text: v.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(v.keyboard ? { reply_markup: v.keyboard } : {}) });

  const tg = {
    trace,
    call,
    send: (chatId, v, view) => call('sendMessage', { chat_id: chatId, ...body(v) }, view),

    /** Edits a message; "not modified" = success; a message that can't be edited is sent anew. */
    async edit(chatId, messageId, v, view) {
      try {
        return await call('editMessageText', { chat_id: chatId, message_id: messageId, ...body(v) }, view);
      } catch (e) {
        const k = classify(e).kind;
        if (k === 'not_modified') return true;
        if (k === 'message_gone' || k === 'bad_request') return tg.send(chatId, v, view);
        throw e;
      }
    },
    /** Edit when there is a message to edit (a button press), else send. */
    show: (chatId, messageId, v, view) => (messageId ? tg.edit(chatId, messageId, v, view) : tg.send(chatId, v, view)),

    /** answerCallbackQuery never throws (a stale query must not become an error). */
    async answer(id, opts = {}) {
      if (!id) return false;
      try {
        await call('answerCallbackQuery', { callback_query_id: id, ...(opts.text ? { text: String(opts.text).slice(0, 200) } : {}), ...(opts.alert ? { show_alert: true } : {}) });
        return true;
      } catch (e) {
        log.warn('answer_callback_failed', { error_code: classify(e).code });
        return false;
      }
    },
    /** deleteMessage that never throws (message gone / too old → false). */
    async remove(chatId, messageId) {
      try {
        await call('deleteMessage', { chat_id: chatId, message_id: messageId }, 'delete');
        return true;
      } catch {
        return false;
      }
    },
    sticker: (chatId, fileId, keyboard, view = 'sticker') => call('sendSticker', { chat_id: chatId, sticker: fileId, ...(keyboard ? { reply_markup: keyboard } : {}) }, view),
    editMarkup: (chatId, messageId, keyboard, view) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard || { inline_keyboard: [] } }, view),
    copy: (chatId, fromChatId, messageId, view) => call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }, view),
    forward: (chatId, fromChatId, messageId, view) => call('forwardMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }, view),
    sendDocument: (chatId, bytes, filename, { type = 'application/octet-stream', caption = '' } = {}, view = 'document') => call('sendDocument', {
      chat_id: chatId, document: new InputFile(bytes, filename, { type }), ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    }, view),
    fileContent: (fileId) => call('getFileContent', { file_id: fileId }, 'file'),
    getChat: (chatId) => call('getChat', { chat_id: chatId }, 'inspect'),
    getChatMember: (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId }, 'gate'),

    /**
     * Resolves a channel reference and checks the bot's own rights there.
     * @returns {Promise<{ok: true, chat: any, isAdmin: boolean, canPost: boolean, canDelete: boolean} | {ok: false, error: 'not_found'|'not_channel'|'transient'}>}
     */
    async inspectChannel(ref) {
      let chat;
      try {
        chat = await call('getChat', { chat_id: ref }, 'inspect');
      } catch (e) {
        const k = classify(e).kind;
        return { ok: false, error: k === 'transient' || k === 'rate_limit' ? 'transient' : 'not_found' };
      }
      if (chat.type !== 'channel' && chat.type !== 'supergroup') return { ok: false, error: 'not_channel' };
      let m = null;
      try {
        m = await call('getChatMember', { chat_id: chat.id, user_id: BOT_ID }, 'inspect');
      } catch (e) {
        const k = classify(e).kind;
        if (k === 'transient' || k === 'rate_limit') return { ok: false, error: 'transient' };
      }
      const isAdmin = !!m && (m.status === 'administrator' || m.status === 'creator');
      return {
        ok: true,
        chat,
        isAdmin,
        canPost: !!m && (m.status === 'creator' || m.can_post_messages === true || (chat.type === 'supergroup' && isAdmin)),
        canDelete: !!m && (m.status === 'creator' || m.can_delete_messages === true),
      };
    },
  };
  return tg;
}
