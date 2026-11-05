// Broadcast to every user (owner only), as a queue in the database.
//
// There is no scheduler and Telegram limits how fast a bot may send, so a broadcast is a cursor
// over users (in id order) that advances in batches: BROADCAST_BATCH users per press of "▶️ ادامه
// ارسال", plus BROADCAST_TICK users whenever any other update wakes the bot. Each batch claims a
// lock first, so two updates never send to the same users. copyMessage keeps formatting and media.
//   403 (blocked the bot)  -> the user is marked inactive and never retried;
//   429 (too many requests) -> the batch stops; nothing is sent before retry_after has passed;
//   other errors            -> counted as failed.
import { BROADCAST_BATCH, BROADCAST_LOCK_SEC, BROADCAST_TICK, OWNER_ID } from './config.js';
import { answer, btn, call, describeError, edit, isApiError, send, show } from './tg.js';
import { fa, nowSec } from './text.js';
import * as store from './store.js';

const isOwner = (id) => id === OWNER_ID;

const STATUS = {
  draft: '📝 منتظر تأیید',
  running: '⏳ در حال ارسال',
  done: '✅ تمام شد',
  stopped: '⛔️ متوقف شد',
};

function duration(sec) {
  const s = Math.max(0, sec);
  if (s < 60) return `${fa(s)} ثانیه`;
  if (s < 3600) return `${fa(Math.floor(s / 60))} دقیقه و ${fa(s % 60)} ثانیه`;
  return `${fa(Math.floor(s / 3600))} ساعت و ${fa(Math.floor((s % 3600) / 60))} دقیقه`;
}

/** The progress (or final report) text and buttons for a broadcast. */
export function progressView(bc) {
  const handled = bc.sent + bc.failed;
  const remaining = bc.status === 'running' ? Math.max(0, bc.total - handled) : 0;
  const pct = bc.status === 'done' ? 100 : bc.total ? Math.min(100, Math.round((handled * 100) / bc.total)) : 0;
  const filled = Math.round(pct / 10);
  const now = nowSec();
  if (bc.status === 'done' || bc.status === 'stopped') {
    const took = bc.startedAt ? duration((bc.finishedAt || now) - bc.startedAt) : '—';
    return {
      text: `${bc.status === 'done' ? '✅ <b>پیام سراسری تمام شد</b>' : '⛔️ <b>پیام سراسری متوقف شد</b>'}\n\n`
        + `📨 ارسال موفق: ${fa(bc.sent)}\n`
        + `❌ ناموفق: ${fa(bc.failed)}${bc.blocked ? ` (🚫 ${fa(bc.blocked)} نفر ربات را بلاک کرده بودند و غیرفعال شدند)` : ''}\n`
        + (bc.status === 'stopped' ? `⏸ ارسال‌نشده: ${fa(Math.max(0, bc.total - handled))}\n` : '')
        + `⏱ مدت: ${took}`,
      kb: [[btn('📢 پیام سراسری جدید', 'ab'), btn('🔙 پنل مدیریت', 'a')]],
    };
  }
  const wait = bc.retryAt > now ? bc.retryAt - now : 0;
  const text = '📢 <b>پیام سراسری</b>\n\n'
    + `وضعیت: ${STATUS[bc.status] || bc.status}\n`
    + `✅ ارسال‌شده: ${fa(bc.sent)}\n`
    + `❌ ناموفق: ${fa(bc.failed)}${bc.blocked ? ` (🚫 بلاک: ${fa(bc.blocked)})` : ''}\n`
    + `⏳ باقی‌مانده: ${fa(remaining)}\n`
    + `پیشرفت: ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${fa(pct)}٪`
    + (wait ? `\n\n⏸ تلگرام سرعت ارسال را محدود کرد؛ ${fa(wait)} ثانیه بعد ادامه بدهید.` : '')
    + '\n\n<i>هر بار «ادامه ارسال» برای دسته‌ی بعدی می‌فرستد؛ با هر پیام دیگری که به ربات برسد هم چند نفر دیگر ارسال می‌شوند.</i>';
  return {
    text,
    kb: [[btn(`▶️ ادامه ارسال (${fa(BROADCAST_BATCH)} نفر)`, `bn:${bc.id}`), btn('⛔ توقف', `bx:${bc.id}`)], [btn('🔙 پنل مدیریت', 'a')]],
  };
}

