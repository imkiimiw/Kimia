// A strict stand-in for the Telegram Bot API, enough to drive the meme bot end to end. It rejects
// what Telegram rejects — bad HTML, callback_data over 64 bytes, a callback answered twice, more than
// 50 inline results, a video/voice result without a title, next_offset over 64 bytes, a bad results
// button, forwarding a message that's gone, unknown file ids, "message is not modified" — so those
// bugs fail locally instead of in production.
import { Buffer } from 'node:buffer';
import http from 'node:http';

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote', 'span']);

/** Checks text the way parse_mode HTML does. Returns { error } or { plain } (the visible text). */
export function parseHtml(text) {
  const stack = [];
  let plain = '';
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '<') {
      const end = s.indexOf('>', i);
      if (end < 0) return { error: `can't parse entities: unclosed start tag at byte offset ${i}` };
      const tag = s.slice(i + 1, end);
      const close = tag.startsWith('/');
      const name = (close ? tag.slice(1) : tag).split(/\s/)[0].toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return { error: `can't parse entities: unsupported start tag "${name}" at byte offset ${i}` };
      if (close) {
        if (stack.pop() !== name) return { error: `can't parse entities: unmatched end tag "${name}"` };
      } else stack.push(name);
      i = end + 1;
    } else if (ch === '&') {
      const m = /^&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i.exec(s.slice(i));
      if (!m) return { error: `can't parse entities: unsupported entity at byte offset ${i}` };
      plain += '?';
      i += m[0].length;
    } else if (ch === '>') {
      return { error: `can't parse entities: unexpected ">" at byte offset ${i}` };
    } else {
      plain += ch;
      i += 1;
    }
  }
  if (stack.length) return { error: `can't parse entities: unclosed tag "${stack[stack.length - 1]}"` };
  return { plain };
}

const BUTTON_KINDS = ['callback_data', 'url', 'switch_inline_query', 'switch_inline_query_current_chat', 'web_app', 'copy_text'];

function checkMarkup(markup) {
  if (!markup) return null;
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) return 'reply markup is not an inline keyboard';
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) return 'keyboard row is empty';
    for (const b of row) {
      if (!b.text) return 'button text is empty';
      const kinds = BUTTON_KINDS.filter((k) => b[k] !== undefined);
      if (kinds.length !== 1) return `button "${b.text}" must have exactly one action`;
      if (b.callback_data !== undefined && (!b.callback_data || Buffer.byteLength(b.callback_data, 'utf8') > 64)) return 'BUTTON_DATA_INVALID';
      if (b.switch_inline_query_current_chat !== undefined && (typeof b.switch_inline_query_current_chat !== 'string' || b.switch_inline_query_current_chat.length > 256)) return 'bad switch_inline_query_current_chat';
    }
  }
  return null;
}

// Required file field and whether a title is required, per cached inline result type.
const INLINE_TYPES = {
  photo: ['photo_file_id', false],
  gif: ['gif_file_id', false],
  mpeg4_gif: ['mpeg4_file_id', false],
  video: ['video_file_id', true],
  sticker: ['sticker_file_id', false],
  voice: ['voice_file_id', true],
};

// Send method → [file field, captionable]
const MEDIA_METHODS = {
  sendPhoto: ['photo', true],
  sendAnimation: ['animation', true],
  sendVideo: ['video', true],
  sendSticker: ['sticker', false],
  sendVoice: ['voice', true],
};

