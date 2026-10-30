/*
 * Structured error logging. record() writes one aegis_errors row and one JSON line to the console
 * (visible in `npx tgcloud run` and the platform logs), and tells the owner in private at most once
 * per ERROR_NOTIFY_INTERVAL_SEC. It never throws.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { ERROR_NOTIFY_INTERVAL_SEC, OWNER_ID } from '../config.js';
import { get as getUser } from '../engines/users.js';
import { t } from '../i18n/index.js';
import { claim } from './kv.js';
import { describeError, isApiError, send } from './tg.js';
import { esc, nowSec, short } from './util.js';

export async function record(ctx, err, { source = 'unknown', updateId = 0, chatId = 0, userId = 0, notify = true } = {}) {
  const at = nowSec();
  const code = isApiError(err) ? String(err.code) : String((err && err.name) || 'Error');
  const message = short(describeError(err), 500);
  const stack = String((err && err.stack) || '').slice(0, 2000);
  if (ctx) ctx.error = `${source}: ${message}`;
  console.error(JSON.stringify({ level: 'error', at, source, updateId, chatId, userId, code, message }));
  try {
    await db.run(sql`INSERT INTO aegis_errors (at, source, update_id, chat_id, user_id, code, message, stack)
      VALUES (${at}, ${source}, ${Number(updateId) || 0}, ${Number(chatId) || 0}, ${Number(userId) || 0}, ${code}, ${message}, ${stack})`);
    if (notify && ctx) {
      const owner = await getUser(OWNER_ID);
      if (owner && Number(owner.started) && !Number(owner.blocked) && (await claim('err_notify_at', at, ERROR_NOTIFY_INTERVAL_SEC))) {
        await send(ctx, OWNER_ID, t(owner.lang, 'errors.owner_notice', { source: esc(source), message: esc(message) }), null, 'error-notice');
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', where: 'errors.record', message: String((e && e.message) || e) }));
  }
}

export async function countSince(since) {
  return Number((await db.get(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${since}`)).n);
}
