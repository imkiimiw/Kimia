// Shared texts and keyboards (all Persian).
import { DAILY_LIMIT, MAX_LINKS } from './config.js';
import { channelLink } from './join.js';
import { btn, urlBtn } from './tg.js';
import { esc, fa } from './text.js';

export const ERROR_TEXT = '⚠️ متأسفانه مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره امتحان کنید.';

export const QUALITY_NAMES = {
  auto: '⚡️ خودکار (تا ۷۲۰p)',
  best: '💎 بهترین کیفیت',
  low: '🪶 کم‌حجم',
};

export const menuBtn = () => btn('🏠 منوی اصلی', 'm');

export function mainMenu(isOwner) {
  const kb = [
    [btn('⚙️ تنظیمات', 'st'), btn('📜 تاریخچه', 'hi')],
    [btn('👤 پروفایل من', 'pf'), btn('❓ راهنما', 'h')],
  ];
  if (isOwner) kb.push([btn('👑 پنل مدیریت', 'a')]);
  return kb;
}

export function welcomeText(firstName) {
  const name = firstName ? ` ${esc(firstName)}` : '';
  return `سلام${name}! 👋\n\n`
    + '📥 من ویدیو، عکس و گیف پست‌های <b>X (توییتر)</b> را برایتان می‌فرستم.\n\n'
    + '🔗 فقط لینک پست را بفرستید، مثلاً:\n<code>https://x.com/NASA/status/2118034216503955710</code>\n\n'
    + `در هر پیام تا ${fa(MAX_LINKS)} لینک می‌توانید بفرستید.`;
}

export function helpText(isOwner) {
  return '❓ <b>راهنما</b>\n\n'
    + '1️⃣ لینک پست را از X کپی کنید (دکمه‌ی اشتراک ← کپی لینک) و برای من بفرستید.\n'
    + '   لینک‌های x.com، twitter.com، mobile.twitter.com، fxtwitter.com، fixupx.com، vxtwitter.com و fixvx.com قبول است.\n'
    + `2️⃣ در یک پیام تا ${fa(MAX_LINKS)} لینک بفرستید؛ یکی‌یکی دریافت و ارسال می‌شوند.\n`
    + '3️⃣ ویدیو با بهترین کیفیتی فرستاده می‌شود که در سقف حجم تلگرام (۵۰ مگابایت) جا شود. '
    + 'زیر هر ویدیو دکمه‌ی «🎚 کیفیت‌های دیگر» هست.\n'
    + '4️⃣ چند عکس با هم به‌صورت آلبوم و با اندازه‌ی اصلی می‌آیند؛ گیف‌ها به‌صورت انیمیشن.\n'
    + '5️⃣ از ⚙️ تنظیمات کیفیت پیش‌فرض و محتوای کپشن (متن پست، نویسنده، لینک) را انتخاب کنید.\n'
    + '6️⃣ در 📜 تاریخچه، ۲۰ دانلود آخر را دوباره و فوری بگیرید.\n\n'
    + (isOwner ? '👑 شما مدیر هستید: محدودیت روزانه ندارید. پنل: /admin\n\n'
      : `📊 سهمیه‌ی روزانه: ${fa(DAILY_LIMIT)} پست.\n\n`)
    + '🔒 پست‌های حساب‌های خصوصی و پست‌های حذف‌شده قابل دریافت نیستند.\n\n'
    + 'دستورها: /start /settings /history /profile /help';
}

/** The screen shown to someone who hasn't joined every mandatory channel. */
export function joinScreen(missing, isStart) {
  const intro = isStart ? '👋 خوش آمدید!\n\n' : '';
  const list = missing.map((ch) => `• ${ch.title ? esc(ch.title) : `@${esc(ch.username)}`}`).join('\n');
  const text = `${intro}🔒 <b>برای استفاده از ربات، اول در ${missing.length > 1 ? 'این کانال‌ها' : 'این کانال'} عضو شوید:</b>\n\n`
    + `${list}\n\nبعد از عضویت، دکمه‌ی «✅ عضو شدم» را بزنید.`;
  const kb = missing.map((ch) => [urlBtn(`📢 عضویت در ${ch.title || `@${ch.username}`}`, channelLink(ch))]);
  kb.push([btn('✅ عضو شدم', 'j')]);
  return { text, kb };
}

/** Persian reason for a post that can't be downloaded. */
export function failureText(reason) {
  switch (reason) {
    case 'not_found':
      return '❌ این پست پیدا نشد. ممکن است حذف شده باشد یا لینک اشتباه باشد.';
    case 'private':
      return '🔒 این پست از یک حساب خصوصی (قفل‌شده) است و بدون دسترسی قابل دریافت نیست.';
    case 'no_media':
      return '📝 این پست عکس، ویدیو یا گیف ندارد (فقط متن است).';
    case 'sensitive':
      return '🔞 این پست «حساس» علامت خورده و توییتر رسانه‌اش را بدون ورود به حساب نشان نمی‌دهد؛ قابل دریافت نیست.';
    case 'blocked':
      return '🛡 رسانه‌ی این پست از دامنه‌ای غیر از twimg.com آمده بود و برای امنیت دریافت نشد.';
    case 'unavailable_or_missing':
      return '⚠️ این پست دریافت نشد: یا حذف شده یا سرویس‌های دریافت پست موقتاً در دسترس نیستند. چند دقیقه بعد دوباره امتحان کنید.';
    case 'error':
      return '⚠️ هنگام دریافت این پست مشکلی پیش آمد. لطفاً دوباره امتحان کنید.';
    case 'send_failed':
      return '⚠️ دریافت پست انجام شد ولی ارسالش به تلگرام ناموفق بود. چند لحظه بعد دوباره امتحان کنید.';
    default:
      return '⚠️ سرویس‌های دریافت پست الان در دسترس نیستند. چند دقیقه بعد دوباره امتحان کنید.';
  }
}
