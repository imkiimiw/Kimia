/*
 * Broadcasts: a queue in aegis_broadcasts (see schema.js for the states).
 *
 * The platform has no scheduler and no timers, so a running broadcast advances in batches, each
 * one a separate invocation: the owner's "send next batch" button, the Mini App's live page (about
 * one batch a second while open), and a small chunk on the side of every other update the bot
 * receives (lib/jobs.js). A batch:
 *   - claims the row with a short lock (lock_until_ms) so two invocations never send at once, and
 *     only when next_at_ms has passed (pacing between batches, or Telegram's retry_after);
 *   - sends one message at a time — copyMessage (no "forwarded from"; the owner's buttons
 *     attached) or forwardMessage — and saves the cursor and the counters after every message, so
 *     it resumes exactly where it stopped even if the invocation is cut short;
 *   - 429: stops, waits retry_after (that recipient is retried); 403: a user who blocked the bot is
 *     marked blocked (inactive), a chat that removed the bot is marked inactive — counted "blocked";
 *     a group that became a supergroup is retried at its new id; anything else counts "failed";
 *   - if the source message is gone (the owner deleted it), the broadcast is paused, not burned.
 * Only one broadcast is running or paused at a time; others wait as "queued" and start in order.
 * Status changes are conditional writes, so "finished" and "cancelled" each happen exactly once.
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { BC_GAP_MS, BC_LOCK_MS, OWNER_ID } from '../config.js';
import * as audit from '../core/audit.js';
import { call, describeError, isApiError, isFlood, retryAfter } from '../core/tg.js';
import { nowSec, parseJson } from '../core/util.js';
import * as chats from './chats.js';
import * as users from './users.js';

export const AUDIENCES = ['users', 'groups', 'channels'];
export const MODES = ['copy', 'forward'];
const START_CURSOR = -9007199254740991;
const SOURCE_GONE = /message to (copy|forward) not found|MESSAGE_ID_INVALID|message not found/i;

export async function get(id) {
  return db.get(sql`SELECT * FROM aegis_broadcasts WHERE id = ${id}`);
}

export const buttonsOf = (row) => parseJson(row && row.buttons, null);

/* The running or paused broadcast, if any. */
export async function active() {
  return db.get(sql`SELECT * FROM aegis_broadcasts WHERE status IN ('running', 'paused') ORDER BY id LIMIT 1`);
}

export async function queued() {
  return db.all(sql`SELECT * FROM aegis_broadcasts WHERE status = 'queued' ORDER BY id LIMIT 20`);
}

export async function latestFinished() {
  return db.get(sql`SELECT * FROM aegis_broadcasts WHERE status IN ('done', 'cancelled') ORDER BY id DESC LIMIT 1`);
}

export async function countAudience(audience) {
  if (audience === 'users') return users.countReachable(OWNER_ID);
  return chats.countAudience(audience);
}

export async function createDraft({ audience, mode, fromChat, messageId, contentType, createdBy }) {
  const r = await db.run(sql`INSERT INTO aegis_broadcasts (audience, mode, from_chat, message_id, content_type, status, created_by, created_at)
    VALUES (${audience}, ${mode}, ${fromChat}, ${messageId}, ${contentType}, 'draft', ${createdBy}, ${nowSec()}) RETURNING id`);
  const id = Number(r.rows[0].id);
  await audit.log(createdBy, 'bc.create', { target: id, details: { audience, mode, contentType } });
  return id;
}

export async function setButtons(id, rows) {
  await db.run(sql`UPDATE aegis_broadcasts SET buttons = ${rows ? JSON.stringify(rows) : null} WHERE id = ${id} AND status = 'draft'`);
}

export async function setPanel(id, chatId, messageId) {
  await db.run(sql`UPDATE aegis_broadcasts SET panel_chat = ${chatId}, panel_msg = ${messageId}, progress_at = ${nowSec()} WHERE id = ${id}`);
}

