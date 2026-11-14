# QA — manual device checklists

One section per phase. Tick each box per device; note the Telegram version and the phone model.

## Phase 0 — device spike (after the test push; owner only)

Devices: ☐ Android (mid-range phone, Telegram app) ☐ iPhone (Telegram app) ☐ Telegram Desktop
☐ Telegram Web (web.telegram.org)

Open the Mini App from the bot (Main Mini App / menu button / the link `push` prints), then:

1. ☐ **Run all + heavy** (it downloads ≈ 40 MB on the first run; use Wi-Fi). Wait until every row is
   green or red.
2. ☐ Pick a photo of a **person** and one of an **animal or object** with "Optional photo", then run
   both background-removal rows again. Look at the cut-outs: is the edge clean? Is anything missing?
3. ☐ Look at **Persian text**: letters joined? «می‌خواهم» with its half-space? Latin words and digits
   in the right place?
4. ☐ Look at the **VP9** previews: transparent background (checkerboard visible)? Does it move?
5. ☐ Look at the **animated WebP** previews: do they loop?
6. ☐ Tap **Send to my chat** → a `spike-<platform>.json` document arrives in your chat with the bot.
   Forward it to me (or leave it there).
7. ☐ Write down anything that froze, crashed or took more than 30 s.

What I read from the JSON: VP9 encoder support on iOS; times and memory on the phone; whether
static files of 10–20 MB are served (row "Static hosting"); the largest endpoint request and
response (row "Endpoint"); whether ffmpeg.wasm loads at all on a device.

## Phase 1 — core bot (after the deploy; test with a second account that is not the owner)

Before: @Wanger_Motionbot is an admin in @HIDE_i_SEEK, @Nepenthw_ir, @wangerBots and in the new
publish channel.

Second account:
1. ☐ `/start` → the language buttons → choose فارسی → the join message with three channel buttons.
2. ☐ Send a sticker **before** joining → the join message again. Join all three → «✅ عضو شدم» → the
   bot continues with *that sticker* ("which pack?") without sending it again.
3. ☐ «➕ پک جدید با این استیکر» → a name in Persian → the pack link opens in Telegram.
4. ☐ Send two more stickers → add them to the pack. «🗂 پک‌های من» → the pack → «🖼 استیکرها»:
   move one up, set emojis, keywords, delete one, rename the pack, «💾 پشتیبان» (a JSON file).
5. ☐ Send `t.me/addstickers/<a public pack>` after «📦 وارد کردن از یک پک» → «همه» → a new pack.
6. ☐ «📢 انتشار در کانال» → turn on the name only → «ارسال برای بررسی».
7. ☐ `/admin` from the second account → nothing but "I don't know that command".

Owner:
8. ☐ The review card arrives → «✅ تأیید و انتشار» → the post appears in the channel with the
   sticker, «➕ افزودن…», «👤 <name>» and «🎨 پک خودت را بساز»; the second account gets the link.
9. ☐ Add the second account as a reviewer; publish another pack from a third account; the reviewer
   approves it. The reviewer's `/admin` shows only the queue.
10. ☐ Withdraw a post from the creator's pack screen → it disappears from the channel.
11. ☐ Broadcast a short text to "English" only → only English users get it; the progress message
    ends with the report.
12. ☐ Forced join: disable a channel, re-enable it, preview the gate; maintenance mode on → the second
    account sees the maintenance text → off again.

## Phase 2 — Studio (Android mid-range phone, iPhone, Telegram Desktop)

1. ☐ Send a photo to the bot → «🎨 باز کردن در استودیو» → the photo opens in the Studio.
2. ☐ «✨ حذف خودکار» → note the time (target: the whole flow, step 1 to 6, under 60 s on a mid-range Android).
3. ☐ Erase a bit with «🧽 پاک کن», bring it back with «🖌 برگردان»; zoom in and pan with «✋».
4. ☐ «متن» → «➕ متن تازه» → type `سلام Wanger ۱۲۳` → letters joined, order right; drag it.
5. ☐ «شکل» → دایره, then آزاد; «ظاهر» → outline colour and width, shadow off/on; undo ↶ and redo ↷.
6. ☐ «ذخیره‌ی استیکر» → the size line shows ≤ 512 px and < 512 KB → «➕ پک جدید» + a name →
   «✅ ذخیره» → the bot messages the pack link; open it in Telegram: the sticker is there.
7. ☐ Send another photo → «⚡️ استیکر سریع» → goes straight to saving → add to the same pack.
8. ☐ Menu button «🎨 استودیو» → «📂 انتخاب عکس» → a photo from the gallery (try a HEIC photo on iPhone).
9. ☐ A second account that is not a member opens the Studio → the join screen → join → «✅ عضو شدم».

## Phase 3 — animated, GIF and WhatsApp (Android mid-range phone, iPhone, Telegram Desktop)

