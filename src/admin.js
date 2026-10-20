import { MAX_CHANNELS } from './config.js';
import * as Q from './db.js';
import { clearJoinCache } from './join.js';
import { fa, formatDate, normalizeInput, toLatinDigits } from './time.js';
import { btn, esc, inline } from './ui.js';

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

// ---------- views ----------

export async function homeView(ctx) {
  const channels = await Q.listChannels(ctx.db);
  return {
    text: [
      '👑 <b>پنل مدیریت ربات</b>',
      '',
      `📢 کانال‌های جوین اجباری: ${fa(channels.length)} از ${fa(MAX_CHANNELS)}`,
      '',
      'دستورات متنی هم در دسترس است:',
      '<code>/channels</code> — لیست کانال‌ها',
      '<code>/addchannel @username</code> — افزودن کانال',
      '<code>/delchannel @username</code> یا <code>/delchannel 2</code> — حذف کانال',
    ].join('\n'),
    kb: inline([
      [btn(`📢 کانال‌های جوین اجباری (${fa(channels.length)}/${fa(MAX_CHANNELS)})`, 'A|ch')],
      [btn('📊 آمار ربات', 'A|st'), btn('📣 پیام همگانی', 'A|bc')],
    ]),
  };
}

export async function channelsView(ctx, notice = '') {
  const channels = await Q.listChannels(ctx.db);
  const lines = channels.length
    ? channels.map((c, i) => `${fa(i + 1)}. <b>${esc(c.title || c.chat)}</b>\n      <code>${esc(c.chat)}</code> — ${esc(c.link)}`)
    : ['هیچ کانالی تنظیم نشده؛ جوین اجباری غیرفعال است.'];
  const rows = channels.map((c, i) => [btn(`❌ حذف ${fa(i + 1)}. ${c.title || c.chat}`, `A|cd|${c.id}`)]);
  rows.push([
    channels.length < MAX_CHANNELS ? btn('➕ افزودن کانال', 'A|ca') : btn(`⛔️ سقف ${fa(MAX_CHANNELS)} کانال پر است`, 'A|full'),
    btn('🔄 بررسی وضعیت', 'A|ck'),
  ]);
  rows.push([btn('🔙 پنل مدیریت', 'A|h')]);
  return {
    text: [
      notice,
      `📢 <b>کانال‌های جوین اجباری</b> (${fa(channels.length)} از ${fa(MAX_CHANNELS)})`,
      '',
      ...lines,
      '',
      '⚠️ ربات باید در هر کانال <b>ادمین</b> باشد تا عضویت کاربران بررسی شود.',
    ]
      .filter((l, i) => i > 0 || l)
      .join('\n'),
    kb: inline(rows),
  };
}

export const ADD_CHANNEL_PROMPT = [
  '➕ <b>افزودن کانال جوین اجباری</b>',
  '',
  'یکی از این‌ها را بفرستید:',
  '• یوزرنیم کانال: <code>@channel</code>',
  '• لینک کانال: <code>https://t.me/channel</code>',
  '• کانال خصوصی: آیدی عددی + لینک دعوت، مثل:',
  '  <code>-1001234567890 https://t.me/+AbCdEf</code>',
  '• یا یک پیام از خود کانال را اینجا فوروارد کنید.',
  '',
  '⚠️ قبلش ربات را در کانال ادمین کنید.',
].join('\n');

// ---------- channel management ----------

