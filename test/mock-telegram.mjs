// Minimal stand-in for the Telegram Bot API, enough to drive the bot end to end.
import { Buffer } from 'node:buffer';
import http from 'node:http';

export function createMockTelegram({ botId }) {
  const state = {
    calls: [],
    nextMessageId: 1000,
    chats: new Map(), // '@name' (lowercase) -> { id, title, username, type }
    botAdmin: new Set(), // chat keys where the bot is admin
    members: new Map(), // `${chatKey}:${userId}` -> ChatMember fields ({ status, is_member })
    unknownUsers: new Set(), // user ids Telegram doesn't know ("user not found")
    blocked: new Set(), // chat ids that blocked the bot
    rateLimitOnce: new Set(), // chat ids whose next copyMessage gets a 429
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
  const err = (code, description) => ({ ok: false, error_code: code, description });

  const handlers = {
    getMe: () => ok({ id: botId, is_bot: true, first_name: 'TodoBot', username: 'todo_test_bot' }),
    answerCallbackQuery: () => ok(true),
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
      if (state.blocked.has(Number(p.chat_id))) return err(403, 'Forbidden: bot was blocked by the user');
      return ok({ message_id: state.nextMessageId++, chat: { id: p.chat_id }, text: p.text });
    },
    copyMessage: (p) => {
      const chat = Number(p.chat_id);
      if (state.rateLimitOnce.delete(chat)) return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } };
      if (state.blocked.has(chat)) return err(403, 'Forbidden: bot was blocked by the user');
      if (state.unknownUsers.has(chat)) return err(400, 'Bad Request: chat not found');
      return ok({ message_id: state.nextMessageId++ });
    },
    editMessageText: (p) => ok({ message_id: p.message_id, chat: { id: p.chat_id }, text: p.text }),
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
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
