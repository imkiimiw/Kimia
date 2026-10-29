// Owner panel: mandatory channels (list / add / remove, at most 10), the join on/off switch and
// broadcasts to every user.
// The router lets only OWNER_ID (by numeric from.id) reach these functions, and every one of
// them checks again, so a forged callback or a stale state can never act for someone else.
import { MAX_CHANNELS, OWNER_ID } from './config.js';
import { channelRef } from './join.js';
import { answer, btn, call, describeError, isApiError, send, show } from './tg.js';
import { asciiDigits, esc, fa, short } from './text.js';
import { menuBtn } from './ui.js';
import * as store from './store.js';

/** callback_data actions that belong to the owner panel. */
export const ADMIN_ACTIONS = new Set(['a', 'al', 'aa', 'ar', 'ary', 'at', 'ab', 'bs', 'bn', 'bx']);

export const isOwner = (userId) => userId === OWNER_ID;

async function botId(ctx) {
  if (!ctx.botId) ctx.botId = (await call(ctx, 'getMe', {})).id;
  return ctx.botId;
}

const isAdminStatus = (m) => !!m && (m.status === 'administrator' || m.status === 'creator');

const withNotice = (notice, text) => (notice ? `${notice}\n\n${text}` : text);

export async function showPanel(ctx, notice) {
  if (!isOwner(ctx.userId)) return null;
  const settings = await store.getSettings();
  const channels = await store.getChannels(settings);
  const joinOn = settings.join !== '0';
  const bc = await store.latestBroadcast();
  const running = !!bc && bc.status === 'running';
  const text = '👑 <b>پنل مدیریت</b>\n\n'
    + `🔒 عضویت اجباری: ${joinOn ? '✅ روشن' : '⛔️ خاموش'}\n`
    + `📢 کانال‌ها: ${fa(channels.length)} از ${fa(MAX_CHANNELS)}\n`
    + `👥 کاربران: ${fa(Number(settings.users || 0))}`
    + (running ? `\n📣 پیام همگانی در حال ارسال: ${fa(bc.sent + bc.failed)} از ${fa(bc.total)}` : '');
  return show(ctx, 'admin_panel', withNotice(notice, text), [
    [btn('📢 کانال‌ها', 'al'), btn('➕ افزودن کانال', 'aa')],
    [btn(running ? '📣 ادامه‌ی پیام همگانی' : '📣 پیام همگانی', 'ab')],
    [btn(joinOn ? '⛔️ خاموش کردن عضویت اجباری' : '✅ روشن کردن عضویت اجباری', 'at')],
    [menuBtn()],
  ]);
}

/** Lists the channels and whether the bot is an admin in each (otherwise membership can't be checked). */
export async function showChannels(ctx, notice) {
  if (!isOwner(ctx.userId)) return null;
  const channels = await store.getChannels(await store.getSettings());
  let text = `📢 <b>کانال‌های عضویت اجباری</b> (${fa(channels.length)} از ${fa(MAX_CHANNELS)})\n\n`;
  if (!channels.length) {
    text += 'هیچ کانالی ثبت نشده؛ فعلاً عضویت اجباری از هیچ‌کس خواسته نمی‌شود.';
  } else {
    const me = await botId(ctx);
    const status = await Promise.all(channels.map(async (ch) => {
      try {
        const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: me });
        return isAdminStatus(m) ? '✅' : '⚠️ ربات ادمین نیست';
      } catch (err) {
        return `❌ بررسی نشد: <code>${esc(describeError(err))}</code>`;
      }
    }));
    text += channels.map((ch, i) => {
      const name = ch.title ? `${esc(ch.title)} — @${esc(ch.username)}` : `@${esc(ch.username)}`;
      return `${fa(i + 1)}. ${name} ${status[i]}`;
    }).join('\n');
    text += '\n\n✅ = ربات ادمین است و عضویت بررسی می‌شود.\n'
      + '⚠️ / ❌ = عضویت در این کانال بررسی نمی‌شود (کاربران به‌خاطر آن قفل نمی‌شوند).';
  }
  const kb = channels.map((ch) => [btn(`❌ حذف @${short(ch.username, 24)}`, `ar:${ch.id}`)]);
  kb.push([btn('➕ افزودن کانال', 'aa'), btn('🔙 پنل', 'a')]);
  return show(ctx, 'admin_channels', withNotice(notice, text), kb);
}

function limitScreen(ctx) {
  return show(ctx, 'admin_channel_limit',
    `⛔️ <b>سقف کانال‌ها پر است</b>\n\nحداکثر ${fa(MAX_CHANNELS)} کانال می‌توانید داشته باشید و الان ${fa(MAX_CHANNELS)} کانال ثبت شده است. `
    + 'برای افزودن کانال جدید، اول یکی را حذف کنید.',
    [[btn('📢 کانال‌ها', 'al'), btn('🔙 پنل', 'a')]]);
}

