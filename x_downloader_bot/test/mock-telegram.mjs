// Minimal stand-in for the Telegram Bot API, enough to drive the bot end to end. It enforces the
// limits that matter here: 50 MB per uploaded file, 10 MB per photo, 20 MB when Telegram fetches a
// URL itself, 2-10 items per album, known file_ids only, and unknown / blocked chats.
import http from 'node:http';

const MB = 1024 * 1024;

export function createMockTelegram({ botId }) {
  const state = {
    calls: [],
    nextMessageId: 1000,
    nextFile: 1,
    files: new Map(), // file_id -> { kind, size }
    chats: new Map(), // '@name' (lowercase) -> { id, title, username, type }
    botAdmin: new Set(), // chat keys where the bot is admin
    members: new Map(), // `${chatKey}:${userId}` -> ChatMember fields
    users: new Set(), // private chats that exist (users who started the bot)
    blocked: new Set(), // users who blocked the bot (403)
    rateLimitOnce: new Set(), // chat ids whose next copyMessage gets a 429
    urlFails: false, // Telegram can't fetch URLs
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

  function chatCheck(chatId) {
    const id = Number(chatId);
    if (state.blocked.has(id)) return err(403, 'Forbidden: bot was blocked by the user');
    if (!state.users.has(id)) return err(400, 'Bad Request: chat not found');
    return null;
  }

  /** A file parameter -> { fileId, size } or an error. */
  function takeFile(v, kind) {
    if (v && v.__file) {
      const limit = kind === 'photo' ? 10 * MB : 50 * MB;
      if (v.__file.size > limit) return { error: kind === 'photo' ? err(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS') : err(413, 'Request Entity Too Large') };
      const fileId = `${kind.toUpperCase()}_${state.nextFile++}`;
      state.files.set(fileId, { kind, size: v.__file.size });
      return { fileId, size: v.__file.size, how: 'upload' };
    }
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      if (state.urlFails) return { error: err(400, 'Bad Request: failed to get HTTP URL content') };
      const fileId = `${kind.toUpperCase()}_${state.nextFile++}`;
      state.files.set(fileId, { kind, size: 0 });
      return { fileId, size: 0, how: 'url' };
    }
    if (typeof v === 'string' && state.files.has(v)) return { fileId: v, size: state.files.get(v).size, how: 'file_id' };
    return { error: err(400, 'Bad Request: wrong file identifier/HTTP URL specified') };
  }

  function mediaObject(kind, f) {
    const base = { file_id: f.fileId, file_unique_id: `U${f.fileId}`, file_size: f.size };
    if (kind === 'photo') return { photo: [{ ...base, file_id: `${f.fileId}_s`, width: 90, height: 60 }, { ...base, width: 1280, height: 853 }] };
    return { [kind]: base };
  }

  const message = (chatId, extra) => ({ message_id: state.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: 'private' }, ...extra });

  function sendFile(kind) {
    return (p) => {
      const bad = chatCheck(p.chat_id);
      if (bad) return bad;
      const f = takeFile(p[kind], kind);
      if (f.error) return f.error;
      return ok(message(p.chat_id, { ...mediaObject(kind, f), ...(p.caption ? { caption: p.caption } : {}) }));
    };
  }

  const handlers = {
    getMe: () => ok({ id: botId, is_bot: true, first_name: 'XDownloader', username: 'x_downloader_test_bot' }),
    answerCallbackQuery: () => ok(true),
    sendChatAction: (p) => chatCheck(p.chat_id) || ok(true),
    getChat: (p) => {
      const c = state.chats.get(key(p.chat_id));
      return c ? ok({ ...c }) : err(400, 'Bad Request: chat not found');
    },
    getChatMember: (p) => {
      const k = key(p.chat_id);
      if (!state.chats.has(k)) return err(400, 'Bad Request: chat not found');
      if (Number(p.user_id) === botId) return ok({ status: state.botAdmin.has(k) ? 'administrator' : 'left', user: { id: botId } });
      if (!state.botAdmin.has(k)) return err(400, 'Bad Request: member list is inaccessible');
      const m = state.members.get(`${k}:${p.user_id}`);
      // Like the real Bot API (seen in the cloud tests): an id Telegram doesn't know in that chat.
      if (!m && !state.users.has(Number(p.user_id))) return err(400, 'Bad Request: member not found');
      if (!m) return ok({ status: 'left', user: { id: Number(p.user_id) } });
      return ok({ ...m, user: { id: Number(p.user_id) } });
    },
    sendMessage: (p) => chatCheck(p.chat_id) || ok(message(p.chat_id, { text: p.text })),
    editMessageText: (p) => ok(message(p.chat_id, { message_id: p.message_id, text: p.text })),
    deleteMessage: () => ok(true),
    copyMessage: (p) => {
      const chat = Number(p.chat_id);
      if (state.rateLimitOnce.delete(chat)) return err(429, 'Too Many Requests: retry after 3', { retry_after: 3 });
      const bad = chatCheck(chat);
      if (bad) return bad;
      return ok({ message_id: state.nextMessageId++ });
    },
    sendVideo: sendFile('video'),
    sendAnimation: sendFile('animation'),
    sendPhoto: sendFile('photo'),
    sendDocument: sendFile('document'),
    sendMediaGroup: (p) => {
      const bad = chatCheck(p.chat_id);
      if (bad) return bad;
      if (!Array.isArray(p.media) || p.media.length < 2 || p.media.length > 10) return err(400, 'Bad Request: wrong number of media in the album');
      const out = [];
      for (const m of p.media) {
        const f = takeFile(m.media, m.type);
        if (f.error) return f.error;
        out.push(message(p.chat_id, { ...mediaObject(m.type, f), media_group_id: 'G1', ...(m.caption ? { caption: m.caption } : {}) }));
      }
      return ok(out);
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
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