export async function touchProgress(id) {
  await db.run(sql`UPDATE aegis_broadcasts SET progress_at = ${nowSec()} WHERE id = ${id}`);
}

async function begin(id) {
  const row = await get(id);
  const total = await countAudience(row.audience);
  const r = await db.run(sql`UPDATE aegis_broadcasts SET status = 'running', total = ${total}, started_at = ${nowSec()},
    cursor = ${START_CURSOR}, next_at_ms = 0, lock_until_ms = 0 WHERE id = ${id} AND status IN ('draft', 'queued')`);
  return r.rowsAffected > 0;
}

/* Draft → running, or → queued behind the active one. Gives 'running', 'queued' or null. */
export async function start(id, actorId) {
  const cur = await active();
  if (cur && Number(cur.id) !== id) {
    const r = await db.run(sql`UPDATE aegis_broadcasts SET status = 'queued' WHERE id = ${id} AND status = 'draft'`);
    if (!r.rowsAffected) return null;
    await audit.log(actorId, 'bc.queue', { target: id });
    return 'queued';
  }
  if (!(await begin(id))) return null;
  await audit.log(actorId, 'bc.start', { target: id });
  return 'running';
}

/* When nothing is running or paused, the oldest queued broadcast starts. Gives its id or null. */
export async function promoteNext() {
  if (await active()) return null;
  const next = (await queued())[0];
  if (!next) return null;
  if (!(await begin(Number(next.id)))) return null;
  await audit.log(0, 'bc.start', { target: Number(next.id), details: { from: 'queue' } });
  return Number(next.id);
}

export async function pause(id, actorId, reason = null) {
  const r = await db.run(sql`UPDATE aegis_broadcasts SET status = 'paused', last_error = COALESCE(${reason}, last_error)
    WHERE id = ${id} AND status = 'running'`);
  if (r.rowsAffected) await audit.log(actorId, 'bc.pause', { target: id, details: reason ? { reason } : null });
  return r.rowsAffected > 0;
}

export async function resume(id, actorId) {
  const r = await db.run(sql`UPDATE aegis_broadcasts SET status = 'running', next_at_ms = 0, last_error = NULL WHERE id = ${id} AND status = 'paused'`);
  if (r.rowsAffected) await audit.log(actorId, 'bc.resume', { target: id });
  return r.rowsAffected > 0;
}

/* Any unfinished broadcast → cancelled. True if this call cancelled it. */
export async function cancel(id, actorId) {
  const r = await db.run(sql`UPDATE aegis_broadcasts SET status = 'cancelled', finished_at = ${nowSec()}, lock_until_ms = 0
    WHERE id = ${id} AND status IN ('draft', 'queued', 'running', 'paused')`);
  if (!r.rowsAffected) return false;
  await audit.log(actorId, 'bc.cancel', { target: id });
  await promoteNext();
  return true;
}

async function recipients(row, limit) {
  const cursor = Number(row.cursor);
  if (row.audience === 'users') return users.reachableAfter(cursor, limit, OWNER_ID);
  return chats.audienceAfter(row.audience, cursor, limit);
}

async function deliver(ctx, row, chatId, markupRows) {
  const base = { chat_id: chatId, from_chat_id: Number(row.from_chat), message_id: Number(row.message_id) };
  if (row.mode === 'forward') return call(ctx, 'forwardMessage', base, 'broadcast');
  if (markupRows) base.reply_markup = { inline_keyboard: markupRows };
  return call(ctx, 'copyMessage', base, 'broadcast');
}

/*
 * Sends up to `limit` messages of running broadcast `id` within `budgetMs`.
 * Gives { ran: false, reason: 'not_running' | 'wait' | 'locked', row }
 *    or { ran: true, attempted, finished, limited, sourceGone, row }.
 */
