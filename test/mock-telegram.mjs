// Minimal stand-in for the Telegram Bot API, enough to drive the bot end to end.
import { Buffer } from 'node:buffer';
import http from 'node:http';

export function createMockTelegram({ botId }) {
  const state = {
    calls: [],
    nextMessageId: 1000,
    chats: new Map(), // '@name' or '-100…' -> { id, title, username, type }
    botAdmin: new Set(), // chat keys where the bot is admin
    members: new Map(), // `${chatKey}:${userId}` -> status
    blocked: new Set(), // user ids that blocked the bot
    webhookUrl: '',
    failOnce: new Set(), // user ids whose next copyMessage gets a 429
  };

  const key = (chatId) => {
    const s = String(chatId);
    if (s.startsWith('@')) return s.toLowerCase();
    for (const [k, c] of state.chats) if (String(c.id) === s) return k;
    return s;
  };

  function addChannel(username, { title, admin = true, id } = {}) {
    const k = username.startsWith('@') ? username.toLowerCase() : username;
    const chat = { id: id ?? -1000000000000 - state.chats.size - 1, title: title || username.replace('@', ''), type: 'channel' };
    if (username.startsWith('@')) chat.username = username.slice(1);
    state.chats.set(k, chat);
    if (admin) state.botAdmin.add(k);
    return chat;
  }

  const ok = (result) => ({ ok: true, result });
  const err = (code, description) => ({ ok: false, error_code: code, description });

  const handlers = {
    getMe: () => ok({ id: botId, is_bot: true, first_name: 'TodoBot', username: 'todo_test_bot' }),
    setWebhook: (p) => {
      state.webhookUrl = p.url;
      return ok(true);
    },
    getWebhookInfo: () => ok({ url: state.webhookUrl, pending_update_count: 0 }),
    setMyCommands: () => ok(true),
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
      return ok({ status: state.members.get(`${k}:${p.user_id}`) || 'left', user: { id: p.user_id } });
    },
    createChatInviteLink: (p) => ok({ invite_link: `https://t.me/+generated${Math.abs(Number(p.chat_id) % 1000)}` }),
    sendMessage: (p) => {
      if (state.blocked.has(Number(p.chat_id))) return err(403, 'Forbidden: bot was blocked by the user');
      return ok({ message_id: state.nextMessageId++, chat: { id: p.chat_id }, text: p.text });
    },
    editMessageText: (p) => ok({ message_id: p.message_id, chat: { id: p.chat_id }, text: p.text }),
    copyMessage: (p) => {
      if (state.failOnce.delete(Number(p.chat_id))) return err(429, 'Too Many Requests: retry after 1');
      if (state.blocked.has(Number(p.chat_id))) return err(403, 'Forbidden: bot was blocked by the user');
      return ok({ message_id: state.nextMessageId++ });
    },
    sendDocument: (p) => ok({ message_id: state.nextMessageId++, document: { file_name: p.filename } }),
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      const raw = Buffer.concat(chunks).toString('utf8');
      let params = {};
      const type = req.headers['content-type'] || '';
      if (type.includes('application/json')) params = JSON.parse(raw || '{}');
      else if (type.includes('multipart/form-data')) {
        // Good enough for the fields this bot sends.
        for (const part of raw.split(/--[-\w]+/)) {
          const name = part.match(/name="([^"]+)"/);
          if (!name) continue;
          const file = part.match(/filename="([^"]+)"/);
          const body = part.split(/\r\n\r\n/).slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
          params[name[1]] = body;
          if (file) params.filename = file[1];
        }
      }
      const method = m?.[2];
      const handler = handlers[method];
      const result = handler ? handler(params) : err(404, `Not Found: method ${method} not mocked`);
      state.calls.push({ token: m?.[1], method, params, result });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  return {
    state,
    addChannel,
    join: (chat, userId, status = 'member') => state.members.set(`${key(chat)}:${userId}`, status),
    leave: (chat, userId) => state.members.set(`${key(chat)}:${userId}`, 'left'),
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
