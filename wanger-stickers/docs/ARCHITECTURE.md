# Architecture — Wanger Stickers (Phases 1–6)

One tgcloud project (@Wanger_Motionbot, app9292593567): a thin Serverless backend in `tgcloud/`,
the Mini App in `src/` (Phase 0–1: the device spike page; the Studio from Phase 2), and the media
engine in `src/engine/`; Phase 6 adds the Android companion app in `android/` (not deployed by
tgcloud; see [android/README.md](../android/README.md)). Brief: [BRIEF.md](BRIEF.md); choices: [DECISIONS.md](DECISIONS.md).

## Request flow (chat)

```
handlers/{message,callback_query,my_chat_member}.js   (thin: one line each)
  → lib/boundary.js     buildApp → de-duplicate update_id → run → piggyback tick → flush stats
                        errors: log → errors row → throttled owner alert → normal return
  → lib/bot/router.js   maintenance → ban → flood → first-start language → GATE → step → command → media/text
                        callbacks: decode (≤ 64 bytes, typed args) → permission (every press) → GATE → route
  → lib/bot/*_ui.js, lib/admin/*_ui.js   screens and conversation steps
  → services            lib/wanger/{account,gate,broadcast}.js, lib/packs/{service,ops,publish}.js
  → lib/db/*.js         all SQL (sql tag), one statement per state change, every query LIMITed
  → sdk                 db, api (only through lib/tg.js, which records the trace)
```

## Modules

