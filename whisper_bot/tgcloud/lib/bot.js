// The bot's own id and username (for deep links and admin checks), from getMe, cached in kv.
import { call, describeError } from './tg.js';
import { setKv } from './store.js';

export async function botInfo(ctx, kv) {
  if (kv.bot_id && kv.bot_username) return { id: Number(kv.bot_id), username: kv.bot_username };
  try {
    const me = await call(ctx, 'getMe', {}, 'bot_info');
    await setKv('bot_id', me.id);
    await setKv('bot_username', me.username);
    kv.bot_id = String(me.id);
    kv.bot_username = me.username;
    return { id: Number(me.id), username: me.username };
  } catch (err) {
    console.warn(`getMe failed: ${describeError(err)}`);
    return { id: null, username: null };
  }
}

export const startLink = (username, param) => `https://t.me/${username}?start=${param}`;
