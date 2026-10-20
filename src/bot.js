import { MAX_NOTE_LEN, MAX_TASK_LEN, ownerId, PAGE_SIZE } from './config.js';
import * as admin from './admin.js';
import * as Q from './db.js';
import { checkJoin, joinGateView } from './join.js';
import { cleanCategory, parseQuickAdd } from './quickadd.js';
import { createApi } from './telegram.js';
import {
  addRepeat,
  DAY,
  fa,
  formatDate,
  formatShortDate,
  formatTime,
  fromLocal,
  localDateKey,
  localParts,
  MINUTE,
  nextOccurrence,
  parseWhen,
  REPEAT_LABELS,
} from './time.js';
import * as ui from './ui.js';

const { btn, esc, inline } = ui;

export async function handleUpdate(env, update) {
  await Q.ensureSchema(env.DB);
  const base = { env, api: createApi(env), db: env.DB, now: Date.now(), owner: ownerId(env) };
  if (update.message) return onMessage(base, update.message);
  if (update.callback_query) return onCallback(base, update.callback_query);
  return null;
}

async function buildCtx(base, from, chatId) {
  const user = await Q.touchUser(base.db, from, base.now);
  return { ...base, from, chatId, user, uid: from.id, isOwner: from.id === base.owner, state: Q.parseState(user) };
}

const clearState = (ctx) => {
  if (!ctx.state) return null;
  ctx.state = null;
  return Q.setState(ctx.db, ctx.uid, null);
};

const setState = (ctx, state) => {
  ctx.state = state;
  return Q.setState(ctx.db, ctx.uid, state);
};

const DEFAULT_CTX = 'p.0';

function listFromCtx(lctx) {
  const i = (lctx || DEFAULT_CTX).lastIndexOf('.');
  return { filter: lctx.slice(0, i) || 'p', page: Number(lctx.slice(i + 1)) || 0 };
}

// ======================= messages =======================

async function onMessage(base, msg) {
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return null;
  const ctx = await buildCtx(base, msg.from, msg.chat.id);

  if (!ctx.isOwner) {
    const missing = await checkJoin(ctx, ctx.uid);
    if (missing.length) {
      const v = joinGateView(missing);
      return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
    }
  }

  const text = (msg.text || '').trim();

  if (text.startsWith('/')) {
    const [head, ...rest] = text.split(/\s+/);
    const cmd = head.split('@')[0].toLowerCase();
    const arg = rest.join(' ').trim();
    const command = COMMANDS[cmd];
    if (command) {
      await clearState(ctx);
      return command(ctx, arg);
    }
    if (ctx.isOwner) {
      await clearState(ctx);
      const done = await admin.onAdminCommand(ctx, cmd, arg);
      if (done) return done;
    }
    return ctx.api.send(ctx.chatId, '❓ دستور ناشناخته است. راهنما: /help');
  }

  const menu = MENU[text];
  if (menu && (menu !== showAdmin || ctx.isOwner)) {
    await clearState(ctx);
    return menu(ctx);
  }

  if (ctx.state) return onStateInput(ctx, msg, text);
  if (!text) return ctx.api.send(ctx.chatId, '📝 برای افزودن کار، متنش را به‌صورت پیام متنی بفرستید.');
  return quickAdd(ctx, text);
}

const COMMANDS = {
  '/start': sendWelcome,
  '/help': (ctx) => ctx.api.send(ctx.chatId, ui.HELP_TEXT, { reply_markup: ui.mainKeyboard(ctx.isOwner) }),
  '/list': (ctx) => sendList(ctx, 'p', 0),
  '/today': (ctx) => sendList(ctx, 't', 0),
  '/done': (ctx) => sendList(ctx, 'd', 0),
  '/add': (ctx, arg) => (arg ? quickAdd(ctx, arg) : promptAdd(ctx)),
  '/search': (ctx, arg) => (arg ? sendSearch(ctx, arg) : promptSearch(ctx)),
  '/stats': sendStats,
  '/categories': sendCategories,
  '/settings': (ctx) => sendSettings(ctx),
  '/cancel': (ctx) => ctx.api.send(ctx.chatId, '❌ لغو شد.', { reply_markup: ui.mainKeyboard(ctx.isOwner) }),
};