| Module | What it does |
|---|---|
| `lib/config.js` | Owner, bot id/username, seed channels, setting DEFAULTS and ranges, internal timings (`T`). Pure. |
| `lib/core/*` | Pure: `limits` (every platform number), `inspect` (WebP/WebM/PNG headers), `codec` (callback_data + keyboards), `errors` (Bot API error classes), `gate` (membership decisions), `packs` (names, titles, emojis, keywords, links, number lists), `roles` (owner / reviewer / user), `chatref`, `limiter`, `logger`, `html`, `util`, `bytes`. |
| `lib/i18n/{fa,en,index}.js` | Every text. `t()` escapes vars + Persian digits, `tp()` plain. Same keys in both (tested). |
| `lib/app.js` | Per-invocation context: clock, logger, Telegram client, settings (one query), buffered stats, alerts, audit, conversation state, the current user and role. Bootstrap seeds the gate channels once. |
| `lib/tg.js` | The only Bot API path; trace of every call; edit-or-send; never-throwing answer/remove; `inspectChannel`. |
| `lib/wanger/account.js` | Wanger Account adapter — LocalAccountProvider only (no hub exists). |
| `lib/wanger/gate.js` | Forced join: parallel checks, 10-min pass cache with a list version, broken channels skipped + alerted, owner management. |
| `lib/wanger/broadcast.js` | Broadcast engine: lease + cursor + in-flight marker (at most once per recipient), copy/forward, audiences. |
| `lib/packs/service.js` | Sticker-set operations by file_id; the `pack_items` mirror refreshed from `getStickerSet`; quotas. |
| `lib/packs/ops.js` | Bulk ops (import, copy, duplicate, merge) across invocations: snapshot + lease + forward-only cursor. |
| `lib/packs/publish.js` | Channel publishing: request → review cards → decide → one post (lease, no re-send) → withdraw/remove (48 h rule); channel + reviewers. |
| `lib/jobs.js` | The tick: housekeeping (≤ every 10 min, elected), broadcast slice, one queued post, one bulk-op slice, owner notices. |
| `lib/bot/{router,ui,packs_ui,publish_ui}.js` | Routing and user screens. |
| `lib/admin/{panel,channels_ui,broadcast_ui,publish_ui}.js` | Owner panel; reviewers reach only `a:home`, `a:q`, `a:qv` and `pr:*`. |
| `lib/packs/whatsapp.js` | WhatsApp packs (Phase 3): create / add / tray / remove / emojis / rename / delete, storage channel (fallback: the user's chat), rule check, ZIP export (+ `.wastickers` behind a flag). |
| `lib/bot/wa_ui.js` | «🟢 پک‌های واتس‌اپ» in chat (`w:*`): list, screen with status, preview albums, steps for remove / emojis / rename, ZIP, delete. |
| `lib/core/zip.js` | Stored-only ZIP writer and reader (CRC-32), shared with the engine. |
| `lib/core/qr.js`, `lib/core/png.js` | QR encoder (byte mode, level M, versions 1–10) and 1-bit PNG writer — share links (Phase 4). |
| `endpoints/spike_*.js` | Phase 0 spike tools (owner only). |
| `endpoints/wa_export.js` | Sends a WhatsApp pack's ZIP (gate re-checked without the cache). |
| `lib/packs/gallery.js`, `lib/bot/community_ui.js` | Phase 5: gallery (browse, like, report, auto-hide, moderation), points screen (earn, spend, invite), Pro button. |
| `lib/payments/stars.js`, `handlers/pre_checkout_query.js` | Phase 5: Pro with Telegram Stars (invoice link, pre-checkout, payment once per charge id, refund). |
| `lib/ai/provider.js`, `lib/core/suggest.js`, `endpoints/ai_suggest.js` | Phase 5: the AiProvider interface and its local provider (emoji suggestions, caption ideas). |
| `lib/db/community.js` | Phase 5 SQL: points ledger, gallery likes / reports, payments. |

## The Studio (Phase 2)

```
chat photo → handlers/message → jobs row → «🎨 باز کردن در استودیو» (web_app ?job=<id>)
Mini App: src/studio/Studio.tsx → studio_boot (gate) → studio_media (chunks) → src/engine/*
  image (decode ≤ 1024 px) → segment (ONNX, on device) → mask (brush) → render (shape, outline,
  shadow, text) → export (libwebp, ≤ 6 encodes, validate) → upload_commit (inline ≤ 256 KB)
server: lib/endpoint.js (gate …) → lib/studio/transfer.js (size, SHA-256, validate again)
  → uploadStickerFile → packs.add / packs.create / sendSticker
```

### Phase 3: animated, GIF, WhatsApp

```
chat video / GIF / round video / video or TGS sticker → jobs row → buttons per kind (?job=&mode=video|gif|wa)
Mini App home → mode → src/studio/AnimStudio.tsx (lazy chunk)
  engine/anim/source   video (<video>, one playback pass via requestVideoFrameCallback, seek fallback),
                       GIF (omggif), TGS (lottie-web light canvas), still images
  engine/anim/timeline clip → constant-rate plan (speed, reverse, boomerang, loop cross-fade)
  engine/anim/compose  crop, shape, background, text overlay rendered once → frames per target size
  encoders             vp9 (2 WebCodecs encoders + webm/mux, size targeting) · mp4 (avc1 + mp4-muxer)
                       gif (gifenc) · awebp (WebPAnimEncoder, WhatsApp ladder) · files (frames ZIP)
  engine/export        WhatsApp static (512×512 + margin) and the tray icon
  engine/anim/split    screenshot to pack (alpha or border-colour mask → components → boxes)
upload kinds (core/validate.js UPLOAD_KINDS) → upload_commit → lib/studio/transfer.js ACT[kind]
  telegram_static|video → uploadStickerFile → pack add/new/send · animation → sendAnimation
  gif / webp_file / frames_zip → sendDocument · whatsapp_* → lib/packs/whatsapp.js (storage channel)
```

### Phase 4: Studio Pro

```
engine/effects.ts   motion effects + text animations, pure functions of the loop phase
engine/decor.ts     9 vector templates (under / over the art, inset room, Persian text)
engine/render.ts    + templates, pen strokes          engine/text.ts  + spacing, box, auto-fit, per-frame state
engine/anim/compose + effect transform, template, animated text, 'emoji' target (100×100), per-frame cut-out
engine/anim/source  + concatSources (join), blankSource (text animation); slideshow skips bad photos
engine/anim/cutout  U²-Netp masks at 6 fps for ≤ 3 s clips (experimental)
engine/export.ts    + toCustomEmojiStatic          engine/anim/vp9.ts  + emoji kind (100×100 validator)
studio/drafts.ts    IndexedDB drafts (static + animated)
server              upload kinds emoji_static / emoji_video → custom_emoji sets (lib/studio/transfer.js)
                    pk:share → QR + stats; /start pack_<code> → packs_ui.onSharedPack (share_visits)
```

`src/engine/` never imports React, Telegram or i18n (reusable). Shared pure modules from
`tgcloud/lib/core/` (limits, validate, inspect, bytes) are imported by the engine, so the client
and the server check files with the same code.

## Data (schema.js, 29 tables; Phase 3 adds `packs.tray_file_id`; Phase 4 `packs.share_code`, `share_opens`, `share_visits`; Phase 5 `points_ledger`, `gallery_likes`, `gallery_reports`, `payments` and `packs.likes`, `reports`, `gallery_hidden`, `gallery_at`)

users · usage_daily · channels · membership_cache · user_state · pending_actions · packs ·
pack_items · pack_posts · staff · pack_ops · broadcasts · settings · secrets · rate_limits · errors ·
stats_daily · processed_updates · alerts · audit_log · jobs · job_chunks · uploads · upload_chunks. WhatsApp packs are
`packs` rows with `platform = 'whatsapp'` (Telegram queries filter on it). No foreign keys; children deleted before
parents in code; timestamps are unix seconds; jobs and uploads expire after 30 minutes (housekeeping).

## Platform rules the code follows (measured, SPIKE_REPORT §3a)

- CPU ≈ 3 s, wall ≈ 30 s per invocation → piggyback budget 2.5 s, button budget 20 s, item caps.
- No transactions → every state change is one conditional statement (`UPDATE … WHERE status = … RETURNING`).
- No scheduler → background work moves only on updates and owner buttons.
- One SQL value < 1 MB; ≤ 4096 bound values; ≤ 10 000 rows written; deletes in batches of ≤ 5000.
- `getChatMember` "member not found" = not a member; "member list is inaccessible" = bot not admin.
- `deleteMessage` only < 48 h → older channel posts get their buttons stripped instead.
- Module budget ≤ 85 (currently counted by `tests/guard.test.mjs`).

## Tests

`npm test`: unit (`core`, `guard`) + end-to-end on the SDK emulation (`tests/sdk/`, node:sqlite with
the platform's measured limits) and a strict fake Bot API with sticker-set rules
(`tests/helpers/fake-telegram.mjs`). Acceptance suites: `e2e.gate`, `e2e.packs`, `e2e.publish`,
`e2e.admin` (permission matrix over every admin route and step, broadcast interruption), `e2e.media`
(video stickers, deliveries, WhatsApp packs end to end), `e2e.pro` (custom emoji packs, share links,
QR decoded by jsQR), `e2e.community` (points, gallery, Stars payments, suggestions), `anim` (timeline,
splitter, ZIP, validators, effect loops).
In a browser: `npm run engine:local` (encoders + validators + ffprobe) and `npm run studio:local`
(the real Studio UI with a mock Telegram bridge).
`android` checks the app against the bot (numbers, provider contract, fixtures, the APK flow); the app's
own 40 tests run with `cd android && ./gradlew testDebugUnitTest`.

## Android companion app (Phase 6)

`android/` is a separate Gradle project. The bot's WhatsApp ZIP is its only input: `PackReader`
(checks) → `PackStore` (app-private, hashed folders) → `StickerContentProvider` (WhatsApp's contract:
`metadata`, `stickers`, `stickers_asset`, read permission `com.whatsapp.sticker.READ`) and the
`ENABLE_STICKER_PACK` intent; the UI is Jetpack Compose in `ui/` (`AppModel` holds the state). The bot's side is one setting (`android.apk`), the admin screen
«📱 برنامه‌ی اندروید» (`a:apk*`, step `a_apk`) and the `w:apk` button under the ZIP guide
(`wa_ui.zipHelpView`, used by `w:zip` and the `wa_export` endpoint).
