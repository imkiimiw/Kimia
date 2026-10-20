import { PAGE_SIZE } from './config.js';
import { fa, formatDate, formatTime, relativeDay, REPEAT_LABELS } from './time.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const truncate = (s, n) => {
  const chars = Array.from(String(s));
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : String(s);
};

/** Joins callback parts; drops the trailing list context if Telegram's 64-byte limit would be exceeded. */
export function cb(...parts) {
  const data = parts.join('|');
  if (new TextEncoder().encode(data).length <= 64) return data;
  return parts.slice(0, -1).join('|');
}

export const btn = (text, data) => ({ text, callback_data: data });
export const urlBtn = (text, url) => ({ text, url });
export const inline = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });

// ---------- main menu ----------

export const BTN = {
  add: '➕ کار جدید',
  list: '📋 کارهای من',
  today: '📅 امروز',
  search: '🔍 جستجو',
  cats: '🗂 دسته‌ها',
  stats: '📊 آمار',
  settings: '⚙️ تنظیمات',
  help: '❓ راهنما',
  admin: '👑 پنل مدیریت',
};

export function mainKeyboard(isOwner) {
  const rows = [
    [BTN.add, BTN.list],
    [BTN.today, BTN.search],
    [BTN.cats, BTN.stats],
    [BTN.settings, BTN.help],
  ];
  if (isOwner) rows.push([BTN.admin]);
  return { keyboard: rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true };
}

export const cancelKb = inline([[btn('❌ لغو', 'CX')]]);

// ---------- tasks ----------

export const PRIORITY = {
  1: { icon: '🔴', label: 'بالا' },
  2: { icon: '🟡', label: 'متوسط' },
  3: { icon: '🟢', label: 'کم' },
};

export function dueLabel(t, now) {
  if (!t.due_at) return '';
  const time = t.due_time ? ` ${formatTime(t.due_at)}` : '';
  const late = !t.done && t.due_at < now ? '⚠️ ' : '';
  return `${late}${relativeDay(t.due_at, now)}${time}`;
}

// maxLen keeps multi-task messages (lists, search, digest) under Telegram's 4096-character limit.
export function taskLine(t, now, maxLen = 120) {
  const icon = t.done ? '✅' : PRIORITY[t.priority].icon;
  const text = esc(truncate(t.text, maxLen));
  const title = t.done ? `<s>${text}</s>` : text;
  const meta = [];
  if (t.due_at) meta.push(`📅 ${dueLabel(t, now)}`);
  if (t.category) meta.push(`🗂 ${esc(t.category)}`);
  if (t.remind_at && !t.done) meta.push('⏰');
  if (t.repeat) meta.push('🔁');
  if (t.note) meta.push('📝');
  return `${icon} <b>${fa(t.num)}.</b> ${title}${meta.length ? `\n      <i>${meta.join(' · ')}</i>` : ''}`;
}

export function taskCard(t, now) {
  const lines = [
    `${t.done ? '✅' : PRIORITY[t.priority].icon} <b>کار شماره ${fa(t.num)}</b>`,
    '',
    `<b>${esc(t.text)}</b>`,
    '━━━━━━━━━━━━━━',
    `📌 وضعیت: ${t.done ? `انجام شده (${relativeDay(t.done_at, now)})` : '⏳ در جریان'}`,
    `🔥 اولویت: ${PRIORITY[t.priority].icon} ${PRIORITY[t.priority].label}`,
    `🗂 دسته: ${t.category ? esc(t.category) : '—'}`,
    `📅 ددلاین: ${t.due_at ? `${formatDate(t.due_at, { time: !!t.due_time, now })} (${dueLabel(t, now)})` : '—'}`,
    `⏰ یادآور: ${t.remind_at && !t.done ? formatDate(t.remind_at, { now }) : '—'}`,
    `🔁 تکرار: ${t.repeat ? REPEAT_LABELS[t.repeat] : '—'}`,
  ];
  if (t.note) lines.push('', `📝 <b>یادداشت:</b>\n${esc(t.note)}`);
  lines.push('', `<i>🕓 ایجاد: ${formatDate(t.created_at, { now })}</i>`);
  return lines.join('\n');
}

