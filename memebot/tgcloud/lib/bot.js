/*
 * Facts about the bot itself and messages to the owner.
 */
import { ENV } from './env.js';
import { ALERT_EVERY, NOTIFY_EVERY } from './config.js';
import { langOf, t } from './i18n.js';
import * as admin from './adminstore.js';
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

/* 'owner' | 'admin' | null — read fresh from the database on every use, never cached. */
export async function roleOf(id) {
  if (isOwner(id)) return 'owner';
  return (await admin.isAdminRow(id)) ? 'admin' : null;
}

/* Tells the owner and every admin (each in their language) about waiting work, at most once per
   NOTIFY_EVERY for the same kind. `build(lang)` returns [text, keyboard]. */
export async function notifyAdmins(ctx, kind, build, nowSec) {
  if (!(await store.claimEvery(`notify:${kind}`, nowSec, NOTIFY_EVERY))) return 0;
  const ids = [ENV.ownerId, ...(await admin.listAdmins()).map((a) => a.user_id)].filter(Boolean);
  let n = 0;
  for (const id of [...new Set(ids)]) {
    const lang = langOf(await store.getUser(id), null);
    const [text, kb] = build(lang);
    if (await send(ctx, `notify.${kind}`, text, kb, { chatId: id })) n += 1;
  }
  return n;
}

/* Sends the owner an alert in their language, at most once per ALERT_EVERY for the same kind. */
export async function alertOwner(ctx, kind, key, vars, nowSec) {
  if (!ENV.ownerId || !(await store.claimEvery(`alert:${kind}`, nowSec, ALERT_EVERY))) return false;
  const owner = await store.getUser(ENV.ownerId);
  const lang = langOf(owner, null);
  return !!(await send(ctx, `alert.${kind}`, t(lang, key, vars), null, { chatId: ENV.ownerId }));
}
