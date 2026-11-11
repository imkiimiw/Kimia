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
