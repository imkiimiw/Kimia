// Shared texts and keyboards. All user-facing text is Persian; callback_data stays short ASCII
// (see the code table in lib/router.js).
import { OWNER_ID } from './config.js';
import { btn, urlBtn } from './tg.js';
import { esc } from './text.js';

export const PRIORITY = {
  1: { icon: '🔴', name: 'بالا' },
  2: { icon: '🟡', name: 'متوسط' },
  3: { icon: '🟢', name: 'پایین' },
};

export const SORT = {
  p: { label: '🔥 اولویت', next: 'd' },
  d: { label: '📅 تاریخ', next: 'n' },
  n: { label: '🆕 جدیدترین', next: 'p' },
};

export const ERROR_TEXT = '⚠️ متأسفانه مشکلی پیش آمد. لطفاً چند لحظه دیگر دوباره تلاش کنید.';

export const menuBtn = () => btn('🏠 منوی اصلی', 'm');

export function mainMenuKeyboard(userId) {
  const kb = [
    [btn('➕ افزودن کار', 'add'), btn('📋 لیست کارها', 'l:0:0')],
    [btn('🗂 دسته‌بندی‌ها', 'cats'), btn('🔍 جستجو', 's')],
    [btn('📊 آمار', 'st'), btn('❓ راهنما', 'h')],
  ];
  if (userId === OWNER_ID) kb.push([btn('👑 پنل مدیریت', 'a')]);
  return kb;
}

export function welcomeText(firstName) {
  const name = firstName ? ` ${esc(firstName)}` : '';
  return `👋 سلام${name}، خوش آمدید!\n\n`
    + '📝 من دستیار کارهای شما هستم. کارهایتان را ثبت کنید، اولویت و تاریخ سررسید بدهید، '
    + 'دسته‌بندی کنید و پیشرفتتان را ببینید.\n\n'
    + '✍️ برای افزودن کار کافی است متنش را همین‌جا بفرستید.\n'
    + 'از دکمه‌های زیر هم می‌توانید استفاده کنید 👇';
}

export const HELP_TEXT = '❓ <b>راهنمای ربات</b>\n\n'
  + '➕ <b>افزودن کار:</b> متن کار را بفرستید یا بنویسید <code>/add خرید نان</code>\n'
  + '📋 <b>لیست کارها:</b> /list — با ⬜️ / ✅ وضعیت کار عوض می‌شود و با زدن روی هر کار، '
  + 'می‌توانید متن، اولویت، تاریخ و دسته‌اش را تغییر دهید یا حذفش کنید.\n'
  + '🔥 <b>اولویت:</b> 🔴 بالا، 🟡 متوسط، 🟢 پایین؛ ترتیب لیست را با دکمه‌ی «مرتب‌سازی» عوض کنید.\n'
  + '📅 <b>سررسید:</b> شمسی مثل <code>1405/08/10</code> یا میلادی مثل <code>2026-11-01</code>. '
  + 'کارهای عقب‌افتاده هنگام باز کردن لیست با ⏰ مشخص می‌شوند.\n'
  + '🗂 <b>دسته‌بندی:</b> /cats — دسته بسازید و لیست را بر اساس دسته ببینید.\n'
  + '🔍 <b>جستجو:</b> <code>/search نان</code>\n'
  + '📊 <b>آمار:</b> /stats — همراه با پاک‌کردن کارهای انجام‌شده.\n'
  + '❌ <b>انصراف:</b> /cancel\n\n'
  + 'ℹ️ این ربات پیام یادآوری خودکار نمی‌فرستد؛ سررسیدها هر بار که لیست را باز می‌کنید بررسی می‌شوند.';

/** The "join these channels first" screen, listing only the channels the user hasn't joined. */
export function joinScreen(missing, withWelcome) {
  const lines = missing.map((ch) => `• ${ch.title ? `${esc(ch.title)} (@${esc(ch.username)})` : `@${esc(ch.username)}`}`);
  const text = (withWelcome ? '👋 سلام، خوش آمدید!\n\n' : '')
    + '🔒 <b>عضویت اجباری</b>\n\n'
    + 'برای استفاده از ربات، ابتدا در کانال‌های زیر عضو شوید:\n'
    + `${lines.join('\n')}\n\n`
    + 'بعد از عضویت، روی «✅ عضو شدم» بزنید.';
  const kb = missing.map((ch) => [urlBtn(`📢 عضویت در ${ch.title || `@${ch.username}`}`, `https://t.me/${ch.username}`)]);
  kb.push([btn('✅ عضو شدم', 'j')]);
  return { text, kb };
}
