// Owner panel. The router calls these only after checking from.id === OWNER_ID in a private chat,
// for every command and every button. Stats are counts only: no whisper content is ever shown here.
import { BC_BATCH, MAX_CHANNELS, OWNER_ID } from './config.js';
import { botInfo } from './bot.js';
import { finalReport, processBatch, progressView } from './broadcast.js';
import { channelRef } from './join.js';
import {
  addChannel, bumpChannelVersion, clearState, countChannels, createBroadcast, getBroadcast, getChannel,
  getChannels, getUser, removeChannel, runningBroadcast, setBanned, setBroadcastStatus, setKv,
  setBroadcastProgressMessage, setState, startBroadcast, stats,
} from './store.js';
import {
  answer, btn, call, describeError, isApiError, send, show,
} from './tg.js';
import { esc, fa, nowSec, toAsciiDigits, truncate } from './util.js';

const toPanel = [btn('🔙 پنل', 'a')];

export async function showPanel(ctx, kv) {
  const n = await countChannels();
  const joinOn = kv.join !== '0';
  const running = kv.bc ? await getBroadcast(Number(kv.bc)) : null;
  const kb = [
    [btn('📋 کانال‌ها', 'a:ch'), btn('➕ افزودن کانال', 'a:add')],
    [btn(`🔁 عضویت اجباری: ${joinOn ? 'روشن ✅' : 'خاموش ❌'}`, 'a:j')],
    [btn('⛔ بن کاربر', 'a:ban'), btn('✅ آنبن کاربر', 'a:unban')],
    [btn('📊 آمار', 'a:st')],
    [running && running.status === 'running'
      ? btn(`📢 پیام سراسری در حال ارسال (#${running.id})`, `a:bcp:${running.id}`)
      : btn('📢 پیام سراسری', 'a:bc')],
  ];
  return show(ctx, 'admin_panel',
    '👑 <b>پنل مالک</b>\n\n'
    + `🔒 عضویت اجباری: ${joinOn ? 'روشن' : 'خاموش'}\n`
    + `📢 کانال‌ها: ${fa(n)} از ${fa(MAX_CHANNELS)}`, kb);
}

// ---------- channels ----------

/** Lists the channels with whether the bot is an admin there (one getChatMember each, in parallel). */
export async function showChannels(ctx, kv, note = '') {
  const channels = await getChannels(kv);
  const bot = await botInfo(ctx, kv);
  const status = await Promise.all(channels.map(async (ch) => {
    if (!bot.id) return '❓';
    try {
      const m = await call(ctx, 'getChatMember', { chat_id: channelRef(ch), user_id: bot.id }, 'admin_check');
      return m.status === 'administrator' || m.status === 'creator' ? '✅ ربات ادمین است' : '⚠️ ربات ادمین نیست';
    } catch (err) {
      return `⚠️ ${esc(truncate(isApiError(err) ? err.description : describeError(err), 60))}`;
    }
  }));
  const lines = channels.map((ch, i) => `${fa(i + 1)}. @${esc(ch.username)} — ${esc(truncate(ch.title, 40))}\n     ${status[i]}`);
  const kb = channels.map((ch) => [btn(`❌ حذف @${ch.username}`.slice(0, 60), `a:rm:${ch.id}`)]);
  if (channels.length < MAX_CHANNELS) kb.push([btn('➕ افزودن کانال', 'a:add')]);
  kb.push(toPanel);
  const off = kv.join === '0' ? '\n\n⚠️ عضویت اجباری الان خاموش است.' : '';
  return show(ctx, 'admin_channels',
    `${note ? `${note}\n\n` : ''}📋 <b>کانال‌های عضویت اجباری</b> (${fa(channels.length)} از ${fa(MAX_CHANNELS)})\n\n`
    + `${lines.join('\n') || 'هیچ کانالی ثبت نشده.'}${off}`, kb);
}