/** Extracts { chat, link } from owner input (text or a forwarded channel post). */
export function parseChannelInput(msg) {
  const origin = msg.forward_origin;
  const fwdChat = origin?.type === 'channel' ? origin.chat : msg.forward_from_chat;
  if (fwdChat && fwdChat.type === 'channel') {
    return fwdChat.username
      ? { chat: `@${fwdChat.username}`, link: `https://t.me/${fwdChat.username}` }
      : { chat: String(fwdChat.id), link: null };
  }
  // Not lower-cased: private invite links are case-sensitive.
  const text = toLatinDigits(msg.text || msg.caption || '').trim().replace(/^\/addchannel(@\w+)?\s*/i, '');
  let chat = null;
  let link = null;
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^<|>$/g, '');
    const invite = token.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(\+[\w-]+|joinchat\/[\w-]+)\/?$/i);
    const pub = token.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i);
    if (invite) link = `https://t.me/${invite[1]}`;
    else if (pub) chat = `@${pub[1]}`;
    else if (/^@/.test(token) && USERNAME_RE.test(token.slice(1))) chat = token;
    else if (/^-100\d{5,}$/.test(token)) chat = token;
  }
  if (chat?.startsWith('@')) link = `https://t.me/${chat.slice(1)}`;
  return chat ? { chat, link } : null;
}

export async function addChannel(ctx, input) {
  if (!input) return { ok: false, text: '❗️ ورودی نامعتبر است.\n\n' + ADD_CHANNEL_PROMPT };
  const channels = await Q.listChannels(ctx.db);
  if (channels.length >= MAX_CHANNELS) return { ok: false, text: `⛔️ حداکثر ${fa(MAX_CHANNELS)} کانال قابل تنظیم است. اول یکی را حذف کنید.` };
  if (channels.some((c) => c.chat.toLowerCase() === input.chat.toLowerCase())) return { ok: false, text: `ℹ️ کانال <code>${esc(input.chat)}</code> از قبل در لیست هست.` };

  const info = await ctx.api.call('getChat', { chat_id: input.chat });
  let { chat, link } = input;
  let title = null;
  if (info.ok) {
    title = info.result.title || null;
    if (info.result.username) {
      chat = `@${info.result.username}`;
      link = link || `https://t.me/${info.result.username}`;
      if (channels.some((c) => c.chat.toLowerCase() === chat.toLowerCase())) return { ok: false, text: `ℹ️ کانال <code>${esc(chat)}</code> از قبل در لیست هست.` };
    }
    if (!link) link = info.result.invite_link || null;
    if (!link) {
      const created = await ctx.api.call('createChatInviteLink', { chat_id: chat, name: 'todo-bot join' });
      if (created.ok) link = created.result.invite_link;
    }
  } else if (!chat.startsWith('@')) {
    return { ok: false, text: '❌ ربات به این کانال دسترسی ندارد. اول ربات را در کانال ادمین کنید و دوباره امتحان کنید.' };
  }
  if (!link) return { ok: false, text: '❗️ لینک دعوت کانال پیدا نشد. آیدی عددی را همراه لینک دعوت بفرستید:\n<code>-1001234567890 https://t.me/+AbCdEf</code>' };

  const me = await ctx.api.call('getChatMember', { chat_id: chat, user_id: ctx.api.botId() });
  const isAdmin = me.ok && ['administrator', 'creator'].includes(me.result.status);

  await Q.addChannel(ctx.db, chat, title, link, ctx.now);
  clearJoinCache();
  const warn = isAdmin ? '' : '\n⚠️ ربات در این کانال ادمین نیست؛ تا وقتی ادمین نشود، عضویت در این کانال بررسی نمی‌شود.';
  return { ok: true, text: `✅ کانال <b>${esc(title || chat)}</b> اضافه شد.${warn}\n` };
}

export async function removeChannel(ctx, id) {
  const ch = await Q.getChannel(ctx.db, id);
  if (!ch) return null;
  await Q.removeChannel(ctx.db, id);
  clearJoinCache();
  return ch;
}

async function resolveChannelRef(ctx, ref) {
  const channels = await Q.listChannels(ctx.db);
  const r = normalizeInput(ref);
  if (/^\d+$/.test(r)) return channels[Number(r) - 1] || null;
  const name = r.replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//, '@').replace(/\/$/, '');
  return channels.find((c) => c.chat.toLowerCase() === name || c.chat.toLowerCase() === `@${name}`) || null;
}

