// The rest of the bot works with Bot API-style results ({ ok, result } / { ok: false, error_code, description }),
// so this wraps the platform's `api`, which returns the bare result and throws BotApiError on failure.
import { api, BotApiError, InputFile } from 'sdk';
import { utf8Bytes } from './utf8.js';

export function createApi() {
  let me = null;

  async function call(method, params = {}) {
    try {
      return { ok: true, result: await api[method](params) };
    } catch (err) {
      if (err instanceof BotApiError || (err && typeof err.code === 'number')) {
        if (!/message is not modified/.test(err.description || '')) console.warn(`telegram ${method} failed:`, err.code, err.description);
        return { ok: false, error_code: err.code, description: err.description, parameters: err.parameters };
      }
      console.error(`telegram ${method} error:`, err);
      return { ok: false, error_code: 0, description: String(err) };
    }
  }

  return {
    call,
    sendDocument: (chatId, filename, content, caption) =>
      call('sendDocument', {
        chat_id: chatId,
        document: new InputFile(utf8Bytes(content), filename, { type: 'text/plain' }),
        ...(caption ? { caption, parse_mode: 'HTML' } : {}),
      }),
    send: (chatId, text, extra = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      }),
    edit: (chatId, messageId, text, extra = {}) =>
      call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      }),
    answer: (callbackId, text, showAlert = false) =>
      call('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: showAlert }),
    // The platform holds the bot token, so the bot's own id comes from getMe (once per invocation).
    botId: async () => {
      if (!me) {
        const r = await call('getMe');
        me = r.ok ? r.result : null;
      }
      return me ? me.id : 0;
    },
  };
}

export const isBlockedError = (r) => r && !r.ok && (r.error_code === 403 || /chat not found|blocked|deactivated/i.test(r.description || ''));
