/*
 * Broadcasts: the owner's message is copied (copyMessage, so formatting, media and buttons are
 * kept) to every user who started the bot and hasn't blocked it.
 *
 * There is no scheduler and no timer, so sending happens in batches, each one a separate request:
 * the owner's "send next batch" button, or the Mini App's broadcast page, which calls the
 * broadcastTick endpoint about once a second while it is open. A batch takes a lock on the row
 * (lock_until_ms), sends up to BROADCAST_BATCH messages one by one, and saves the cursor (the last
 * user id handled) and the counters after every message, so it resumes exactly where it stopped
 * — even if an invocation is cut short. Batches are at least BROADCAST_GAP_MS apart (≈ 25 msg/s).
 * A 429 stops the batch and pauses the broadcast for retry_after. 403 = blocked: the user is marked.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BROADCAST_BATCH, BROADCAST_BUDGET_MS, BROADCAST_GAP_MS } from './config.js';
import * as store from './store.js';
import { call, describeError, isApiError } from './tg.js';

export async function getBroadcast(id) {
  return db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`);
}

/* The running broadcast, else the most recent one. */
export async function currentBroadcast() {
  const running = await db.get(sql`SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id DESC LIMIT 1`);
  if (running) return running;
  return db.get(sql`SELECT * FROM broadcasts WHERE status IN ('done', 'cancelled') ORDER BY id DESC LIMIT 1`);
}

export async function createDraft(fromChat, messageId, markup) {
  const r = await db.run(sql`INSERT INTO broadcasts (from_chat, message_id, markup, status, created_at)
    VALUES (${fromChat}, ${messageId}, ${markup ? JSON.stringify(markup) : null}, 'draft', ${store.nowSec()}) RETURNING id`);
  return Number(r.rows[0].id);
}

/* Draft → running, unless another broadcast is running. */
export async function startBroadcast(id, panelMsg) {
  const busy = await db.get(sql`SELECT id FROM broadcasts WHERE status = 'running' LIMIT 1`);
  if (busy) return false;
  const total = await store.countRecipients();
  const r = await db.run(sql`UPDATE broadcasts SET status = 'running', total = ${total}, panel_msg = ${panelMsg || 0} WHERE id = ${id} AND status = 'draft'`);
  return r.rowsAffected > 0;
}

export async function cancelBroadcast(id) {
  const r = await db.run(sql`UPDATE broadcasts SET status = 'cancelled', finished_at = ${store.nowSec()} WHERE id = ${id} AND status IN ('draft', 'running')`);
  return r.rowsAffected > 0;
}

export async function setPanel(id, panelMsg) {
  await db.run(sql`UPDATE broadcasts SET panel_msg = ${panelMsg} WHERE id = ${id}`);
}

/*
 * Sends one batch of the running broadcast `id`. Gives { row, sent, finished } — sent: messages
 * attempted in this call (0 when it was locked or paused), finished: this call completed it.
 */
export async function sendBatch(ctx, id) {
  const startMs = Date.now();
  const lock = await db.run(sql`UPDATE broadcasts SET lock_until_ms = ${startMs + 30000}
    WHERE id = ${id} AND status = 'running' AND lock_until_ms <= ${startMs}`);
  if (!lock.rowsAffected) return { row: await getBroadcast(id), sent: 0, finished: false };
  const b = await getBroadcast(id);
  const markup = b.markup ? JSON.parse(b.markup) : null;
  const users = await store.broadcastRecipients(Number(b.cursor), BROADCAST_BATCH);
  let done = 0;
  let pauseMs = BROADCAST_GAP_MS;
  for (const u of users) {
    if (Date.now() - startMs > BROADCAST_BUDGET_MS) break;
    const userId = Number(u.user_id);
    let col = 'sent';
    try {
      const params = { chat_id: userId, from_chat_id: Number(b.from_chat), message_id: Number(b.message_id) };
      if (markup) params.reply_markup = markup;
      await call(ctx, 'copyMessage', params, 'broadcast');
    } catch (err) {
      if (isApiError(err) && err.code === 429) {
        pauseMs = 1000 * Number((err.parameters && err.parameters.retry_after) || 5);
        break; /* this user is retried in the next batch */
      }
      if (isApiError(err) && err.code === 403) {
        col = 'blocked';
        await store.setBlocked(userId, true);
      } else {
        col = 'failed';
        console.warn(`broadcast ${id} to ${userId}: ${describeError(err)}`);
      }
    }
    await db.run(sql`UPDATE broadcasts SET cursor = ${userId}, ${sql.raw(col)} = ${sql.raw(col)} + 1 WHERE id = ${id}`);
    done += 1;
  }
  const finished = users.length < BROADCAST_BATCH && done === users.length;
  if (finished) {
    await db.run(sql`UPDATE broadcasts SET status = 'done', finished_at = ${store.nowSec()}, lock_until_ms = 0 WHERE id = ${id} AND status = 'running'`);
  } else {
    await db.run(sql`UPDATE broadcasts SET lock_until_ms = ${Date.now() + pauseMs} WHERE id = ${id}`);
  }
  return { row: await getBroadcast(id), sent: done, finished };
}

/* Progress numbers for the panel and the Mini App page. */
export function progress(row) {
  if (!row) return null;
  const sent = Number(row.sent);
  const failed = Number(row.failed);
  const blocked = Number(row.blocked);
  return { id: Number(row.id), status: row.status, sent, failed, blocked, done: sent + failed + blocked, total: Number(row.total) };
}
