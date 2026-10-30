// A strict stand-in for the Telegram Bot API, enough to drive the game bot end to end. It keeps every
// chat's messages and every inline message, knows who is a member of which channel and where the bot
// is an admin, and rejects what Telegram rejects: writing to a user who hasn't started the bot or
// blocked it (403), bad HTML, empty or too-long text, callback_data over 64 bytes, a button without
// exactly one action, web_app buttons in inline results, editing a missing message, "message is not
// modified", answering a button twice, malformed inline results and inline buttons.
import { Buffer } from 'node:buffer';
import http from 'node:http';

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote', 'span']);

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
      if (!ALLOWED_TAGS.has(name)) return { error: `can't parse entities: unsupported start tag "${name}"` };
      if (close) {
        if (stack.pop() !== name) return { error: `can't parse entities: unmatched end tag "${name}"` };
      } else stack.push(name);
      i = end + 1;
    } else if (ch === '&') {
      const m = /^&(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i.exec(s.slice(i));
      if (!m) return { error: `can't parse entities: unsupported entity at byte offset ${i}` };
      plain += { lt: '<', gt: '>', amp: '&', quot: '"' }[m[1].toLowerCase()] || '?';
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

function checkMarkup(markup, { inline = false } = {}) {
  if (!markup) return null;
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) return 'reply markup is not an inline keyboard';
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) return 'keyboard row is empty';
    for (const b of row) {
      if (!b.text) return 'button text is empty';
      const kinds = ['callback_data', 'url', 'web_app', 'switch_inline_query', 'switch_inline_query_current_chat'].filter((k) => b[k] !== undefined);
      if (kinds.length !== 1) return `button "${b.text}" must have exactly one action`;
      if (b.callback_data !== undefined && (!b.callback_data || Buffer.byteLength(b.callback_data, 'utf8') > 64)) return 'BUTTON_DATA_INVALID';
      if (b.web_app && inline) return 'BUTTON_TYPE_INVALID'; // web_app buttons can't be sent in inline messages
      if (b.url !== undefined && !/^(https?|tg):\/\//.test(b.url)) return 'BUTTON_URL_INVALID';
      if (b.url && /startapp=/.test(b.url)) {
        const p = /startapp=([^&]*)/.exec(b.url)[1];
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(p)) return 'bad startapp parameter';
      }
    }
  }
  return null;
}

