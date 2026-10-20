import { secret } from './config.js';

export function createApi(env) {
  const token = secret(env, 'BOT_TOKEN');
  const base = `${env.TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/`;

  async function call(method, params = {}) {
    try {
      const res = await fetch(base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!data.ok && !/message is not modified/.test(data.description || '')) {
        console.warn(`telegram ${method} failed:`, data.error_code, data.description);
      }
      return data;
    } catch (err) {
      console.error(`telegram ${method} error:`, err);
      return { ok: false, error_code: 0, description: String(err) };
    }
  }

  async function sendDocument(chatId, filename, content, caption) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    form.append('document', new Blob([content], { type: 'text/plain' }), filename);
    try {
      const res = await fetch(base + 'sendDocument', { method: 'POST', body: form });
      return await res.json();
    } catch (err) {
      console.error('telegram sendDocument error:', err);
      return { ok: false, description: String(err) };
    }
  }

  return {
    call,
    sendDocument,
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
    botId: () => Number(token.split(':')[0]),
  };
}

export const isBlockedError = (r) => r && !r.ok && (r.error_code === 403 || /chat not found|blocked|deactivated/i.test(r.description || ''));