export function taskCardKb(t, ctx) {
  const n = t.num;
  return inline([
    [btn(t.done ? '↩️ برگرداندن به در جریان' : '✅ انجام شد', cb('D', n, ctx)), btn('🗑 حذف', cb('X', n, ctx))],
    [btn('✏️ ویرایش متن', cb('E', n, 't', ctx)), btn('📝 یادداشت', cb('E', n, 'n', ctx))],
    [btn('🔥 اولویت', cb('E', n, 'p', ctx)), btn('🗂 دسته', cb('E', n, 'c', ctx))],
    [btn('📅 ددلاین', cb('E', n, 'd', ctx)), btn('⏰ یادآور', cb('E', n, 'r', ctx))],
    [btn('🔁 تکرار', cb('E', n, 'R', ctx)), btn('🔙 بازگشت به لیست', `L|${ctx.replace('.', '|')}`)],
  ]);
}

const LIST_TITLES = {
  p: '📋 <b>کارهای در جریان</b>',
  t: '📅 <b>کارهای امروز و عقب‌افتاده</b>',
  d: '✅ <b>کارهای انجام‌شده</b>',
  a: '🗃 <b>همه کارها</b>',
};

export function listView({ filter, page, total, rows, now }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const title = filter.startsWith('c') ? `🗂 <b>دسته «${esc(filter.slice(1))}»</b>` : LIST_TITLES[filter];
  const header = `${title} (${fa(total)})${pages > 1 ? ` — صفحه ${fa(page + 1)} از ${fa(pages)}` : ''}`;
  const body = rows.length
    ? rows.map((t) => taskLine(t, now)).join('\n\n')
    : filter === 'p'
      ? '✨ هیچ کار در جریانی ندارید!\nبرای افزودن کار، کافیه متنش رو همین‌جا بفرستید.'
      : '✨ چیزی برای نمایش نیست.';
  const ctx = `${filter}.${page}`;
  const rowsKb = rows.map((t) => [btn(`${t.done ? '✅' : PRIORITY[t.priority].icon} ${fa(t.num)}. ${truncate(t.text, 30)}`, cb('T', t.num, ctx))]);
  const nav = [];
  if (pages > 1) {
    nav.push(btn('◀️', page > 0 ? `L|${filter}|${page - 1}` : 'N'));
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, 'N'));
    nav.push(btn('▶️', page < pages - 1 ? `L|${filter}|${page + 1}` : 'N'));
  }
  const mark = (f, label) => btn(filter === f ? `• ${label} •` : label, `L|${f}|0`);
  return {
    text: `${header}\n\n${body}`,
    kb: inline([...rowsKb, nav, [mark('p', '⏳ در جریان'), mark('t', '📅 امروز'), mark('d', '✅ انجام‌شده')], [btn('➕ افزودن کار', 'ADD'), btn('🗃 همه', 'L|a|0')]]),
  };
}

export function priorityKb(n, ctx) {
  return inline([
    [1, 2, 3].map((p) => btn(`${PRIORITY[p].icon} ${PRIORITY[p].label}`, cb('P', n, p, ctx))),
    [btn('🔙 بازگشت', cb('T', n, ctx))],
  ]);
}

export function categoryKb(n, categories, current, ctx) {
  const rows = [];
  const names = categories.map((c) => c.category).filter((c) => c !== current).slice(0, 8);
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map((c) => btn(`🗂 ${c}`, cb('C', n, c, ctx))));
  if (current) rows.push([btn('❌ حذف دسته', cb('C', n, '-', ctx))]);
  rows.push([btn('🔙 بازگشت', cb('T', n, ctx))]);
  return inline(rows);
}

export function dueKb(n, hasDue, ctx) {
  return inline([
    [btn('امروز', cb('DD', n, '0', ctx)), btn('فردا', cb('DD', n, '1', ctx)), btn('پس‌فردا', cb('DD', n, '2', ctx))],
    [btn('۳ روز دیگر', cb('DD', n, '3', ctx)), btn('هفته بعد', cb('DD', n, '7', ctx)), btn('ماه بعد', cb('DD', n, '30', ctx))],
    hasDue ? [btn('❌ حذف ددلاین', cb('DD', n, 'x', ctx))] : [],
    [btn('🔙 بازگشت', cb('T', n, ctx))],
  ]);
}

