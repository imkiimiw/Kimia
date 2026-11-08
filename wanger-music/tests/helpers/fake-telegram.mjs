// A strict in-memory Bot API for tests: channels with members and the bot's status, users who
// blocked the bot, scripted failures, and a log of every call.
import { BotApiError } from '../sdk/api.mjs';

export const BOT_ID = 9280424458;

export function createFakeTelegram() {
  let nextMessageId = 1000;
  const calls = [];
  /** chatId → { id, type, title, username, invite_link, bot: status object, members: Map } */
  const channels = new Map();
  const blocked = new Set();
  /** @type {Map<string, Uint8Array>} uploaded documents, by file_id */
  const files = new Map();
  /** messages[chatId][messageId] = { text, reply_markup } */
  const messages = new Map();
  /** scripted failures: { method, match?(params), code, description, parameters, times } */
  const failures = [];

  const fail = (code, description, method, parameters) => { throw new BotApiError(code, description, method, parameters); };
  const findChannel = (ref) => {
    if (typeof ref === 'string' && ref.startsWith('@')) {
      for (const c of channels.values()) if (c.username && c.username.toLowerCase() === ref.slice(1).toLowerCase()) return c;
      return null;
    }
    return channels.get(Number(ref)) || null;
  };
  /** Rough HTML check like Telegram's: unknown or unbalanced tags → 400 can't parse entities. */
  const checkHtml = (text, method) => {
    const stack = [];
    for (const m of String(text || '').matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
      const [, close, tag] = m;
      if (!['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote', 'span'].includes(tag)) fail(400, `Bad Request: can't parse entities: unsupported start tag "${tag}"`, method);
      if (!close) stack.push(tag);
      else if (stack.pop() !== tag) fail(400, `Bad Request: can't parse entities: unexpected end tag "${tag}"`, method);
    }
    if (stack.length) fail(400, `Bad Request: can't parse entities: can't find end tag corresponding to start tag "${stack.at(-1)}"`, method);
  };
  const store = (chatId, msg) => {
    if (!messages.has(chatId)) messages.set(chatId, new Map());
    messages.get(chatId).set(msg.message_id, msg);
    return msg;
  };

  const methods = {
    getMe: () => ({ id: BOT_ID, is_bot: true, first_name: 'Wanger Music', username: 'Wange_Musicbot', supports_inline_queries: true }),
    getWebhookInfo: (p, m) => fail(403, 'Method getWebhookInfo is restricted', m),
    sendMessage(p, m) {
      if (p.chat_id > 0 && blocked.has(p.chat_id)) fail(403, 'Forbidden: bot was blocked by the user', m);
      if (!p.text || p.text.length > 4096) fail(400, 'Bad Request: message is too long', m);
      if (p.parse_mode === 'HTML') checkHtml(p.text, m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, text: p.text, reply_markup: p.reply_markup || null, parse_mode: p.parse_mode });
    },
    editMessageText(p, m) {
      const msg = messages.get(p.chat_id) && messages.get(p.chat_id).get(p.message_id);
      if (!msg) fail(400, 'Bad Request: message to edit not found', m);
      if (msg.text === p.text && JSON.stringify(msg.reply_markup) === JSON.stringify(p.reply_markup || null)) fail(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same', m);
      msg.text = p.text;
      msg.reply_markup = p.reply_markup || null;
      return msg;
    },
    answerCallbackQuery: () => true,
    answerInlineQuery(p, m) {
      if (!Array.isArray(p.results) || p.results.length > 50) fail(400, 'Bad Request: RESULTS_TOO_MUCH', m);
      if (String(p.next_offset || '').length > 64) fail(400, 'Bad Request: NEXT_OFFSET_INVALID', m);
      for (const r of p.results) {
        if (!r.id || String(r.id).length > 64) fail(400, 'Bad Request: RESULT_ID_INVALID', m);
        if (r.parse_mode === 'HTML') checkHtml(r.caption, m);
        if (r.caption && r.caption.length > 1024) fail(400, 'Bad Request: caption is too long', m);
      }
      if (p.button && !/^[A-Za-z0-9_-]{1,64}$/.test(p.button.start_parameter || '')) fail(400, 'Bad Request: START_PARAM_INVALID', m);
      return true;
    },
    copyMessage(p, m) {
      if (p.chat_id > 0 && blocked.has(p.chat_id)) fail(403, 'Forbidden: bot was blocked by the user', m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, copied_from: [p.from_chat_id, p.message_id] });
    },
    getChat(p, m) {
      const c = findChannel(p.chat_id);
      if (!c) fail(400, 'Bad Request: chat not found', m);
      return { id: c.id, type: c.type, title: c.title, username: c.username || undefined, invite_link: c.bot.status === 'administrator' ? c.invite_link : undefined };
    },
    getChatMember(p, m) {
      const c = findChannel(p.chat_id);
      if (!c || c.gone) fail(400, 'Bad Request: chat not found', m);
      if (p.user_id === BOT_ID) return { ...c.bot, user: { id: BOT_ID, is_bot: true } };
      if (c.bot.status !== 'administrator') fail(400, 'Bad Request: member list is inaccessible', m);
      const mem = c.members.get(p.user_id);
      if (!mem) fail(400, 'Bad Request: member not found', m); // what Telegram answers for a non-member
      return mem;
    },
    sendAudio(p, m) {
      if (p.chat_id < 0) {
        const c = channels.get(p.chat_id);
        if (!c) fail(400, 'Bad Request: chat not found', m);
        if (c.bot.status !== 'administrator' || !c.bot.can_post_messages) fail(403, 'Forbidden: bot is not a member of the channel chat', m);
      } else if (blocked.has(p.chat_id)) fail(403, 'Forbidden: bot was blocked by the user', m);
      if (typeof p.audio !== 'string' || !p.audio) fail(400, 'Bad Request: wrong file identifier/HTTP URL specified', m);
      if (p.caption && p.caption.length > 1024) fail(400, 'Bad Request: message caption is too long', m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, audio: { file_id: p.audio }, caption: p.caption || null });
    },
    sendPhoto(p, m) {
      if (p.chat_id < 0) {
        const c = channels.get(p.chat_id);
        if (!c) fail(400, 'Bad Request: chat not found', m);
        if (c.bot.status !== 'administrator' || !c.bot.can_post_messages) fail(403, 'Forbidden: bot is not a member of the channel chat', m);
      } else if (p.chat_id > 0 && blocked.has(p.chat_id)) fail(403, 'Forbidden: bot was blocked by the user', m);
      // like Telegram: an audio file's thumbnail id can't be sent as a photo; uploaded bytes become a photo
      if (typeof p.photo === 'string' && p.photo.startsWith('THUMB')) fail(400, "Bad Request: can't use file of type Thumbnail as Photo", m);
      if (p.photo && p.photo.bytes instanceof Uint8Array) {
        const id = ++nextMessageId;
        return store(p.chat_id, { message_id: id, chat: { id: p.chat_id }, photo: [{ file_id: `PHs${id}` }, { file_id: `PHb${id}` }], caption: p.caption || null });
      }
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, photo: [{ file_id: p.photo }], caption: p.caption || null });
    },
    sendDocument(p, m) {
      if (p.chat_id > 0 && blocked.has(p.chat_id)) fail(403, 'Forbidden: bot was blocked by the user', m);
      const d = p.document;
      if (!d || !(d.bytes instanceof Uint8Array)) fail(400, 'Bad Request: there is no document in the request', m);
      if (d.bytes.length > 50 * 1024 * 1024) fail(413, 'Request Entity Too Large', m);
      const file_id = `DOC${++nextMessageId}`;
      files.set(file_id, d.bytes);
      return store(p.chat_id, { message_id: nextMessageId, chat: { id: p.chat_id }, document: { file_id, file_unique_id: `DU${nextMessageId}`, file_name: d.name, mime_type: d.type, file_size: d.bytes.length }, caption: p.caption || null });
    },
    getFileContent(p, m) {
      if (String(p.file_id).startsWith('THUMB')) return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]); // a thumbnail's bytes
      const bytes = files.get(p.file_id);
      if (!bytes) fail(400, 'Bad Request: wrong file_id or the file is temporarily unavailable', m);
      if (bytes.length > 20 * 1024 * 1024) fail(400, 'Bad Request: file is too big', m);
      return bytes;
    },
    setMyCommands: () => true,
    deleteMyCommands: () => true,
    deleteMessage: () => true,
  };

  function handler(method, params) {
    const call = { method, params, result: null };
    calls.push(call);
    const i = failures.findIndex((f) => f.method === method && (!f.match || f.match(params)));
    if (i >= 0) {
      const f = failures[i];
      if (--f.times <= 0) failures.splice(i, 1);
      fail(f.code, f.description, method, f.parameters);
    }
    if (!methods[method]) throw new Error(`fake telegram: unknown method ${method}`);
    call.result = methods[method](params, method);
    return call.result;
  }

  return {
    handler,
    calls,
    files,
    channels,
    blocked,
    messages,
    addChannel({ id, username = null, title = 'Channel', botAdmin = true, invite_link = null, type = 'channel', rights = {} }) {
      channels.set(id, { id, type, title, username, invite_link, bot: botAdmin ? { status: 'administrator', can_post_messages: true, can_edit_messages: true, can_delete_messages: true, ...rights } : { status: 'left' }, members: new Map() });
      return channels.get(id);
    },
    setMember(channelId, userId, status = 'member', extra = {}) {
      channels.get(channelId).members.set(userId, { status, user: { id: userId }, ...extra });
    },
    setBotStatus(channelId, status) {
      channels.get(channelId).bot = { status, can_post_messages: status === 'administrator' };
    },
    failNext(method, code, description, { times = 1, match = null, parameters } = {}) {
      failures.push({ method, code, description, times, match, parameters });
    },
    message: (chatId, messageId) => messages.get(chatId) && messages.get(chatId).get(messageId),
    /** Calls to `method` (optionally to one chat) since `from`. */
    callsOf(method, chatId, from = 0) {
      return calls.slice(from).filter((c) => c.method === method && (chatId === undefined || c.params.chat_id === chatId));
    },
    lastTo(chatId) {
      const list = calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.params.chat_id === chatId);
      return list.length ? list[list.length - 1].params : null;
    },
    answers: (from = 0) => calls.slice(from).filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params),
  };
}

/** Flattens an inline keyboard. */
export const buttons = (params) => ((params && params.reply_markup && params.reply_markup.inline_keyboard) || []).flat();
