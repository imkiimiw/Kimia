/*
 * Persian (the default language). Every user-visible text of the bot lives in these locale files,
 * under the same keys in every language (npm test checks keys and {placeholders}).
 * Values are Telegram HTML; {name} placeholders are filled by t() — numbers get this language's
 * digits automatically. A value may be { one, other } for plural forms (see en.js).
 * ZWNJ (نیم\u200Cفاصله) is written as \u200C so it can't get lost when the file is copied.
 */
export default {
  _name: 'فارسی',
  _digits: '۰۱۲۳۴۵۶۷۸۹',

  'lang.prompt': '🌐 زبان ربات رو انتخاب کن:',
  'lang.saved': '✅ زبان ربات فارسی شد.',

  'start.welcome': '😎 سلام {name}!\n\n📤 <b>آپلود میم:</b> یه عکس، گیف، ویدیو، استیکر یا ویس برام بفرست، بعد چند کلمه\u200Cی کلیدی براش بنویس.\n🔎 <b>جستجو:</b> توی هر چتی بنویس <code>@{bot} کلمه</code> و میم رو انتخاب کن.',
  'help': '❓ <b>راهنما</b>\n\n📤 <b>آپلود:</b> میم رو (عکس، گیف، ویدیو، استیکر یا ویس) همین\u200Cجا بفرست، بعد کلمه\u200Cهای کلیدی رو بنویس: اسم آدم\u200Cها، دیالوگ معروف، حس و حال. روزی حداکثر {limit} میم.\n\n🔎 <b>جستجو:</b> توی هر چتی تایپ کن <code>@{bot} کلمه</code>. اگه چیزی ننویسی، میم\u200Cهای اخیر خودت و محبوب\u200Cترین\u200Cها رو می\u200Cبینی.\n\n📂 /my — میم\u200Cهای من (دیدن و حذف)\n🌐 /lang — تغییر زبان\n✖️ /cancel — لغو آپلود',

  'menu.upload': '📤 آپلود میم',
  'menu.my': '📂 میم\u200Cهای من',
  'menu.search': '🔎 جستجو',
  'menu.lang': '🌐 زبان / Language',
  'menu.help': '❓ راهنما',

  'upload.how': '📤 میمت رو بفرست: عکس، گیف، ویدیو، استیکر یا ویس.',
  'upload.ask': '🔤 حالا چند کلمه\u200Cی کلیدی برای این میم بنویس.\nمثلاً: <i>اسم شخصیت، دیالوگ معروف، حس و حال</i>\n\nهر چی دقیق\u200Cتر بنویسی، راحت\u200Cتر پیدا می\u200Cشه.',
  'upload.replaced': '♻️ میم قبلی که منتظر کلمه\u200Cی کلیدی بود کنار گذاشته شد.',
  'upload.cancel_btn': '✖️ لغو',
  'upload.saved': '✅ میم ذخیره شد!\n🔤 {kw}\n\nامتحانش کن: <code>@{bot} {q}</code>\n📊 آپلودهای امروز: {used} از {limit}',
  'upload.try_btn': '🔎 امتحانش کن',
  'upload.dup_own': '🙂 این میم رو قبلاً خودت آپلود کردی.\n🔤 {kw}',
  'upload.dup': '🙂 این میم قبلاً توی ربات هست.\n🔤 {kw}',
  'upload.limit': '⛔️ امروز {limit} میم آپلود کردی که سقف روزانه\u200Cست.\nاز ساعت ۰۰:۰۰ (به وقت تهران) دوباره می\u200Cتونی.',
  'upload.unsupported': '🤷 این نوع پیام رو قبول نمی\u200Cکنم.\nفقط عکس، گیف، ویدیو، استیکر یا ویس بفرست (ویدیو و گیف رو به\u200Cشکل فایل نفرست).',
  'upload.album': '📚 آلبوم قبول نمی\u200Cشه؛ میم\u200Cها رو یکی\u200Cیکی بفرست.',
  'upload.expired': '⌛️ وقت این آپلود تموم شده؛ میم رو دوباره بفرست.',
  'kw.empty': '✏️ کلمه\u200Cی کلیدی درستی پیدا نشد. چند کلمه (حرف یا عدد) بنویس.',
  'kw.long': '✏️ کلمه\u200Cهای کلیدی خیلی طولانیه (حداکثر {max} حرف). کوتاه\u200Cترش کن.',
  'kw.links': '🚫 لینک و آیدی توی کلمه\u200Cی کلیدی مجاز نیست. دوباره بنویس.',
  'cancel.done': '✖️ آپلود لغو شد.',
  'cancel.none': 'چیزی برای لغو نیست.',
  'hint': '🙂 برای آپلود، میم رو بفرست. برای جستجو توی هر چتی بنویس <code>@{bot} کلمه</code>.',
  'hint.search_btn': '🔎 جستجوی «{q}»',

  'my.empty': '📂 هنوز میمی آپلود نکردی. یه میم بفرست تا شروع کنیم!',
  'my.title': '📂 <b>میم\u200Cهای من</b> ({n})\nروی هر کدوم بزنی، می\u200Cبینیش و می\u200Cتونی حذفش کنی.\nصفحه\u200Cی {p} از {pages}',
  'my.prev': '« قبلی',
  'my.next': 'بعدی »',
  'my.card': '🔤 {kw}\n📊 {n} بار ارسال شده\n🕒 {ago}',
  'my.delete_btn': '🗑 حذف',
  'my.yes': '✅ آره، حذف کن',
  'my.no': '↩️ نه',
  'my.deleted': '🗑 حذف شد.',
  'my.gone': 'این میم دیگه وجود نداره.',

  'inline.none': '😕 پیدا نشد؛ تو آپلودش کن!',
  'inline.upload': '📤 آپلود میم جدید',
  'inline.empty_db': '📤 هنوز میمی نیست؛ اولین نفر باش!',

  'spam.muted': '🐢 یه کم آروم\u200Cتر! تا {n} دقیقه پیام\u200Cهات جواب داده نمی\u200Cشه.',
  'spam.wait': '🐢 یه کم صبر کن.',
  'error': '⚠️ یه مشکلی پیش اومد؛ دوباره امتحان کن.',

  'ago.now': 'همین الان',
  'ago.m': '{n} دقیقه پیش',
  'ago.h': '{n} ساعت پیش',
  'ago.d': '{n} روز پیش',

  'cmd.start': 'شروع',
  'cmd.my': 'میم\u200Cهای من',
  'cmd.lang': 'تغییر زبان',
  'cmd.help': 'راهنما',
  'cmd.cancel': 'لغو آپلود',
  'bot.description': 'میم بفرست، کلمه\u200Cی کلیدی بذار، و توی هر چتی با @نام_ربات پیداش کن و بفرست.',
  'bot.short': 'آپلود و جستجوی میم در هر چتی',

  'owner.backup_fail': '⚠️ پشتیبان\u200Cگیری میم #m{id} در کانال ناموفق بود:\n<code>{err}</code>\n\nربات باید ادمین کانال پشتیبان با دسترسی «ارسال پیام» باشه. (این هشدار حداکثر هر ۳ ساعت یک\u200Cبار میاد.)',
  'owner.setup': '🛠 <b>راه\u200Cاندازی</b>\n\n{lines}',
  'owner.setup.commands': '✅ دستورها و توضیح ربات برای {n} زبان تنظیم شد.',
  'owner.setup.commands_fail': '❌ تنظیم دستورها ناموفق بود: <code>{err}</code>',
  'owner.setup.inline_on': '✅ حالت اینلاین روشنه.',
  'owner.setup.inline_off': '❌ حالت اینلاین خاموشه: در @BotFather دستور /setinline رو بزن.',
  'owner.setup.feedback': 'ℹ️ برای شمارش ارسال\u200Cها، در @BotFather با /setinlinefeedback گزینه\u200Cی ۱۰۰٪ رو انتخاب کن (از Bot API قابل بررسی نیست).',
  'owner.setup.backup_ok': '✅ کانال پشتیبان: {title}',
  'owner.setup.backup_bad': '❌ کانال پشتیبان ({ch}): {err}',
  'owner.setup.backup_off': '⚠️ کانال پشتیبان تنظیم نشده (MEMEBOT_BACKUP_CHANNEL_ID)؛ آپلودها پشتیبان\u200Cگیری نمی\u200Cشن.',
  'owner.setup.not_admin': 'ربات ادمین این کانال با دسترسی «ارسال پیام» نیست',
};
