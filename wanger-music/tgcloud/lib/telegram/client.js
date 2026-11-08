// The one path for outbound Bot API calls (spec 10.8). Adds HTML defaults, records a trace of
// every call (handlers return it, so `tgcloud run` shows what the bot did), treats "message is not
// modified" as success, and reports 403 "blocked by the user" through the onBlocked hook.
import { api as sdkApi, InputFile } from 'sdk';
import { classify } from './errors.js';
import { BOT_ID } from '../config/static.js';

/**
 * @typedef {{text: string, keyboard?: any}} View
 * @param {{log: any, onBlocked?: (chatId: number) => Promise<any>, api?: any}} deps
 */
export function createTelegramClient({ log, onBlocked, api = sdkApi }) {
  /** @type {{method: string, view?: string, chat_id?: any, ok: boolean, code?: number, kind?: string}[]} */
  const trace = [];

  /** @param {string} method @param {Record<string, any>} params @param {string} [view] */
  async function call(method, params, view) {
    try {
      const result = await api[method](params);
      trace.push({ method, view, chat_id: params.chat_id, ok: true });
      return result;
    } catch (e) {
      const c = classify(e);
      trace.push({ method, view, chat_id: params.chat_id, ok: false, code: c.code, kind: c.kind });
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

  /** @param {View} v */
  const body = (v) => ({
    text: v.text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(v.keyboard ? { reply_markup: v.keyboard } : {}),
  });

  const client = {
    trace,
    call,

    /** @param {number} chatId @param {View} v @param {string} [viewName] */
    send: (chatId, v, viewName) => call('sendMessage', { chat_id: chatId, ...body(v) }, viewName),

    /** Edits a message; "not modified" counts as success; a message that can't be edited is sent anew. */
    async edit(chatId, messageId, v, viewName) {
      try {
        return await call('editMessageText', { chat_id: chatId, message_id: messageId, ...body(v) }, viewName);
      } catch (e) {
        const k = classify(e).kind;
        if (k === 'not_modified') return true;
        if (k === 'message_gone') return client.send(chatId, v, viewName);
        throw e;
      }
    },

    /** Edit when there is a message to edit (a button press), otherwise send. */
    show: (chatId, messageId, v, viewName) => (messageId ? client.edit(chatId, messageId, v, viewName) : client.send(chatId, v, viewName)),

    /** answerCallbackQuery never throws: a stale query must not turn into an error. */
    async answer(callbackQueryId, opts = {}) {
      if (!callbackQueryId) return false;
      try {
        await call('answerCallbackQuery', {
          callback_query_id: callbackQueryId,
          ...(opts.text ? { text: String(opts.text).slice(0, 200) } : {}),
          ...(opts.alert ? { show_alert: true } : {}),
        });
        return true;
      } catch (e) {
        log.warn('answer_callback_failed', { error_code: classify(e).code, error: classify(e).kind });
        return false;
      }
    },

    copy: (chatId, fromChatId, messageId, viewName) => call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }, viewName),
    getChat: (chatId) => call('getChat', { chat_id: chatId }),
    getChatMember: (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId }),
    getMe: () => call('getMe', {}),
    /**
     * Uploads bytes as a document (≤ 50 MB).
     * @param {number} chatId @param {Uint8Array} bytes @param {string} filename
     * @param {{type?: string, caption?: string}} [opts] @param {string} [viewName]
     */
    sendDocument: (chatId, bytes, filename, { type = 'application/octet-stream', caption = '' } = {}, viewName = 'document') => call('sendDocument', {
      chat_id: chatId, document: new InputFile(bytes, filename, { type }), ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    }, viewName),
    /** Uploads bytes as a photo (e.g. an audio thumbnail, which Telegram won't send as a photo by id). @param {Uint8Array} bytes */
    sendPhotoFile: (chatId, bytes, filename, viewName = 'photo') => call('sendPhoto', { chat_id: chatId, photo: new InputFile(bytes, filename, { type: 'image/jpeg' }) }, viewName),
    /** Downloads a file the bot can see (≤ 20 MB, Bot API getFile cap). @returns {Promise<Uint8Array>} */
    fileContent: (fileId) => call('getFileContent', { file_id: fileId }, 'file'),
    getWebhookInfo: () => call('getWebhookInfo', {}),
    setMyCommands: (params) => call('setMyCommands', params),
    deleteMyCommands: (params) => call('deleteMyCommands', params),

    /**
     * Resolves a channel reference and checks the bot's own rights there.
     * @param {string|number} chatRef '@username' or a numeric id
     * @param {{allowGroups?: boolean}} [opts] also accept a basic group (sources only)
     * @returns {Promise<{ok: true, chat: any, member: any, isAdmin: boolean, canPost: boolean} | {ok: false, error: 'not_found'|'not_channel'|'transient'|'no_rights'}>}
     */
    async inspectChannel(chatRef, { allowGroups = false } = {}) {
      let chat;
      try {
        chat = await call('getChat', { chat_id: chatRef }, 'inspect');
      } catch (e) {
        const k = classify(e).kind;
        return { ok: false, error: k === 'transient' || k === 'rate_limit' ? 'transient' : 'not_found' };
      }
      if (chat.type !== 'channel' && chat.type !== 'supergroup' && !(allowGroups && chat.type === 'group')) return { ok: false, error: 'not_channel' };
      let member = null;
      try {
        member = await call('getChatMember', { chat_id: chat.id, user_id: BOT_ID }, 'inspect');
      } catch (e) {
        const k = classify(e).kind;
        if (k === 'transient' || k === 'rate_limit') return { ok: false, error: 'transient' };
      }
      const isAdmin = !!member && (member.status === 'administrator' || member.status === 'creator');
      const canPost = !!member && (member.status === 'creator' || member.can_post_messages === true || chat.type === 'supergroup');
      return { ok: true, chat, member, isAdmin, canPost };
    },
  };
  return client;
}
