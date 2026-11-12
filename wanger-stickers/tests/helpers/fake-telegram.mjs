// A strict in-memory Bot API for tests: channels with members and the bot's rights, users who
// blocked the bot, sticker sets with the Bot API's rules, scripted failures, and a log of every
// call. (Adapted from wanger-music tests/helpers/fake-telegram.mjs, plus sticker sets.)
import { BotApiError } from '../sdk/api.mjs';

export const BOT_ID = 9292593567;
export const BOT_USERNAME = 'Wanger_Motionbot';

export function createFakeTelegram({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  let nextMessageId = 1000;
  let nextFile = 1;
  const calls = [];
  const channels = new Map();
  const blocked = new Set();
  const files = new Map(); // file_id → { bytes?, sticker? }
  const messages = new Map(); // chatId → Map(messageId → msg)
  const sets = new Map(); // name(lower) → set
  const failures = [];

  const fail = (code, description, method, parameters) => { throw new BotApiError(code, description, method, parameters); };
  const findChannel = (ref) => {
    if (typeof ref === 'string' && ref.startsWith('@')) {
      for (const c of channels.values()) if (c.username && c.username.toLowerCase() === ref.slice(1).toLowerCase()) return c;
      return null;
    }
    return channels.get(Number(ref)) || null;
  };
  const checkHtml = (text, method) => {
    const stack = [];
    for (const m of String(text || '').matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
      const [, close, tag] = m;
      if (!['b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote', 'span'].includes(tag)) fail(400, `Bad Request: can't parse entities: unsupported start tag "${tag}"`, method);
      if (!close) stack.push(tag);
      else if (stack.pop() !== tag) fail(400, `Bad Request: can't parse entities: unexpected end tag "${tag}"`, method);
    }
    if (stack.length) fail(400, `Bad Request: can't parse entities: can't find end tag for "${stack.at(-1)}"`, method);
  };
  const store = (chatId, msg) => {
    if (!messages.has(chatId)) messages.set(chatId, new Map());
    messages.get(chatId).set(msg.message_id, { date: now(), ...msg });
    return messages.get(chatId).get(msg.message_id);
  };
  const toChat = (p, m) => {
    if (Number(p.chat_id) < 0) {
      const c = channels.get(Number(p.chat_id));
      if (!c) fail(400, 'Bad Request: chat not found', m);
      if (c.bot.status !== 'administrator' || !c.bot.can_post_messages) fail(403, 'Forbidden: bot is not a member of the channel chat', m);
    } else if (blocked.has(Number(p.chat_id))) fail(403, 'Forbidden: bot was blocked by the user', m);
  };
  const markupOk = (rm, m) => {
    for (const row of (rm && rm.inline_keyboard) || []) {
      for (const b of row) {
        if (b.callback_data !== undefined && (Buffer.byteLength(b.callback_data) < 1 || Buffer.byteLength(b.callback_data) > 64)) fail(400, 'Bad Request: BUTTON_DATA_INVALID', m);
        if (!b.text) fail(400, 'Bad Request: text buttons are unallowed in the inline keyboard', m);
      }
    }
  };

  /* ---- sticker files ---- */
  /** A sticker the user "sends" (as Telegram would deliver it). */
  function sticker({ animated = false, video = false, type = 'regular', set = null, emoji = '😀', w = 512, h = 512 } = {}) {
    const n = nextFile++;
    const s = { file_id: `STK${n}`, file_unique_id: `UQ${n}abcdef`, type, width: w, height: h, is_animated: animated, is_video: video, emoji, ...(set ? { set_name: set } : {}) };
    files.set(s.file_id, { sticker: s });
    return s;
  }
  const setOf = (name, m) => {
    const s = sets.get(String(name || '').toLowerCase());
    if (!s) fail(400, 'Bad Request: STICKERSET_INVALID', m);
    return s;
  };
  function inputToSticker(inp, set, m) {
    if (!inp || typeof inp.sticker !== 'string') fail(400, 'Bad Request: wrong file identifier/HTTP URL specified', m);
    if (!['static', 'animated', 'video'].includes(inp.format)) fail(400, 'Bad Request: invalid sticker format', m);
    if (!Array.isArray(inp.emoji_list) || inp.emoji_list.length < 1 || inp.emoji_list.length > 20) fail(400, 'Bad Request: invalid emoji list', m);
    const src = files.get(inp.sticker);
    if (!src || !src.sticker) fail(400, 'Bad Request: wrong file identifier/HTTP URL specified', m);
    const fmt = src.sticker.is_animated ? 'animated' : src.sticker.is_video ? 'video' : 'static';
    if (fmt !== inp.format) fail(400, 'Bad Request: STICKER_FILE_INVALID', m);
    if (src.sticker.type && src.sticker.type !== 'regular') fail(400, 'Bad Request: STICKER_FILE_INVALID', m);
    const fid = `${src.sticker.file_unique_id}_IN_${set.name}`;
    const s = { file_id: fid, file_unique_id: src.sticker.file_unique_id, type: 'regular', width: 512, height: 512, is_animated: fmt === 'animated', is_video: fmt === 'video', emoji: inp.emoji_list[0], set_name: set.name };
    files.set(fid, { sticker: s });
    return { ...s, emoji_list: inp.emoji_list, keywords: inp.keywords || [] };
  }
  const findInSet = (fileId, m) => {
    for (const set of sets.values()) {
      const i = set.stickers.findIndex((x) => x.file_id === fileId);
      if (i >= 0) return { set, i };
    }
    fail(400, 'Bad Request: STICKER_ID_INVALID', m);
  };
  const publicSticker = (x) => ({ file_id: x.file_id, file_unique_id: x.file_unique_id, type: x.type, width: x.width, height: x.height, is_animated: x.is_animated, is_video: x.is_video, emoji: x.emoji, set_name: x.set_name });

  /** A public set made by someone else (to import from). */
  function addForeignSet(name, title, n) {
    const set = { name, title, owner: 1, sticker_type: 'regular', stickers: [], thumb: null };
    for (let i = 0; i < n; i++) {
      const s = sticker({ set: name });
      set.stickers.push({ ...s, emoji_list: [s.emoji], keywords: [] });
    }
    sets.set(name.toLowerCase(), set);
    return set;
  }

  const methods = {
    getMe: () => ({ id: BOT_ID, is_bot: true, first_name: 'Wanger Motion', username: BOT_USERNAME }),
    setMyCommands: (p, m) => {
      if (!Array.isArray(p.commands) || p.commands.length > 100) fail(400, 'Bad Request: BOT_COMMANDS_TOO_MUCH', m);
      for (const c of p.commands) if (!/^[a-z0-9_]{1,32}$/.test(c.command) || !c.description || c.description.length > 256) fail(400, 'Bad Request: BOT_COMMAND_INVALID', m);
      return true;
    },
    sendMessage(p, m) {
      toChat(p, m);
      if (!p.text || p.text.length > 4096) fail(400, 'Bad Request: message is too long', m);
      if (p.parse_mode === 'HTML') checkHtml(p.text, m);
      markupOk(p.reply_markup, m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, text: p.text, reply_markup: p.reply_markup || null });
    },
    editMessageText(p, m) {
      const msg = messages.get(p.chat_id) && messages.get(p.chat_id).get(p.message_id);
      if (!msg || msg.sticker) fail(400, 'Bad Request: message to edit not found', m);
      if (p.parse_mode === 'HTML') checkHtml(p.text, m);
      markupOk(p.reply_markup, m);
      if (msg.text === p.text && JSON.stringify(msg.reply_markup) === JSON.stringify(p.reply_markup || null)) fail(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same', m);
      msg.text = p.text;
      msg.reply_markup = p.reply_markup || null;
      return msg;
    },
    editMessageReplyMarkup(p, m) {
      const msg = messages.get(Number(p.chat_id)) && messages.get(Number(p.chat_id)).get(p.message_id);
      if (!msg) fail(400, 'Bad Request: message to edit not found', m);
      msg.reply_markup = p.reply_markup && p.reply_markup.inline_keyboard && p.reply_markup.inline_keyboard.length ? p.reply_markup : null;
      return msg;
    },
    deleteMessage(p, m) {
      const box = messages.get(Number(p.chat_id));
      const msg = box && box.get(p.message_id);
      if (!msg) fail(400, 'Bad Request: message to delete not found', m);
      if (now() - msg.date >= 48 * 3600) fail(400, "Bad Request: message can't be deleted", m);
      box.delete(p.message_id);
      return true;
    },
    answerCallbackQuery: () => true,
    copyMessage(p, m) {
      toChat(p, m);
      return { message_id: store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, copied_from: [p.from_chat_id, p.message_id] }).message_id };
    },
    forwardMessage(p, m) {
      toChat(p, m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, forwarded_from: [p.from_chat_id, p.message_id] });
    },
    sendSticker(p, m) {
      toChat(p, m);
      if (typeof p.sticker !== 'string' || !files.has(p.sticker)) fail(400, 'Bad Request: wrong file identifier/HTTP URL specified', m);
      markupOk(p.reply_markup, m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, sticker: files.get(p.sticker).sticker, reply_markup: p.reply_markup || null });
    },
    sendDocument(p, m) {
      toChat(p, m);
      const d = p.document;
      if (!d || !(d.bytes instanceof Uint8Array)) fail(400, 'Bad Request: there is no document in the request', m);
      const file_id = `DOC${++nextMessageId}`;
      files.set(file_id, { bytes: d.bytes });
      return store(p.chat_id, { message_id: nextMessageId, chat: { id: p.chat_id }, document: { file_id, file_name: d.name, mime_type: d.type, file_size: d.bytes.length } });
    },
    getFileContent(p, m) {
      const f = files.get(p.file_id);
      if (!f || !f.bytes) fail(400, 'Bad Request: wrong file_id or the file is temporarily unavailable', m);
      return f.bytes;
    },
    getChat(p, m) {
      const c = findChannel(p.chat_id);
      if (!c) fail(400, 'Bad Request: chat not found', m);
      return { id: c.id, type: c.type, title: c.title, username: c.username || undefined };
    },
    getChatMember(p, m) {
      const c = findChannel(p.chat_id);
      if (!c) fail(400, 'Bad Request: chat not found', m);
      if (p.user_id === BOT_ID) return { ...c.bot, user: { id: BOT_ID, is_bot: true } };
      if (c.bot.status !== 'administrator') fail(400, 'Bad Request: member list is inaccessible', m);
      const mem = c.members.get(p.user_id);
      if (!mem) fail(400, 'Bad Request: member not found', m);
      return mem;
    },

    /* ---- sticker sets (Bot API rules) ---- */
    createNewStickerSet(p, m) {
      if (blocked.has(p.user_id)) fail(400, 'Bad Request: PEER_ID_INVALID', m);
      const name = String(p.name || '');
      if (name.length < 1 || name.length > 64 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.includes('__') || !name.toLowerCase().endsWith(`_by_${BOT_USERNAME.toLowerCase()}`)) fail(400, 'Bad Request: invalid sticker set name is specified', m);
      if (!p.title || p.title.length > 64) fail(400, 'Bad Request: invalid sticker set title', m);
      if (sets.has(name.toLowerCase())) fail(400, 'Bad Request: sticker set name is already occupied', m);
      if (!Array.isArray(p.stickers) || p.stickers.length < 1 || p.stickers.length > 50) fail(400, 'Bad Request: STICKERS_EMPTY', m);
      const set = { name, title: p.title, owner: p.user_id, sticker_type: p.sticker_type || 'regular', stickers: [], thumb: null };
      for (const inp of p.stickers) set.stickers.push(inputToSticker(inp, set, m));
      sets.set(name.toLowerCase(), set);
      return true;
    },
    addStickerToSet(p, m) {
      const set = setOf(p.name, m);
      if (set.owner !== p.user_id) fail(400, 'Bad Request: STICKERSET_INVALID', m);
      if (set.stickers.length >= 120) fail(400, 'Bad Request: STICKERS_TOO_MUCH', m);
      const s = inputToSticker(p.sticker, set, m);
      if (!set.stickers.some((x) => x.file_unique_id === s.file_unique_id)) set.stickers.push(s);
      return true;
    },
    deleteStickerFromSet(p, m) {
      const { set, i } = findInSet(p.sticker, m);
      set.stickers.splice(i, 1);
      return true;
    },
    setStickerPositionInSet(p, m) {
      const { set, i } = findInSet(p.sticker, m);
      if (!Number.isInteger(p.position) || p.position < 0 || p.position >= set.stickers.length) fail(400, 'Bad Request: STICKER_POSITION_INVALID', m);
      const [s] = set.stickers.splice(i, 1);
      set.stickers.splice(p.position, 0, s);
      return true;
    },
    replaceStickerInSet(p, m) {
      const set = setOf(p.name, m);
      const i = set.stickers.findIndex((x) => x.file_id === p.old_sticker);
      if (i < 0) fail(400, 'Bad Request: STICKER_ID_INVALID', m);
      const s = inputToSticker(p.sticker, set, m);
      set.stickers.splice(i, 1, s);
      return true;
    },
    setStickerEmojiList(p, m) {
      const { set, i } = findInSet(p.sticker, m);
      if (!Array.isArray(p.emoji_list) || p.emoji_list.length < 1 || p.emoji_list.length > 20) fail(400, 'Bad Request: invalid emoji list', m);
      set.stickers[i].emoji_list = p.emoji_list;
      set.stickers[i].emoji = p.emoji_list[0];
      return true;
    },
    setStickerKeywords(p, m) {
      const { set, i } = findInSet(p.sticker, m);
      const k = p.keywords || [];
      if (k.length > 20 || k.join('').length > 64) fail(400, 'Bad Request: KEYWORDS_TOO_MUCH', m);
      set.stickers[i].keywords = k;
      return true;
    },
    setStickerSetTitle(p, m) {
      const set = setOf(p.name, m);
      if (!p.title || p.title.length > 64) fail(400, 'Bad Request: invalid sticker set title', m);
      set.title = p.title;
      return true;
    },
    setStickerSetThumbnail(p, m) {
      const set = setOf(p.name, m);
      if (!['static', 'animated', 'video'].includes(p.format)) fail(400, 'Bad Request: format is required', m);
      set.thumb = p.thumbnail || null;
      return true;
    },
    deleteStickerSet(p, m) {
      setOf(p.name, m);
      sets.delete(String(p.name).toLowerCase());
      return true;
    },
    getStickerSet(p, m) {
      const set = setOf(p.name, m);
      return { name: set.name, title: set.title, sticker_type: set.sticker_type, stickers: set.stickers.map(publicSticker) };
    },
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
    handler, calls, files, channels, blocked, messages, sets,
    sticker,
    addForeignSet,
    document(bytes, { mime = 'image/png', name = 'x.png' } = {}) {
      const file_id = `DOC${++nextMessageId}`;
      files.set(file_id, { bytes });
      return { file_id, file_unique_id: `DU${nextMessageId}`, file_name: name, mime_type: mime, file_size: bytes.length };
    },
    addChannel({ id, username = null, title = 'Channel', botAdmin = true, type = 'channel', rights = {} }) {
      channels.set(id, { id, type, title, username, bot: botAdmin ? { status: 'administrator', can_post_messages: true, can_edit_messages: true, can_delete_messages: true, ...rights } : { status: 'left' }, members: new Map() });
      return channels.get(id);
    },
    setMember(channelId, userId, status = 'member', extra = {}) {
      channels.get(channelId).members.set(userId, { status, user: { id: userId }, ...extra });
    },
    setBotStatus(channelId, status) {
      channels.get(channelId).bot = { status, can_post_messages: status === 'administrator', can_delete_messages: status === 'administrator' };
    },
    failNext(method, code, description, { times = 1, match = null, parameters } = {}) {
      failures.push({ method, code, description, times, match, parameters });
    },
    message: (chatId, messageId) => messages.get(chatId) && messages.get(chatId).get(messageId),
    callsOf(method, chatId, from = 0) {
      return calls.slice(from).filter((c) => c.method === method && (chatId === undefined || Number(c.params.chat_id) === chatId));
    },
    lastTo(chatId) {
      const list = calls.filter((c) => c.result && ['sendMessage', 'editMessageText', 'sendSticker'].includes(c.method) && Number(c.params.chat_id) === chatId);
      return list.length ? list[list.length - 1] : null;
    },
    answers: (from = 0) => calls.slice(from).filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params),
  };
}

/** Flattens an inline keyboard. */
export const buttons = (params) => ((params && params.reply_markup && params.reply_markup.inline_keyboard) || []).flat();
