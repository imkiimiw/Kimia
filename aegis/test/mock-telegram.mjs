// A strict stand-in for the Telegram Bot API, enough to drive Aegis end to end. It keeps every chat's
// messages, knows channel/group membership and where the bot is an admin, and rejects what Telegram
// rejects: writing to a user who hasn't started the bot or blocked it (403), bad HTML, empty or
// too-long text, callback_data over 64 bytes, buttons without exactly one action, web_app buttons
// outside private chats, editing a missing message, "message is not modified", answering a button
// twice, copying a message that doesn't exist. It can also inject 429s, kicked chats and group →
// supergroup migrations for the broadcast tests.
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

export function checkMarkup(markup, { privateChat = true } = {}) {
  if (!markup) return null;
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) return 'reply markup is not an inline keyboard';
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) return 'keyboard row is empty';
    for (const b of row) {
      if (!b.text) return 'button text is empty';
      const kinds = ['callback_data', 'url', 'web_app', 'switch_inline_query'].filter((k) => b[k] !== undefined);
      if (kinds.length !== 1) return `button "${b.text}" must have exactly one action`;
      if (b.callback_data !== undefined && (!b.callback_data || Buffer.byteLength(b.callback_data, 'utf8') > 64)) return 'BUTTON_DATA_INVALID';
      if (b.web_app && !privateChat) return 'BUTTON_TYPE_INVALID';
      if (b.web_app && !/^https:\/\//.test(b.web_app.url)) return 'BUTTON_URL_INVALID';
      if (b.url !== undefined && !/^(https?|tg):\/\//.test(b.url)) return 'BUTTON_URL_INVALID';
    }
  }
  return null;
}