Local baseline already green in a container's Chromium (`npm run engine:local`, `npm run
studio:local`; numbers in [SPIKE_REPORT.md](SPIKE_REPORT.md) §9). On the phones:

1. ☐ Send a **video** (≥ 10 s) to the bot → «⚡️ استیکر ویدیویی سریع» → the Studio goes straight to
   saving: the line shows `VP9 · 512×… · ≤ 30 · 3 ثانیه · < 256 کیلوبایت` → «➕ پک جدید» → «✅ ذخیره».
   **This is the real acceptance test of our VP9 file**: Telegram does not check video stickers at
   upload (§9), only when they go into a pack. ☐ The sticker plays in the pack (Android ☐ iPhone ☐ Desktop ☐).
2. ☐ Send a **round video** → «🎬 استیکر ویدیویی» → the preview is a circle with transparent
   corners → «▶ پیش‌نمایش» plays → move «شروع» / «پایان», try ۲× and «⇄ رفت‌وبرگشت» → «ساختن» →
   add to the same pack → the corners are transparent in the pack.
3. ☐ On the **iPhone**: does step 1 work at all? If the Studio says «مرورگر این دستگاه نمی‌تواند
   ویدیوی VP9 بسازد», note the iOS version (that decides the libvpx WASM fallback, D19).
4. ☐ Send a **GIF** → «🌀 ساخت GIF / تبدیل» → «ساختن» → «🎞 بفرست به‌صورت GIF تلگرام» (it arrives as a
   GIF) and «📎 فایل .gif» → **does Telegram keep it as a file?** If it turns into an animation,
   turn on «فایل GIF داخل ZIP» in /admin → ⚙️ → 🚩.
5. ☐ Send a **sticker from a video pack** and an **animated (TGS) sticker** → «🎨 ویرایش در استودیو» →
   both open and can be saved as video stickers.
6. ☐ Menu button «🎨 استودیو» → «🟢 استیکر واتس‌اپ» → a photo → editor → «ذخیره‌ی استیکر» →
   «واتس‌اپ» → «➕ پک واتس‌اپ جدید» (name + publisher) → «✅ ذخیره». Repeat twice → «📦 گرفتن فایل ZIP»
   → the ZIP arrives in the chat. Import it on a phone with WhatsApp through an importer app;
   ☐ the pack shows its 3 stickers and the icon.
7. ☐ An **animated** WhatsApp pack from a video (3 stickers) → ZIP → import → ☐ they move.
8. ☐ «✂️ چند استیکر از یک عکس» with a screenshot of a sticker pack → the numbered boxes are right →
   tap one to leave it out → «ساختن …» into a Telegram pack.
9. ☐ «📚 چند عکس با هم» → 5 photos → «✨ حذف خودکار پس‌زمینه» → into a new pack; one chat message only.
10. ☐ «🗂 پک‌های من» → «🟢 پک‌های واتس‌اپ» → the pack → «👁 دیدن استیکرها», remove one by number,
    change emojis, rename, «📦 گرفتن فایل ZIP».
11. ☐ Owner: set the **storage channel** (/admin → ⚙️ تنظیمات → 🗄 کانال ذخیره) → new WhatsApp
    stickers land there as files, not in your chat.
12. ☐ Write down the times of steps 1, 2, 7 and anything that froze (target: ≤ 60 s each on a
    mid-range Android).

## Phase 4 — Studio Pro (Android mid-range phone, iPhone, Telegram Desktop)

Local baseline green in Chromium (SPIKE_REPORT §10). On the phones:

1. ☐ Studio home → «😀 ایموجی سفارشی» → a photo → save → «➕ پک جدید» → open the link: the emoji
   appear in Telegram's emoji panel (Premium is needed to *send* custom emoji; anyone can add the pack).
2. ☐ A chat video → «😀 ایموجی سفارشی» → the export switch shows «ایموجی سفارشی» → add to the same
   emoji pack → it plays in the emoji panel.
3. ☐ A photo → editor → «قالب» → «💬 حباب» with a Persian word → save → «🎬 متحرکش کن» → «پرش» →
   «ساختن» → add to a sticker pack → it bounces and loops without a jump.
4. ☐ «😂 میم‌ساز» → a photo → change both captions (long Persian text shrinks to fit) → save.
5. ☐ «✍️ متن متحرک» → type a word → «حرکت متن: تایپ» → make a video sticker.
6. ☐ «🎞 اسلایدشو / چسباندن» → 4 photos → time per photo → «📎 فایل .gif»; then 2 GIFs → joined.
7. ☐ A short video → «✨ حذف پس‌زمینه‌ی ویدیو (آزمایشی)» → note the time and the edge quality.
   (Shown only on phones with ≥ 4 GB and 4 cores.)
8. ☐ Start a sticker, close the Studio, open it again from the menu → «📝 ادامه‌ی پیش‌نویس».
9. ☐ «🗂 پک‌های من» → a pack → «📤 اشتراک‌گذاری» → a QR image arrives; scan it with another phone →
   the bot shows the pack; «📤 اشتراک‌گذاری» again → «👁 ۱ بار · 👤 ۱ نفر».

## Phase 5 — community, points, payments (two accounts + the owner)

1. ☐ A second account publishes a pack → you approve → «🖼 گالری پک‌ها» shows it; the second account
   gets +5 points («👤 حساب» ← «🎁 امتیازهای من»).
2. ☐ A third account likes it (❤️ 1) → the creator +1; unlike and like again → still +1 only.
3. ☐ Three accounts report it → it disappears from the gallery and you (and reviewers) get the 🛡 card →
   «✅ نمایش دوباره» brings it back.
4. ☐ «🔗 لینک دعوت من» → open it with a fresh account → make a pack → the inviter +10.
5. ☐ «⚡️ سهمیه‌ی امروز» with enough points → the account screen shows the higher quota.
6. ☐ Pro: `/admin` ← «⭐️ پرداخت‌ها» → set a small price (e.g. 1 Star) → turn on «پرداخت» → a second
   account pays from «حساب Wanger من» → Pro shows; then refund from its user screen → Pro ends and the
   Star comes back. (Costs one real Star for a moment.)
7. ☐ Studio: type a Persian caption → the emoji chips under «ایموجی» suggest fitting emojis;
   «💡 ایده‌ی متن» fills a caption.
