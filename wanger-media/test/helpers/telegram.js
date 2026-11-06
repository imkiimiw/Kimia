// A fake Telegram Bot API for tests: records every call and answers like the real one does for the
// cases the bot meets (measured or documented). Scripted per test via the returned object.
import { BotApiError } from '../sdk/api.js';
import { BOT_ID } from '../../tgcloud/lib/config.js';

export const CHANNELS = [
  { id: -1002407928564, username: 'HIDE_i_SEEK', title: 'Hide i Seek' },
  { id: -1001816009903, username: 'Nepenthw_ir', title: 'Nepenthe' },
  { id: -1001910797391, username: 'wangerBots', title: 'Wanger Bots' },
];

const err = (code, description, parameters) => new BotApiError(code, description, null, parameters);

export function createTelegram({ channels = CHANNELS } = {}) {
  const state = {
    calls: [],
    channels: channels.map((c) => ({ ...c })),
    members: new Map(), // `${channelId}|${userId}` → status string or a BotApiError
    botStatus: new Map(), // channelId → the bot's own status (default administrator)
    unreachable: new Map(), // chat id → BotApiError for sendMessage
    failNext: new Map(), // method → BotApiError (thrown once)
    nextMessageId: 500,
    refuseUrls: false, // Telegram can't fetch media URLs (forces the upload fallback)
    rateLimitAt: 0, // the n-th copyMessage answers 429 (once)
  };

  const channelOf = (ref) => {
    if (typeof ref === 'string' && ref.startsWith('@')) {
      return state.channels.find((c) => c.username.toLowerCase() === ref.slice(1).toLowerCase()) || null;
    }
    return state.channels.find((c) => c.id === Number(ref)) || null;
  };

  async function handler(method, params) {
    state.calls.push({ method, params });
    if (state.failNext.has(method)) {
      const e = state.failNext.get(method);
      state.failNext.delete(method);
      throw e;
    }
    switch (method) {
      case 'sendMessage': {
        if (state.unreachable.has(Number(params.chat_id))) throw state.unreachable.get(Number(params.chat_id));
        return { message_id: ++state.nextMessageId, chat: { id: params.chat_id, type: 'private' }, text: params.text };
      }
      case 'editMessageText':
        return { message_id: params.message_id, chat: { id: params.chat_id, type: 'private' }, text: params.text };
      case 'answerCallbackQuery':
      case 'deleteMessage':
        return true;
      case 'copyMessage': {
        if (state.rateLimitAt && state.calls.filter((c) => c.method === 'copyMessage').length === state.rateLimitAt) {
          state.rateLimitAt = 0;
          throw err(429, 'Too Many Requests: retry after 7', { retry_after: 7 });
        }
        if (state.unreachable.has(Number(params.chat_id))) throw state.unreachable.get(Number(params.chat_id));
        return { message_id: ++state.nextMessageId };
      }
      case 'sendPhoto':
      case 'sendVideo':
      case 'sendAnimation': {
        if (state.unreachable.has(Number(params.chat_id))) throw state.unreachable.get(Number(params.chat_id));
        const field = { sendPhoto: 'photo', sendVideo: 'video', sendAnimation: 'animation' }[method];
        const src = params[field];
        if (state.refuseUrls && typeof src === 'string' && /^https?:/.test(src)) {
          throw err(400, 'Bad Request: failed to get HTTP URL content');
        }
        if (typeof src === 'string' && /^stale_/.test(src)) throw err(400, 'Bad Request: wrong file identifier/HTTP URL specified');
        const id = `${field}_${++state.nextMessageId}`;
        const msg = { message_id: state.nextMessageId, chat: { id: params.chat_id, type: 'private' }, caption: params.caption };
        if (field === 'photo') msg.photo = [{ file_id: id + '_s' }, { file_id: id }];
        else msg[field] = { file_id: id };
        return msg;
      }
      case 'sendMediaGroup': {
        if (state.refuseUrls && params.media.some((m) => typeof m.media === 'string' && /^https?:/.test(m.media))) {
          throw err(400, 'Bad Request: failed to get HTTP URL content');
        }
        if (params.media.some((m) => typeof m.media === 'string' && /^stale_/.test(m.media))) throw err(400, 'Bad Request: wrong file identifier/HTTP URL specified');
        return params.media.map((m) => {
          const id = `${m.type}_${++state.nextMessageId}`;
          return { message_id: state.nextMessageId, chat: { id: params.chat_id }, ...(m.type === 'photo' ? { photo: [{ file_id: id }] } : { video: { file_id: id } }) };
        });
      }
      case 'getChat': {
        const ch = channelOf(params.chat_id);
        if (!ch) throw err(400, 'Bad Request: chat not found');
        return { id: ch.id, type: 'channel', title: ch.title, username: ch.username };
      }
      case 'getChatMember': {
        const ch = channelOf(params.chat_id);
        if (!ch) throw err(400, 'Bad Request: chat not found');
        if (params.user_id === BOT_ID) {
          const s = state.botStatus.get(ch.id) || 'administrator';
          if (s instanceof Error) throw s;
          return { status: s, user: { id: BOT_ID, is_bot: true } };
        }
        if ((state.botStatus.get(ch.id) || 'administrator') !== 'administrator') {
          throw err(400, 'Bad Request: member list is inaccessible');
        }
        const m = state.members.get(`${ch.id}|${params.user_id}`);
        if (m instanceof Error) throw m;
        if (!m) throw err(400, 'Bad Request: member not found');
        return m === 'restricted_member' ? { status: 'restricted', is_member: true } : { status: m, user: { id: params.user_id } };
      }
      default:
        throw err(400, `Bad Request: method ${method} not faked`);
    }
  }

  return {
    state,
    handler,
    calls: (method) => state.calls.filter((c) => !method || c.method === method),
    reset() { state.calls.length = 0; },
    /** Makes `userId` a member (or any status / error) of every channel, or of the given ones. */
    setMember(userId, status = 'member', channelIds = state.channels.map((c) => c.id)) {
      for (const id of channelIds) state.members.set(`${id}|${userId}`, status);
    },
    setBotStatus(channelId, status) { state.botStatus.set(channelId, status); },
    unreachable(chatId, e = err(403, 'Forbidden: bot was blocked by the user')) { state.unreachable.set(Number(chatId), e); },
    failNext(method, e) { state.failNext.set(method, e); },
    err,
  };
}