async function showAdmin(ctx) {
  return admin.onAdminCommand(ctx, '/admin', '');
}

const MENU = {
  [ui.BTN.add]: promptAdd,
  [ui.BTN.list]: (ctx) => sendList(ctx, 'p', 0),
  [ui.BTN.today]: (ctx) => sendList(ctx, 't', 0),
  [ui.BTN.search]: promptSearch,
  [ui.BTN.cats]: sendCategories,
  [ui.BTN.stats]: sendStats,
  [ui.BTN.settings]: (ctx) => sendSettings(ctx),
  [ui.BTN.help]: COMMANDS['/help'],
  [ui.BTN.admin]: showAdmin,
};

async function sendWelcome(ctx) {
  const name = esc(ctx.from.first_name || 'دوست من');
  const text = [
    `👋 سلام ${name}!`,
    'به ربات <b>تودو لیست</b> خوش اومدی 🌱',
    'اینجا کارهات رو ثبت می‌کنی، اولویت و ددلاین می‌ذاری، یادآور می‌گیری و پیشرفتت رو می‌بینی.',
    '',
    ui.QUICK_ADD_HINT,
    '',
    'از منوی پایین هم می‌تونی استفاده کنی 👇 (راهنمای کامل: /help)',
  ].join('\n');
  return ctx.api.send(ctx.chatId, text, { reply_markup: ui.mainKeyboard(ctx.isOwner) });
}

function promptAdd(ctx) {
  return Promise.all([
    setState(ctx, { a: 'add' }),
    ctx.api.send(ctx.chatId, `✍️ متن کار جدید را بفرستید.\n\n${ui.QUICK_ADD_HINT}`, { reply_markup: ui.cancelKb }),
  ]);
}

function promptSearch(ctx) {
  return Promise.all([
    setState(ctx, { a: 'search' }),
    ctx.api.send(ctx.chatId, '🔍 عبارت مورد نظر را بفرستید (در متن، یادداشت و دسته‌ی کارها جستجو می‌شود):', { reply_markup: ui.cancelKb }),
  ]);
}

async function quickAdd(ctx, input) {
  const p = parseQuickAdd(input, ctx.now);
  if (!p.text) return ctx.api.send(ctx.chatId, '❗️ متن کار خالی است. یک متن بفرستید.');
  if (Array.from(p.text).length > MAX_TASK_LEN) return ctx.api.send(ctx.chatId, `❗️ متن کار حداکثر ${fa(MAX_TASK_LEN)} کاراکتر می‌تواند باشد.`);
  await clearState(ctx);
  const t = await Q.addTask(
    ctx.db,
    ctx.uid,
    {
      text: p.text,
      priority: p.priority,
      category: p.category,
      due_at: p.due?.ts ?? null,
      due_time: p.due?.hasTime ? 1 : 0,
    },
    ctx.now,
  );
  return sendCard(ctx, t, DEFAULT_CTX, '✅ <b>به لیست اضافه شد!</b>\n\n');
}

function sendCard(ctx, t, lctx = DEFAULT_CTX, prefix = '') {
  return ctx.api.send(ctx.chatId, prefix + ui.taskCard(t, ctx.now), { reply_markup: ui.taskCardKb(t, lctx) });
}

async function sendList(ctx, filter, page) {
  const v = await buildList(ctx, filter, page);
  return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
}

async function buildList(ctx, filter, page) {
  let { total, rows } = await Q.listTasks(ctx.db, ctx.uid, filter, page, ctx.now);
  if (!rows.length && page > 0) {
    page = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ total, rows } = await Q.listTasks(ctx.db, ctx.uid, filter, page, ctx.now));
  }
  return ui.listView({ filter, page, total, rows, now: ctx.now });
}

