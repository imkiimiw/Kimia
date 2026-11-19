# Changelog

## Android app 1.1 — new design (2026-11-19)

- Rebuilt in **Jetpack Compose + Material 3** with the **Vazirmatn** typeface: gradient header with
  counts, pack cards with the first stickers playing, "New pack" / "Pack ready 🎉" / error **bottom
  sheets**, a pack screen with a full-bleed header, a big «افزودن به واتس‌اپ» button and a sticker
  grid with a large preview, an illustrated empty state with numbered steps, animated transitions,
  branded launch screen, dark mode. WhatsApp integration and checks unchanged.
- 42 Android tests (the flow tests now drive the Compose UI); screenshots of every screen in
  `android/app/build/screenshots/`. versionCode 2 / 1.1.0; release APK ≈ 1.6 MB.

## Phase 6 — Android companion app (2026-11-14)

- **`android/`: Wanger Stickers for Android** (Kotlin, no AndroidX, Android 6.0+, targets 16): opens
  the bot's WhatsApp ZIP (or a `.wastickers`) from Telegram's "Open with" / "Share" or the file
  picker, checks every WhatsApp rule with a precise message per sticker, keeps up to 10 packs and adds
  them with **WhatsApp's official integration** (ContentProvider + `ENABLE_STICKER_PACK`, consumer and
  Business, whitelist status, WhatsApp's refusal reason shown). No permissions at all (no internet).
  Persian / English, RTL, dark mode. Release APK ≈ 80 KB.
- **Bot:** `/admin` → ⚙️ → «📱 برنامه‌ی اندروید»: the owner sends the APK once; from then on the guide
  after every WhatsApp ZIP has a «📱 برنامه‌ی اندروید» button that sends it (by file_id), with install
  steps; remove it and the button disappears. The Studio's "ZIP sent" screen points to the button.
  Setting `android.apk` (no schema change).
