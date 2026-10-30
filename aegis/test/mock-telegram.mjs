// A strict stand-in for the Telegram Bot API, enough to drive Aegis end to end. It keeps every chat's
// messages, knows channel/group membership and where the bot is an admin, and rejects what Telegram
// rejects: writing to a user who hasn't started the bot or blocked it (403), bad HTML, empty or
// too-long text, callback_data over 64 bytes, buttons without exactly one action, web_app buttons
// outside private chats, editing a missing message, "message is not modified", answering a button
// twice, copying a message that doesn't exist. It can also inject 429s, kicked chats and group →
// supergroup migrations for the broadcast tests. Admins follow Telegram's rules: a chat has a
// creator and admins (each remembers who promoted it); promoteChatMember works only in supergroups
// and channels, needs the bot's can_promote_members, can grant only rights the bot has, and can
// edit or demote only admins the bot promoted itself (can_be_edited). Restrict/ban/unban need the bot's
// can_restrict_members, never touch admins (except ones the bot promoted, for bans), restrictions only in
// supergroups; sendDocument takes a real multipart upload; reply keyboards may ask for users or chats;
// deleteMessage removes a stored message (a member's only with the bot's can_delete_messages).
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
  if (markup.remove_keyboard === true) return null;
  if (Array.isArray(markup.keyboard)) {
    for (const row of markup.keyboard) {
      if (!Array.isArray(row) || !row.length) return 'keyboard row is empty';
      for (const b of row) {
        if (!b.text) return 'button text is empty';
        if (b.request_chat) {
          if (!privateChat) return 'BUTTON_TYPE_INVALID';
          if (!Number.isInteger(b.request_chat.request_id) || typeof b.request_chat.chat_is_channel !== 'boolean') return 'bad request_chat';
        }
        if (b.request_users) {
          if (!privateChat) return 'BUTTON_TYPE_INVALID';
          const r = b.request_users;
          if (!Number.isInteger(r.request_id)) return 'request_id must be an integer';
          if (r.max_quantity !== undefined && (r.max_quantity < 1 || r.max_quantity > 10)) return 'bad max_quantity';
        }
      }
    }
    return null;
  }
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