async function sendSearch(ctx, query) {
  const q = query.trim().slice(0, 100);
  const rows = await Q.searchTasks(ctx.db, ctx.uid, q);
  if (!rows.length) return ctx.api.send(ctx.chatId, `🔍 نتیجه‌ای برای «${esc(q)}» پیدا نشد.`);
  const text = `🔍 <b>نتایج جستجو برای «${esc(q)}»</b> (${fa(rows.length)})\n\n${rows.map((t) => ui.taskLine(t, ctx.now)).join('\n\n')}`;
  const kb = inline(rows.map((t) => [btn(`${t.done ? '✅' : ui.PRIORITY[t.priority].icon} ${fa(t.num)}. ${ui.truncate(t.text, 30)}`, ui.cb('T', t.num, DEFAULT_CTX))]));
  return ctx.api.send(ctx.chatId, text, { reply_markup: kb });
}

async function sendCategories(ctx) {
  const cats = await Q.listCategories(ctx.db, ctx.uid);
  if (!cats.length) {
    return ctx.api.send(
      ctx.chatId,
      '🗂 هنوز دسته‌ای نساخته‌اید.\n\nبرای دسته‌بندی، موقع افزودن کار از <code>#نام_دسته</code> استفاده کنید یا از دکمه «🗂 دسته» در کارت هر کار.',
    );
  }
  const text = `🗂 <b>دسته‌های شما</b>\n\n${cats.map((c) => `• <b>${esc(c.category)}</b> — ${fa(c.pending)} در جریان از ${fa(c.total)}`).join('\n')}`;
  const kb = inline(cats.map((c) => [btn(`🗂 ${c.category} (${fa(c.pending)})`, `L|c${c.category}|0`)]));
  return ctx.api.send(ctx.chatId, text, { reply_markup: kb });
}

async function sendStats(ctx) {
  const s = await Q.userStats(ctx.db, ctx.uid, ctx.now);
  const cats = await Q.listCategories(ctx.db, ctx.uid);
  const ratio = s.total ? s.done / s.total : 0;
  const lines = [
    '📊 <b>آمار شما</b>',
    '',
    `📝 کل کارها: <b>${fa(s.total)}</b>`,
    `✅ انجام‌شده: <b>${fa(s.done)}</b>`,
    `⏳ در جریان: <b>${fa(s.pending)}</b>`,
    `⚠️ عقب‌افتاده: <b>${fa(s.overdue)}</b>`,
    `📅 ددلاین امروز: <b>${fa(s.today)}</b>`,
    `🏁 انجام‌شده امروز: <b>${fa(s.done_today)}</b>`,
    `🗓 انجام‌شده در ۷ روز اخیر: <b>${fa(s.week)}</b>`,
    `🔁 کارهای تکراری: <b>${fa(s.recurring)}</b> · ⏰ یادآورهای فعال: <b>${fa(s.reminders)}</b>`,
    '',
    `📈 پیشرفت کلی: ${ui.progressBar(ratio)} ${fa(Math.round(ratio * 100))}٪`,
    '',
    `🔥 اولویت کارهای در جریان: 🔴 ${fa(s.p1)} · 🟡 ${fa(s.p2)} · 🟢 ${fa(s.p3)}`,
  ];
  if (cats.length) lines.push(`🗂 دسته‌ها: ${cats.slice(0, 8).map((c) => `${esc(c.category)} ${fa(c.pending)}/${fa(c.total)}`).join(' · ')}`);
  if (s.total && s.pending === 0) lines.push('', '🎉 همه کارها انجام شده؛ عالیه!');
  else if (s.overdue) lines.push('', '💪 چند کار عقب‌افتاده دارید؛ از «📅 امروز» شروع کنید.');
  return ctx.api.send(ctx.chatId, lines.join('\n'));
}

function settingsView(ctx) {
  const h = ctx.user.digest_hour;
  const text = [
    '⚙️ <b>تنظیمات</b>',
    '',
    `🌅 خلاصه روزانه: ${h === null || h === undefined ? 'خاموش' : `هر روز ساعت ${fa(`${String(h).padStart(2, '0')}:00`)}`}`,
    '',
    '📤 «خروجی فایل» یک فایل متنی از همه کارهایتان می‌فرستد.',
    '🧹 «پاکسازی» همه کارهای انجام‌شده را حذف می‌کند.',
  ].join('\n');
  const kb = inline([
    [btn('🌅 خلاصه روزانه', 'S|dg')],
    [btn('📤 خروجی فایل', 'S|ex'), btn('🧹 پاکسازی انجام‌شده‌ها', 'S|cl')],
  ]);
  return { text, kb };
}

