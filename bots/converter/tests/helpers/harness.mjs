// End-to-end harness: a fresh in-memory database with the real schema, the fake Telegram as the Bot
// API, a controllable clock, and helpers that call the real handlers the way the platform does.
import * as schema from '../../tgcloud/schema.js';
import { setupDatabase, rawDatabase } from '../sdk/db.mjs';
import { setApiHandler } from '../sdk/api.mjs';
import { createFakeTelegram, buttons } from './fake-telegram.mjs';
import messageHandler from '../../tgcloud/handlers/message.js';
import callbackHandler from '../../tgcloud/handlers/callback_query.js';
import myChatMemberHandler from '../../tgcloud/handlers/my_chat_member.js';

export const OWNER = 5557901897;
export const SEED = [-1002407928564, -1001816009903, -1001910797391];

const realNow = Date.now.bind(Date);
let offsetMs = 0;
export const advance = (seconds) => { offsetMs += seconds * 1000; };

/** Log lines written by the bot during a test (captured, not printed). */
export const logs = [];
console.log = (...a) => logs.push(['log', a.join(' ')]);
console.warn = (...a) => logs.push(['warn', a.join(' ')]);
console.error = (...a) => logs.push(['error', a.join(' ')]);

/**
 * setup({ botAdminIn, members }) — botAdminIn: channels where the bot is admin (default: all three);
 * members: user ids who joined all three channels.
 */
/** Every test starts at the same instant (rate limits use clock windows; counters use Tehran days). */
const START = Date.parse('2026-11-07T08:00:01Z'); // 11:30 in Tehran, a minute and an hour just began

export function setup({ botAdminIn = SEED, members = [] } = {}) {
  offsetMs = START - realNow();
  logs.length = 0;
  Date.now = () => realNow() + offsetMs;
  setupDatabase(schema);
  const tg = createFakeTelegram();
  setApiHandler(tg.handler);
  tg.addChannel({ id: SEED[0], username: 'HIDE_i_SEEK', title: 'HIDE & SEEK', botAdmin: botAdminIn.includes(SEED[0]) });
  tg.addChannel({ id: SEED[1], username: 'Nepenthw_ir', title: 'Nepenthe', botAdmin: botAdminIn.includes(SEED[1]) });
  tg.addChannel({ id: SEED[2], username: 'wangerBots', title: 'Wanger bots', botAdmin: botAdminIn.includes(SEED[2]) });
  for (const id of members) for (const ch of SEED) tg.setMember(ch, id);
  let updateId = 1;
  let msgId = 1;
  const person = (id, extra = {}) => ({ id, is_bot: false, first_name: `User${id}`, username: `user${id}`, language_code: 'fa', ...extra });

  const h = {
    tg,
    q: (text, ...params) => rawDatabase().prepare(text).all(...params),
    one: (text, ...params) => rawDatabase().prepare(text).get(...params),
    person,
    join: (userId) => { for (const ch of SEED) tg.setMember(ch, userId); },
    nextUpdateId: () => updateId,
    /** A private message (text or extra fields); returns the handler result. */
    async send(fromId, text, extra = {}, updateIdOverride) {
      const message = { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: fromId, type: 'private' }, from: person(fromId), ...(text !== null ? { text } : {}), ...extra };
      const update_id = updateIdOverride ?? updateId++;
      return messageHandler(message, { update: { update_id, message } });
    },
    /** Sends a document: bytes + name → handler result. */
    async sendFile(fromId, bytes, name, extra = {}) {
      const doc = tg.putFile(bytes, { name, mime: 'application/octet-stream' });
      return h.send(fromId, null, { document: doc, ...extra });
    },
    /** Sends a photo (Telegram's sizes array). */
    async sendPhoto(fromId, bytes) {
      const f = tg.putFile(bytes);
      return h.send(fromId, null, { photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 10 }, { file_id: f.file_id, file_unique_id: f.file_unique_id, width: 1280, height: 960, file_size: f.file_size }] });
    },
    /** Presses a button: data, and the message it sits on. */
    async press(fromId, data, messageId = null, updateIdOverride) {
      const chat = { id: fromId, type: 'private' };
      const cq = { id: `cq${updateId}`, from: person(fromId), chat_instance: 'x', data, message: { message_id: messageId || 1, chat, date: 0 } };
      const update_id = updateIdOverride ?? updateId++;
      return callbackHandler(cq, { update: { update_id, callback_query: cq } });
    },
    /** Presses the button with this callback_data on the latest bot message that has it. */
    async tap(fromId, data) {
      const msgs = tg.calls.filter((c) => c.result && ['sendMessage', 'editMessageText', 'sendDocument'].includes(c.method) && c.params.chat_id === fromId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (buttons(msgs[i].params).some((b) => b.callback_data === data)) {
          const id = msgs[i].method === 'editMessageText' ? msgs[i].params.message_id : msgs[i].result.message_id;
          advance(2); // past the double-tap guard
          return h.press(fromId, data, id);
        }
      }
      throw new Error(`no button ${data} for ${fromId}; last: ${JSON.stringify(h.lastButtons(fromId).map((b) => b.callback_data))}`);
    },
    /** Finds a button by (part of) its text on the latest message and presses it. */
    async tapText(fromId, part) {
      const b = h.lastButtons(fromId).find((x) => x.text.includes(part));
      if (!b) throw new Error(`no button "${part}"; have: ${h.lastButtons(fromId).map((x) => x.text).join(' | ')}`);
      return h.tap(fromId, b.callback_data);
    },
    async myChatMember(chat, newStatus, oldStatus = 'member', fromId = OWNER) {
      const upd = { chat, from: person(fromId), date: 0, old_chat_member: { status: oldStatus, user: { id: 9216103899 } }, new_chat_member: { status: newStatus, user: { id: 9216103899 } } };
      return myChatMemberHandler(upd, { update: { update_id: updateId++, my_chat_member: upd } });
    },
    lastText: (chatId) => { const p = tg.lastTo(chatId) || {}; return p.text || p.caption || ''; },
    lastButtons: (chatId) => buttons(tg.lastTo(chatId)),
    docs: (chatId, from = 0) => tg.callsOf('sendDocument', chatId, from).filter((c) => c.result).map((c) => c.result),
    mark: () => tg.calls.length,
  };
  return h;
}

export { buttons };
