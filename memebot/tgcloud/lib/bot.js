/*
 * Facts about the bot itself and messages to the owner.
 */
import { ENV } from './env.js';
import { ALERT_EVERY } from './config.js';
import { langOf, t } from './i18n.js';
import * as store from './store.js';
import { call, send } from './tg.js';

const USERNAME_TTL = 86400;

/* The bot's @username (cached in kv for a day; getMe otherwise). */
export async function botUsername(ctx, nowSec) {
  const row = await store.kvGet('bot:username');
  if (row && row.value && nowSec - row.n < USERNAME_TTL) return row.value;
  try {
    const me = await call(ctx, 'getMe', {}, 'getMe');
    await store.kvSet('bot:username', me.username, nowSec);
    return me.username;
  } catch (err) {
    return row && row.value ? row.value : 'bot';
  }
}

export const isOwner = (id) => Number(id) === Number(ENV.ownerId);

/* Sends the owner an alert in their language, at most once per ALERT_EVERY for the same kind. */
export async function alertOwner(ctx, kind, key, vars, nowSec) {
  if (!ENV.ownerId || !(await store.claimEvery(`alert:${kind}`, nowSec, ALERT_EVERY))) return false;
  const owner = await store.getUser(ENV.ownerId);
  const lang = langOf(owner, null);
  return !!(await send(ctx, `alert.${kind}`, t(lang, key, vars), null, { chatId: ENV.ownerId }));
}
