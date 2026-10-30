/*
 * The bot's own identity (getMe, cached in aegis_kv) and the Mini App address derived from it.
 */
import { APP_URL } from '../config.js';
import * as kv from './kv.js';
import { call } from './tg.js';

export async function me(ctx) {
  const s = await kv.all(ctx);
  if (s.bot_id && s.bot_username) return { id: Number(s.bot_id), username: s.bot_username };
  const r = await call(ctx, 'getMe', {}, 'me');
  await kv.set(ctx, 'bot_id', r.id);
  await kv.set(ctx, 'bot_username', r.username);
  return { id: r.id, username: r.username };
}

/* The Mini App's URL: APP_URL from config, else https://app<bot id>.tgcloud.ai/. */
export async function appUrl(ctx) {
  if (APP_URL) return APP_URL;
  const b = await me(ctx);
  return `https://app${b.id}.tgcloud.ai/`;
}
