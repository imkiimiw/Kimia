// End-to-end harness: a fresh in-memory database with the real schema, the fake Telegram as the
// Bot API, a controllable clock, and helpers that call the real handlers the way the platform does.
import * as schema from '../../tgcloud/schema.js';
import { setupDatabase, rawDatabase } from '../sdk/db.mjs';
import { setApiHandler } from '../sdk/api.mjs';
import { createFakeTelegram, buttons } from './fake-telegram.mjs';
import messageHandler from '../../tgcloud/handlers/message.js';
import callbackHandler from '../../tgcloud/handlers/callback_query.js';
import myChatMemberHandler from '../../tgcloud/handlers/my_chat_member.js';
import opsTick from '../../tgcloud/endpoints/opsTick.js';

export const OWNER = 5557901897;
export const SEED = [-1002407928564, -1001816009903, -1001910797391];

const realNow = Date.now.bind(Date);
let offsetMs = 0;

/** Moves the clock forward. */
export const advance = (seconds) => { offsetMs += seconds * 1000; };

/** Log lines written by the bot during a test (console is captured, not printed). */
export const logs = [];
console.log = (...a) => logs.push(['log', a.join(' ')]);
console.warn = (...a) => logs.push(['warn', a.join(' ')]);
console.error = (...a) => logs.push(['error', a.join(' ')]);

export function setup({ seedChannels = true, botAdminIn = SEED } = {}) {
  offsetMs = 0;
  logs.length = 0;
  Date.now = () => realNow() + offsetMs;
  setupDatabase(schema);
  const tg = createFakeTelegram();
  setApiHandler(tg.handler);
  if (seedChannels) {
    tg.addChannel({ id: SEED[0], username: 'HIDE_i_SEEK', title: 'HIDE & SEEK', botAdmin: botAdminIn.includes(SEED[0]) });
    tg.addChannel({ id: SEED[1], username: 'Nepenthw_ir', title: 'Nepenthe', botAdmin: botAdminIn.includes(SEED[1]) });
    tg.addChannel({ id: SEED[2], username: 'wangerBots', title: 'Wanger bots', botAdmin: botAdminIn.includes(SEED[2]) });
  }
  let updateId = 1;
  let msgId = 1;
  const person = (id, extra = {}) => ({ id, is_bot: false, first_name: `User${id}`, username: `user${id}`, language_code: 'fa', ...extra });

  const h = {
    tg,
    db: () => rawDatabase(),
    q: (text, ...params) => rawDatabase().prepare(text).all(...params),
    one: (text, ...params) => rawDatabase().prepare(text).get(...params),
    person,
    /** Sends a private message; returns the handler result. */
    async send(fromId, text, extra = {}, updateIdOverride) {
      const message = { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: fromId, type: 'private' }, from: person(fromId), ...(text !== null ? { text } : {}), ...extra };
      const update_id = updateIdOverride ?? updateId++;
      return messageHandler(message, { update: { update_id, message } });
    },
    /** Presses a button: data, and the message it sits on. */
    async press(fromId, data, messageId = null, chat = { id: fromId, type: 'private' }) {
      const cq = { id: `cq${updateId}`, from: person(fromId), chat_instance: 'x', data, ...(messageId ? { message: { message_id: messageId, chat, date: 0 } } : {}) };
      const update_id = updateId++;
      return callbackHandler(cq, { update: { update_id, callback_query: cq } });
    },
    /** Presses the button with this callback_data on the last message the bot sent/edited for the user. */
    async tap(fromId, data) {
      const msgs = tg.calls.filter((c) => c.result && (c.method === 'sendMessage' || c.method === 'editMessageText') && c.params.chat_id === fromId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (buttons(msgs[i].params).some((b) => b.callback_data === data)) {
          const id = msgs[i].method === 'editMessageText' ? msgs[i].params.message_id : msgs[i].result && msgs[i].result.message_id;
          return h.press(fromId, data, id);
        }
      }
      throw new Error(`no button ${data} for ${fromId}`);
    },
    async myChatMember(chat, from, newStatus, oldStatus = 'member') {
      const upd = { chat, from: person(from), date: 0, old_chat_member: { status: oldStatus, user: { id: 9280424458 } }, new_chat_member: { status: newStatus, user: { id: 9280424458 } } };
      return myChatMemberHandler(upd, { update: { update_id: updateId++, my_chat_member: upd } });
    },
    opsTick: (userId) => opsTick({}, { initData: { user: { id: userId } } }),
    lastText: (chatId) => (tg.lastTo(chatId) || {}).text || '',
    lastButtons: (chatId) => buttons(tg.lastTo(chatId)),
    mark: () => tg.calls.length,
  };

  return h;
}