- **Tests:** 40 Android tests (JVM + Robolectric: the provider exactly as WhatsApp queries it, import →
  add → WhatsApp's answer on API 24 and 36, Persian, screenshots) on fixtures exported by the bot's own
  endpoints (`scripts/android-fixtures.mjs`); bot: 104 (adds `android`: numbers in sync with
  `limits.js`, provider contract, fixtures still current, the APK flow and its owner-only screens).
- Not done (Kimi's decisions): the release signing key, Google Play ($25), iOS (Apple account).

## Phase 5 — community, points, payments, suggestions (2026-11-14)

- **Wanger Points** (local provider): earned for a new pack (+2), each new person from a pack's share
  link (+1), an approved publication (+5), a gallery like (+1) and a friend who joins with your invite
  link and makes a first pack (+10) — amounts owner-editable, **daily caps per reason**, every award
  once per **idempotency key** (`points_ledger`). Spent atomically on «⚡️ سهمیه‌ی امروز» (+50 stickers,
  +20 GIFs) or «⭐️ ۷ روز Pro». «🎁 امتیازهای من» in the account screen; invite link.
- **Public gallery** («🖼 گالری پک‌ها»): packs published in the channel, newest or most liked; one
  like per person; reports with a reason (spam, sexual, hate, violence, copyright, other); at 3 open
  reports (setting) the pack is hidden and the owner and reviewers get a moderation card (show again /
  remove; ban from publishing = owner only); «🛡 گزارش‌های گالری» in the panel (reviewers too).
- **Pro with Telegram Stars**: 30-day subscription invoice (XTR), `pre_checkout_query` answered at once
  with checks (buyer, price, sale on, ban), `successful_payment` stored once per charge id (also
  during maintenance) → Pro until the subscription's expiry; refunds from the user's screen
  (`refundStarPayment` + cancel the subscription); «⭐️ پرداخت‌ها» in the panel. **Hidden until the
  owner sets a price** (`pro.price_stars`) and turns on «پرداخت».
- **AiProvider** interface with the **local** provider (no key, no network): emoji suggestions from
  the sticker's text (chips next to every emoji field in the Studio) and caption ideas (💡 in the text
  tab); endpoint `ai_suggest`. Image generation and the character studio wait for a provider + key.
- **Storage channel fix**: forwarded post / id without -100 / @username, specific errors, public
  channels refused, one-tap offer when the owner makes the bot an admin of a private channel.
- Schema: `points_ledger`, `gallery_likes`, `gallery_reports`, `payments`; `packs.likes`, `reports`,
  `gallery_hidden`, `gallery_at` (+ 2 indexes) — all additive. New handler `pre_checkout_query`.
- Tests: 100 (adds e2e.community).

## Phase 4 — Studio Pro (2026-11-14)

- **Custom emoji packs:** 100×100 static (WebP) and video (VP9) emoji from photos, videos, GIFs and
  stickers — in the Studio («😀 ایموجی سفارشی» tile, a sticker ⇄ emoji switch in every Telegram export,
  «😀 ایموجی سفارشی» on media in chat). Own sets (`custom_emoji`, up to 200, optional "takes the text
  colour"); never mixed with regular stickers; the pack screen links to `addemoji`.
- **Share links:** «📤 اشتراک‌گذاری» on a pack sends a **QR code** of a private link
  `t.me/Wanger_Motionbot?start=pack_<code>` with both links and **stats** (times opened, people);
  opening it shows the pack with «➕ افزودن» and «🎨 پک خودت را بساز», also for new users after the
  language choice and the gate. The owner's own opens are not counted.
- **Templates:** 9 vector templates — speech bubble, thought bubble, banner, frame, polaroid,
  sparkles, hearts, burst badge, tape — with colour and Persian text, in the static and animated editors.
- **Motion effects:** 9 loop-exact effects on any sticker (pulse, shake, spin, bounce, wobble, float,
  heartbeat, glow, swing) with strength; «🎬 متحرکش کن» turns a finished still sticker into a video
  sticker / GIF / WhatsApp animation.
- **Animated text:** typewriter, pop, wave, blink; «✍️ متن متحرک» makes a sticker that is only text.
- **Meme maker:** the whole photo (or GIF / video) with top and bottom captions that size themselves.
- **GIF studio gaps closed:** slideshow from photos (time per photo), joining GIFs / clips.
- **Background removal on videos (experimental):** U²-Netp on frames sampled at 6 fps, ≤ 3 s, only on
  devices with ≥ 4 GB / 4 cores; slow (≈ a minute in a desktop Chromium).
- **Editor polish:** several text layers in the animated editor, letter spacing, a box behind the
  text, layer order, quick emoji layers, a pen, drafts autosaved on the device (IndexedDB) with
  «📝 ادامه‌ی پیش‌نویس» on the home screen.
- **Server:** upload kinds `emoji_static` / `emoji_video`; flags `emoji`, `share`, `anim_bg` (on);
  schema: `packs.share_code` (unique), `packs.share_opens`, table `share_visits` (all additive);
  our own QR encoder and 1-bit PNG writer (pure, decoded by jsQR in tests).
- **Fix:** the publish channel's stored @username / title refresh from each post (post links to
  creators were missing after the channel became public).
- **Tests:** 93; `engine:local` (Phase 4 checks) and `studio:local` (13 flows) pass in Chromium.

## Phase 3 — animated, GIF and WhatsApp (2026-11-14)

- **Inputs:** videos (MP4 / MOV / WebM), GIFs (as Telegram animations or real .gif files), round
  videos, Telegram video stickers and animated (TGS) stickers — in chat (a job with buttons that fit
  the kind: video sticker, quick video sticker, GIF, WhatsApp) or picked in the Studio.
- **Studio home:** tiles for every enabled mode — sticker from a photo, video sticker, GIF & conversion,
  WhatsApp sticker, several stickers from one image, several photos at once. The menu button now opens
  the home.
- **Animated studio** (its own lazy chunk): timeline with frame previews, start / end within the
  target's limit (3 s Telegram, 10 s WhatsApp, 30 s GIF, 60 s MP4), speed 0.5–2×, reverse,
  boomerang, smooth loop (cross-fade), original / square frame, no shape / circle / rounded,
  transparent or colour background, one text layer (Persian shaped by the browser), preview.
- **Telegram video stickers:** VP9 WebM with alpha (two WebCodecs encoders + our muxer), constant
  30 fps, long side 512, ≤ 3 s, no audio, size targeting (bitrate search ≤ 6 encodes, then
  30 → 24 → 20 → 15 fps, then "shorten it"). Round videos keep transparent corners.
- **GIF & conversions:** MP4 (H.264, sent as a Telegram GIF), real .gif files (gifenc; sendDocument
  without type detection, optional ZIP wrapper flag), animated WebP files, frames → ZIP of PNGs, first
  frame → the static editor. TGS → video sticker / GIF via lottie-web.
- **WhatsApp packs:** static (512×512 with a margin, ≤ 100 KB) and animated (WebPAnimEncoder,
  ≤ 500 KB, ≤ 10 s, quality search + 15 → 12 → 10 → 8 fps) stickers, 96×96 tray icon made from the
  first sticker, 3–30 stickers, never mixed, 1–3 emojis, name + publisher. Files are kept in the
  **storage channel** (until the owner sets one: as silent documents in the user's own chat); the
  bot sends a ZIP (stickers, tray, README, pack.json); a `.wastickers` package behind a flag (off).
  In chat: «🟢 پک‌های واتس‌اپ» with preview albums, remove / emojis by number, rename, delete, ZIP.
- **Screenshot to pack** (connected components on alpha, or a border-colour background estimate +
  closing) with numbered boxes; **batch mode** (several photos, one setting, one destination; one
  chat confirmation per batch).
- **Server:** validators for Telegram video, WhatsApp static / animated / tray / pack, GIF and MP4,
  shared with the engine; upload kinds with per-kind feature flags and actions; quotas `media_send`
  and `wa_export`; flags `video`, `wastickers`, `gif_zip`; endpoint `wa_export`. Schema: one new
  column `packs.tray_file_id` (safe).
- **Tests:** 88 (adds e2e.media and anim); `npm run engine:local` and `npm run studio:local` drive the
  engine and the Studio in Chromium (all outputs pass the server's validators).

## Phase 2 — Studio MVP: static stickers (2026-11-12)

- The Mini App is now the **Studio**: a photo sent in chat (or a static sticker) becomes a job with
  «🎨 باز کردن در استودیو» and «⚡️ استیکر سریع»; the Studio also opens from the menu button and
  /studio, where the user picks a photo on the device (nothing leaves the device until saving).
- Editor: automatic background removal on the device (U²-Netp; «حالت آدم» = MODNet), erase / restore
  brush with size, softness, zoom and pan; shapes (free trim, square, circle, rounded), rotate,
  mirror; white (any colour) outline with width, drop shadow, brightness / contrast / saturation;
  text layers in Persian and English (Vazirmatn, Lalezar, Inter; outline, shadow, size, colour,
  drag to move; base direction per layer); undo / redo (60 steps).
- Export: Telegram static sticker (long side exactly 512) as WebP via libwebp WASM with bounded
  size targeting; checked by the shared validator before upload; saved to an existing pack, a new
  pack, or sent to the chat.
- Backend: `jobs`, `job_chunks`, `uploads`, `upload_chunks` (4 safe new tables); endpoints
  `studio_boot`, `studio_job`, `studio_media`, `upload_begin`, `upload_chunk`, `upload_commit` —
  each runs the gate (JOIN_REQUIRED with the channels), maintenance, ban, rate limit and strict
  input checks; commit verifies size + SHA-256 and re-validates before `uploadStickerFile`.
- Models self-hosted under `/assets/models/` with pinned SHA-256 (`scripts/fetch-models.mjs`).
- The Phase 0 device spike stays reachable from the owner panel («🧪 تست دستگاه», `?spike=1`).
- Tests: 71 (adds the Studio backend and pure engine tests); `npm run studio:local` drives the real
  Studio in a local Chromium.

## Phase 1 — core bot (2026-11-12, not deployed yet)

- Schema: 20 tables (users, quotas, forced join, conversation state and pending actions, packs and
  their sticker mirror, publications, reviewers, bulk ops, broadcasts, settings, secrets, rate
  limits, errors, stats, update de-duplication, alerts, audit log).
- /start with the language choice (fa / en), main menu, help & settings, «حساب Wanger من», /lang,
  /cancel, /deletemydata; commands registered per language and /admin for the owner only.
- Wanger Account adapter with the local provider (no hub exists).
- Forced join on every entry point (messages, buttons); pending action resumed after «عضو شدم»;
  10-minute pass cache; broken channels skipped with a throttled owner alert; owner management
  (add by username/id/link/forward, max 10, reorder, enable/disable, invite link, preview, gate on/off).
- Telegram pack management by file_id: add a sent sticker, new pack, browse, reorder, emojis,
  keywords, replace, delete, rename, pack icon (100×100 file checked by its header), share, JSON
  backup, delete pack; import a public pack (all or by number), copy, duplicate, merge — bulk ops
  resumable across invocations.
- **Channel publishing** (owner's request): a new channel set in the panel, manual approval by the
  owner or **reviewers she adds**, creator name / @username only if the creator turns them on,
  withdraw / remove (48 h deletion rule), queue with a gap between posts, no automatic re-send.
- Owner panel: stats, broadcast (copy/forward, 5 audiences, pause/resume/cancel, at-most-once
  delivery), users (ban bot/ecosystem, Pro, points, quota reset, message, publish ban), settings,
  feature flags (unbuilt features can't be turned on), texts, maintenance mode, notifications,
  errors, secrets (message deleted), backup.
- Tests: 60 (unit, guards, and end-to-end acceptance suites for the gate, packs, publishing,
  permissions and broadcast).
- Measured on @Wanger_Motionbot (Phase 0 completed): see docs/SPIKE_REPORT.md §3a.

## Phase 0 — discovery and spike (2026-11-11, not deployed)

- Project created with the official tools (`create-vite` react-ts, `npm create @tgcloud/bot .`);
  the scaffold's echo handler removed (no user features in Phase 0); empty schema.
- `tgcloud/lib/core/limits.js`: every Telegram and WhatsApp number, re-checked against the official
  pages (Bot API 10.4); `src/engine/limits.ts` re-exports it.
- `tgcloud/lib/core/inspect.js`: WebP (RIFF) and WebM (EBML) header readers.
- Engine prototypes: `src/engine/webm/mux.ts` (VP9 WebM with alpha in BlockAdditions),
  `src/engine/webp/animmux.ts` (animated WebP).
- Device spike Mini App (`src/spike/`), owner-only spike endpoints `spike_echo`, `spike_report`.
- Scripts: `tg.mjs` (token isolation), `probe.mjs` (platform probe via `tgcloud run`),
  `spike-assets.mjs`, `spike-local.mjs` (headless Chromium baseline).
- Docs: BRIEF (with Addendum A1: publish packs to a channel), SPIKE_REPORT, proposed DECISIONS,
  QA, THIRD_PARTY_LICENSES.