export function reminderKb(n, t, ctx) {
  return inline([
    [btn('۱۵ دقیقه بعد', cb('RM', n, '15', ctx)), btn('۳۰ دقیقه بعد', cb('RM', n, '30', ctx))],
    [btn('۱ ساعت بعد', cb('RM', n, '60', ctx)), btn('۳ ساعت بعد', cb('RM', n, '180', ctx))],
    [btn('فردا ۹ صبح', cb('RM', n, 't9', ctx)), btn('امشب ۲۱:۰۰', cb('RM', n, 'n21', ctx))],
    t.due_at && t.due_time ? [btn('⏱ سر موعد ددلاین', cb('RM', n, 'due', ctx)), btn('۱ ساعت قبل ددلاین', cb('RM', n, 'due60', ctx))] : [],
    t.remind_at ? [btn('❌ حذف یادآور', cb('RM', n, 'x', ctx))] : [],
    [btn('🔙 بازگشت', cb('T', n, ctx))],
  ]);
}

export function repeatKb(n, current, ctx) {
  const mark = (r, label) => btn(current === r ? `✓ ${label}` : label, cb('RP', n, r, ctx));
  return inline([
    [mark('d', 'روزانه'), mark('w', 'هفتگی'), mark('m', 'ماهانه')],
    current ? [btn('❌ بدون تکرار', cb('RP', n, 'x', ctx))] : [],
    [btn('🔙 بازگشت', cb('T', n, ctx))],
  ]);
}

export function progressBar(ratio, width = 10) {
  const filled = Math.round(ratio * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const QUICK_ADD_HINT = [
  '💡 <b>افزودن سریع:</b> هر متنی بفرستید به‌عنوان کار جدید ذخیره می‌شه.',
  'می‌تونید داخل متن از این‌ها هم استفاده کنید:',
  '• <code>#دسته</code> ← دسته‌بندی (مثلاً <code>#خرید</code>)',
  '• <code>!1</code> / <code>!2</code> / <code>!3</code> ← اولویت بالا / متوسط / کم',
  '• <code>@زمان</code> ← ددلاین (مثلاً <code>@فردا</code>، <code>@شنبه ساعت 18</code>، <code>@1405/08/10</code>)',
  '',
  'نمونه: <code>خرید نان و شیر #خانه !1 @فردا 18:00</code>',
].join('\n');

export const HELP_TEXT = [
  '📖 <b>راهنمای ربات تودو لیست</b>',
  '',
  '<b>۱۰ قابلیت ربات:</b>',
  '1️⃣ <b>افزودن سریع هوشمند</b> — متن بفرستید؛ دسته، اولویت و ددلاین رو از خود متن می‌فهمه.',
  '2️⃣ <b>اولویت‌بندی</b> 🔴🟡🟢 — کارها خودکار بر اساس اولویت و ددلاین مرتب می‌شن.',
  '3️⃣ <b>ددلاین با تقویم شمسی</b> 📅 — با هشدار ⚠️ برای کارهای عقب‌افتاده.',
  '4️⃣ <b>یادآور زمان‌دار</b> ⏰ — سر وقت پیام می‌گیرید (با دکمه تعویق).',
  '5️⃣ <b>دسته‌بندی</b> 🗂 — کارها رو گروه‌بندی و فیلتر کنید.',
  '6️⃣ <b>کارهای تکراری</b> 🔁 — روزانه، هفتگی یا ماهانه؛ با انجام هر نوبت، نوبت بعد خودکار ساخته می‌شه.',
  '7️⃣ <b>یادداشت و ویرایش کامل</b> 📝 — متن، یادداشت و همه مشخصات هر کار قابل ویرایشه.',
  '8️⃣ <b>جستجو</b> 🔍 — در متن، یادداشت و دسته کارها.',
  '9️⃣ <b>آمار و نمودار پیشرفت</b> 📊',
  '🔟 <b>خلاصه روزانه صبحگاهی</b> 🌅 — هر روز ساعت دلخواه، لیست کارهای امروز براتون ارسال می‌شه.',
  '',
  '➕ همچنین: خروجی فایل از همه کارها 📤 و پاکسازی کارهای انجام‌شده 🧹 در ⚙️ تنظیمات.',
  '',
  QUICK_ADD_HINT,
  '',
  '<b>فرمت‌های زمان:</b> <code>امروز</code>، <code>فردا</code>، <code>پس‌فردا</code>، <code>شنبه</code>، <code>هفته بعد</code>، <code>+3</code> (۳ روز بعد)، <code>30 دقیقه دیگر</code>، <code>2 ساعت بعد</code>، <code>18:30</code>، <code>ساعت 8 شب</code>، <code>1405/08/10</code>، <code>2026-11-01 09:00</code>',
  '',
  '<b>دستورات:</b> /start · /list · /today · /add · /search · /stats · /settings · /help · /cancel',
].join('\n');