export async function askChannel(ctx, user) {
  if ((await countChannels()) >= MAX_CHANNELS) {
    return answer(ctx, `⛔ حداکثر ${fa(MAX_CHANNELS)} کانال؛ برای افزودن، اول یکی را حذف کن.`, { alert: true });
  }
  await setState(user.id, 'add_channel');
  await answer(ctx);
  return show(ctx, 'admin_add_channel',
    '➕ یوزرنیم کانال (مثل <code>@mychannel</code>) یا لینکش (<code>https://t.me/mychannel</code>) را بفرست.\n\n'
    + 'قبلش ربات را در کانال <b>ادمین</b> کن؛ بدون ادمین بودن تلگرام اجازه‌ی بررسی عضویت نمی‌دهد.',
    [[btn('❌ انصراف', 'a:x')]]);
}

/** "@name", "name", "t.me/name", "https://telegram.me/s/name" → "name"; private links → null. */
export function normalizeChannel(input) {
  const s = toAsciiDigits(String(input || '').trim()).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  let m = /^(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:[?#].*)?$/i.exec(s);
  if (m) return m[1];
  m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
  return m ? m[1] : null;
}

export async function onChannelInput(ctx, user, kv, text) {
  const name = normalizeChannel(text);
  if (!name) {
    return send(ctx, 'admin_channel_invalid',
      '⚠️ یوزرنیم یا لینک عمومی معتبر نیست. نمونه: <code>@mychannel</code> یا <code>https://t.me/mychannel</code>\n'
      + '(لینک‌های خصوصی مثل t.me/+… پشتیبانی نمی‌شوند.) دوباره بفرست یا /cancel.');
  }
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: `@${name}` }, 'admin_get_chat');
  } catch (err) {
    return send(ctx, 'admin_channel_missing', `❌ کانال @${esc(name)} پیدا نشد (${esc(describeError(err))}). دوباره بفرست یا /cancel.`);
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') {
    return send(ctx, 'admin_channel_type', `❌ @${esc(name)} کانال یا گروه نیست. دوباره بفرست یا /cancel.`);
  }
  const bot = await botInfo(ctx, kv);
  let isAdmin = false;
  try {
    const m = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: bot.id }, 'admin_check');
    isAdmin = m.status === 'administrator' || m.status === 'creator';
  } catch (err) {
    console.warn(`bot admin check failed: ${describeError(err)}`);
  }
  if (!isAdmin) {
    return send(ctx, 'admin_channel_not_admin',
      `⚠️ ربات در @${esc(chat.username || name)} ادمین نیست. اول ادمینش کن، بعد دوباره یوزرنیم را بفرست (یا /cancel).`);
  }
  const r = await addChannel({ username: chat.username || name, chatId: Number(chat.id), title: chat.title || name });
  await clearState(user.id);
  ctx.messageId = null;
  if (r === 'dup') return showChannels(ctx, kv, `ℹ️ @${esc(name)} از قبل در لیست است.`);
  if (r === 'full') return showChannels(ctx, kv, `⛔ حداکثر ${fa(MAX_CHANNELS)} کانال؛ @${esc(name)} اضافه نشد.`);
  await bumpChannelVersion(kv);
  return showChannels(ctx, kv, `✅ @${esc(chat.username || name)} اضافه شد.`);
}

export async function confirmRemove(ctx, id) {
  const ch = await getChannel(Number(id));
  if (!ch) return answer(ctx, 'این کانال دیگر در لیست نیست.', { alert: true });
  await answer(ctx);
  return show(ctx, 'admin_remove_confirm', `🗑 @${esc(ch.username)} از عضویت اجباری حذف شود؟`,
    [[btn('✅ بله، حذف کن', `a:rmy:${ch.id}`), btn('🔙 نه', 'a:ch')]]);
}

export async function doRemove(ctx, kv, id) {
  const ch = await getChannel(Number(id));
  const ok = ch ? await removeChannel(ch.id) : false;
  if (ok) await bumpChannelVersion(kv);
  await answer(ctx, ok ? '🗑 حذف شد' : 'قبلاً حذف شده بود');
  return showChannels(ctx, kv, ok ? `🗑 @${esc(ch.username)} حذف شد.` : '');
}