export async function statusReport(ctx) {
  const channels = await Q.listChannels(ctx.db);
  const botId = ctx.api.botId();
  const lines = await Promise.all(
    channels.map(async (c, i) => {
      const [info, me] = await Promise.all([
        ctx.api.call('getChat', { chat_id: c.chat }),
        ctx.api.call('getChatMember', { chat_id: c.chat, user_id: botId }),
      ]);
      if (info.ok && info.result.title && info.result.title !== c.title) await Q.setChannelTitle(ctx.db, c.id, info.result.title);
      const name = esc((info.ok && info.result.title) || c.title || c.chat);
      if (!info.ok) return `${fa(i + 1)}. ❌ <b>${name}</b> — کانال پیدا نشد یا ربات به آن دسترسی ندارد`;
      if (me.ok && ['administrator', 'creator'].includes(me.result.status)) return `${fa(i + 1)}. ✅ <b>${name}</b> — ربات ادمین است`;
      return `${fa(i + 1)}. ⚠️ <b>${name}</b> — ربات ادمین نیست (عضویت بررسی نمی‌شود)`;
    }),
  );
  return lines.length ? `🔄 <b>وضعیت کانال‌ها:</b>\n${lines.join('\n')}\n` : '';
}

// ---------- stats & broadcast ----------

export async function statsView(ctx) {
  const s = await Q.botStats(ctx.db, ctx.now);
  const b = await Q.activeBroadcast(ctx.db);
  return {
    text: [
      '📊 <b>آمار ربات</b>',
      '',
      `👥 کل کاربران: ${fa(s.users)}`,
      `🆕 کاربران جدید (۲۴ ساعت): ${fa(s.new_day)}`,
      `🟢 فعال در ۲۴ ساعت: ${fa(s.active_day)}`,
      `📆 فعال در ۷ روز: ${fa(s.active_week)}`,
      `🚫 ربات را بلاک کرده‌اند: ${fa(s.blocked)}`,
      '',
      `📝 کل کارها: ${fa(s.tasks)}`,
      `✅ کارهای انجام‌شده: ${fa(s.done)}`,
      b ? `\n📣 ارسال همگانی در حال اجرا: ${fa(b.sent)} ارسال‌شده، ${fa(b.failed)} ناموفق` : '',
      '',
      `<i>🕓 ${formatDate(ctx.now, { now: ctx.now })}</i>`,
    ].join('\n'),
    kb: inline([[btn('🔄 بروزرسانی', 'A|st'), btn('🔙 پنل مدیریت', 'A|h')]]),
  };
}

export async function prepareBroadcast(ctx, msg) {
  await Q.setState(ctx.db, ctx.uid, null);
  const count = await Q.countActiveUsers(ctx.db);
  return ctx.api.send(ctx.chatId, `📣 این پیام برای <b>${fa(count)}</b> کاربر ارسال شود؟`, {
    reply_to_message_id: msg.message_id,
    reply_markup: inline([[btn('✅ بله، ارسال کن', `A|bcy|${msg.message_id}`), btn('❌ لغو', 'A|bcn')]]),
  });
}

// ---------- entry points ----------

