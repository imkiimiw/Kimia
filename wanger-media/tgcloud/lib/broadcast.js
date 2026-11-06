// Broadcast (brief §8): a copy of one staff message to every user, in small resumable batches —
// there is no scheduler, so batches run when staff press "send next batch" and, a few messages at a
// time, piggybacked on other updates (lib/router.js). A batch is claimed with a lease, the cursor
// advances after every message, a 429 stops the batch until retry_after has passed, and users who
// blocked the bot are marked (and counted). Never more than ~30 messages a second.
import * as broadcasts from './db/broadcasts.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { t } from './i18n/index.js';
import * as tg from './tg.js';

export const ACTIVE_KEY = 'broadcast.active';
const LEASE_S = 60;

/** The progress text of a broadcast row. */
export function progressText(lang, b) {
  return t(lang, 'bc.progress', { id: b.id, status: t(lang, 'bc.status.' + b.status), sent: b.sent, failed: b.failed, blocked: b.blocked });
}

/**
 * Sends up to `max` copies within `budgetMs`. → { claimed, sent, failed, blocked, done, retryAfter }
 */
export async function runBatch(ctx, id, { max = 25, budgetMs = 8000 } = {}) {
  const b = await broadcasts.claim(id, ctx.now, LEASE_S);
  if (!b) return { claimed: false };
  const startMs = Date.now();
  const res = { claimed: true, sent: 0, failed: 0, blocked: 0, done: false, retryAfter: null };
  let cursor = b.cursor;
  const list = await broadcasts.nextUsers(cursor, max);
  for (const u of list) {
    if (Date.now() - startMs > budgetMs) break;
    const delta = {};
    if (!u.blocked) {
      try {
        await tg.call(ctx, 'broadcast', 'copyMessage', { chat_id: u.id, from_chat_id: b.source_chat, message_id: b.source_message });
        delta.sent = 1;
      } catch (err) {
        if (err && err.kind === 'rate') {
          res.retryAfter = Number(err.retryAfter) || 5;
          await broadcasts.pause(id, ctx.now + res.retryAfter + 1, ctx.now);
          return finishBatch(ctx, b, res, false);
        }
        if (err && err.kind === 'blocked') {
          delta.blocked = 1;
          if (await users.setBlocked(u.id, true)) await system.count([['users_blocked', '', 1]]);
        } else {
          delta.failed = 1;
        }
      }
    }
    cursor = u.id;
    await broadcasts.advance(id, cursor, delta, ctx.now);
    res.sent += delta.sent || 0;
    res.failed += delta.failed || 0;
    res.blocked += delta.blocked || 0;
  }
  const done = list.length < max && cursor === (list.length ? list[list.length - 1].id : b.cursor);
  if (done) {
    await broadcasts.finish(id, ctx.now);
    await system.deleteSetting(ACTIVE_KEY);
    await system.audit(ctx.now, 0, 'broadcast.done', String(id), null);
  } else {
    await broadcasts.release(id);
  }
  res.done = done;
  return finishBatch(ctx, b, res, true);
}

async function finishBatch(ctx, b, res) {
  const fresh = await broadcasts.get(b.id);
  if (fresh && fresh.progress_chat && fresh.progress_message) {
    const lang = (await users.langOf(fresh.created_by)) || 'en';
    try {
      await tg.edit(ctx, 'broadcast_progress', { chat: { id: fresh.progress_chat }, message_id: fresh.progress_message }, progressScreen(lang, fresh));
    } catch { /* the progress message may be gone */ }
  }
  return res;
}

/** Progress text with the buttons that fit the state (shared with lib/admin/broadcast.js). */
export function progressScreen(lang, b) {
  const rows = [];
  if (b.status === 'running') rows.push([{ text: t(lang, 'bc.btn.next'), callback_data: `A:bg:${b.id}` }, { text: t(lang, 'bc.btn.cancel'), callback_data: `A:bx:${b.id}` }]);
  rows.push([{ text: t(lang, 'btn.back'), callback_data: 'A:b' }, { text: t(lang, 'btn.home'), callback_data: 'h' }]);
  return { text: progressText(lang, b), reply_markup: { inline_keyboard: rows } };
}

/** Piggyback: a few messages of the active broadcast on the side of any update. */
export async function piggyback(ctx, activeSetting) {
  const id = activeSetting && activeSetting.value && activeSetting.value.id;
  if (!id) return null;
  try {
    return await runBatch(ctx, id, { max: 5, budgetMs: 2500 });
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}
