/*
 * Broadcast (owner only). The owner sends any single message; the bot asks for confirmation; then
 * the message is copied (copyMessage) to every user who wrote to the bot, except banned users and
 * those known to have blocked it.
 *
 * Telegram Serverless has no scheduler, so sending happens in batches: BROADCAST_BATCH per press of
 * "▶ Next batch", and BROADCAST_SIDE on the side of every other message or button the bot receives
 * while a broadcast runs. The cursor (last user id done) is claimed with compare-and-set before a
 * batch is sent, so two updates never send the same range; on a 429 the unsent part is given back
 * and sending waits for retry_after. Users who blocked the bot (403) are marked and skipped later.
 * The owner's message must stay in their chat until the broadcast is done (it is copied from there).
 *
 * callback_data: a:bc (new) | a:bcy:<id> send | a:bcn:<id> cancel draft | a:bcx:<id> next batch |
 *                a:bcs:<id> stop
 */
import { BROADCAST_BATCH, BROADCAST_SIDE } from './config.js';
import * as admin from './adminstore.js';
import { langOf, t } from './i18n.js';
import * as store from './store.js';
import { answer, call, edit, isApiError, send } from './tg.js';

export const STATE_BROADCAST = 'adm:bc';

/* a:bc — ask for the message. */
export async function askMessage(ctx, user, nowSec) {
  await store.setState(user.id, STATE_BROADCAST, null, nowSec);
  await send(ctx, 'bc.ask', t(ctx.lang, 'bc.ask'), [[{ text: t(ctx.lang, 'upload.cancel_btn'), callback_data: 'a:x' }]]);
}

/* The owner's message while STATE_BROADCAST: store it as a draft and ask to confirm. */
export async function onDraft(ctx, user, msg, nowSec) {
  if (msg.media_group_id) return void (await send(ctx, 'bc.album', t(ctx.lang, 'bc.album')));
  await store.clearState(user.id);
  const id = await admin.createBroadcast(msg.chat.id, msg.message_id, user.id, nowSec);
  const n = await admin.countRecipients();
  await send(ctx, 'bc.confirm', t(ctx.lang, 'bc.confirm', { n }), [[
    { text: t(ctx.lang, 'bc.send'), callback_data: `a:bcy:${id}` },
    { text: t(ctx.lang, 'upload.cancel_btn'), callback_data: `a:bcn:${id}` },
  ]], { replyTo: msg.message_id });
}

function progress(ctx, b, waiting) {
  const status = b.status === 'running' && waiting ? 'waiting' : b.status;
  const text = `${t(ctx.lang, 'bc.progress', { id: String(b.id), sent: b.sent, failed: b.failed, total: b.total, status: t(ctx.lang, `bc.status.${status}`) })}\n\n${t(ctx.lang, 'bc.note', { n: BROADCAST_BATCH })}`;
  const kb = b.status === 'running'
    ? [[{ text: t(ctx.lang, 'bc.next'), callback_data: `a:bcx:${b.id}` }, { text: t(ctx.lang, 'bc.stop'), callback_data: `a:bcs:${b.id}` }]]
    : null;
  return [text, kb];
}

async function showProgress(ctx, id, msgId, waiting, nowSec) {
  const b = await admin.getBroadcast(id);
  if (!b) return;
  const [text, kb] = progress(ctx, b, waiting || b.retry_at > nowSec);
  await edit(ctx, 'bc.progress', msgId, text, kb);
}

/* Sends up to `limit` copies. Returns 'sent' | 'done' | 'waiting' | 'busy'. */
async function runBatch(ctx, b, limit, nowSec) {
  if (b.status !== 'running') return 'done';
  if (b.retry_at > nowSec) return 'waiting';
  const rows = await admin.recipientsAfter(b.cursor, limit);
  if (!rows.length) {
    if (await admin.setBroadcastStatus(b.id, 'running', 'done')) await finished(ctx, b.id);
    return 'done';
  }
  const to = rows[rows.length - 1].id;
  if (!(await admin.claimRange(b.id, b.cursor, to))) return 'busy';
  let sent = 0;
  let failed = 0;
  let last = b.cursor;
  let waiting = false;
  for (const r of rows) {
    try {
      await call(ctx, 'copyMessage', { chat_id: r.id, from_chat_id: b.src_chat, message_id: b.src_msg }, 'broadcast');
      sent += 1;
    } catch (err) {
      if (isApiError(err) && err.code === 429) {
        const wait = Number((err.parameters && err.parameters.retry_after) || 5);
        await admin.rewindRange(b.id, to, last, nowSec + wait);
        waiting = true;
        break;
      }
      if (isApiError(err) && err.code === 403) await admin.markBlocked(r.id);
      failed += 1;
    }
    last = r.id;
  }
  await admin.addBroadcastCounts(b.id, sent, failed);
  if (waiting) return 'waiting';
  if (rows.length < limit && (await admin.setBroadcastStatus(b.id, 'running', 'done'))) {
    await finished(ctx, b.id);
    return 'done';
  }
  return 'sent';
}

async function finished(ctx, id) {
  const b = await admin.getBroadcast(id);
  const lang = langOf(await store.getUser(b.created_by), null);
  await send(ctx, 'bc.finished', t(lang, 'bc.finished', { id: String(b.id), sent: b.sent, failed: b.failed }), null, { chatId: b.created_by });
}

/* a:bcy — start the draft and send the first batch on this press. */
export async function confirm(ctx, id, msgId, nowSec) {
  const total = await admin.countRecipients();
  if (!(await admin.startBroadcast(id, total))) {
    const b = await admin.getBroadcast(id);
    return void (await answer(ctx, t(ctx.lang, b && b.status === 'draft' ? 'bc.busy' : 'adm.done_already'), true));
  }
  ctx.broadcastDone = true;
  const result = await runBatch(ctx, await admin.getBroadcast(id), BROADCAST_BATCH, nowSec);
  await showProgress(ctx, id, msgId, result === 'waiting', nowSec);
  await answer(ctx);
}

/* a:bcn — drop a draft. */
export async function cancelDraft(ctx, id, msgId) {
  const ok = await admin.setBroadcastStatus(id, 'draft', 'cancelled');
  if (ok) await edit(ctx, 'bc.cancelled', msgId, t(ctx.lang, 'bc.cancelled'), null);
  await answer(ctx, ok ? t(ctx.lang, 'bc.cancelled') : t(ctx.lang, 'adm.done_already'), !ok);
}

/* a:bcx — the next batch. */
export async function nextBatch(ctx, id, msgId, nowSec) {
  ctx.broadcastDone = true;
  const b = await admin.getBroadcast(id);
  const result = b ? await runBatch(ctx, b, BROADCAST_BATCH, nowSec) : 'done';
  await showProgress(ctx, id, msgId, result === 'waiting', nowSec);
  await answer(ctx);
}

/* a:bcs — stop a running broadcast. */
export async function stop(ctx, id, msgId, nowSec) {
  await admin.setBroadcastStatus(id, 'running', 'cancelled');
  await showProgress(ctx, id, msgId, false, nowSec);
  await answer(ctx, t(ctx.lang, 'bc.status.cancelled'));
}

/* On the side of other updates: a few more copies while a broadcast runs. Never throws. */
export async function sideStep(ctx, nowSec) {
  if (ctx.broadcastDone) return;
  try {
    const b = await admin.runningBroadcast();
    if (b) await runBatch(ctx, b, BROADCAST_SIDE, nowSec);
  } catch (err) {
    console.warn(`broadcast side step failed: ${String((err && err.message) || err)}`);
  }
}