export async function promptAddChannel(ctx) {
  if (!isOwner(ctx.userId)) return null;
  if ((await store.countChannels()) >= MAX_CHANNELS) {
    await answer(ctx, `⛔️ سقف ${fa(MAX_CHANNELS)} کانال پر است.`, true);
    return limitScreen(ctx);
  }
  await store.setState(ctx.userId, 'admin_add');
  return show(ctx, 'admin_add_prompt',
    '➕ <b>افزودن کانال</b>\n\nیوزرنیم یا لینک کانال را بفرستید:\n<code>@mychannel</code>\n<code>https://t.me/mychannel</code>\n\n'
    + '⚠️ قبل از آن، ربات را در کانال <b>ادمین</b> کنید.',
    [[btn('❌ انصراف', 'a')]]);
}

/**
 * @username, username, t.me/username or https://t.me/s/username -> { username }.
 * Invite links (t.me/+..., t.me/joinchat/...) -> { error: 'private' }; anything else -> { error: 'invalid' }.
 */
export function parseChannelInput(input) {
  let s = asciiDigits(String(input)).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const link = s.match(/^(?:t\.me|telegram\.me|telegram\.dog)\/(.*)$/i);
  if (link) {
    let path = link[1].split(/[?#]/)[0];
    if (/^(\+|joinchat\/)/i.test(path)) return { error: 'private' };
    if (/^s\//i.test(path)) path = path.slice(2);
    s = path.split('/')[0];
  } else if (s.startsWith('@')) {
    s = s.slice(1);
  }
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? { username: s } : { error: 'invalid' };
}

/** The owner sent a channel while the panel waits for one: validate it with Telegram, then save. */
export async function addChannelInput(ctx, text) {
  if (!isOwner(ctx.userId)) return null;
  const retry = [[btn('❌ انصراف', 'a')]];
  const parsed = parseChannelInput(text);
  if (parsed.error === 'private') {
    return send(ctx, 'admin_add_invalid',
      '⚠️ لینک دعوت خصوصی قابل بررسی نیست. یوزرنیم عمومی کانال را بفرستید، مثل <code>@mychannel</code>', retry);
  }
  if (parsed.error) {
    return send(ctx, 'admin_add_invalid',
      '⚠️ یوزرنیم یا لینک معتبر نیست.\nنمونه: <code>@mychannel</code> یا <code>https://t.me/mychannel</code>', retry);
  }
  const { username } = parsed;

  if ((await store.countChannels()) >= MAX_CHANNELS) {
    await store.clearState(ctx.userId);
    return limitScreen(ctx);
  }
  if (await store.findChannelByName(username)) {
    await store.clearState(ctx.userId);
    return showChannels(ctx, `ℹ️ کانال @${esc(username)} از قبل در لیست هست.`);
  }

  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: `@${username}` });
  } catch {
    return send(ctx, 'admin_add_not_found', `⚠️ کانالی با یوزرنیم @${esc(username)} پیدا نشد. یوزرنیم را بررسی کنید و دوباره بفرستید:`, retry);
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') {
    return send(ctx, 'admin_add_not_channel', `⚠️ @${esc(username)} کانال نیست. یوزرنیم یک کانال را بفرستید:`, retry);
  }
  const title = chat.title || username;
  let member = null;
  try {
    member = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: await botId(ctx) });
  } catch {
    member = null;
  }
  if (!isAdminStatus(member)) {
    return send(ctx, 'admin_add_not_admin',
      `⚠️ ربات در «${esc(title)}» ادمین نیست، پس نمی‌تواند عضویت کاربران را بررسی کند.\nاول ربات را در کانال ادمین کنید، بعد دوباره یوزرنیم را بفرستید:`,
      retry);
  }

  const saved = await store.insertChannel({ username: chat.username || username, chatId: chat.id, title });
  await store.clearState(ctx.userId);
  if (!saved) return showChannels(ctx, `ℹ️ کانال @${esc(username)} از قبل در لیست هست.`);
  return showChannels(ctx, `✅ کانال «${esc(title)}» (@${esc(chat.username || username)}) اضافه شد.`);
}

export async function confirmRemoveChannel(ctx, channelId) {
  if (!isOwner(ctx.userId)) return null;
  const ch = await store.getChannel(channelId);
  if (!ch) {
    await answer(ctx, '⚠️ این کانال در لیست نیست.', true);
    return showChannels(ctx);
  }
  return show(ctx, 'admin_remove_confirm', `❌ کانال @${esc(ch.username)} از عضویت اجباری حذف شود؟`,
    [[btn('✅ بله، حذف کن', `ary:${ch.id}`), btn('❌ نه', 'al')]]);
}