export function createMockTelegram({ botId = 7100000001, botUsername = 'meme_test_bot' } = {}) {
  const state = {
    calls: [],
    nextMessageId: 5000,
    inline: true, // supports_inline_queries (BotFather /setinline)
    channels: new Map(), // id -> { id, title, username, admin }
    privateChats: new Set(), // users who started the bot
    blocked: new Set(),
    messages: new Map(), // `${chat}:${id}` -> { text, markup, media }
    userMessages: new Map(), // `${chat}:${id}` -> message a user sent (forwardable)
    answeredCallbacks: new Set(),
    answeredInline: new Map(), // inline_query_id -> params
    badFiles: new Set(), // file ids Telegram refuses
    forwards: [], // { to, from_chat_id, message_id, new_id }
    sent: [], // media sends: { chat_id, method, file, caption, new_id }
    botTexts: new Map(), // language_code ('' default) -> { commands, description, short }
    members: new Map(), // `${channelId}:${userId}` -> ChatMember fields ({ status, is_member })
    noInviteRight: new Set(), // channel ids where the bot may not create invite links
    copies: [], // copyMessage: { to, from_chat_id, message_id, new_id }
    inlineMessages: new Map(), // inline_message_id -> markup (JSON) of memes sent through inline mode
    rateLimitAt: null, // copyMessage number (1-based, counted from when it was set) that gets one 429
    rateLimitCount: 0,
  };

  const ok = (result) => ({ ok: true, result });
  const err = (code, description, parameters) => ({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });

  function addChannel(id, { title = `Channel ${id}`, username = null, admin = true } = {}) {
    state.channels.set(Number(id), { id: Number(id), title, username, admin });
  }
  function channelOf(chatId) {
    const s = String(chatId);
    if (s.startsWith('@')) return [...state.channels.values()].find((c) => c.username && `@${c.username}`.toLowerCase() === s.toLowerCase()) || null;
    return state.channels.get(Number(chatId)) || null;
  }

  /** Who the bot may send to: a started user who didn't block it, or a channel where it is admin. */
  function reachable(chatId) {
    const ch = channelOf(chatId);
    if (ch) return ch.admin ? null : err(403, 'Forbidden: bot is not a member of the channel chat');
    if (String(chatId).startsWith('-')) return err(400, 'Bad Request: chat not found');
    const id = Number(chatId);
    if (state.blocked.has(id)) return err(403, 'Forbidden: bot was blocked by the user');
    if (!state.privateChats.has(id)) return err(403, "Forbidden: bot can't initiate conversation with a user");
    return null;
  }
  const chatKey = (chatId) => {
    const ch = channelOf(chatId);
    return String(ch ? ch.id : chatId);
  };

  function checkText(text, parseMode, max) {
    if (typeof text !== 'string' || !text) return 'message text is empty';
    let plain = text;
    if (parseMode === 'HTML') {
      const h = parseHtml(text);
      if (h.error) return h.error;
      plain = h.plain;
    }
    if (plain.length > max) return max === 4096 ? 'message is too long' : 'message caption is too long';
    return null;
  }

  function newMessage(chatId, record) {
    const message_id = state.nextMessageId++;
    state.messages.set(`${chatKey(chatId)}:${message_id}`, record);
    return message_id;
  }

  function chatObject(chatId) {
    const ch = channelOf(chatId);
    return ch ? { id: ch.id, type: 'channel', title: ch.title, ...(ch.username ? { username: ch.username } : {}) } : { id: Number(chatId), type: 'private' };
  }

  function mediaSend(method) {
    const [field, captionable] = MEDIA_METHODS[method];
    return (p) => {
      const r = reachable(p.chat_id);
      if (r) return r;
      if (!p[field]) return err(400, `Bad Request: there is no ${field} in the request`);
      if (state.badFiles.has(p[field])) return err(400, 'Bad Request: wrong file identifier/HTTP URL specified');
      if (p.caption !== undefined) {
        if (!captionable) return err(400, 'Bad Request: caption is not allowed');
        const e = checkText(p.caption, p.parse_mode, 1024);
        if (e) return err(400, `Bad Request: ${e}`);
      }
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const message_id = newMessage(p.chat_id, { media: field, file: p[field], caption: p.caption, markup: JSON.stringify(p.reply_markup || null) });
      state.sent.push({ chat_id: chatKey(p.chat_id), method, file: p[field], caption: p.caption, new_id: message_id });
      return ok({ message_id, chat: chatObject(p.chat_id), date: 0, [field]: { file_id: p[field] } });
    };
  }

  function checkInlineResults(results) {
    if (!Array.isArray(results)) return 'results must be an array';
    if (results.length > 50) return 'RESULTS_TOO_MUCH';
    const ids = new Set();
    for (const r of results) {
      const spec = INLINE_TYPES[r.type];
      if (!spec) return `unsupported inline result type ${r.type}`;
      const idLen = Buffer.byteLength(String(r.id || ''), 'utf8');
      if (!idLen || idLen > 64) return 'RESULT_ID_INVALID';
      if (ids.has(r.id)) return 'RESULT_ID_DUPLICATE';
      ids.add(r.id);
      if (!r[spec[0]]) return `${r.type} result without ${spec[0]}`;
      if (state.badFiles.has(r[spec[0]])) return 'Bad Request: wrong file identifier/HTTP URL specified';
      if (spec[1] && !r.title) return `RESULT_TITLE_EMPTY (${r.type})`;
      if (r.type === 'sticker' && (r.caption !== undefined || r.title !== undefined)) return 'sticker results take no caption or title';
    }
    return null;
  }

  const handlers = {
    getMe: () => ok({ id: botId, is_bot: true, first_name: 'Meme', username: botUsername, supports_inline_queries: state.inline }),
    sendMessage: (p) => {
      const r = reachable(p.chat_id);
      if (r) return r;
      const e = checkText(p.text, p.parse_mode, 4096);
      if (e) return err(400, `Bad Request: ${e}`);
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const message_id = newMessage(p.chat_id, { text: p.text, markup: JSON.stringify(p.reply_markup || null) });
      return ok({ message_id, chat: chatObject(p.chat_id), date: 0, text: p.text });
    },
    editMessageText: (p) => {
      const key = `${chatKey(p.chat_id)}:${p.message_id}`;
      const msg = state.messages.get(key);
      if (!msg || msg.media) return err(400, 'Bad Request: message to edit not found');
      const e = checkText(p.text, p.parse_mode, 4096);
      if (e) return err(400, `Bad Request: ${e}`);
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const markup = JSON.stringify(p.reply_markup || null);
      if (msg.text === p.text && msg.markup === markup) return err(400, 'Bad Request: message is not modified');
      Object.assign(msg, { text: p.text, markup });
      return ok(true);
    },
    editMessageReplyMarkup: (p) => {
      if (p.inline_message_id !== undefined) {
        if (!state.inlineMessages.has(p.inline_message_id)) return err(400, 'Bad Request: MESSAGE_ID_INVALID');
        const m = checkMarkup(p.reply_markup);
        if (m) return err(400, `Bad Request: ${m}`);
        const markup = JSON.stringify(p.reply_markup || null);
        if (state.inlineMessages.get(p.inline_message_id) === markup) return err(400, 'Bad Request: message is not modified');
        state.inlineMessages.set(p.inline_message_id, markup);
        return ok(true);
      }
      const msg = state.messages.get(`${chatKey(p.chat_id)}:${p.message_id}`);
      if (!msg) return err(400, 'Bad Request: message to edit not found');
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const markup = JSON.stringify(p.reply_markup && p.reply_markup.inline_keyboard && p.reply_markup.inline_keyboard.length ? p.reply_markup : null);
      if (msg.markup === markup) return err(400, 'Bad Request: message is not modified');
      msg.markup = markup;
      return ok(true);
    },
    editMessageCaption: (p) => {
      const msg = state.messages.get(`${chatKey(p.chat_id)}:${p.message_id}`);
      if (!msg || !msg.media) return err(400, 'Bad Request: message to edit not found');
      const e = p.caption ? checkText(p.caption, p.parse_mode, 1024) : null;
      if (e) return err(400, `Bad Request: ${e}`);
      if (msg.caption === p.caption) return err(400, 'Bad Request: message is not modified');
      msg.caption = p.caption;
      if (p.reply_markup) msg.markup = JSON.stringify(p.reply_markup);
      return ok(true);
    },
    deleteMessage: (p) => {
      const key = `${chatKey(p.chat_id)}:${p.message_id}`;
      if (!state.messages.delete(key)) return err(400, 'Bad Request: message to delete not found');
      return ok(true);
    },
    answerCallbackQuery: (p) => {
      if (state.answeredCallbacks.has(p.callback_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      if (p.text && p.text.length > 200) return err(400, 'Bad Request: MESSAGE_TOO_LONG');
      state.answeredCallbacks.add(p.callback_query_id);
      return ok(true);
    },
    answerInlineQuery: (p) => {
      if (state.answeredInline.has(p.inline_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      const e = checkInlineResults(p.results);
      if (e) return err(400, `Bad Request: ${e}`);
      if (p.next_offset !== undefined && Buffer.byteLength(String(p.next_offset), 'utf8') > 64) return err(400, 'Bad Request: NEXT_OFFSET_INVALID');
      if (p.cache_time !== undefined && !Number.isInteger(p.cache_time)) return err(400, 'Bad Request: bad cache_time');
      if (p.button) {
        const b = p.button;
        const kinds = ['web_app', 'start_parameter'].filter((k) => b[k] !== undefined);
        if (!b.text || kinds.length !== 1) return err(400, 'Bad Request: BUTTON_INVALID');
        if (b.start_parameter !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(b.start_parameter)) return err(400, 'Bad Request: START_PARAM_INVALID');
      }
      state.answeredInline.set(p.inline_query_id, p);
      return ok(true);
    },
    forwardMessage: (p) => {
      const ch = channelOf(p.chat_id);
      if (!ch) return err(400, 'Bad Request: chat not found');
      if (!ch.admin) return err(403, 'Forbidden: bot is not a member of the channel chat');
      const src = state.userMessages.get(`${p.from_chat_id}:${p.message_id}`);
      if (!src) return err(400, 'Bad Request: message to forward not found');
      const message_id = newMessage(ch.id, { media: 'forward', markup: 'null' });
      state.forwards.push({ to: ch.id, from_chat_id: Number(p.from_chat_id), message_id: Number(p.message_id), new_id: message_id });
      return ok({ ...src, message_id, chat: chatObject(ch.id), forward_origin: { type: 'user', sender_user: src.from } });
    },
    ...Object.fromEntries(Object.keys(MEDIA_METHODS).map((m) => [m, mediaSend(m)])),
    getChat: (p) => {
      const ch = channelOf(p.chat_id);
      return ch ? ok(chatObject(ch.id)) : err(400, 'Bad Request: chat not found');
    },
    getChatMember: (p) => {
      const ch = channelOf(p.chat_id);
      if (!ch) return err(400, 'Bad Request: chat not found');
      if (Number(p.user_id) === botId) return ok(ch.admin ? { status: 'administrator', can_post_messages: true, user: { id: botId } } : { status: 'left', user: { id: botId } });
      if (!ch.admin) return err(400, 'Bad Request: member list is inaccessible');
      const m = state.members.get(`${ch.id}:${Number(p.user_id)}`);
      return m ? ok({ ...m, user: { id: Number(p.user_id) } }) : err(400, 'Bad Request: member not found');
    },
    createChatInviteLink: (p) => {
      const ch = channelOf(p.chat_id);
      if (!ch || !ch.admin || state.noInviteRight.has(ch.id)) return err(400, 'Bad Request: not enough rights to manage chat invite link');
      return ok({ invite_link: `https://t.me/+inv${Math.abs(ch.id)}`, name: p.name, creator: { id: botId } });
    },
    copyMessage: (p) => {
      const r = reachable(p.chat_id);
      if (r) return r;
      if (!state.userMessages.has(`${p.from_chat_id}:${p.message_id}`)) return err(400, 'Bad Request: message to copy not found');
      state.rateLimitCount += 1;
      if (state.rateLimitAt !== null && state.rateLimitCount === state.rateLimitAt) {
        state.rateLimitAt = null;
        return err(429, 'Too Many Requests: retry after 7', { retry_after: 7 });
      }
      const message_id = newMessage(p.chat_id, { media: 'copy', markup: 'null' });
      state.copies.push({ to: Number(p.chat_id), from_chat_id: Number(p.from_chat_id), message_id: Number(p.message_id), new_id: message_id });
      return ok({ message_id });
    },
    setMyCommands: (p) => {
      if (!Array.isArray(p.commands) || !p.commands.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description && c.description.length <= 256)) return err(400, 'Bad Request: BOT_COMMAND_INVALID');
      text(p).commands = p.commands;
      return ok(true);
    },
    setMyDescription: (p) => {
      if (String(p.description || '').length > 512) return err(400, 'Bad Request: description is too long');
      text(p).description = p.description;
      return ok(true);
    },
    setMyShortDescription: (p) => {
      if (String(p.short_description || '').length > 120) return err(400, 'Bad Request: short description is too long');
      text(p).short = p.short_description;
      return ok(true);
    },
  };
  // Keyed like Telegram stores them: per scope (default = '') and language ('' = all languages).
  function text(p) {
    const scope = p.scope && p.scope.type && p.scope.type !== 'default' ? `${p.scope.type}:${p.scope.chat_id || ''}/` : '';
    const k = scope + (p.language_code || '');
    if (!state.botTexts.has(k)) state.botTexts.set(k, {});
    return state.botTexts.get(k);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      let params = {};
      try {
        params = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        params = {};
      }
      const h = handlers[method];
      const out = h ? h(params) : err(404, `Not Found: method ${method} is not mocked`);
      state.calls.push({ method, params, ok: out.ok, error: out.ok ? undefined : out.description, result: out.result });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  return {
    state,
    botId,
    botUsername,
    addChannel,
    setMember(channelId, userId, status = 'member') {
      if (status) state.members.set(`${channelId}:${userId}`, { status, ...(status === 'restricted' ? { is_member: true } : {}) });
      else state.members.delete(`${channelId}:${userId}`);
    },
    /** A 429 on the n-th copyMessage from now. */
    rateLimitCopyAt(n) {
      state.rateLimitCount = 0;
      state.rateLimitAt = n;
    },
    /** Records a message a user sent, so the bot can forward it. */
    userSent(message) {
      state.userMessages.set(`${message.chat.id}:${message.message_id}`, message);
    },
    userDeleted(chatId, messageId) {
      state.userMessages.delete(`${chatId}:${messageId}`);
    },
    message(chatId, messageId) {
      return state.messages.get(`${chatKey(chatId)}:${messageId}`);
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
