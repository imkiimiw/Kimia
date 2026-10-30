/*
 * What every Mini App endpoint does first: take the caller from the verified init data, record
 * them (users row: first/last seen, language on first contact), and — unless `join: false` —
 * refuse with NOT_JOINED (and the missing channels) until they have joined the forced-join
 * channels. Refusals are EndpointErrors whose parameters.code the Mini App switches on.
 */
import { EndpointError } from 'sdk';
import { OWNER_ID } from './config.js';
import { joinStatus } from './join.js';
import { RoomError } from './rooms.js';
import { nowSec, touchUser } from './store.js';
import { createCtx } from './tg.js';

export const fail = (code, extra = {}) => new EndpointError(code, { code, ...extra });

export function endpoint(fn, { join = true, owner = false } = {}) {
  return async function (input, ctx) {
    const u = ctx && ctx.initData && ctx.initData.user;
    if (!u || !Number.isInteger(u.id)) throw fail('NO_USER');
    if (owner && u.id !== OWNER_ID) throw fail('OWNER_ONLY');
    const tg = createCtx();
    const user = await touchUser(u);
    if (join) {
      const j = await joinStatus(tg, u.id);
      if (!j.ok) throw fail('NOT_JOINED', { channels: j.missing });
    }
    const env = { tg, user, from: u, initData: ctx.initData, chat: ctx.initData.chat_instance || null, now: nowSec() };
    try {
      return await fn(input && typeof input === 'object' ? input : {}, env);
    } catch (err) {
      if (err instanceof RoomError) throw fail(err.code);
      throw err;
    }
  };
}