export async function removeChannel(ctx, channelId) {
  if (!isOwner(ctx.userId)) return null;
  const ch = await store.getChannel(channelId);
  const ok = ch ? await store.deleteChannel(ch.id) : false;
  // Once the owner edits the list, the defaults must never come back on their own.
  await store.setSetting('seeded', '1');
  await answer(ctx, ok ? '🗑 کانال حذف شد' : '⚠️ این کانال در لیست نیست.', !ok);
  return showChannels(ctx, ok ? `🗑 کانال @${esc(ch.username)} حذف شد.` : undefined);
}

export async function toggleJoin(ctx) {
  if (!isOwner(ctx.userId)) return null;
  const settings = await store.getSettings();
  const next = settings.join === '0' ? '1' : '0';
  await store.setSetting('join', next);
  await answer(ctx, next === '1' ? '✅ عضویت اجباری روشن شد' : '⛔️ عضویت اجباری خاموش شد');
  return showPanel(ctx);
}

// ---------- broadcast to every user ----------
// There is no scheduler, so a broadcast is sent in batches: each press of "next batch" copies the
// message to the next BROADCAST_BATCH users (in user-id order) and saves where it stopped.

const BROADCAST_BATCH = 25; // well under Telegram's ~30 messages per second

const BROADCAST_STATUS = {
  draft: '📝 منتظر تأیید',
  running: '⏳ در حال ارسال',
  done: '✅ تمام شد',
  stopped: '⛔️ متوقف شد',
};

export async function showBroadcast(ctx, bc, notice) {
  if (!isOwner(ctx.userId)) return null;
  const handled = bc.sent + bc.failed;
  const pct = bc.total ? Math.min(100, Math.round((handled * 100) / bc.total)) : (bc.status === 'done' ? 100 : 0);
  const filled = Math.round(pct / 10);
  const text = '📣 <b>پیام همگانی</b>\n\n'
    + `وضعیت: ${BROADCAST_STATUS[bc.status] || bc.status}\n`
    + `✅ ارسال‌شده: ${fa(bc.sent)}\n`
    + `❌ ناموفق: ${fa(bc.failed)}\n`
    + `👥 کل کاربران: ${fa(bc.total)}\n`
    + `پیشرفت: ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${fa(pct)}٪\n\n`
    + '<i>ناموفق یعنی کاربر ربات را بلاک کرده یا حسابش حذف شده است.</i>';
  let kb;
  if (bc.status === 'running') {
    kb = [
      [btn(`▶️ ارسال دسته‌ی بعدی (${fa(BROADCAST_BATCH)} نفر)`, `bn:${bc.id}`)],
      [btn('⛔️ توقف ارسال', `bx:${bc.id}`), btn('🔙 پنل', 'a')],
    ];
  } else if (bc.status === 'draft') {
    kb = [[btn('✅ شروع ارسال', `bs:${bc.id}`), btn('❌ لغو', `bx:${bc.id}`)]];
  } else {
    kb = [[btn('📣 پیام همگانی جدید', 'ab'), btn('🔙 پنل', 'a')]];
  }
  return show(ctx, 'admin_broadcast', withNotice(notice, text), kb);
}

export async function promptBroadcast(ctx) {
  if (!isOwner(ctx.userId)) return null;
  const bc = await store.latestBroadcast();
  if (bc && bc.status === 'running') {
    return showBroadcast(ctx, bc, 'ℹ️ یک پیام همگانی در حال ارسال است. ادامه‌اش بدهید یا متوقفش کنید، بعد پیام جدید بفرستید.');
  }
  await store.setState(ctx.userId, 'admin_bc');
  return show(ctx, 'admin_bc_prompt',
    '📣 <b>پیام همگانی</b>\n\nپیامی را که می‌خواهید برای همه‌ی کاربران فرستاده شود همین‌جا بفرستید: '
    + 'متن، عکس، ویدیو، فایل، صدا یا یک پیام فورواردی.\n\n'
    + '• آلبوم (چند عکس با هم) پشتیبانی نمی‌شود.\n'
    + '• متن نباید با / شروع شود.\n'
    + '• پیام فورواردی بدون نام فرستنده‌ی اصلی کپی می‌شود.',
    [[btn('❌ انصراف', 'a')]]);
}