export async function runBatch(ctx, id, { limit, budgetMs }) {
  const startMs = Date.now();
  const lock = await db.run(sql`UPDATE aegis_broadcasts SET lock_until_ms = ${startMs + BC_LOCK_MS}
    WHERE id = ${id} AND status = 'running' AND lock_until_ms <= ${startMs} AND next_at_ms <= ${startMs}`);
  if (!lock.rowsAffected) {
    const row = await get(id);
    let reason = 'locked';
    if (!row || row.status !== 'running') reason = 'not_running';
    else if (Number(row.next_at_ms) > startMs) reason = 'wait';
    return { ran: false, reason, row };
  }
  const row = await get(id);
  const markupRows = buttonsOf(row);
  const list = await recipients(row, limit);
  let attempted = 0;
  let limited = false;
  let sourceGone = false;
  let nextAt = 0;
  for (const target of list) {
    if (Date.now() - startMs > budgetMs) break;
    let col = 'sent';
    try {
      await deliver(ctx, row, target, markupRows);
    } catch (err) {
      if (isFlood(err)) {
        const wait = retryAfter(err);
        nextAt = Date.now() + wait * 1000;
        limited = true;
        await db.run(sql`UPDATE aegis_broadcasts SET wait_sec = ${wait} WHERE id = ${id}`);
        break;
      }
      const migrated = isApiError(err) && err.parameters && err.parameters.migrate_to_chat_id;
      if (migrated && row.audience !== 'users') {
        await chats.migrate(target, Number(migrated));
        try {
          await deliver(ctx, row, Number(migrated), markupRows);
        } catch (err2) {
          col = isApiError(err2) && err2.code === 403 ? 'blocked' : 'failed';
        }
      } else if (isApiError(err) && err.code === 400 && SOURCE_GONE.test(err.description)) {
        sourceGone = true;
        break;
      } else if (isApiError(err) && err.code === 403) {
        col = 'blocked';
        if (row.audience !== 'users') await chats.setInactive(target, 'kicked');
      } else {
        col = 'failed';
        console.warn(`broadcast ${id} → ${target}: ${describeError(err)}`);
        await db.run(sql`UPDATE aegis_broadcasts SET last_error = ${describeError(err).slice(0, 300)} WHERE id = ${id}`);
      }
    }
    await db.run(sql`UPDATE aegis_broadcasts SET cursor = ${target}, ${sql.raw(col)} = ${sql.raw(col)} + 1 WHERE id = ${id}`);
    attempted += 1;
  }
  const finished = !limited && !sourceGone && list.length < limit && attempted === list.length;
  if (finished) {
    const r = await db.run(sql`UPDATE aegis_broadcasts SET status = 'done', finished_at = ${nowSec()}, lock_until_ms = 0
      WHERE id = ${id} AND status = 'running'`);
    if (r.rowsAffected) {
      await audit.log(0, 'bc.done', { target: id });
      await promoteNext();
      return { ran: true, attempted, finished: true, limited, sourceGone, row: await get(id) };
    }
  }
  if (sourceGone) await pause(id, 0, 'source_gone');
  const next = Math.max(nextAt, Date.now() + BC_GAP_MS);
  await db.run(sql`UPDATE aegis_broadcasts SET lock_until_ms = 0, next_at_ms = ${next} WHERE id = ${id}`);
  return { ran: true, attempted, finished: false, limited, sourceGone, row: await get(id) };
}

/* Numbers for the progress views. */
export function progress(row) {
  const sent = Number(row.sent);
  const failed = Number(row.failed);
  const blocked = Number(row.blocked);
  const total = Number(row.total);
  const done = sent + failed + blocked;
  return {
    id: Number(row.id), status: row.status, audience: row.audience, mode: row.mode,
    sent, failed, blocked, done, total, left: Math.max(0, total - done),
    pct: total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : (row.status === 'done' ? 100 : 0),
    waitMs: Math.max(0, Number(row.next_at_ms) - Date.now()),
    waitSec: Number(row.wait_sec),
    lastError: row.last_error || null,
    took: row.finished_at && row.started_at ? Number(row.finished_at) - Number(row.started_at) : 0,
  };
}