function sendSettings(ctx) {
  const v = settingsView(ctx);
  return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
}

async function onStateInput(ctx, msg, text) {
  const s = ctx.state;
  if (ctx.isOwner && (s.a === 'addch' || s.a === 'bc')) return admin.onAdminState(ctx, msg);
  if (!text) return ctx.api.send(ctx.chatId, '📝 لطفاً پیام متنی بفرستید (یا /cancel برای لغو).');

  if (s.a === 'add') return quickAdd(ctx, text);
  if (s.a === 'search') {
    await clearState(ctx);
    return sendSearch(ctx, text);
  }

  const t = s.n ? await Q.getTask(ctx.db, ctx.uid, s.n) : null;
  if (!t) {
    await clearState(ctx);
    return ctx.api.send(ctx.chatId, '❗️ این کار پیدا نشد (شاید حذف شده).');
  }
  const lctx = s.c || DEFAULT_CTX;
  const retry = (message) => ctx.api.send(ctx.chatId, message, { reply_markup: inline([[btn('❌ لغو', ui.cb('T', t.num, lctx))]]) });

  switch (s.a) {
    case 'text': {
      if (Array.from(text).length > MAX_TASK_LEN) return retry(`❗️ حداکثر ${fa(MAX_TASK_LEN)} کاراکتر. دوباره بفرستید:`);
      await Q.updateTask(ctx.db, ctx.uid, t.num, { text });
      break;
    }
    case 'note': {
      if (Array.from(text).length > MAX_NOTE_LEN) return retry(`❗️ یادداشت حداکثر ${fa(MAX_NOTE_LEN)} کاراکتر می‌تواند باشد. دوباره بفرستید:`);
      await Q.updateTask(ctx.db, ctx.uid, t.num, { note: text });
      break;
    }
    case 'cat': {
      const name = cleanCategory(text.replace(/^#/, ''));
      if (!name) return retry('❗️ نام دسته فقط می‌تواند حروف، عدد، فاصله، نیم‌فاصله و _ داشته باشد و کوتاه باشد (حداکثر ۲۰ حرف). دوباره بفرستید:');
      await Q.updateTask(ctx.db, ctx.uid, t.num, { category: name });
      break;
    }
    case 'due': {
      const r = parseWhen(text, ctx.now, { defaultHour: 23, defaultMinute: 59 });
      if (!r) return retry('❗️ تاریخ را متوجه نشدم. نمونه‌ها: <code>فردا</code>، <code>شنبه</code>، <code>1405/08/10</code>، <code>فردا 18:00</code>');
      await Q.updateTask(ctx.db, ctx.uid, t.num, { due_at: r.ts, due_time: r.hasTime ? 1 : 0 });
      break;
    }
    case 'rem': {
      const r = parseWhen(text, ctx.now, { defaultHour: 9, defaultMinute: 0 });
      if (!r) return retry('❗️ زمان را متوجه نشدم. نمونه‌ها: <code>30 دقیقه دیگر</code>، <code>18:30</code>، <code>فردا ساعت 9</code>');
      if (r.ts <= ctx.now) return retry('❗️ این زمان گذشته است. یک زمان در آینده بفرستید:');
      await Q.updateTask(ctx.db, ctx.uid, t.num, { remind_at: r.ts });
      break;
    }
    default:
      await clearState(ctx);
      return COMMANDS['/cancel'](ctx);
  }
  await clearState(ctx);
  return sendCard(ctx, await Q.getTask(ctx.db, ctx.uid, t.num), lctx, '✏️ <b>ذخیره شد.</b>\n\n');
}

// ======================= callbacks =======================

async function onCallback(base, cq) {
  if (!cq.message || cq.message.chat?.type !== 'private') return base.api.answer(cq.id);
  const ctx = await buildCtx(base, cq.from, cq.message.chat.id);
  ctx.msgId = cq.message.message_id;
  let answered = false;
  ctx.toast = (text, alert = false) => {
    answered = true;
    return ctx.api.answer(cq.id, text, alert);
  };
  ctx.show = async (text, kb) => {
    const extra = kb ? { reply_markup: kb } : {};
    const r = await ctx.api.edit(ctx.chatId, ctx.msgId, text, extra);
    if (!r.ok && !/not modified/.test(r.description || '')) return ctx.api.send(ctx.chatId, text, extra);
    return r;
  };
  try {
    await routeCallback(ctx, cq.data || '');
  } finally {
    if (!answered) await ctx.api.answer(cq.id);
  }
}

async function onJoinCheck(ctx) {
  const missing = ctx.isOwner ? [] : await checkJoin(ctx, ctx.uid, { force: true });
  if (missing.length) {
    await ctx.toast('❌ هنوز در همه کانال‌ها عضو نشده‌اید.', true);
    const v = joinGateView(missing);
    return ctx.show(v.text, v.kb);
  }
  await ctx.toast('✅ عضویت شما تأیید شد');
  await ctx.show('✅ عضویت شما تأیید شد. خوش آمدید!', null);
  return sendWelcome(ctx);
}

async function routeCallback(ctx, data) {
  if (data === 'J') return onJoinCheck(ctx);

  if (!ctx.isOwner) {
    const missing = await checkJoin(ctx, ctx.uid);
    if (missing.length) {
      await ctx.toast('🔒 اول باید در کانال‌ها عضو شوید.', true);
      const v = joinGateView(missing);
      return ctx.api.send(ctx.chatId, v.text, { reply_markup: v.kb });
    }
  }

  const [action, ...p] = data.split('|');
  switch (action) {
    case 'N':
      return null;
    case 'CX':
      await clearState(ctx);
      return ctx.show('❌ لغو شد.', null);
    case 'ADD':
      await clearState(ctx);
      return promptAdd(ctx);
    case 'L': {
      await clearState(ctx);
      const v = await buildList(ctx, p[0] || 'p', Number(p[1]) || 0);
      return ctx.show(v.text, v.kb);
    }
    case 'S':
      return onSettingsCallback(ctx, p);
    case 'A':
      if (!ctx.isOwner) return ctx.toast('⛔️ این بخش فقط برای مالک ربات است.', true);
      return admin.onAdminCallback(ctx, p);
    case 'SN':
      return onSnooze(ctx, Number(p[0]), Number(p[1]));
    default:
      return onTaskCallback(ctx, action, p);
  }
}

async function onTaskCallback(ctx, action, p) {
  const num = Number(p[0]);
  const t = Number.isInteger(num) ? await Q.getTask(ctx.db, ctx.uid, num) : null;
  if (!t) {
    await ctx.toast('❗️ این کار پیدا نشد (شاید حذف شده).', true);
    const v = await buildList(ctx, 'p', 0);
    return ctx.show(v.text, v.kb);
  }
  // The list context ("filter.page") is always the last part, when it fit in the callback data.
  const lctx = action === 'T' || action === 'D' || action === 'X' || action === 'XX' ? p[1] || DEFAULT_CTX : p[2] || DEFAULT_CTX;
  const card = async (toast) => {
    if (toast) await ctx.toast(toast);
    const fresh = await Q.getTask(ctx.db, ctx.uid, num);
    return ctx.show(ui.taskCard(fresh, ctx.now), ui.taskCardKb(fresh, lctx));
  };
  const backKb = (rows = []) => inline([...rows, [btn('🔙 بازگشت', ui.cb('T', num, lctx))]]);

  switch (action) {
    case 'T':
      await clearState(ctx);
      return card();

    case 'D':
      return card(await toggleDone(ctx, t));

    case 'X':
      return ctx.show(
        `🗑 کار «<b>${esc(ui.truncate(t.text, 60))}</b>» حذف شود؟`,
        inline([[btn('✅ بله، حذف شود', ui.cb('XX', num, lctx)), btn('❌ نه', ui.cb('T', num, lctx))]]),
      );

    case 'XX': {
      await Q.deleteTask(ctx.db, ctx.uid, num);
      await ctx.toast('🗑 حذف شد');
      const { filter, page } = listFromCtx(lctx);
      const v = await buildList(ctx, filter, page);
      return ctx.show(v.text, v.kb);
    }

    case 'E':
      return onEditMenu(ctx, t, p[1], lctx, backKb);

    case 'P':
      await Q.updateTask(ctx.db, ctx.uid, num, { priority: Math.min(3, Math.max(1, Number(p[1]) || 2)) });
      return card(`اولویت: ${ui.PRIORITY[Number(p[1])]?.label || 'متوسط'}`);

    case 'C': {
      await clearState(ctx);
      const name = p[1] === '-' ? null : cleanCategory(p[1]);
      await Q.updateTask(ctx.db, ctx.uid, num, { category: name });
      return card(name ? `🗂 دسته: ${name}` : '🗂 دسته حذف شد');
    }

    case 'DD': {
      await clearState(ctx);
      if (p[1] === 'x') {
        await Q.updateTask(ctx.db, ctx.uid, num, { due_at: null, due_time: 0 });
        return card('📅 ددلاین حذف شد');
      }
      const days = Number(p[1]) || 0;
      const base = days === 30 ? addRepeat(ctx.now, 'm') : ctx.now + days * DAY;
      const lp = localParts(base);
      const ts = fromLocal(lp.y, lp.m, lp.d, 23, 59);
      await Q.updateTask(ctx.db, ctx.uid, num, { due_at: ts, due_time: 0 });
      return card(`📅 ددلاین: ${formatShortDate(ts)}`);
    }

    case 'RM': {
      await clearState(ctx);
      if (p[1] === 'x') {
        await Q.updateTask(ctx.db, ctx.uid, num, { remind_at: null });
        return card('⏰ یادآور حذف شد');
      }
      const ts = reminderPreset(ctx.now, p[1], t);
      if (!ts || ts <= ctx.now) return ctx.toast('❗️ این زمان گذشته است؛ زمان دیگری انتخاب کنید.', true);
      await Q.updateTask(ctx.db, ctx.uid, num, { remind_at: ts });
      return card(`⏰ یادآور: ${formatDate(ts, { now: ctx.now })}`);
    }

    case 'RP': {
      const repeat = ['d', 'w', 'm'].includes(p[1]) ? p[1] : null;
      await Q.updateTask(ctx.db, ctx.uid, num, { repeat });
      return card(repeat ? `🔁 تکرار ${REPEAT_LABELS[repeat]}` : '🔁 تکرار خاموش شد');
    }

    case 'NX':
      await clearState(ctx);
      await Q.updateTask(ctx.db, ctx.uid, num, { note: null });
      return card('📝 یادداشت حذف شد');

    default:
      return ctx.toast('دستور نامعتبر');
  }
}

async function onEditMenu(ctx, t, field, lctx, backKb) {
  const num = t.num;
  const title = `<b>${fa(num)}. ${esc(ui.truncate(t.text, 60))}</b>\n\n`;
  switch (field) {
    case 't':
      await setState(ctx, { a: 'text', n: num, c: lctx });
      return ctx.show(`${title}✏️ متن جدید این کار را بفرستید:\n\n<code>${esc(t.text)}</code>`, backKb());
    case 'n':
      await setState(ctx, { a: 'note', n: num, c: lctx });
      return ctx.show(
        `${title}📝 یادداشت این کار را بفرستید${t.note ? ' (جایگزین یادداشت فعلی می‌شود)' : ''}:${t.note ? `\n\n<i>${esc(t.note)}</i>` : ''}`,
        backKb(t.note ? [[btn('🗑 حذف یادداشت', ui.cb('NX', num, '', lctx))]] : []),
      );
    case 'p':
      return ctx.show(`${title}🔥 اولویت را انتخاب کنید:`, ui.priorityKb(num, lctx));
    case 'c': {
      await setState(ctx, { a: 'cat', n: num, c: lctx });
      const cats = await Q.listCategories(ctx.db, ctx.uid);
      return ctx.show(`${title}🗂 یک دسته انتخاب کنید یا <b>نام دسته جدید</b> را تایپ کنید:`, ui.categoryKb(num, cats, t.category, lctx));
    }
    case 'd':
      await setState(ctx, { a: 'due', n: num, c: lctx });
      return ctx.show(
        `${title}📅 ددلاین را انتخاب کنید یا تایپ کنید.\nنمونه: <code>فردا</code>، <code>شنبه 18:00</code>، <code>1405/08/10</code>، <code>+5</code>`,
        ui.dueKb(num, !!t.due_at, lctx),
      );
    case 'r':
      await setState(ctx, { a: 'rem', n: num, c: lctx });
      return ctx.show(
        `${title}⏰ زمان یادآوری را انتخاب کنید یا تایپ کنید.\nنمونه: <code>45 دقیقه دیگر</code>، <code>18:30</code>، <code>فردا ساعت 8</code>، <code>1405/08/10 10:00</code>`,
        ui.reminderKb(num, t, lctx),
      );
    case 'R':
      return ctx.show(
        `${title}🔁 تکرار این کار را انتخاب کنید.\nبا انجام هر نوبت، ددلاین (و یادآور) خودکار به نوبت بعد منتقل می‌شود.`,
        ui.repeatKb(num, t.repeat, lctx),
      );
    default:
      return ctx.toast('دستور نامعتبر');
  }
}

function reminderPreset(now, preset, t) {
  if (/^\d+$/.test(preset)) return now + Number(preset) * MINUTE;
  const lp = localParts(now);
  if (preset === 't9') {
    const tp = localParts(now + DAY);
    return fromLocal(tp.y, tp.m, tp.d, 9, 0);
  }
  if (preset === 'n21') return fromLocal(lp.y, lp.m, lp.d, 21, 0);
  if (preset === 'due') return t.due_at;
  if (preset === 'due60') return t.due_at ? t.due_at - 60 * MINUTE : null;
  return null;
}

/** Marks a task done/undone; recurring tasks log a done copy and move to their next occurrence. */
export async function toggleDone(ctx, t) {
  if (t.done) {
    await Q.updateTask(ctx.db, ctx.uid, t.num, { done: 0, done_at: null });
    return '↩️ به کارهای در جریان برگشت';
  }
  if (t.repeat) {
    const today = localParts(ctx.now);
    const base = t.due_at ?? fromLocal(today.y, today.m, today.d, 23, 59);
    const next = nextOccurrence(base, t.repeat, ctx.now);
    await Q.addTask(
      ctx.db,
      ctx.uid,
      { text: t.text, note: t.note, priority: t.priority, category: t.category, due_at: t.due_at, due_time: t.due_time, done: 1, done_at: ctx.now },
      ctx.now,
    );
    // A reminder that already fired was rescheduled by the cron; only move one still pending for this occurrence.
    let remind = t.remind_at && t.remind_at <= base ? t.remind_at + (next - base) : t.remind_at;
    if (remind && remind <= ctx.now) remind = nextOccurrence(remind, t.repeat, ctx.now);
    await Q.updateTask(ctx.db, ctx.uid, t.num, { due_at: next, due_time: t.due_at ? t.due_time : 0, remind_at: remind });
    return `🔁 انجام شد! نوبت بعد: ${formatShortDate(next)}`;
  }
  await Q.updateTask(ctx.db, ctx.uid, t.num, { done: 1, done_at: ctx.now, remind_at: null });
  return '✅ آفرین! انجام شد';
}

async function onSnooze(ctx, num, minutes) {
  const t = await Q.getTask(ctx.db, ctx.uid, num);
  if (!t || t.done) return ctx.show('ℹ️ این کار دیگر در جریان نیست.', null);
  const ts = ctx.now + (minutes || 10) * MINUTE;
  await Q.updateTask(ctx.db, ctx.uid, num, { remind_at: ts });
  await ctx.toast('😴 به تعویق افتاد');
  return ctx.show(
    `😴 یادآوری «<b>${esc(t.text)}</b>» به ساعت ${formatTime(ts)} موکول شد.`,
    inline([[btn('📄 جزئیات کار', ui.cb('T', num, DEFAULT_CTX))]]),
  );
}

async function onSettingsCallback(ctx, p) {
  const [action, arg] = p;
  switch (action) {
    case 'h': {
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case 'dg': {
      const hours = [6, 7, 8, 9, 10, 12, 14, 18, 20, 21, 22, 23];
      const rows = [];
      for (let i = 0; i < hours.length; i += 4) {
        rows.push(hours.slice(i, i + 4).map((h) => btn(`${ctx.user.digest_hour === h ? '✓ ' : ''}${fa(`${h}:00`)}`, `S|dh|${h}`)));
      }
      rows.push([btn('🔕 خاموش', 'S|dh|x'), btn('🔙 بازگشت', 'S|h')]);
      return ctx.show(
        '🌅 <b>خلاصه روزانه</b>\n\nهر روز در ساعت انتخابی، لیست کارهای امروز، کارهای عقب‌افتاده و کارهای مهم برایتان ارسال می‌شود.\nساعت را انتخاب کنید:',
        inline(rows),
      );
    }
    case 'dh': {
      const hour = arg === 'x' ? null : Math.min(23, Math.max(0, Number(arg)));
      // If today's slot already passed, start from tomorrow instead of sending immediately.
      const last = hour !== null && localParts(ctx.now).hh >= hour ? localDateKey(ctx.now) : null;
      await Q.setDigest(ctx.db, ctx.uid, hour, last);
      ctx.user.digest_hour = hour;
      await ctx.toast(hour === null ? '🔕 خلاصه روزانه خاموش شد' : `🌅 هر روز ساعت ${fa(hour)}:۰۰`);
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    case 'ex': {
      const tasks = await Q.allTasks(ctx.db, ctx.uid);
      if (!tasks.length) return ctx.toast('هنوز کاری ثبت نکرده‌اید.', true);
      await ctx.toast('📤 در حال آماده‌سازی فایل...');
      return ctx.api.sendDocument(ctx.chatId, `todo-${localDateKey(ctx.now)}.txt`, exportText(tasks, ctx.now), `📤 خروجی ${fa(tasks.length)} کار شما`);
    }
    case 'cl':
      return ctx.show('🧹 همه کارهای <b>انجام‌شده</b> برای همیشه حذف شوند؟', inline([[btn('✅ بله، پاک کن', 'S|cly'), btn('❌ نه', 'S|h')]]));
    case 'cly': {
      const r = await Q.clearDone(ctx.db, ctx.uid);
      await ctx.toast(`🧹 ${fa(r.meta.changes || 0)} کار انجام‌شده پاک شد`, true);
      const v = settingsView(ctx);
      return ctx.show(v.text, v.kb);
    }
    default:
      return ctx.toast('دستور نامعتبر');
  }
}

function exportText(tasks, now) {
  const pending = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const line = (t) => {
    const parts = [`${t.done ? '[✔]' : `[${ui.PRIORITY[t.priority].icon}]`} #${t.num} ${t.text}`];
    if (t.category) parts.push(`دسته: ${t.category}`);
    if (t.due_at) parts.push(`ددلاین: ${formatDate(t.due_at, { time: !!t.due_time, now })}`);
    if (t.remind_at && !t.done) parts.push(`یادآور: ${formatDate(t.remind_at, { now })}`);
    if (t.repeat) parts.push(`تکرار: ${REPEAT_LABELS[t.repeat]}`);
    if (t.done_at) parts.push(`انجام: ${formatDate(t.done_at, { now })}`);
    return parts.join(' | ') + (t.note ? `\n      یادداشت: ${t.note.replace(/\n/g, '\n      ')}` : '');
  };
  return [
    `خروجی تودو لیست — ${formatDate(now, { now })}`,
    '='.repeat(40),
    '',
    `⏳ در جریان (${pending.length})`,
    ...pending.map(line),
    '',
    `✅ انجام‌شده (${done.length})`,
    ...done.map(line),
    '',
  ].join('\n');
}