async function updateProgress(ctx, bc) {
  const view = progressView(bc);
  if (bc.progressChat && bc.progressMsg && (await edit(ctx, 'bc_progress', bc.progressChat, bc.progressMsg, view.text, view.kb))) return;
  const msg = await send(ctx, 'bc_progress', view.text, view.kb, bc.progressChat || OWNER_ID);
  if (msg && msg.message_id) await store.setBroadcastProgressMessage(bc.id, msg.chat ? msg.chat.id : OWNER_ID, msg.message_id);
}

export async function promptBroadcast(ctx) {
  if (!isOwner(ctx.userId)) return null;
  const bc = await store.runningBroadcast();
  if (bc) {
    const view = progressView(bc);
    return show(ctx, 'bc_progress', `ℹ️ یک پیام سراسری در حال ارسال است؛ تا تمام یا متوقف نشود، پیام جدید شروع نمی‌شود.\n\n${view.text}`, view.kb);
  }
  await store.setState(ctx.userId, 'admin_bc');
  return show(ctx, 'bc_prompt',
    '📢 <b>پیام سراسری</b>\n\nپیامی را که می‌خواهید برای همه‌ی کاربران فرستاده شود همین‌جا بفرستید: '
    + 'متن، عکس، ویدیو، فایل یا هر پیام با کپشن. قالب‌بندی و رسانه همان‌طور که هست کپی می‌شود.\n\n'
    + '• آلبوم (چند رسانه با هم) پشتیبانی نمی‌شود.\n'
    + '• متن نباید با / شروع شود.\n'
    + '• قبل از ارسال، پیش‌نمایش و دکمه‌ی تأیید نشان داده می‌شود.',
    [[btn('❌ انصراف', 'a')]]);
}

/** The owner sent the message to broadcast: save a draft, show a preview, ask to confirm. */
export async function broadcastInput(ctx, message) {
  if (!isOwner(ctx.userId)) return null;
  if (message.media_group_id) {
    return send(ctx, 'bc_album', '⚠️ آلبوم پشتیبانی نمی‌شود. یک پیام تکی بفرستید:', [[btn('❌ انصراف', 'a')]]);
  }
  await store.clearState(ctx.userId);
  if (await store.runningBroadcast()) return promptBroadcast(ctx);
  const counters = await store.getCounters();
  const total = Math.max(0, counters.users_active - 1); // everyone reachable but the owner
  if (!total) return send(ctx, 'bc_no_users', 'ℹ️ هنوز کاربری غیر از شما ندارید که پیام برایش فرستاده شود.', [[btn('🔙 پنل مدیریت', 'a')]]);
  const id = await store.createBroadcast(message.chat.id, message.message_id);
  try {
    await call(ctx, 'copyMessage', { chat_id: ctx.chatId, from_chat_id: message.chat.id, message_id: message.message_id }, 'bc_preview');
  } catch (err) {
    await store.stopBroadcast(id);
    return send(ctx, 'bc_uncopyable', `⚠️ این پیام قابل کپی نیست (<code>${describeError(err)}</code>). پیام دیگری بفرستید.`, [[btn('🔙 پنل مدیریت', 'a')]]);
  }
  return send(ctx, 'bc_confirm',
    `👆 <b>پیش‌نمایش پیام سراسری</b>\n\nبرای حدود ${fa(total)} کاربر فرستاده شود؟\n`
    + `ارسال دسته‌ای است (هر دسته ${fa(BROADCAST_BATCH)} نفر) و پیشرفتش همین‌جا نشان داده می‌شود.`,
    [[btn('✅ تأیید و ارسال', `bs:${id}`), btn('❌ لغو', `bx:${id}`)]]);
}

async function gone(ctx) {
  await answer(ctx, '⚠️ این پیام سراسری پیدا نشد.', true);
  return null;
}

export async function beginBroadcast(ctx, id) {
  if (!isOwner(ctx.userId)) return null;
  const bc = await store.getBroadcast(id);
  if (!bc) return gone(ctx);
  if (bc.status === 'draft') {
    const counters = await store.getCounters();
    const started = await store.startBroadcast(id, {
      total: Math.max(0, counters.users_active - 1),
      progressChat: ctx.chatId,
      progressMsg: ctx.messageId,
    });
    if (!started) {
      await answer(ctx, '⚠️ یک پیام سراسری دیگر در حال ارسال است.', true);
      return promptBroadcast(ctx);
    }
  }
  return sendBatch(ctx, id, BROADCAST_BATCH);
}

/**
 * Sends up to `limit` copies. `quiet` (the opportunistic chunk while handling someone else's
 * update) answers nothing and only refreshes the owner's progress message.
 */
