// A strict in-memory Bot API for tests: files users send (bytes by file_id), channels with members
// and the bot's status, users who blocked the bot, scripted failures, and a log of every call.
// It refuses what Telegram refuses (bad HTML, callback_data > 64 bytes, long texts, files > 20 MB to
// download) and truncates document names the way Telegram did when measured (docs/LIMITS.md §5 #2).
import { BotApiError, InputFile } from '../sdk/api.mjs';

export const BOT_ID = 9216103899;
const MB = 1024 * 1024;

const TAGS = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote', 'span'];

/** Telegram's name truncation, as measured: base ≤ 64 chars, extension ≤ 16, emoji removed. */
export function telegramName(name) {
  const clean = [...String(name)].filter((ch) => !/\p{Extended_Pictographic}/u.test(ch)).join('');
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot + 1) : null;
  const b = [...base].slice(0, 64).join('');
  return ext === null ? b : `${b}.${[...ext].slice(0, 16).join('')}`;
}

export function createFakeTelegram() {
  let nextMessageId = 1000;
  let nextFile = 1;
  const calls = [];
  const channels = new Map();
  const blocked = new Set();
  /** file_id → { bytes, unique, name, mime } */
  const files = new Map();
  const messages = new Map();
  const failures = [];
  const deleted = new Set();

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
      if (!TAGS.includes(tag)) fail(400, `Bad Request: can't parse entities: unsupported start tag "${tag}"`, method);
      if (!close) stack.push(tag);
      else if (stack.pop() !== tag) fail(400, `Bad Request: can't parse entities: unexpected end tag "${tag}"`, method);
    }
    if (stack.length) fail(400, `Bad Request: can't parse entities: can't find end tag corresponding to start tag "${stack.at(-1)}"`, method);
    // a bare "<" or "&" that isn't an entity is refused by Telegram too
    const stripped = String(text || '').replace(/<\/?[a-z-]+[^>]*>/g, '');
    if (/<|&(?!(lt|gt|amp|quot|#\d+);)/.test(stripped)) fail(400, "Bad Request: can't parse entities: unescaped character", method);
  };
  const checkMarkup = (markup, method) => {
    for (const row of (markup && markup.inline_keyboard) || []) {
      for (const b of row) {
        if (!b.text) fail(400, 'Bad Request: text buttons are unallowed in the inline keyboard', method);
        if (b.callback_data !== undefined && (new TextEncoder().encode(b.callback_data).length > 64 || !b.callback_data)) fail(400, 'Bad Request: BUTTON_DATA_INVALID', method);
      }
    }
  };
  const store = (chatId, msg) => {
    if (!messages.has(chatId)) messages.set(chatId, new Map());
    messages.get(chatId).set(msg.message_id, msg);
    return msg;
  };
  const toUser = (chatId, method) => {
    if (chatId > 0 && blocked.has(chatId)) fail(403, 'Forbidden: bot was blocked by the user', method);
  };
  const putFile = (bytes, { name = null, mime = null } = {}) => {
    const n = nextFile++;
    const file_id = `FILE${n}`;
    files.set(file_id, { bytes, unique: `UNIQ${n}`, name, mime });
    return { file_id, file_unique_id: `UNIQ${n}`, file_size: bytes.length, ...(name ? { file_name: name } : {}), ...(mime ? { mime_type: mime } : {}) };
  };

  const methods = {
    getMe: () => ({ id: BOT_ID, is_bot: true, first_name: 'Wanger Converter', username: 'Wanger_Converterbot' }),
    sendMessage(p, m) {
      toUser(p.chat_id, m);
      if (!p.text || p.text.length > 4096) fail(400, 'Bad Request: message is too long', m);
      if (p.parse_mode === 'HTML') checkHtml(p.text, m);
      checkMarkup(p.reply_markup, m);
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, text: p.text, reply_markup: p.reply_markup || null });
    },
    editMessageText(p, m) {
      const msg = messages.get(p.chat_id) && messages.get(p.chat_id).get(p.message_id);
      if (!msg) fail(400, 'Bad Request: message to edit not found', m);
      if (p.parse_mode === 'HTML') checkHtml(p.text, m);
      checkMarkup(p.reply_markup, m);
      if (msg.text === p.text && JSON.stringify(msg.reply_markup) === JSON.stringify(p.reply_markup || null)) fail(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same', m);
      msg.text = p.text;
      msg.reply_markup = p.reply_markup || null;
      return msg;
    },
    answerCallbackQuery: () => true,
    sendChatAction: (p, m) => { toUser(p.chat_id, m); return true; },
    deleteMessage(p, m) {
      const key = `${p.chat_id}:${p.message_id}`;
      if (deleted.has(key)) fail(400, 'Bad Request: message to delete not found', m);
      deleted.add(key);
      const box = messages.get(p.chat_id);
      if (box) box.delete(p.message_id);
      return true; // users' own messages aren't stored here; deleting them succeeds once
    },
    copyMessage(p, m) {
      toUser(p.chat_id, m);
      return { message_id: ++nextMessageId };
    },
    getChat(p, m) {
      const c = findChannel(p.chat_id);
      if (!c) fail(400, 'Bad Request: chat not found', m);
      return { id: c.id, type: c.type, title: c.title, username: c.username || undefined };
    },
    getChatMember(p, m) {
      const c = findChannel(p.chat_id);
      if (!c || c.gone) fail(400, 'Bad Request: chat not found', m);
      if (c.bot.status !== 'administrator') fail(400, 'Bad Request: member list is inaccessible', m); // measured (C0)
      if (p.user_id === BOT_ID) return { ...c.bot, user: { id: BOT_ID, is_bot: true } };
      const mem = c.members.get(p.user_id);
      if (!mem) fail(400, 'Bad Request: member not found', m);
      return mem;
    },
    sendDocument(p, m) {
      toUser(p.chat_id, m);
      if (p.caption && p.caption.length > 1024) fail(400, 'Bad Request: message caption is too long', m);
      if (p.parse_mode === 'HTML' && p.caption) checkHtml(p.caption, m);
      checkMarkup(p.reply_markup, m);
      let doc;
      if (p.document instanceof InputFile) {
        if (p.document.bytes.length > 50 * MB) fail(413, 'Request Entity Too Large', m);
        if (!p.document.bytes.length) fail(400, 'Bad Request: file must be non-empty', m);
        doc = putFile(p.document.bytes, { name: telegramName(p.document.name), mime: p.document.type || 'application/octet-stream' });
      } else if (typeof p.document === 'string' && files.has(p.document)) {
        const f = files.get(p.document);
        doc = { file_id: p.document, file_unique_id: f.unique, file_size: f.bytes.length, file_name: f.name, mime_type: f.mime };
      } else {
        fail(400, 'Bad Request: wrong file identifier/HTTP URL specified', m);
      }
      return store(p.chat_id, { message_id: ++nextMessageId, chat: { id: p.chat_id }, document: doc, caption: p.caption || null, reply_markup: p.reply_markup || null });
    },
    getFile(p, m) {
      const f = files.get(p.file_id);
      if (!f) fail(400, 'Bad Request: invalid file_id', m);
      if (f.bytes.length > 20 * MB) fail(400, 'Bad Request: file is too big', m);
      return { file_id: p.file_id, file_unique_id: f.unique, file_size: f.bytes.length };
    },
    getFileContent(p, m) {
      const f = files.get(p.file_id);
      if (!f) fail(400, 'Bad Request: invalid file_id', m);
      if (f.bytes.length > 20 * MB) fail(400, 'Bad Request: file is too big', m);
      return f.bytes;
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
    handler,
    calls,
    files,
    channels,
    blocked,
    messages,
    deleted,
    putFile,
    addChannel({ id, username = null, title = 'Channel', botAdmin = true, type = 'channel' }) {
      channels.set(id, { id, type, title, username, bot: botAdmin ? { status: 'administrator' } : { status: 'left' }, members: new Map() });
      return channels.get(id);
    },
    setMember(channelId, userId, status = 'member', extra = {}) {
      channels.get(channelId).members.set(userId, { status, user: { id: userId }, ...extra });
    },
    setBotStatus(channelId, status) {
      channels.get(channelId).bot = { status };
    },
    failNext(method, code, description, { times = 1, match = null, parameters } = {}) {
      failures.push({ method, code, description, times, match, parameters });
    },
    message: (chatId, messageId) => messages.get(chatId) && messages.get(chatId).get(messageId),
    callsOf(method, chatId, from = 0) {
      return calls.slice(from).filter((c) => c.method === method && (chatId === undefined || c.params.chat_id === chatId));
    },
    lastTo(chatId) {
      const list = calls.filter((c) => c.result && ['sendMessage', 'editMessageText', 'sendDocument'].includes(c.method) && c.params.chat_id === chatId);
      return list.length ? list[list.length - 1].params : null;
    },
    answers: (from = 0) => calls.slice(from).filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params),
  };
}

/** Flattens an inline keyboard. */
export const buttons = (params) => ((params && params.reply_markup && params.reply_markup.inline_keyboard) || []).flat();