/* multipart/form-data → params; a file part becomes { filename, type, bytes }; other values JSON when they parse. */
export function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const sep = Buffer.from(`--${boundary}`);
  const out = {};
  let at = body.indexOf(sep);
  while (at >= 0) {
    const next = body.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = body.subarray(at + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString('utf8');
    const data = part.subarray(headEnd + 4);
    const name = /name="([^"]+)"/.exec(head)[1];
    const file = /filename="([^"]*)"/.exec(head);
    if (file) out[name] = { filename: file[1], type: (/Content-Type: (.+)/i.exec(head) || [])[1], bytes: Buffer.from(data) };
    else {
      const v = data.toString('utf8');
      try {
        out[name] = JSON.parse(v);
      } catch {
        out[name] = v;
      }
    }
    at = next;
  }
  return out;
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
  const RIGHTS = ['can_manage_chat', 'can_change_info', 'can_post_messages', 'can_edit_messages', 'can_delete_messages', 'can_invite_users',
    'can_restrict_members', 'can_pin_messages', 'can_manage_topics', 'can_promote_members', 'can_manage_video_chats', 'can_post_stories',
    'can_edit_stories', 'can_delete_stories'];
  function botMember(c) {
    if (c.kicked) return { status: 'kicked', user: bot };
    if (c.botAdmin) return { status: 'administrator', user: bot, can_be_edited: false, ...(c.botRights || {}) };
    return { status: c.type === 'channel' ? 'left' : 'member', user: bot };
  }
  function memberOf(c, userId) {
    const id = Number(userId);
    if (id === botId) return botMember(c);
    const a = c.admins && c.admins.get(id);
    if (a && a.status === 'creator') return { status: 'creator', user: a.user, is_anonymous: false };
    if (a) return { status: 'administrator', user: a.user, can_be_edited: a.promotedBy === botId, is_anonymous: false, ...a.rights };
    const user = (c.people && c.people.get(id)) || { id, is_bot: false, first_name: `User ${id}` };
    const now = Math.floor(Date.now() / 1000);
    const ban = c.banned && c.banned.get(id);
    if (ban !== undefined && (!ban || ban > now)) return { status: 'kicked', user, until_date: ban || 0 };
    const r = c.restricted && c.restricted.get(id);
    if (r && (!r.until || r.until > now)) return { status: 'restricted', user, is_member: c.members.has(id), until_date: r.until || 0, ...r.permissions };
    if (c.members.has(id)) return { status: 'member', user };
    return { status: 'left', user };
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
      const ct = Number(p.chat_id) > 0 ? 'private' : ((state.chats.get(Number(p.chat_id)) || {}).type || 'supergroup');
      return ok({ message_id: id, from: bot, chat: { id: Number(p.chat_id), type: ct }, date: 0, text: p.text });
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
      if (Number(p.user_id) === botId) return ok(botMember(c));
      if (c.broken || (c.type === 'channel' && !c.botAdmin)) return err(400, 'Bad Request: member list is inaccessible');
      if (!Number.isSafeInteger(Number(p.user_id)) || Number(p.user_id) <= 0) return err(400, 'Bad Request: invalid user_id specified');
      return ok(memberOf(c, p.user_id));
    },
    getChatAdministrators: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      if (c.kicked || (c.type === 'channel' && !c.botAdmin)) return err(400, 'Bad Request: CHAT_ADMIN_REQUIRED');
      const list = [];
      for (const id of (c.admins || new Map()).keys()) list.push(memberOf(c, id));
      if (c.botAdmin) list.push(botMember(c));
      return ok(list);
    },
    promoteChatMember: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      if (c.type !== 'supergroup' && c.type !== 'channel') return err(400, 'Bad Request: method is available for supergroup and channel chats only');
      if (!c.botAdmin || !(c.botRights || {}).can_promote_members) return err(400, 'Bad Request: not enough rights');
      const id = Number(p.user_id);
      const cur = c.admins.get(id);
      if (cur && cur.status === 'creator') return err(400, "Bad Request: can't change chat owner");
      if (cur && cur.promotedBy !== botId) return err(400, 'Bad Request: CHAT_ADMIN_REQUIRED');
      if (!cur && !c.members.has(id)) return err(400, 'Bad Request: USER_NOT_PARTICIPANT');
      const rights = {};
      for (const r of RIGHTS) if (p[r] === true) rights[r] = true;
      for (const r of Object.keys(rights)) if (r !== 'can_manage_chat' && !(c.botRights || {})[r]) return err(400, 'Bad Request: RIGHT_FORBIDDEN');
      const granting = Object.keys(rights).filter((r) => r !== 'can_manage_chat');
      if (!granting.length && !rights.can_manage_chat) {
        c.admins.delete(id);
        c.members.add(id);
        return ok(true);
      }
      const user = (cur && cur.user) || (c.people && c.people.get(id)) || { id, is_bot: false, first_name: `User ${id}` };
      c.admins.set(id, { status: 'administrator', user, rights, promotedBy: botId });
      return ok(true);
    },
    setMyDefaultAdministratorRights: (p) => {
      const r = p.rights || {};
      for (const f of ['is_anonymous', 'can_manage_chat', 'can_delete_messages', 'can_manage_video_chats', 'can_restrict_members', 'can_promote_members',
        'can_change_info', 'can_invite_users', 'can_post_stories', 'can_edit_stories', 'can_delete_stories']) {
        if (typeof r[f] !== 'boolean') return err(400, `Bad Request: field "${f}" must be a boolean`);
      }
      state.defaultRights = state.defaultRights || {};
      state.defaultRights[p.for_channels ? 'channel' : 'group'] = r;
      return ok(true);
    },
    restrictChatMember: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      if (c.type !== 'supergroup') return err(400, 'Bad Request: method is available only for supergroups');
      if (!c.botAdmin || !(c.botRights || {}).can_restrict_members) return err(400, 'Bad Request: not enough rights to restrict/unrestrict chat member');
      const id = Number(p.user_id);
      if (id === botId) return err(400, "Bad Request: can't restrict self");
      if (c.admins.has(id)) return err(400, 'Bad Request: user is an administrator of the chat');
      if (!p.permissions || typeof p.permissions !== 'object') return err(400, 'Bad Request: permissions are required');
      c.restricted = c.restricted || new Map();
      const perms = Object.entries(p.permissions);
      if (perms.length && perms.every(([, v]) => v === true)) c.restricted.delete(id);
      else c.restricted.set(id, { permissions: p.permissions, until: Number(p.until_date) || 0 });
      return ok(true);
    },
    banChatMember: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      if (!c.botAdmin || !(c.botRights || {}).can_restrict_members) return err(400, 'Bad Request: not enough rights to restrict/unrestrict chat member');
      const id = Number(p.user_id);
      if (id === botId) return err(400, "Bad Request: can't remove self");
      const a = c.admins.get(id);
      if (a && (a.status === 'creator' || a.promotedBy !== botId)) return err(400, 'Bad Request: user is an administrator of the chat');
      if (a) c.admins.delete(id);
      c.banned = c.banned || new Map();
      c.banned.set(id, Number(p.until_date) || 0);
      c.members.delete(id);
      state.bans = (state.bans || 0) + 1;
      return ok(true);
    },
    unbanChatMember: (p) => {
      const c = chat(p.chat_id);
      if (!c) return err(400, 'Bad Request: chat not found');
      if (!c.botAdmin || !(c.botRights || {}).can_restrict_members) return err(400, 'Bad Request: not enough rights to restrict/unrestrict chat member');
      const id = Number(p.user_id);
      if (c.admins.has(id)) return err(400, 'Bad Request: user is an administrator of the chat');
      if (c.banned && c.banned.has(id)) c.banned.delete(id);
      else if (!p.only_if_banned) c.members.delete(id);
      return ok(true);
    },
    deleteMessage: (p) => {
      const msg = state.messages.get(k(p.chat_id, p.message_id));
      if (!msg) return err(400, 'Bad Request: message to delete not found');
      const c = Number(p.chat_id) < 0 ? chat(p.chat_id) : null;
      if (c && msg.from && msg.from.id !== botId && !(c.botAdmin && (c.botRights || {}).can_delete_messages)) return err(400, "Bad Request: message can't be deleted");
      state.messages.delete(k(p.chat_id, p.message_id));
      state.deleted = state.deleted || [];
      state.deleted.push(k(p.chat_id, p.message_id));
      return ok(true);
    },
    editMessageReplyMarkup: (p) => {
      const msg = state.messages.get(k(p.chat_id, p.message_id));
      if (!msg) return err(400, 'Bad Request: message to edit not found');
      if (msg.from && msg.from.id !== botId) return err(400, "Bad Request: message can't be edited");
      const m = checkMarkup(p.reply_markup, { privateChat: Number(p.chat_id) > 0 });
      if (m) return err(400, `Bad Request: ${m}`);
      const next = markupOf(p);
      const norm = (x) => JSON.stringify(x && x.inline_keyboard && x.inline_keyboard.length ? x : null);
      if (norm(msg.markup) === norm(next)) return err(400, 'Bad Request: message is not modified');
      msg.markup = next;
      return ok({ message_id: msg.message_id });
    },
    sendDocument: (p) => {
      const bad = reachable(p.chat_id);
      if (bad) return bad;
      const doc = p.document;
      if (!doc || !doc.filename || !doc.bytes) return err(400, 'Bad Request: there is no document in the request');
      if (p.caption && p.caption.length > 1024) return err(400, 'Bad Request: message caption is too long');
      const id = store(p.chat_id, { kind: 'document', caption: p.caption, document: { file_name: doc.filename, mime_type: doc.type, bytes: doc.bytes } });
      return ok({ message_id: id, chat: { id: Number(p.chat_id) }, date: 0, document: { file_name: doc.filename, mime_type: doc.type, file_size: doc.bytes.length } });
    },
    getWebhookInfo: () => ok({ url: 'https://cloud.telegram.org/app1/webhook', has_custom_certificate: false, pending_update_count: state.pendingUpdates || 0 }),
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
      const body = Buffer.concat(chunks);
      const type = String(req.headers['content-type'] || '');
      const params = type.startsWith('multipart/form-data') ? parseMultipart(body, type) : JSON.parse(body.toString('utf8') || '{}');
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
      const full = { members: new Set(), admins: new Map(), people: new Map(), botAdmin: true, ...c };
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
      const type = m.chat > 0 ? 'private' : ((state.chats.get(m.chat) || {}).type || 'supergroup');
      return { message_id: m.message_id, from: m.from, chat: { id: m.chat, type }, date: 0, text: m.plain, ...(m.markup ? { reply_markup: m.markup } : {}) };
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
