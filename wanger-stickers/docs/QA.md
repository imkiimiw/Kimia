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