export function createMockTelegram({ botId, botUsername = 'aegis_test_bot' }) {
  const bot = { id: botId, is_bot: true, first_name: 'Aegis', username: botUsername };
  const state = {
    calls: [],
    nextMessageId: 5000,
    started: new Set(),
    blocked: new Set(),
    chats: new Map(), // id -> { id, type, title, username, members: Set, botAdmin, broken, kicked, migrateTo, count, inviteLink }
    messages: new Map(), // `${chat}:${id}` -> { chat, message_id, text, plain, markup, kind, from, forwardOf, copyOf }
    answered: new Set(),
    floodAfter: Infinity, // copy/forward calls to other chats allowed before one 429
    floodRetry: 3,
    sendsToOthers: 0,
    commands: [],
    failNext: new Map(), // method -> { code, description } for the next call
  };
  const k = (chat, id) => `${Number(chat)}:${Number(id)}`;
  const ok = (result) => ({ ok: true, result });
  const err = (code, description, parameters) => ({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });
  const markupOf = (p) => (p.reply_markup ? JSON.parse(JSON.stringify(p.reply_markup)) : null);

  function chat(ref) {
    if (typeof ref === 'string' && ref.startsWith('@')) {
      const key = ref.slice(1).toLowerCase();
      for (const c of state.chats.values()) if (c.username && c.username.toLowerCase() === key) return c;
      return null;
    }
    return state.chats.get(Number(ref)) || null;
  }
  function reachable(chatId) {
    const id = Number(chatId);
    if (id > 0) {
      if (state.blocked.has(id)) return err(403, 'Forbidden: bot was blocked by the user');
      if (!state.started.has(id)) return err(403, "Forbidden: bot can't initiate conversation with a user");
      return null;
    }
    const c = state.chats.get(id);
    if (!c) return err(400, 'Bad Request: chat not found');
    if (c.migrateTo) return err(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: c.migrateTo });
    if (c.kicked) return err(403, `Forbidden: bot was kicked from the ${c.type === 'channel' ? 'channel' : 'group'} chat`);
    return null;
  }
  function checkText(p) {
    if (typeof p.text !== 'string' || !p.text) return err(400, 'Bad Request: message text is empty');
    if (p.parse_mode === 'HTML') {
      const h = parseHtml(p.text);
      if (h.error) return err(400, `Bad Request: ${h.error}`);
      if (h.plain.length > 4096) return err(400, 'Bad Request: message is too long');
    } else if (p.text.length > 4096) return err(400, 'Bad Request: message is too long');
    return null;
  }
  const plainOf = (p) => (p.parse_mode === 'HTML' ? parseHtml(p.text).plain : p.text);
  function store(chatId, fields) {
    const id = state.nextMessageId++;
    state.messages.set(k(chatId, id), { chat: Number(chatId), message_id: id, from: bot, ...fields });
    return id;
  }
  function flood(p) {
    if (Number(p.chat_id) === Number(p.from_chat_id)) return null;
    state.sendsToOthers += 1;
    if (state.sendsToOthers > state.floodAfter) {
      state.floodAfter = Infinity;
      return err(429, `Too Many Requests: retry after ${state.floodRetry}`, { retry_after: state.floodRetry });
    }
    return null;
  }

  const handlers = {
    getMe: () => ok(bot),
    setMyCommands: (p) => {
      if (!Array.isArray(p.commands) || !p.commands.length) return err(400, 'Bad Request: commands must be non-empty');
      for (const c of p.commands) {
        if (!/^[a-z0-9_]{1,32}$/.test(c.command)) return err(400, 'Bad Request: BOT_COMMAND_INVALID');
        if (!c.description || c.description.length > 256) return err(400, 'Bad Request: BOT_COMMAND_DESCRIPTION_INVALID');
      }
      if (p.scope && p.scope.type === 'chat' && !state.started.has(Number(p.scope.chat_id))) return err(400, 'Bad Request: chat not found');
      state.commands.push(p);
      return ok(true);
    },
    sendMessage: (p) => {
      const bad = reachable(p.chat_id) || checkText(p);
      if (bad) return bad;
      const m = checkMarkup(p.reply_markup, { privateChat: Number(p.chat_id) > 0 });
      if (m) return err(400, `Bad Request: ${m}`);
      const id = store(p.chat_id, { text: p.text, plain: plainOf(p), markup: markupOf(p), kind: 'text' });
      return ok({ message_id: id, from: bot, chat: { id: Number(p.chat_id), type: Number(p.chat_id) > 0 ? 'private' : 'supergroup' }, date: 0, text: p.text });
    },
    copyMessage: (p) => {
      const bad = reachable(p.chat_id) || flood(p);
      if (bad) return bad;
      const src = state.messages.get(k(p.from_chat_id, p.message_id));
      if (!src) return err(400, 'Bad Request: message to copy not found');
      const m = checkMarkup(p.reply_markup, { privateChat: Number(p.chat_id) > 0 });
      if (m) return err(400, `Bad Request: ${m}`);
      const id = store(p.chat_id, { text: src.text, plain: src.plain, kind: src.kind, markup: markupOf(p), copyOf: k(p.from_chat_id, p.message_id) });
      return ok({ message_id: id });
    },
    forwardMessage: (p) => {
      const bad = reachable(p.chat_id) || flood(p);
      if (bad) return bad;
      const src = state.messages.get(k(p.from_chat_id, p.message_id));
      if (!src) return err(400, 'Bad Request: message to forward not found');
      const id = store(p.chat_id, { text: src.text, plain: src.plain, kind: src.kind, markup: null, forwardOf: k(p.from_chat_id, p.message_id) });
      return ok({ message_id: id, chat: { id: Number(p.chat_id) }, date: 0 });
    },
    editMessageText: (p) => {
      const msg = state.messages.get(k(p.chat_id, p.message_id));
      if (!msg) return err(400, 'Bad Request: message to edit not found');
      if (msg.from && msg.from.id !== botId) return err(400, "Bad Request: message can't be edited");
      if (msg.kind !== 'text') return err(400, 'Bad Request: there is no text in the message to edit');
      const bad = checkText(p);
      if (bad) return bad;
      const m = checkMarkup(p.reply_markup, { privateChat: Number(p.chat_id) > 0 });
      if (m) return err(400, `Bad Request: ${m}`);
      const newMarkup = markupOf(p);
      const same = (a, b) => JSON.stringify(a && a.inline_keyboard && a.inline_keyboard.length ? a : null) === JSON.stringify(b && b.inline_keyboard && b.inline_keyboard.length ? b : null);
      if (msg.text === p.text && same(msg.markup, newMarkup)) {
        return err(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
      }
      msg.text = p.text;
      msg.plain = plainOf(p);
      msg.markup = newMarkup;
      return ok({ message_id: msg.message_id });
    },
    answerCallbackQuery: (p) => {
      if (state.answered.has(p.callback_query_id)) return err(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
      if (p.text && p.text.length > 200) return err(400, 'Bad Request: MESSAGE_TOO_LONG');
      state.answered.add(p.callback_query_id);
      return ok(true);
    },
    getChatMember: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      if (Number(p.user_id) === botId) return ok({ status: c.kicked ? 'kicked' : (c.botAdmin ? 'administrator' : 'left'), user: bot });
      if (c.broken || (c.type === 'channel' && !c.botAdmin)) return err(400, 'Bad Request: member list is inaccessible');
      return ok({ status: c.members.has(Number(p.user_id)) ? 'member' : 'left', user: { id: Number(p.user_id) } });
    },
    getChat: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      return ok({ id: c.id, type: c.type, title: c.title, ...(c.username ? { username: c.username } : {}), ...(c.inviteLink && c.botAdmin ? { invite_link: c.inviteLink } : {}) });
    },
    getChatMemberCount: (p) => {
      const bad = reachable(p.chat_id);
      if (bad) return bad;
      const c = chat(p.chat_id);
      return ok(c.count !== undefined ? c.count : c.members.size);
    },
    exportChatInviteLink: (p) => {
      const c = chat(p.chat_id);
      if (!c || !c.botAdmin) return err(400, 'Bad Request: not enough rights to manage chat invite link');
      return ok(`https://t.me/+inv${Math.abs(c.id)}`);
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const method = m && m[2];
      let result;
      if (state.failNext.has(method)) {
        const f = state.failNext.get(method);
        state.failNext.delete(method);
        result = err(f.code, f.description, f.parameters);
      } else {
        const handler = handlers[method];
        result = handler ? handler(params) : err(404, `Not Found: method ${method} not mocked`);
      }
      state.calls.push({ method, params, result });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  return {
    state,
    bot,
    addChat(c) {
      const full = { members: new Set(), botAdmin: true, ...c };
      state.chats.set(c.id, full);
      return full;
    },
    get: (chatId, id) => state.messages.get(k(chatId, id)),
    /** A message the user sent (so the bot can copy or forward it). */
    userMessage(chatId, id, fields) {
      state.messages.set(k(chatId, id), { chat: chatId, message_id: id, from: { id: chatId }, kind: 'text', ...fields });
    },
    deleteMessage(chatId, id) {
      state.messages.delete(k(chatId, id));
    },
    messageObject(chatId, id) {
      const m = state.messages.get(k(chatId, id));
      if (!m) return null;
      return { message_id: m.message_id, from: m.from, chat: { id: m.chat, type: m.chat > 0 ? 'private' : 'supergroup' }, date: 0, text: m.plain, ...(m.markup ? { reply_markup: m.markup } : {}) };
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
