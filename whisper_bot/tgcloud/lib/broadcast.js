// Owner broadcasts as a database queue (there is no scheduler): the users after broadcasts.last_user
// in idx_users_reachable order are still to do. Each "▶️ ادامه ارسال" press sends one batch of
// BC_BATCH; every other update also sends a chunk of BC_CHUNK on the side, so a broadcast keeps
// moving while the bot is in use. A lock row field keeps concurrent updates from sending twice.
//   403 → the user blocked the bot: marked inactive, never retried.
//   429 → stop this batch, wait parameters.retry_after seconds; that user is retried later.
//   anything else → counted as failed.
import {
  BC_CHUNK, BC_LOCK_SEC, BC_PROGRESS_EVERY_SEC, OWNER_ID,
} from './config.js';
import {
  getBroadcast, lockBroadcast, markInactive, reachableAfter, saveBroadcastProgress, setBroadcastStatus,
  setKv, touchBroadcastProgress, unlockBroadcast,
} from './store.js';
import {
  btn, call, describeError, isApiError, send,
} from './tg.js';
import { fa, faDuration, nowSec } from './util.js';

const STATUS = {
  draft: '📝 پیش‌نویس',
  running: '⏳ در حال ارسال',
  done: '✅ تمام شد',
  stopped: '⛔ متوقف شد',
  cancelled: '❌ لغو شد',
};

const processed = (b) => b.sent + b.failed + b.blocked;

export function progressView(b) {
  const now = nowSec();
  const remaining = b.status === 'running' ? Math.max(0, b.total - processed(b)) : 0;
  const lines = [
    `📢 <b>پیام سراسری #${fa(b.id)}</b>`,
    `وضعیت: ${STATUS[b.status] || b.status}`,
    '',
    `✅ ارسال‌شده: ${fa(b.sent)}`,
    `❌ ناموفق: ${fa(b.failed + b.blocked)}${b.blocked ? ` (🚫 ربات را بلاک کرده: ${fa(b.blocked)})` : ''}`,
    `⏳ باقی‌مانده: ${fa(remaining)}`,
  ];
  if (b.status === 'running' && b.nextAt > now) lines.push('', `⏸ محدودیت سرعت تلگرام: ${fa(b.nextAt - now)} ثانیه‌ی دیگر ادامه بده.`);
  if (b.status === 'running') lines.push('', 'هر بار «▶️ ادامه ارسال» حدود ۲۵ نفر را می‌فرستد؛ استفاده‌ی بقیه از ربات هم کم‌کم جلو می‌بردش.');
  const kb = b.status === 'running'
    ? [[btn('▶️ ادامه ارسال', `a:bcc:${b.id}`), btn('⛔ توقف', `a:bcs:${b.id}`)], [btn('🔙 پنل', 'a')]]
    : [[btn('🔙 پنل', 'a')]];
  return { text: lines.join('\n'), kb };
}

/**
 * Sends up to `limit` messages of a running broadcast. Returns
 * { ran: false, reason: 'not_running' | 'wait' | 'locked', b } or { ran: true, done, limited, b }.
 */
export async function processBatch(ctx, id, limit) {
  if (!(await lockBroadcast(id, BC_LOCK_SEC))) {
    const b = await getBroadcast(id);
    let reason = 'locked';
    if (!b || b.status !== 'running') reason = 'not_running';
    else if (b.nextAt > nowSec()) reason = 'wait';
    return { ran: false, reason, b };
  }
  const b = await getBroadcast(id);
  let limited = false;
  let done = false;
  try {
    const ids = await reachableAfter(b.lastUser, limit);
    for (const uid of ids) {
      if (uid === OWNER_ID) {
        b.lastUser = uid; // the owner saw the preview; not a recipient
        continue;
      }
      try {
        await call(ctx, 'copyMessage', { chat_id: uid, from_chat_id: b.fromChat, message_id: b.messageId }, 'broadcast');
        b.sent += 1;
      } catch (err) {
        if (isApiError(err) && err.code === 429) {
          const wait = Number((err.parameters && err.parameters.retry_after) || 5);
          b.nextAt = nowSec() + Math.max(1, wait);
          limited = true;
          break; // this user is not done: retried after the wait
        }
        if (isApiError(err) && err.code === 403) {
          await markInactive(uid);
          b.blocked += 1;
        } else {
          console.warn(`broadcast to ${uid} failed: ${describeError(err)}`);
          b.failed += 1;
        }
      }
      b.lastUser = uid;
      await saveBroadcastProgress(b); // after every send: a killed batch never resends
    }
    if (!limited && ids.length < limit) done = true;
    await saveBroadcastProgress(b);
    if (done && (await setBroadcastStatus(id, 'running', 'done'))) {
      b.status = 'done';
      b.finishedAt = nowSec();
      await setKv('bc', null);
    }
  } finally {
    await unlockBroadcast(id);
  }
  return { ran: true, done, limited, b };
}

/** Edits the progress message (the one with the ▶️/⛔ buttons). */
export async function updateProgress(ctx, b) {
  if (!b.progressChat || !b.progressMsg) return;
  const { text, kb } = progressView(b);
  try {
    await call(ctx, 'editMessageText', {
      chat_id: b.progressChat,
      message_id: b.progressMsg,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kb },
    }, 'broadcast_progress');
  } catch (err) {
    if (!/message is not modified/i.test(isApiError(err) ? err.description : '')) {
      console.warn(`broadcast progress edit failed: ${describeError(err)}`);
    }
  }
  await touchBroadcastProgress(b.id);
}

/** The final report, as a new message so the owner is notified. */
export async function finalReport(ctx, b) {
  const took = b.finishedAt && b.createdAt ? `\n⏱ مدت: ${faDuration(b.finishedAt - b.createdAt)}` : '';
  await send(ctx, 'broadcast_report',
    `🏁 <b>گزارش نهایی پیام سراسری #${fa(b.id)}</b> — ${STATUS[b.status] || b.status}\n\n`
    + `✅ ارسال‌شده: ${fa(b.sent)}\n`
    + `❌ ناموفق: ${fa(b.failed)}\n`
    + `🚫 ربات را بلاک کرده (غیرفعال شدند): ${fa(b.blocked)}${took}`,
    [[btn('🔙 پنل', 'a')]], OWNER_ID);
}

/** A small chunk on the side of another update; never throws. */
export async function broadcastTick(ctx, id) {
  try {
    const r = await processBatch(ctx, id, BC_CHUNK);
    if (!r.ran) {
      if (r.reason === 'not_running') await setKv('bc', null);
      return;
    }
    if (r.done) {
      await updateProgress(ctx, r.b);
      await finalReport(ctx, r.b);
    } else if (nowSec() - r.b.progressAt >= BC_PROGRESS_EVERY_SEC) {
      await updateProgress(ctx, r.b);
    }
  } catch (err) {
    console.warn(`broadcast tick failed: ${describeError(err)}`);
  }
}
