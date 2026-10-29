// A strict stand-in for the Telegram Bot API, enough to drive the relay bot end to end. It keeps every
// chat's messages and rejects what Telegram rejects: writing to someone who hasn't started the bot or
// blocked it (403), forwarding/copying a message that doesn't exist or can't be copied, replying to a
// missing message without allow_sending_without_reply, bad HTML, callback_data over 64 bytes, alerts
// over 200 characters, answering a button twice, and "message is not modified".
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
      const kinds = ['callback_data', 'url'].filter((k) => b[k] !== undefined);
      if (kinds.length !== 1) return `button "${b.text}" must have exactly one action`;
      if (b.callback_data !== undefined && (!b.callback_data || Buffer.byteLength(b.callback_data, 'utf8') > 64)) return 'BUTTON_DATA_INVALID';
    }
  }
  return null;
}

export function createMockTelegram({ botId, botUsername = 'relay_test_bot' }) {
  const bot = { id: botId, is_bot: true, first_name: 'Relay', username: botUsername };
  const state = {
    calls: [],
    nextMessageId: 1000, // ids of messages the bot sends (user messages are numbered by the test)
    started: new Set(), // user ids that started the bot (others can't be messaged: 403)
    blocked: new Set(), // user ids that blocked the bot
    users: new Map(), // user id -> User, for forward_origin
    messages: new Map(), // `${chat}:${message_id}` -> stored message (see store())
    answeredCallbacks: new Set(),
  };

  const k = (chat, id) => `${Number(chat)}:${Number(id)}`;
  const ok = (result) => ({ ok: true, result });
  const err = (code, description, parameters) => ({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });

  /** A message in a chat. `kind`: text, photo, voice, sticker, quiz (can't be copied), service (can't be forwarded or copied). */
  function store(chat, id, fields) {
    const m = { chat: Number(chat), message_id: Number(id), markup: null, ...fields };
    state.messages.set(k(chat, id), m);
    return m;
  }

  /** Who can receive a message in a private chat. */
  function reachable(chatId) {
    const id = Number(chatId);
    if (state.blocked.has(id)) return err(403, 'Forbidden: bot was blocked by the user');
    if (id > 0 && !state.started.has(id)) return err(403, "Forbidden: bot can't initiate conversation with a user");
    return null;
  }

  function checkReply(p) {
    const r = p.reply_parameters;
    if (!r) return null;
    if (!state.messages.has(k(p.chat_id, r.message_id)) && !r.allow_sending_without_reply) return err(400, 'Bad Request: message to be replied not found');
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
    return null;
  }

  const markupOf = (p) => (p.reply_markup ? JSON.parse(JSON.stringify(p.reply_markup)) : null);

  const handlers = {
    getMe: () => ok(bot),
    sendMessage: (p) => {
      const bad = reachable(p.chat_id) || checkText(p) || checkReply(p);
      if (bad) return bad;
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const id = state.nextMessageId++;
      store(p.chat_id, id, { from: bot, kind: 'text', text: p.text, markup: markupOf(p), replyTo: p.reply_parameters ? p.reply_parameters.message_id : null });
      return ok({ message_id: id, from: bot, chat: { id: Number(p.chat_id), type: 'private' }, date: 0, text: p.text });
    },
    forwardMessage: (p) => {
      const bad = reachable(p.chat_id);
      if (bad) return bad;
      if (p.reply_markup) return err(400, 'test: forwardMessage takes no reply_markup');
      const src = state.messages.get(k(p.from_chat_id, p.message_id));
      if (!src) return err(400, 'Bad Request: message to forward not found');
      if (src.kind === 'service') return err(400, "Bad Request: message can't be forwarded");
      const id = state.nextMessageId++;
      const sender = state.users.get(Number(src.from && src.from.id));
      const origin = sender && sender.hidden
        ? { type: 'hidden_user', sender_user_name: sender.first_name, date: 0 }
        : { type: 'user', sender_user: src.from, date: 0 };
      store(p.chat_id, id, { from: bot, kind: src.kind, text: src.text, forwardOrigin: origin, source: k(p.from_chat_id, p.message_id) });
      return ok({ message_id: id, from: bot, chat: { id: Number(p.chat_id), type: 'private' }, date: 0, forward_origin: origin });
    },
    copyMessage: (p) => {
      const bad = reachable(p.chat_id) || checkReply(p);
      if (bad) return bad;
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const src = state.messages.get(k(p.from_chat_id, p.message_id));
      if (!src) return err(400, 'Bad Request: message to copy not found');
      if (src.kind === 'service' || src.kind === 'quiz') return err(400, "Bad Request: the message can't be copied");
      const id = state.nextMessageId++;
      store(p.chat_id, id, {
        from: bot, kind: src.kind, text: src.text, markup: markupOf(p), source: k(p.from_chat_id, p.message_id),
        replyTo: p.reply_parameters && state.messages.has(k(p.chat_id, p.reply_parameters.message_id)) ? p.reply_parameters.message_id : null,
      });
      return ok({ message_id: id });
    },
    answerCallbackQuery: (p) => {
      if (state.answeredCallbacks.has(p.callback_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      if (p.text && p.text.length > 200) return err(400, 'Bad Request: MESSAGE_TOO_LONG');
      state.answeredCallbacks.add(p.callback_query_id);
      return ok(true);
    },
    editMessageReplyMarkup: (p) => {
      const msg = state.messages.get(k(p.chat_id, p.message_id));
      if (!msg) return err(400, 'Bad Request: message to edit not found');
      if (Number(msg.from && msg.from.id) !== botId) return err(400, "Bad Request: message can't be edited");
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      if (JSON.stringify(msg.markup) === JSON.stringify(markupOf(p))) return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
      msg.markup = markupOf(p);
      return ok({ message_id: msg.message_id, chat: { id: msg.chat } });
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
    bot,
    store,
    get: (chat, id) => state.messages.get(k(chat, id)),
    /** The Message object Telegram would put in reply_to_message / callback_query.message. */
    messageObject(chat, id) {
      const m = state.messages.get(k(chat, id));
      if (!m) return null;
      const out = { message_id: m.message_id, from: m.from, chat: { id: m.chat, type: 'private' }, date: 0 };
      if (m.kind === 'text') out.text = m.text;
      else out[m.kind === 'quiz' ? 'poll' : m.kind] = m.kind === 'photo' ? [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] : { file_id: 'f' };
      if (m.forwardOrigin) out.forward_origin = m.forwardOrigin;
      if (m.markup) out.reply_markup = m.markup;
      return out;
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
