// End-to-end harness: a fresh in-memory database with the real schema, the fake Telegram as the
// Bot API, a controllable clock, and helpers that call the real handlers the way the platform does.
// (Adapted from wanger-music tests/helpers/harness.mjs.)
import * as schema from '../../tgcloud/schema.js';
import { setupDatabase, rawDatabase } from '../sdk/db.mjs';
import { setApiHandler } from '../sdk/api.mjs';
import { createFakeTelegram, buttons, BOT_ID } from './fake-telegram.mjs';
import messageHandler from '../../tgcloud/handlers/message.js';
import callbackHandler from '../../tgcloud/handlers/callback_query.js';
import myChatMemberHandler from '../../tgcloud/handlers/my_chat_member.js';

export const OWNER = 5557901897;
export const SEED = [-1002407928564, -1001816009903, -1001910797391];
export const PUB_CHANNEL = -1009999999999;

const realNow = Date.now.bind(Date);
let offsetMs = 0;
export const advance = (seconds) => { offsetMs += seconds * 1000; };

export const logs = [];
console.log = (...a) => logs.push(['log', a.join(' ')]);
console.warn = (...a) => logs.push(['warn', a.join(' ')]);
console.error = (...a) => logs.push(['error', a.join(' ')]);

/** @param {{botAdminIn?: number[], settings?: Record<string, any>}} [opts] */
export function setup({ botAdminIn = SEED, settings = {} } = {}) {
  offsetMs = 0;
  logs.length = 0;
  // a fixed time of day (10:00 Tehran) so the daily summary timing is deterministic
  const base = Date.UTC(2026, 10, 12, 6, 30, 0);
  offsetMs = base - realNow();
  Date.now = () => realNow() + offsetMs;
  setupDatabase(schema);
  const db = rawDatabase();
  const put = (k, v) => db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, 0, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
  put('notify.daily', false);
  for (const [k, v] of Object.entries(settings)) put(k, v);
  const tg = createFakeTelegram({ now: () => Math.floor(Date.now() / 1000) });
  setApiHandler(tg.handler);
  tg.addChannel({ id: SEED[0], username: 'HIDE_i_SEEK', title: 'HIDE & SEEK', botAdmin: botAdminIn.includes(SEED[0]) });
  tg.addChannel({ id: SEED[1], username: 'Nepenthw_ir', title: 'Nepenthe', botAdmin: botAdminIn.includes(SEED[1]) });
  tg.addChannel({ id: SEED[2], username: 'wangerBots', title: 'Wanger bots', botAdmin: botAdminIn.includes(SEED[2]) });
  let updateId = 1;
  let msgId = 1;
  const person = (id, extra = {}) => ({ id, is_bot: false, first_name: `User${id}`, username: `user${id}`, language_code: 'fa', ...extra });

  const h = {
    tg,
    db,
    q: (text, ...params) => db.prepare(text).all(...params),
    one: (text, ...params) => db.prepare(text).get(...params),
    person,
    /** Makes a user a member of every seed channel. */
    join(userId, channels = SEED) {
      for (const c of channels) tg.setMember(c, userId);
    },
    /** A private message; returns the handler result. */
    async send(fromId, text, extra = {}, fromExtra = {}) {
      advance(1); // a person needs a second per action (keeps the flood limiter realistic)
      const message = { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: fromId, type: 'private' }, from: person(fromId, fromExtra), ...(text !== null ? { text } : {}), ...extra };
      return messageHandler(message, { update: { update_id: updateId++, message } });
    },
    sendSticker: (fromId, sticker) => h.send(fromId, null, { sticker }),
    /** Presses a button with this data on a given message (or none). */
    async press(fromId, data, messageId = null) {
      advance(1);
      const stored = messageId ? tg.message(fromId, messageId) : null;
      const cq = { id: `cq${updateId}`, from: person(fromId), chat_instance: 'x', data, ...(messageId ? { message: { message_id: messageId, chat: { id: fromId, type: 'private' }, date: 0, ...(stored && stored.sticker ? { sticker: stored.sticker } : {}), ...(stored && stored.text ? { text: stored.text } : {}) } } : {}) };
      return callbackHandler(cq, { update: { update_id: updateId++, callback_query: cq } });
    },
    /** Presses the button with this callback_data on the newest message that has it. */
    async tap(fromId, data) {
      const msgs = tg.calls.filter((c) => c.result && ['sendMessage', 'editMessageText', 'sendSticker'].includes(c.method) && Number(c.params.chat_id) === fromId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (buttons(msgs[i].params).some((b) => b.callback_data === data)) {
          const id = msgs[i].method === 'editMessageText' ? msgs[i].params.message_id : msgs[i].result.message_id;
          return h.press(fromId, data, id);
        }
      }
      throw new Error(`no button ${data} for ${fromId}; last: ${JSON.stringify(h.lastButtons(fromId).map((b) => b.callback_data || b.url))}`);
    },
    /** First button whose callback_data starts with `prefix` on the user's latest messages. */
    findData(fromId, prefix) {
      const msgs = tg.calls.filter((c) => c.result && ['sendMessage', 'editMessageText', 'sendSticker'].includes(c.method) && Number(c.params.chat_id) === fromId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const b = buttons(msgs[i].params).find((x) => x.callback_data && x.callback_data.startsWith(prefix));
        if (b) return b.callback_data;
      }
      return null;
    },
    async myChatMember(chat, fromId, newStatus, extra = {}) {
      const upd = { chat, from: person(fromId), date: 0, old_chat_member: { status: 'member', user: { id: BOT_ID } }, new_chat_member: { status: newStatus, user: { id: BOT_ID }, ...extra } };
      return myChatMemberHandler(upd, { update: { update_id: updateId++, my_chat_member: upd } });
    },
    lastText: (chatId) => { const c = tg.lastTo(chatId); return (c && c.params.text) || ''; },
    lastButtons: (chatId) => buttons(tg.lastTo(chatId) && tg.lastTo(chatId).params),
    texts: (chatId, from = 0) => tg.calls.slice(from).filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && Number(c.params.chat_id) === chatId).map((c) => c.params.text),
    mark: () => tg.calls.length,
    /** A user who picked Persian and joined every channel. */
    async ready(userId, lang = 'fa') {
      h.join(userId);
      await h.send(userId, '/start');
      await h.tap(userId, `l:set:${lang}`);
    },
  };
  return h;
}

export { buttons };
