// A strict stand-in for the Telegram Bot API, enough to drive the bot end to end. It rejects what
// Telegram rejects (bad HTML, callback_data over 64 bytes, alerts over 200 characters, double
// answers, unknown inline messages, "message is not modified") so those bugs fail locally.
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
      } else {
        if (name === 'a' && !/^a\s+href="[^"]+"$/.test(tag)) return { error: `can't parse entities: bad <a> tag "${tag}"` };
        stack.push(name);
      }
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

function checkMarkup(markup) {
  if (!markup) return null;
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) return 'reply markup is not an inline keyboard';
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) return 'keyboard row is empty';
    for (const b of row) {
      if (!b.text) return 'button text is empty';
      const kinds = ['callback_data', 'url', 'switch_inline_query'].filter((k) => b[k] !== undefined);
      if (kinds.length !== 1) return `button "${b.text}" must have exactly one action`;
      if (b.callback_data !== undefined && (Buffer.byteLength(b.callback_data, 'utf8') > 64 || !b.callback_data)) return 'BUTTON_DATA_INVALID';
      if (b.url !== undefined && !/^(https:\/\/t\.me\/|tg:\/\/)\S+$/.test(b.url)) return `bad button url ${b.url}`;
    }
  }
  return null;
}

export function createMockTelegram({ botId, botUsername = 'whisper_test_bot' }) {
  const state = {
    calls: [],
    nextMessageId: 1000,
    chats: new Map(), // '@name' (lowercase) -> { id, title, username, type }
    botAdmin: new Set(), // chat keys where the bot is admin
    members: new Map(), // `${chatKey}:${userId}` -> ChatMember fields ({ status, is_member })
    unknownUsers: new Set(), // user ids Telegram doesn't know
    blocked: new Set(), // user ids that blocked the bot
    privateChats: new Set(), // user ids that started the bot (others can't be messaged: 403)
    rateLimitOnce: new Map(), // user id -> retry_after: their next copyMessage gets a 429
    messages: new Map(), // `${chat}:${message_id}` -> { text, markup }
    inline: new Map(), // inline_message_id -> { text, markup }
    answeredCallbacks: new Set(),
    answeredInline: new Set(),
    copied: [], // { chat_id, from_chat_id, message_id, reply_markup, new_id }
    uncopyable: new Set(), // `${chat}:${message_id}` that copyMessage refuses (like a service message)
    deleted: [],
  };

  const key = (chatId) => {
    const s = String(chatId);
    if (s.startsWith('@')) return s.toLowerCase();
    for (const [k, c] of state.chats) if (String(c.id) === s) return k;
    return s;
  };

  function addChat(username, { title, admin = true, type = 'channel' } = {}) {
    const k = `@${username.toLowerCase()}`;
    const chat = { id: -1001000000000 - state.chats.size - 1, title: title || username, username, type };
    state.chats.set(k, chat);
    if (admin) state.botAdmin.add(k);
    return chat;
  }

  const ok = (result) => ({ ok: true, result });
  const err = (code, description, parameters) => ({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });

  /** Who can receive a message in a private chat. */
  function reachable(chatId) {
    const id = Number(chatId);
    if (state.unknownUsers.has(id)) return err(400, 'Bad Request: chat not found');
    if (state.blocked.has(id)) return err(403, 'Forbidden: bot was blocked by the user');
    if (id > 0 && !state.privateChats.has(id)) return err(403, "Forbidden: bot can't initiate conversation with a user");
    return null;
  }

  function checkText(p) {
    if (typeof p.text !== 'string' || !p.text) return err(400, 'Bad Request: message text is empty');
    let plain = p.text;
    if (p.parse_mode === 'HTML') {
      const h = parseHtml(p.text);
      if (h.error) return err(400, `Bad Request: ${h.error}`);
      plain = h.plain;
    }
    if (plain.length > 4096) return err(400, 'Bad Request: message is too long');
    const m = checkMarkup(p.reply_markup);
    if (m) return err(400, `Bad Request: ${m}`);
    return null;
  }

  const handlers = {
    getMe: () => ok({ id: botId, is_bot: true, first_name: 'Whisper', username: botUsername }),
    answerCallbackQuery: (p) => {
      if (state.answeredCallbacks.has(p.callback_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      if (p.text && p.text.length > 200) return err(400, 'Bad Request: MESSAGE_TOO_LONG');
      if (p.url && !/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]{1,64}$/.test(p.url)) return err(400, 'Bad Request: URL_INVALID');
      state.answeredCallbacks.add(p.callback_query_id);
      return ok(true);
    },
    answerInlineQuery: (p) => {
      if (state.answeredInline.has(p.inline_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      const results = p.results || [];
      if (results.length > 50) return err(400, 'Bad Request: RESULTS_TOO_MUCH');
      const ids = new Set();
      for (const r of results) {
        if (!r.id || Buffer.byteLength(r.id, 'utf8') > 64) return err(400, 'Bad Request: RESULT_ID_INVALID');
        if (ids.has(r.id)) return err(400, 'Bad Request: RESULT_ID_DUPLICATE');
        ids.add(r.id);
        if (r.type !== 'article' || !r.title) return err(400, 'Bad Request: result is invalid');
        const c = checkText({ text: r.input_message_content && r.input_message_content.message_text, parse_mode: r.input_message_content && r.input_message_content.parse_mode, reply_markup: r.reply_markup });
        if (c) return c;
      }
      if (p.button) {
        if (!p.button.text || !/^[A-Za-z0-9_-]{1,64}$/.test(p.button.start_parameter || '')) return err(400, 'Bad Request: BUTTON_INVALID');
      }
      if (p.cache_time !== 0 || p.is_personal !== true) return err(400, 'test: expected cache_time 0 and is_personal true');
      state.answeredInline.add(p.inline_query_id);
      return ok(true);
    },
    getChat: (p) => {
      const c = state.chats.get(key(p.chat_id));
      return c ? ok({ ...c }) : err(400, 'Bad Request: chat not found');
    },
    getChatMember: (p) => {
      const k = key(p.chat_id);
      if (!state.chats.has(k)) return err(400, 'Bad Request: chat not found');
      if (Number(p.user_id) === botId) return ok({ status: state.botAdmin.has(k) ? 'administrator' : 'left', user: { id: botId } });
      if (!state.botAdmin.has(k)) return err(400, 'Bad Request: member list is inaccessible');
      if (state.unknownUsers.has(Number(p.user_id))) return err(400, 'Bad Request: user not found');
      const m = state.members.get(`${k}:${p.user_id}`) || { status: 'left' };
      return ok({ ...m, user: { id: Number(p.user_id) } });
    },
    sendMessage: (p) => {
      const r = reachable(p.chat_id);
      if (r) return r;
      const c = checkText(p);
      if (c) return c;
      const message_id = state.nextMessageId++;
      state.messages.set(`${p.chat_id}:${message_id}`, { text: p.text, markup: JSON.stringify(p.reply_markup || null), reply_to: p.reply_parameters ? p.reply_parameters.message_id : null });
      return ok({ message_id, chat: { id: p.chat_id }, text: p.text });
    },
    copyMessage: (p) => {
      const chat = Number(p.chat_id);
      if (state.rateLimitOnce.has(chat)) {
        const wait = state.rateLimitOnce.get(chat);
        state.rateLimitOnce.delete(chat);
        return err(429, `Too Many Requests: retry after ${wait}`, { retry_after: wait });
      }
      if (Number(p.chat_id) > 0 && state.blocked.has(chat)) return err(403, 'Forbidden: bot was blocked by the user');
      const r = reachable(chat);
      if (r) return r;
      if (!p.from_chat_id || !p.message_id) return err(400, 'Bad Request: message to copy not found');
      if (state.uncopyable.has(`${p.from_chat_id}:${p.message_id}`)) return err(400, "Bad Request: message can't be copied");
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const message_id = state.nextMessageId++;
      state.copied.push({ chat_id: chat, from_chat_id: p.from_chat_id, message_id: p.message_id, reply_markup: p.reply_markup, new_id: message_id });
      state.messages.set(`${chat}:${message_id}`, { text: `<copy of ${p.from_chat_id}:${p.message_id}>`, markup: JSON.stringify(p.reply_markup || null) });
      return ok({ message_id });
    },
    editMessageReplyMarkup: (p) => {
      const k = `${p.chat_id}:${p.message_id}`;
      const m = state.messages.get(k);
      if (!m) return err(400, 'Bad Request: message to edit not found');
      const bad = checkMarkup(p.reply_markup);
      if (bad) return err(400, `Bad Request: ${bad}`);
      const markup = JSON.stringify(p.reply_markup || null);
      if (m.markup === markup) return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
      state.messages.set(k, { ...m, markup });
      return ok(true);
    },
    deleteMessage: (p) => {
      const k = `${p.chat_id}:${p.message_id}`;
      if (!state.messages.has(k)) return err(400, 'Bad Request: message to delete not found');
      state.messages.delete(k);
      state.deleted.push(k);
      return ok(true);
    },
    editMessageText: (p) => {
      const c = checkText(p);
      if (c) return c;
      const markup = JSON.stringify(p.reply_markup || null);
      if (p.inline_message_id) {
        const m = state.inline.get(p.inline_message_id);
        if (!m) return err(400, 'Bad Request: MESSAGE_ID_INVALID');
        if (m.text === p.text && m.markup === markup) return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
        state.inline.set(p.inline_message_id, { text: p.text, markup });
        return ok(true);
      }
      const k = `${p.chat_id}:${p.message_id}`;
      const m = state.messages.get(k);
      if (!m) return err(400, 'Bad Request: message to edit not found');
      if (m.text === p.text && m.markup === markup) return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
      state.messages.set(k, { text: p.text, markup });
      return ok({ message_id: p.message_id, chat: { id: p.chat_id }, text: p.text });
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const method = m && m[2];
      const handler = handlers[method];
      const result = handler ? handler(params) : err(404, `Not Found: method ${method} not mocked`);
      state.calls.push({ method, params, result });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  return {
    state,
    addChat,
    setMember: (username, userId, member) => state.members.set(`@${username.toLowerCase()}:${userId}`, member),
    /** The client posted an inline result: Telegram now has a message with that content. */
    postInline: (inlineId, result) => state.inline.set(inlineId, {
      text: result.input_message_content.message_text,
      markup: JSON.stringify(result.reply_markup || null),
    }),
    /** A message the bot sent earlier, so the test can press its buttons (edits need it to exist). */
    seedMessage: (chatId, messageId, text = '…') => state.messages.set(`${chatId}:${messageId}`, { text, markup: 'null' }),
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