export async function onAdminCommand(ctx, cmd, arg) {
  if (cmd === '/admin') {
    const v = await homeView(ctx);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (cmd === '/channels') {
    const v = await channelsView(ctx);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (cmd === '/addchannel') {
    if (!arg) {
      await Q.setState(ctx.db, ctx.uid, { a: 'addch' });
      return ctx.api.send(ctx.chatId, ADD_CHANNEL_PROMPT, { reply_markup: inline([[btn('❌ لغو', 'A|ch')]]) });
    }
    const res = await addChannel(ctx, parseChannelInput({ text: arg }));
    const v = await channelsView(ctx, res.text);
    return ctx.api.send(ctx.chatId, res.ok ? v.text : res.text, { reply_markup: res.ok ? v.kb : undefined });
  }
  if (cmd === '/delchannel') {
    const ch = arg ? await resolveChannelRef(ctx, arg) : null;
    if (!ch) return ctx.api.send(ctx.chatId, '❗️ کانال پیدا نشد. نمونه: <code>/delchannel @username</code> یا <code>/delchannel 2</code> (شماره در لیست /channels)');
    await removeChannel(ctx, ch.id);
    const v = await channelsView(ctx, `🗑 کانال <b>${esc(ch.title || ch.chat)}</b> حذف شد.\n`);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  return null;
}

export async function onAdminState(ctx, msg) {
  if (ctx.state.a === 'addch') {
    const res = await addChannel(ctx, parseChannelInput(msg));
    if (!res.ok) return ctx.api.send(ctx.chatId, res.text, { reply_markup: inline([[btn('❌ لغو', 'A|ch')]]) });
    await Q.setState(ctx.db, ctx.uid, null);
    const v = await channelsView(ctx, res.text);
    return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
  }
  if (ctx.state.a === 'bc') return prepareBroadcast(ctx, msg);
  return null;
}

export async function onAdminCallback(ctx, parts) {
  const [action, arg] = parts;
  if (action !== 'ca' && action !== 'bc' && ctx.state) await Q.setState(ctx.db, ctx.uid, null);

  switch (action) {
    case 'h': {
      const v = await homeView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case 'ch': {
      const v = await channelsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case 'full':
      return ctx.toast(`⛔️ حداکثر ${fa(MAX_CHANNELS)} کانال؛ اول یکی را حذف کنید.`, true);
    case 'ca': {
      const channels = await Q.listChannels(ctx.db);
      if (channels.length >= MAX_CHANNELS) return ctx.toast(`⛔️ حداکثر ${fa(MAX_CHANNELS)} کانال؛ اول یکی را حذف کنید.`, true);
      await Q.setState(ctx.db, ctx.uid, { a: 'addch' });
      return ctx.show(ADD_CHANNEL_PROMPT, inline([[btn('🔙 لغو و بازگشت', 'A|ch')]]));
    }
    case 'cd': {
      const ch = await Q.getChannel(ctx.db, Number(arg));
      if (!ch) return ctx.toast('این کانال قبلاً حذف شده.', true);
      return ctx.show(
        `🗑 کانال <b>${esc(ch.title || ch.chat)}</b> از جوین اجباری حذف شود؟`,
        inline([[btn('✅ بله، حذف شود', `A|cdy|${ch.id}`), btn('❌ نه', 'A|ch')]]),
      );
    }
    case 'cdy': {
      const ch = await removeChannel(ctx, Number(arg));
      const v = await channelsView(ctx, ch ? `🗑 کانال <b>${esc(ch.title || ch.chat)}</b> حذف شد.\n` : '');
      await ctx.toast(ch ? '🗑 حذف شد' : 'قبلاً حذف شده بود');
      return ctx.show(v.text, v.kb);
    }
    case 'ck': {
      await ctx.toast('⏳ در حال بررسی...');
      const report = await statusReport(ctx);
      const v = await channelsView(ctx, report);
      return ctx.show(v.text, v.kb);
    }
    case 'st': {
      const v = await statsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case 'bc': {
      await Q.setState(ctx.db, ctx.uid, { a: 'bc' });
      return ctx.show(
        '📣 <b>پیام همگانی</b>\n\nپیامی که می‌خواهید برای همه کاربران ارسال شود را بفرستید (متن، عکس، ویدیو، فایل یا فوروارد).',
        inline([[btn('🔙 لغو و بازگشت', 'A|h')]]),
      );
    }
    case 'bcy': {
      if (await Q.activeBroadcast(ctx.db)) return ctx.toast('⏳ یک ارسال همگانی دیگر در حال اجراست.', true);
      await Q.createBroadcast(ctx.db, ctx.chatId, Number(arg), ctx.now);
      await ctx.toast('📣 ارسال شروع شد');
      return ctx.show('📣 ارسال همگانی شروع شد. پیام‌ها در پس‌زمینه ارسال می‌شوند و در پایان گزارش برایتان می‌آید.', null);
    }
    case 'bcn':
      return ctx.show('❌ ارسال همگانی لغو شد.', null);
    default:
      return ctx.toast('دستور نامعتبر');
  }
}
