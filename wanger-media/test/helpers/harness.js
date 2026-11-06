// Runs the real handlers against the local SDK (node:sqlite) and the fake Telegram.
import { vi } from 'vitest';
import * as schema from '../../tgcloud/schema.js';
import callbackQuery from '../../tgcloud/handlers/callback_query.js';
import message from '../../tgcloud/handlers/message.js';
import myChatMember from '../../tgcloud/handlers/my_chat_member.js';
import { setApiHandler } from '../sdk/api.js';
import { rawDatabase, resetStats, setupDatabase, stats } from '../sdk/db.js';
import { createTelegram } from './telegram.js';

export const OWNER = { id: 5557901897, is_bot: false, first_name: 'Owner', username: 'owner_wanger', language_code: 'fa' };
export const ALICE = { id: 1001, is_bot: false, first_name: 'Alice', username: 'alice', language_code: 'en-US' };
export const BORIS = { id: 1002, is_bot: false, first_name: 'Борис', language_code: 'ru' };
export const SARA = { id: 1003, is_bot: false, first_name: 'سارا', language_code: 'fa-IR' };

/** 2026-11-05 12:00 Tehran. */
export const T0 = Date.UTC(2026, 10, 5, 8, 30, 0);

export function setup(options = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  setupDatabase(schema);
  const tg = createTelegram(options);
  setApiHandler(tg.handler);
  let updateId = 10_000;
  let messageId = 1;

  /** Like Telegram, marks every http(s) link in the text with a url entity (UTF-16 offsets). */
  const linkEntities = (text) => [...String(text || '').matchAll(/https?:\/\/\S+/g)].map((m) => ({ type: 'url', offset: m.index, length: m[0].length }));
  const privateMessage = (from, text) => ({
    message_id: messageId++, from, chat: { id: from.id, type: 'private', first_name: from.first_name }, date: Math.floor(Date.now() / 1000), text,
    ...(linkEntities(text).length ? { entities: linkEntities(text) } : {}),
  });

  const h = {
    tg,
    stats,
    /** Sends a private message; returns the handler result. `id` reuses an update_id (redelivery). */
    async send(from, text, { id } = {}) {
      const msg = privateMessage(from, text);
      const update = { update_id: id ?? ++updateId, message: msg };
      return message(msg, { update });
    },
    /** A message in a group (links get url entities, like Telegram); `extra` merges into the message. */
    async sendGroup(from, chat, text, { id, extra = {} } = {}) {
      const msg = { message_id: messageId++, from, chat: { type: 'supergroup', ...chat }, date: Math.floor(Date.now() / 1000), text,
        ...(linkEntities(text).length ? { entities: linkEntities(text) } : {}), ...extra };
      return message(msg, { update: { update_id: id ?? ++updateId, message: msg } });
    },
    /** Presses a button on a bot message in a group. */
    async pressGroup(from, chat, data, { messageId: mid = 950, id } = {}) {
      const cq = { id: 'gcq' + (id ?? updateId + 1), from, data, message: { message_id: mid, chat: { type: 'supergroup', ...chat }, date: 0, text: '…' } };
      return callbackQuery(cq, { update: { update_id: id ?? ++updateId, callback_query: cq } });
    },
    /** Presses a button on a bot message ({ message_id, chat }) with callback_data `data`. */
    async press(from, data, { messageId: mid = 900, id, chatType = 'private' } = {}) {
      const cq = {
        id: 'cq' + (id ?? updateId + 1), from, data,
        message: { message_id: mid, chat: { id: chatType === 'private' ? from.id : -100500, type: chatType }, date: 0, text: '…' },
      };
      const update = { update_id: id ?? ++updateId, callback_query: cq };
      return callbackQuery(cq, { update });
    },
    async chatMember(upd, { id } = {}) {
      const update = { update_id: id ?? ++updateId, my_chat_member: upd };
      return myChatMember(upd, { update });
    },
    /** First run for `from`: /start, language, member of every channel, disclaimer accepted. */
    async onboard(from, lang = 'en') {
      h.tg.setMember(from.id);
      await h.send(from, '/start');
      await h.press(from, 'L:' + lang, { messageId: 1 });
      return h.press(from, 'a', { messageId: 2 });
    },
    /** Moves the clock forward by `seconds`. */
    advance(seconds) { vi.setSystemTime(Date.now() + seconds * 1000); },
    rows(text, ...params) { return rawDatabase().prepare(text).all(...params); },
    row(text, ...params) { return rawDatabase().prepare(text).get(...params); },
    counter(name, day = '') {
      const r = rawDatabase().prepare('SELECT value FROM counters WHERE name = ? AND day = ?').get(name, day);
      return r ? Number(r.value) : 0;
    },
    /** The last message/edit text the bot produced for `chatId`. */
    lastScreen(chatId) {
      const c = tg.state.calls.filter((x) => (x.method === 'sendMessage' || x.method === 'editMessageText') && Number(x.params.chat_id) === Number(chatId));
      return c.length ? c[c.length - 1].params : null;
    },
    resetCalls() { tg.reset(); resetStats(); },
  };
  return h;
}

/** callback_data values on a screen's inline keyboard. */
export const buttonsOf = (params) => (params && params.reply_markup ? params.reply_markup.inline_keyboard.flat() : []);