export async function toggleJoin(ctx, kv) {
  const on = kv.join === '0';
  await setKv('join', on ? '1' : '0');
  kv.join = on ? '1' : '0';
  await answer(ctx, on ? '🔒 عضویت اجباری روشن شد' : '🔓 عضویت اجباری خاموش شد');
  return showPanel(ctx, kv);
}

// ---------- ban / unban ----------

export async function askBan(ctx, user, ban) {
  await setState(user.id, ban ? 'ban' : 'unban');
  await answer(ctx);
  return show(ctx, ban ? 'admin_ban_ask' : 'admin_unban_ask',
    `${ban ? '⛔' : '✅'} آیدی <b>عددی</b> کاربری را که می‌خواهی ${ban ? 'بن' : 'آنبن'} کنی بفرست.`,
    [[btn('❌ انصراف', 'a:x')]]);
}

export async function onBanInput(ctx, user, text, ban) {
  const t = toAsciiDigits(String(text || '').trim());
  if (!/^[1-9][0-9]{4,15}$/.test(t)) return send(ctx, 'admin_ban_invalid', '⚠️ فقط آیدی عددی بفرست (یا /cancel).');
  const id = Number(t);
  await clearState(user.id);
  if (id === OWNER_ID) return send(ctx, 'admin_ban_owner', '⛔ مالک را نمی‌شود بن کرد.', [toPanel]);
  await setBanned(id, ban);
  const u = await getUser(id);
  const who = u && u.username ? ` (@${esc(u.username)})` : '';
  return send(ctx, ban ? 'admin_banned' : 'admin_unbanned',
    ban ? `⛔ کاربر <code>${id}</code>${who} بن شد؛ دیگر نمی‌تواند نجوا بفرستد.` : `✅ کاربر <code>${id}</code>${who} آنبن شد.`,
    [toPanel]);
}

// ---------- stats ----------

export async function showStats(ctx) {
  const s = await stats();
  return show(ctx, 'admin_stats',
    '📊 <b>آمار ربات</b>\n\n'
    + `👥 کل کاربران: ${fa(s.users)}\n`
    + `🟢 کاربران فعال (ربات را استارت کرده‌اند و بلاکش نکرده‌اند): ${fa(s.active)}\n`
    + `⛔ بن‌شده: ${fa(s.banned)}\n`
    + `🤫 نجواهای امروز: ${fa(s.today)}\n`
    + `📨 کل نجواها: ${fa(s.whispers)}\n`
    + `💬 پیام‌های ناشناس: ${fa(s.anon)}\n`
    + `📢 کانال‌های عضویت اجباری: ${fa(s.channels)}\n\n`
    + '<i>فقط تعداد؛ متن نجواها و پیام‌های ناشناس، و اینکه چه کسی به چه کسی پیام داده، برای هیچ‌کس — حتی مالک — نمایش داده نمی‌شود.</i>', [toPanel]);
}

// ---------- broadcast ----------

async function recipientsCount() {
  const s = await stats();
  const owner = await getUser(OWNER_ID);
  return Math.max(0, s.active - (owner && owner.started && owner.active && !owner.banned ? 1 : 0));
}

export async function askBroadcast(ctx, user) {
  const running = await runningBroadcast();
  if (running) {
    await answer(ctx, '⏳ یک پیام سراسری در حال ارسال است؛ فقط یکی در هر زمان.', { alert: true });
    const { text, kb } = progressView(running);
    return show(ctx, 'broadcast_progress', text, kb);
  }
  await setState(user.id, 'bc_wait');
  await answer(ctx);
  return show(ctx, 'broadcast_ask',
    '📢 پیامی را که می‌خواهی برای همه‌ی کاربران فرستاده شود بفرست: متن، عکس، ویدیو، فایل (با کپشن) و …\n'
    + 'قالب‌بندی و رسانه همان‌طور کپی می‌شود. (آلبوم چندتایی پشتیبانی نمی‌شود.)',
    [[btn('❌ انصراف', 'a:x')]]);
}