export async function sendBatch(ctx, id, limit = BROADCAST_BATCH, { quiet = false } = {}) {
  if (!quiet && !isOwner(ctx.userId)) return null;
  let bc = await store.getBroadcast(id);
  if (!bc) return quiet ? null : gone(ctx);
  if (bc.status !== 'running') {
    if (quiet) return null;
    await answer(ctx, `این پیام سراسری ${STATUS[bc.status] || bc.status}.`);
    const view = progressView(bc);
    return show(ctx, 'bc_progress', view.text, view.kb);
  }
  if (!(await store.lockBroadcast(id, BROADCAST_LOCK_SEC))) {
    if (quiet) return null;
    const now = nowSec();
    if (bc.retryAt > now) await answer(ctx, `⏸ تلگرام سرعت را محدود کرده؛ ${fa(bc.retryAt - now)} ثانیه دیگر دوباره بزنید.`, true);
    else await answer(ctx, '⏳ دسته‌ی قبلی هنوز در حال ارسال است؛ چند ثانیه بعد دوباره بزنید.', true);
    return null;
  }
  bc = await store.getBroadcast(id); // re-read under the lock
  const users = await store.recipientsAfter(bc.cursor, limit + 1, OWNER_ID);
  const batch = users.slice(0, limit);
  let { cursor, sent, failed, blocked } = bc;
  let retryAt = 0;
  let interrupted = false;
  for (const uid of batch) {
    try {
      await call(ctx, 'copyMessage', { chat_id: uid, from_chat_id: bc.fromChat, message_id: bc.messageId }, 'bc_copy');
      sent += 1;
    } catch (err) {
      if (isApiError(err) && err.code === 429) {
        retryAt = nowSec() + Math.max(1, Number((err.parameters && err.parameters.retry_after) || 5));
        interrupted = true;
        break; // this user is retried after the wait
      }
      if (!isApiError(err)) {
        console.warn(`broadcast to ${uid} failed: ${describeError(err)}`);
        interrupted = true;
        break; // a network problem: retry this user in the next batch
      }
      failed += 1;
      if (err.code === 403) {
        blocked += 1;
        await store.markInactive(uid);
      }
    }
    cursor = uid;
  }
  const done = !interrupted && users.length <= limit;
  await store.saveBroadcastProgress(id, { cursor, sent, failed, blocked, done, retryAt });
  const after = await store.getBroadcast(id);
  await updateProgress(ctx, after);
  if (after.status === 'done') {
    const view = progressView(after);
    await send(ctx, 'bc_report', view.text, view.kb, after.progressChat || OWNER_ID);
  }
  if (!quiet) {
    const n = (sent + failed) - (bc.sent + bc.failed);
    if (retryAt) await answer(ctx, `⏸ تلگرام سرعت را محدود کرد. ${fa(retryAt - nowSec())} ثانیه بعد «ادامه ارسال» را بزنید.`, true);
    else if (interrupted) await answer(ctx, '⚠️ این دسته نیمه‌کاره ماند؛ دوباره بزنید تا از همان‌جا ادامه دهد.', true);
    else await answer(ctx, done ? '✅ ارسال تمام شد' : `✅ این دسته: ${fa(n)} نفر`);
  }
  return after;
}

export async function stopBroadcast(ctx, id) {
  if (!isOwner(ctx.userId)) return null;
  const bc = await store.getBroadcast(id);
  if (!bc) return gone(ctx);
  const stopped = await store.stopBroadcast(id);
  await answer(ctx, stopped ? (bc.status === 'draft' ? '❌ لغو شد' : '⛔️ ارسال متوقف شد') : 'این پیام سراسری قبلاً تمام یا متوقف شده است.');
  if (stopped && bc.status === 'draft') return show(ctx, 'bc_cancelled', '❌ پیام سراسری لغو شد.', [[btn('🔙 پنل مدیریت', 'a')]]);
  const after = await store.getBroadcast(id);
  const view = progressView(after);
  if (after.progressMsg && after.progressMsg !== ctx.messageId) await updateProgress(ctx, after);
  return show(ctx, 'bc_progress', view.text, view.kb);
}

/** A small chunk of a running broadcast, while the bot is awake for another update. Never throws. */
export async function tick(ctx) {
  try {
    const bc = await store.runningBroadcast();
    const now = nowSec();
    if (!bc || bc.retryAt > now || bc.lockedUntil > now) return;
    await sendBatch(ctx, bc.id, BROADCAST_TICK, { quiet: true });
  } catch (err) {
    console.warn(`broadcast tick failed: ${describeError(err)}`);
  }
}