export function createMockTelegram({ botId, botUsername = 'game_test_bot' }) {
  const bot = { id: botId, is_bot: true, first_name: 'Games', username: botUsername };
  const state = {
    calls: [],
    nextMessageId: 5000,
    started: new Set(),
    blocked: new Set(),
    channels: new Map(), // username(lower) or id -> { id, title, username, type, members: Set, botAdmin: bool, broken: bool }
    messages: new Map(), // `${chat}:${id}` | `inline:${id}` -> { text, plain, markup, from }
    answered: new Set(),
    inlineAnswers: new Map(),
    nextInline: 1,
    floodAfter: Infinity, // copyMessage calls allowed before a 429
  };
  const k = (chat, id) => `${Number(chat)}:${Number(id)}`;
  const ok = (result) => ({ ok: true, result });
  const err = (code, description, parameters) => ({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });
  const markupOf = (p) => (p.reply_markup ? JSON.parse(JSON.stringify(p.reply_markup)) : null);

  function reachable(chatId) {
    const id = Number(chatId);
    if (state.blocked.has(id)) return err(403, 'Forbidden: bot was blocked by the user');
    if (id > 0 && !state.started.has(id)) return err(403, "Forbidden: bot can't initiate conversation with a user");
    return null;
  }
  function checkText(p) {
    if (typeof p.text !== 'string' || !p.text) return err(400, 'Bad Request: message text is empty');
    if (p.parse_mode === 'HTML') {
      const h = parseHtml(p.text);
      if (h.error) return err(400, `Bad Request: ${h.error}`);
      if (h.plain.length > 4096) return err(400, 'Bad Request: message is too long');
    }
    return null;
  }
  const plainOf = (p) => (p.parse_mode === 'HTML' ? parseHtml(p.text).plain : p.text);
  function channel(ref) {
    const key = typeof ref === 'string' ? ref.replace(/^@/, '').toLowerCase() : Number(ref);
    for (const ch of state.channels.values()) if ((ch.username && ch.username.toLowerCase() === key) || ch.id === key) return ch;
    return null;
  }
  function store(chat, fields) {
    const id = state.nextMessageId++;
    state.messages.set(k(chat, id), { chat: Number(chat), message_id: id, from: bot, ...fields });
    return id;
  }

  const handlers = {
    getMe: () => ok(bot),
    sendMessage: (p) => {
      const bad = reachable(p.chat_id) || checkText(p);
      if (bad) return bad;
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const id = store(p.chat_id, { text: p.text, plain: plainOf(p), markup: markupOf(p) });
      return ok({ message_id: id, from: bot, chat: { id: Number(p.chat_id), type: 'private' }, date: 0, text: p.text });
    },
    copyMessage: (p) => {
      const bad = reachable(p.chat_id);
      if (bad) return bad;
      if (p.chat_id !== p.from_chat_id) {
        state.copies = (state.copies || 0) + 1;
        if (state.copies > state.floodAfter) {
          state.floodAfter = Infinity;
          return err(429, 'Too Many Requests: retry after 3', { retry_after: 3 });
        }
      }
      const src = state.messages.get(k(p.from_chat_id, p.message_id));
      if (!src) return err(400, 'Bad Request: message to copy not found');
      if (src.kind === 'service') return err(400, "Bad Request: the message can't be copied");
      const m = checkMarkup(p.reply_markup);
      if (m) return err(400, `Bad Request: ${m}`);
      const id = store(p.chat_id, { text: src.text, plain: src.plain, markup: markupOf(p), copyOf: k(p.from_chat_id, p.message_id) });
      return ok({ message_id: id });
    },
    editMessageText: (p) => {
      const key = p.inline_message_id !== undefined ? `inline:${p.inline_message_id}` : k(p.chat_id, p.message_id);
      const msg = state.messages.get(key);
      if (!msg) return err(400, 'Bad Request: message to edit not found');
      if (msg.from && msg.from.id !== botId) return err(400, "Bad Request: message can't be edited");
      const bad = checkText(p);
      if (bad) return bad;
      const m = checkMarkup(p.reply_markup, { inline: p.inline_message_id !== undefined });
      if (m) return err(400, `Bad Request: ${m}`);
      if (msg.text === p.text && JSON.stringify(msg.markup) === JSON.stringify(markupOf(p))) {
        return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
      }
      msg.text = p.text;
      msg.plain = plainOf(p);
      msg.markup = markupOf(p);
      return ok(p.inline_message_id !== undefined ? true : { message_id: msg.message_id });
    },
    answerCallbackQuery: (p) => {
      if (state.answered.has(p.callback_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      if (p.text && p.text.length > 200) return err(400, 'Bad Request: MESSAGE_TOO_LONG');
      state.answered.add(p.callback_query_id);
      return ok(true);
    },
    answerInlineQuery: (p) => {
      if (!Array.isArray(p.results) || p.results.length > 50) return err(400, 'Bad Request: RESULTS_TOO_MUCH');
      if (p.button && (!p.button.text || (p.button.start_parameter !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(p.button.start_parameter)))) return err(400, 'Bad Request: bad button');
      const ids = new Set();
      for (const r of p.results) {
        if (r.type !== 'article' || !r.id || !r.title || Buffer.byteLength(r.id) > 64) return err(400, 'Bad Request: RESULT_ID_INVALID');
        if (ids.has(r.id)) return err(400, 'Bad Request: RESULT_ID_DUPLICATE');
        ids.add(r.id);
        const c = r.input_message_content;
        if (!c || !c.message_text) return err(400, 'Bad Request: MESSAGE_EMPTY');
        if (c.parse_mode === 'HTML' && parseHtml(c.message_text).error) return err(400, `Bad Request: ${parseHtml(c.message_text).error}`);
        const m = checkMarkup(r.reply_markup, { inline: true });
        if (m) return err(400, `Bad Request: ${m}`);
      }
      state.inlineAnswers.set(p.inline_query_id, p);
      return ok(true);
    },
    getChatMember: (p) => {
      const ch = channel(p.chat_id);
      if (!ch) return err(400, 'Bad Request: chat not found');
      if (ch.broken) return err(400, 'Bad Request: member list is inaccessible');
      if (Number(p.user_id) === botId) return ok({ status: ch.botAdmin ? 'administrator' : 'left', user: bot });
      if (!ch.botAdmin) return err(400, 'Bad Request: member list is inaccessible');
      return ok({ status: ch.members.has(Number(p.user_id)) ? 'member' : 'left', user: { id: Number(p.user_id) } });
    },
    getChat: (p) => {
      const ch = channel(p.chat_id);
      if (!ch) return err(400, 'Bad Request: chat not found');
      return ok({ id: ch.id, type: ch.type || 'channel', title: ch.title, ...(ch.username ? { username: ch.username } : {}) });
    },
    exportChatInviteLink: (p) => {
      const ch = channel(p.chat_id);
      if (!ch || !ch.botAdmin) return err(400, 'Bad Request: not enough rights');
      return ok(`https://t.me/+invite${Math.abs(ch.id)}`);
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
    addChannel(ch) {
      state.channels.set(ch.id, { members: new Set(), botAdmin: true, ...ch });
    },
    get: (chat, id) => state.messages.get(k(chat, id)),
    getInline: (id) => state.messages.get(`inline:${id}`),
    userMessage(chat, id, fields) {
      state.messages.set(k(chat, id), { chat, message_id: id, from: { id: chat }, ...fields });
    },
    chooseInline(queryId, resultId) {
      const r = state.inlineAnswers.get(queryId).results.find((x) => x.id === resultId);
      const id = `inl${state.nextInline++}`;
      const c = r.input_message_content;
      state.messages.set(`inline:${id}`, { inline: id, from: bot, text: c.message_text, plain: parseHtml(c.message_text).plain, markup: r.reply_markup });
      return id;
    },
    messageObject(chat, id) {
      const m = state.messages.get(k(chat, id));
      if (!m) return null;
      return { message_id: m.message_id, from: m.from, chat: { id: m.chat, type: 'private' }, date: 0, text: m.plain, ...(m.markup ? { reply_markup: m.markup } : {}) };
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