/** The owner sent the message to broadcast: save it as a draft and ask for confirmation. */
export async function broadcastInput(ctx, message) {
  if (!isOwner(ctx.userId)) return null;
  if (message.media_group_id) {
    return send(ctx, 'admin_bc_album', '⚠️ آلبوم پشتیبانی نمی‌شود. یک پیام تکی بفرستید:', [[btn('❌ انصراف', 'a')]]);
  }
  const settings = await store.getSettings();
  const total = Math.max(0, Number(settings.users || 0) - 1); // everyone but the owner
  await store.clearState(ctx.userId);
  if (!total) return showPanel(ctx, 'ℹ️ هنوز کاربری غیر از شما ندارید که پیام برایش فرستاده شود.');
  const id = await store.createBroadcast(message.chat.id, message.message_id, total);
  return send(ctx, 'admin_bc_confirm',
    `📣 پیام بالا برای ${fa(total)} کاربر فرستاده شود؟\n\n`
    + `ارسال دسته‌ای است: با هر بار زدن «▶️ ارسال دسته‌ی بعدی»، برای ${fa(BROADCAST_BATCH)} کاربر بعدی فرستاده می‌شود.`,
    [[btn('✅ بله، شروع کن', `bs:${id}`), btn('❌ لغو', `bx:${id}`)]]);
}

async function broadcastGone(ctx) {
  await answer(ctx, '⚠️ این پیام همگانی پیدا نشد.', true);
  return showPanel(ctx);
}

export async function beginBroadcast(ctx, id) {
  if (!isOwner(ctx.userId)) return null;
  const bc = await store.getBroadcast(id);
  if (!bc) return broadcastGone(ctx);
  if (bc.status === 'draft') await store.startBroadcast(id);
  return sendBatch(ctx, id);
}

/** Sends the next batch. Users who blocked the bot count as failed; a 429 or a network error stops
 *  the batch at that user, so the next press resumes there and nobody gets the message twice. */
export async function sendBatch(ctx, id) {
  if (!isOwner(ctx.userId)) return null;
  let bc = await store.getBroadcast(id);
  if (!bc) return broadcastGone(ctx);
  if (bc.status !== 'running') {
    await answer(ctx, `این پیام همگانی ${BROADCAST_STATUS[bc.status] || bc.status}.`);
    return showBroadcast(ctx, bc);
  }
  if (!(await store.lockBroadcast(id))) {
    await answer(ctx, '⏳ دسته‌ی قبلی هنوز در حال ارسال است؛ چند ثانیه بعد دوباره بزنید.', true);
    return null;
  }
  bc = await store.getBroadcast(id); // re-read under the lock
  const users = await store.usersAfter(bc.lastUser, BROADCAST_BATCH + 1);
  const batch = users.slice(0, BROADCAST_BATCH);
  let { lastUser, sent, failed } = bc;
  let interrupted = false;
  let retryAfter = 0;
  for (const uid of batch) {
    if (uid !== OWNER_ID) {
      try {
        await call(ctx, 'copyMessage', { chat_id: uid, from_chat_id: bc.fromChat, message_id: bc.messageId });
        sent += 1;
      } catch (err) {
        if (isApiError(err) && err.code === 429) {
          retryAfter = Number((err.parameters && err.parameters.retry_after) || 5);
          interrupted = true;
          break;
        }
        if (!isApiError(err)) {
          console.warn(`broadcast to ${uid} failed: ${describeError(err)}`);
          interrupted = true;
          break;
        }
        failed += 1; // blocked, deactivated, chat not found: this user can't receive it
      }
    }
    lastUser = uid;
  }
  const done = !interrupted && users.length <= BROADCAST_BATCH;
  await store.saveBroadcastProgress(id, { lastUser, sent, failed, done });
  const thisBatch = (sent + failed) - (bc.sent + bc.failed);
  if (retryAfter) await answer(ctx, `⏳ تلگرام سرعت ارسال را محدود کرد. ${fa(retryAfter)} ثانیه صبر کنید و دوباره بزنید.`, true);
  else if (interrupted) await answer(ctx, '⚠️ ارسال این دسته نیمه‌کاره ماند؛ دوباره بزنید تا از همان‌جا ادامه دهد.', true);
  else await answer(ctx, done ? '✅ ارسال پیام همگانی تمام شد' : `✅ این دسته: ${fa(thisBatch)} کاربر`);
  return showBroadcast(ctx, await store.getBroadcast(id));
}

export async function stopBroadcast(ctx, id) {
  if (!isOwner(ctx.userId)) return null;
  const bc = await store.getBroadcast(id);
  if (!bc) return broadcastGone(ctx);
  const stopped = await store.stopBroadcast(id);
  await answer(ctx, stopped ? (bc.status === 'draft' ? '❌ لغو شد' : '⛔️ ارسال متوقف شد') : 'این پیام همگانی قبلاً تمام یا متوقف شده است.');
  if (stopped && bc.status === 'draft') return showPanel(ctx, '❌ پیام همگانی لغو شد.');
  return showBroadcast(ctx, await store.getBroadcast(id));
}