/** The owner sent the message to broadcast: show a preview and ask for confirmation. */
export async function onBroadcastMessage(ctx, user, message) {
  await clearState(user.id);
  try {
    await call(ctx, 'copyMessage', { chat_id: user.id, from_chat_id: message.chat.id, message_id: message.message_id }, 'broadcast_preview');
  } catch (err) {
    return send(ctx, 'broadcast_uncopyable', `❌ این پیام قابل کپی نیست (${esc(describeError(err))}). پیام دیگری امتحان کن.`, [toPanel]);
  }
  const id = await createBroadcast(Number(message.chat.id), Number(message.message_id));
  const n = await recipientsCount();
  const album = message.media_group_id ? '\n⚠️ این پیام بخشی از یک آلبوم است؛ فقط همین یک مورد فرستاده می‌شود.' : '';
  return send(ctx, 'broadcast_confirm',
    `👆 پیش‌نمایش پیام سراسری #${fa(id)}\n\nبرای حدود <b>${fa(n)}</b> کاربر فرستاده شود؟${album}`,
    [[btn('✅ تأیید و ارسال', `a:bcy:${id}`), btn('❌ لغو', `a:bcn:${id}`)]]);
}

async function showProgress(ctx, b) {
  const { text, kb } = progressView(b);
  return show(ctx, 'broadcast_progress', text, kb);
}

export async function confirmBroadcast(ctx, id) {
  const b = await getBroadcast(Number(id));
  if (!b || b.status !== 'draft') {
    await answer(ctx, 'این پیام سراسری دیگر قابل شروع نیست.', { alert: true });
    return b ? showProgress(ctx, b) : null;
  }
  const total = await recipientsCount();
  if (!(await startBroadcast(b.id, total, ctx.chatId, ctx.messageId))) {
    return answer(ctx, '⏳ یک پیام سراسری دیگر در حال ارسال است؛ فقط یکی در هر زمان.', { alert: true });
  }
  await setKv('bc', b.id);
  await answer(ctx, '🚀 ارسال شروع شد');
  return runBatch(ctx, b.id);
}

/** "▶️ ادامه ارسال": one batch, then the progress message (and the final report when done). */
export async function runBatch(ctx, id) {
  const r = await processBatch(ctx, Number(id), BC_BATCH);
  if (!r.ran) {
    if (r.reason === 'wait') await answer(ctx, `⏸ محدودیت تلگرام؛ ${fa(r.b.nextAt - nowSec())} ثانیه‌ی دیگر دوباره بزن.`, { alert: true });
    else if (r.reason === 'locked') await answer(ctx, '⏳ یک دسته در حال ارسال است؛ چند ثانیه بعد دوباره بزن.');
    else await answer(ctx);
    return r.b ? showProgress(ctx, r.b) : null;
  }
  await answer(ctx);
  if (ctx.messageId) await setBroadcastProgressMessage(r.b.id, ctx.chatId, ctx.messageId);
  await showProgress(ctx, r.b);
  if (r.done) await finalReport(ctx, r.b);
  return null;
}

export async function stopBroadcast(ctx, id) {
  const ok = await setBroadcastStatus(Number(id), 'running', 'stopped');
  const b = await getBroadcast(Number(id));
  if (ok) await setKv('bc', null);
  await answer(ctx, ok ? '⛔ متوقف شد' : 'در حال اجرا نبود');
  if (!b) return null;
  await showProgress(ctx, b);
  if (ok) await finalReport(ctx, b);
  return null;
}

export async function cancelBroadcast(ctx, id) {
  const ok = await setBroadcastStatus(Number(id), 'draft', 'cancelled');
  await answer(ctx, ok ? '❌ لغو شد' : 'قابل لغو نیست');
  return show(ctx, 'broadcast_cancelled', ok ? '❌ پیام سراسری لغو شد.' : 'این پیام سراسری قابل لغو نیست.', [toPanel]);
}

export async function showBroadcast(ctx, id) {
  const b = await getBroadcast(Number(id));
  await answer(ctx);
  return b ? showProgress(ctx, b) : null;
}

