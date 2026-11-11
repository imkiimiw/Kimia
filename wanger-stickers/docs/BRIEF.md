# Wanger Stickers — Claude Code Build Prompt

11 Nov 2026 · @Kimi — the owner's brief, kept verbatim (converted to Markdown). Section 1's working
rules apply to every session. Owner additions after this date are at the end (**Addenda**); where an
addendum and the brief differ, the addendum wins.

## 1. Mission and working rules

Build Wanger Stickers, a Telegram bot plus Mini App that turns photos, videos, GIFs, round videos and stickers into Telegram and WhatsApp stickers and GIFs. It belongs to Kimi's Wanger bot ecosystem, so the conventions in section 2 are fixed requirements.

The product: a real editor (background removal, Persian and English text, outlines, shadows), an animated sticker and GIF studio, Telegram pack management, WhatsApp-ready exports, a forced-join gate and an owner-only admin panel. It must stay simple for beginners: first sticker in under a minute.

Working rules:

1. Work phase by phase (section 14). Do only the phase Kimi asked for. When it is done, stop and send a short report in Persian: what was built, how to test it, known gaps, and the decisions you need. Start the next phase only on Kimi's explicit command.
2. Read before writing: the project's AGENTS.md and docs/tgcloud-sdk.md, the official Telegram Serverless docs, and the other Wanger bots in this repository. Reuse their shared code and patterns (forced join, owner panel, broadcast, i18n, token handling). Where this prompt conflicts with how those bots already work, follow the bots and tell Kimi.
3. Never guess platform limits. Keep every Telegram and WhatsApp number in one config module and re-check it against the current official docs in Phase 0. If the docs disagree with this prompt, the docs win; say so in the report.
4. Ask before anything live or irreversible: npx tgcloud push, npx tgcloud migrate (never --yes on warnings), deleting data, BotFather changes, sending a real broadcast.
5. Free services only: no paid APIs, no own server. If something cannot be done for free, stop and propose options with their costs.
6. Secrets never go into code, git, logs or chat output.
7. No half-built features behind visible buttons. Keep unfinished features hidden behind feature flags until they work end to end.

## 2. Fixed decisions (Wanger ecosystem conventions)

These match Kimi's other bots and are not open for redesign; build around them.

| Decision | Value |
|---|---|
| Hosting | Telegram Serverless (tgcloud), like the other Wanger bots. Backend = JS modules in tgcloud/. The Mini App front-end is hosted by the same project at `https://app<app_id>.tgcloud.ai/`. |
| Owner | Telegram numeric user ID 5557901897, hardcoded as OWNER_ID in tgcloud/lib/config.js. The owner bypasses the forced-join gate, quotas, bans and maintenance mode. |
| Admin access | Owner only: admin panel, forced-join channels, broadcasts, settings, secrets. Check the ID on every admin command, callback and endpoint, not only when drawing buttons. |
| Forced join | Membership in up to 10 channels is required before any feature works. Initial channels (seeded as data, not code): @HIDE_i_SEEK, @Nepenthw_ir, @wangerBots. Managed only by the owner from the bot's private chat (section 6). |
| Broadcast | The owner can broadcast any message to all users (section 7). |
| Account layer | Wanger Account: the ecosystem's shared identity, plan, points and ban layer, tied to the mother bot (بات مادر). See section 5. |
| Code location | Its own folder wanger-stickers/ in the repo, like aegis/. Nothing outside this folder changes unless Kimi approves. |
| Token naming | CLI access token in the env var WangerStickers_BOT_TGCLOUD_TOKEN (same pattern as Aegis_BOT_TGCLOUD_TOKEN). Map it to TGCLOUD_TOKEN only inside this project's npm scripts, so it never clashes with other bots. |
| Languages | Persian (default, RTL) and English, chosen at first /start and changeable anytime. All user-facing text lives in i18n files; no hardcoded strings. The structure must accept more languages later. |
| Cost | Free services only. |
| Reuse | The media engine is a standalone module, so Wanger Converter and other Wanger bots can reuse it later. |

## 3. Platform reality: what Telegram Serverless can and cannot do

Telegram Serverless runs plain JavaScript modules in a V8 isolate next to the Bot API and a built-in SQLite database (official docs). The backend therefore cannot process media, and the architecture in section 4 follows from that.

- Imports: only sdk (db, api, fetch, InputFile, EndpointError) and your own modules inside tgcloud/, by relative path with .js. No npm packages, no Node APIs (Buffer, fs), no filesystem, no child processes. Bytes are Uint8Array.
- Consequence: FFmpeg, libwebp, Pillow, OpenCV and AI models cannot run in the backend. All media processing runs on the user's device inside the Mini App.
- Handlers: one file per update type in tgcloud/handlers/ (flat). An update type is delivered only if its handler exists, so create only what is needed: message, callback_query, my_chat_member; later pre_checkout_query (payments) and chat_join_request (only if a private gate channel needs it).
- Endpoints: tgcloud/endpoints/<name>.js, called from the Mini App with Telegram.WebApp.Serverless.call. The platform verifies initData and hands you ctx.initData.user. Refuse calls with throw new EndpointError(message, { code }).
- Database: Drizzle-like DSL from sdk/db, every call awaited, no foreign keys. push deploys schema.js; migrate applies it separately. Remove columns or tables with .deprecated(), never by deleting them from the schema.
- Files: api.getFileContent / api.getFileStream download up to 20 MB. Uploads with new InputFile(bytes, name, { type }) go up to 50 MB (10 MB for photos). Outbound fetch responses are capped at 30 MB.
- Not documented: cron or scheduled jobs, env vars at runtime, a secrets store. Design without them (sections 7 and 11). If Phase 0 finds them in the current docs or BotFather, use them and note it.
- Errors: Bot API failures throw BotApiError with .code, .description and .parameters.retry_after. Never swallow them silently.
- Fast test loop: `npx tgcloud run handlers/message '<json5 payload>'` runs local code on the platform without deploying.

Measure these in Phase 0; do not assume them: max run time and CPU per handler and endpoint, max endpoint request and response size, whether WebAssembly and crypto.subtle exist in the isolate, database size limits, and Mini App static file size limits.

## 4. Architecture

One tgcloud project with three parts: a thin Serverless backend, the Studio Mini App, and an on-device media engine. Follow the official layout: the Vite front-end is the project root and tgcloud/ sits next to it.

```
wanger-stickers/
├─ tgcloud/                  # Serverless backend: plain JS ES modules + JSDoc types
│  ├─ handlers/              # message, callback_query, my_chat_member (+ later ones)
│  ├─ endpoints/             # Mini App API: studio_*, media_*, upload_*, pack_*, admin_*
│  ├─ lib/
│  │  ├─ core/               # pure logic, no 'sdk' imports, runs under node --test
│  │  ├─ wanger/             # account adapter, gate, owner panel, broadcast (shareable)
│  │  ├─ tg/                 # keyboards, safe send, Bot API error mapping
│  │  ├─ i18n/               # fa.js, en.js
│  │  └─ config.js           # OWNER_ID, limits, defaults
│  └─ schema.js
├─ src/                      # Studio Mini App: React + TypeScript (Vite)
│  ├─ engine/                # media engine: no React, Telegram or i18n imports
│  └─ editor/ gif/ packs/ admin/ i18n/
├─ public/                   # OFL fonts, wasm, models (if hosting limits allow)
├─ tests/   docs/
├─ tgcloud.jsonc             # "static": { "source": "dist", "spa": true, "immutable": ["/assets/*"] }
└─ package.json
```

Request flow:

1. The user sends media in chat, or opens the Studio from the menu button and picks a file on the device (preferred: no server transfer).
2. For chat media, handlers/message saves a short-lived jobs row (file_id, kind, size) and replies with an inline web_app button whose URL carries ?job=<id>.
3. The Studio calls studio_getJob, then media_download for the bytes in base64 chunks (server side: api.getFileStream). Both refuse jobs that do not belong to ctx.initData.user.id.
4. Editing and encoding run on the device. The engine validates every output against the platform rules before upload.
5. Upload uses the transfer protocol below. The server re-validates, then acts: add to a Telegram pack, send a sticker, animation or document to the user's chat, or store a file in the storage channel.
6. The bot confirms in chat with a preview, the pack link `https://t.me/addstickers/<name>`, or the WhatsApp ZIP.

Transfer protocol. `upload_begin({ kind, size, sha256 })` returns an uploadId. `upload_chunk({ uploadId, idx, b64 })` stores each chunk as a blob row. `upload_commit({ uploadId, action, params })` reassembles, checks size and SHA-256, runs the validators from lib/core, performs the action and deletes the chunks. Chunk size and maximum file size come from the Phase 0 measurements; unfinished uploads expire after 30 minutes. Hash with crypto.subtle if present, else a small vendored pure-JS SHA-256.

Storage channel. A private channel where the bot is admin, set by the owner in the admin panel. WhatsApp sticker files are posted there as documents and only their file_ids are stored, so packs can be edited and re-exported later without keeping bytes in SQLite. Telegram stickers need no storage: their file_ids live in the sticker sets.

Media engine (src/engine/):

- Images: Canvas 2D or OffscreenCanvas, createImageBitmap for decoding. Static WebP through a libwebp WASM build, because Safari does not reliably encode WebP from canvas; PNG from canvas.
- Video and GIF: compare WebCodecs (with a pure-JS WebM/MP4 muxer) against the ffmpeg.wasm single-thread core, which needs no SharedArrayBuffer (Telegram Web opens Mini Apps in an iframe). Choose per device by capability detection, behind one Encoder interface.
- Background removal: an on-device segmentation model via onnxruntime-web or transformers.js, permissive license only, lazy-loaded and cached, with a smaller fallback model for low-memory devices.
- TGS: gunzip (DecompressionStream or pako) and render with lottie-web to canvas, to convert Telegram animated stickers.
- Heavy assets (wasm, models, fonts) load only when a feature needs them: from the static build if Phase 0 allows the sizes, else from pinned CDN URLs with SRI hashes.
- Public API: toTelegramStatic, toTelegramVideo, toWhatsAppStatic, toWhatsAppAnimated, toGif, toMp4, extractFrames, validate. Each takes a project document model, not UI state.

Licensing. List every library, wasm build, model and font in THIRD_PARTY_LICENSES.md. Before adopting anything GPL, AGPL or non-commercial, ask Kimi, because the bot may earn money later. Known cases to check: the default ffmpeg.wasm core (GPL, includes x264), @imgly/background-removal (AGPL), BRIA RMBG models (non-commercial).

## 5. Wanger Account integration

Wanger Account is the ecosystem's shared user layer: one identity per Telegram user across all Wanger bots, tied to the mother bot, carrying language, plan, points and ban status. Each tgcloud project has its own database and cannot import code from outside its own tgcloud/ folder, so this bot reaches Wanger Account only through one adapter.

Step 1: discover (Phase 0). Search the repo for an existing Wanger Account implementation, contract or notes (the mother bot's folder, a wanger-account module, shared modules, READMEs). If one exists, use its exact contract, data shapes and auth scheme, and copy shared modules into tgcloud/lib/wanger/ the way the other bots do. If nothing exists or the contract is unclear, report it and build step 2 without inventing a hub.

Step 2: adapter. tgcloud/lib/wanger/account.js exposes one interface. No other code touches account storage directly.

```
ensureAccount(tgUser)                     // create or link on first contact → Account
getAccount(tgUserId)                      // { wangerId, tgUserId, lang, plan, planUntil, points, banned }
getEntitlements(tgUserId)                 // { pro, quotas: { [featureKey]: dailyLimit } }
addPoints(tgUserId, delta, reason, idempotencyKey)
spendCredits(tgUserId, amount, reason, idempotencyKey) // → { ok, balance } | { ok: false, reason: 'INSUFFICIENT' }
setBan(tgUserId, banned, reason, scope)   // scope: 'bot' | 'ecosystem'
recordEvent(tgUserId, type, payload)      // ecosystem analytics, fire-and-forget
```

- LocalAccountProvider: the interface on this bot's own tables. This is the default now.
- HubAccountProvider: the same interface over HTTPS with the SDK fetch, used once a central Wanger Account hub exists. Requests are HMAC-SHA256 signed with a per-bot secret from the secrets table, carry a timestamp against replay, time out after 5 s, and send an idempotency key on every write. When the hub is down, fall back to cached data read-only and queue writes for retry.
- The account_provider setting switches providers; never switch by editing code.
- An ecosystem-wide ban from Wanger Account applies here too. A local ban stays local unless the owner picks "ecosystem".

## 6. Forced-join gate

Every user action passes the gate, in chat and in the Mini App. Exceptions: the owner, the first-start language choice, the gate's own check button, and my_chat_member updates. Banned users are stopped before the gate; maintenance mode is checked before both.

Membership check

- Call api.getChatMember({ chat_id, user_id }) for every enabled channel, in parallel, each with its own timeout and error handling.
- Joined = creator, administrator, member, or restricted with is_member: true. Not joined = left or kicked.
- The bot must be an admin in every gate channel. Verify this when the owner adds a channel and refuse the channel if not.
- Cache passes in membership_cache for 10 minutes (a setting). Never cache failures. Re-check without cache on the check button and before pack creation and exports.
- If the bot lost access to a channel (removed, demoted, channel deleted): skip that one channel so users are not locked out, log it, and alert the owner at most once per hour. my_chat_member updates for gate channels trigger the same alert immediately.

Gate message (texts from i18n, Persian or English)

- One short line asking the user to join the channels below.
- One URL button per missing channel, in the owner's order, labelled with the channel title: `https://t.me/<username>`, or the stored invite link for private channels.
- A final callback button "عضو شدم" that re-checks without cache.
- After passing, resume what the user was doing: keep the pending action (for example the photo they sent) for 15 minutes, so nothing has to be sent again.

Mini App. Every endpoint runs the same gate. A non-member gets EndpointError with `{ code: 'JOIN_REQUIRED', channels: [{ title, url }] }`. The Studio shows the same gate screen, opens links with Telegram.WebApp.openTelegramLink, then re-checks.

Owner management (private chat only, owner only)

- List channels with their status (bot is admin: yes or no, member count if available).
- Add by @username, numeric chat ID, or a forwarded post from the channel. Hard limit: 10 channels.
- Remove, reorder (up and down), enable or disable one channel, enable or disable the whole gate.
- Set a custom invite link per channel; preview the gate exactly as a user sees it.
- Seed @HIDE_i_SEEK, @Nepenthw_ir and @wangerBots on first run as data, so the owner can change them later.

Join-request channels (optional, behind a setting). For a private channel that uses join requests, the bot creates its own invite link with creates_join_request: true. A chat_join_request handler records pending requests, and the owner decides whether a pending request counts as joined. This bot never approves requests itself.

## 7. Owner admin panel

The panel opens with /admin or an admin button, both visible only to 5557901897. Register /admin with setMyCommands using BotCommandScopeChat for the owner's chat only. The UI is an inline keyboard in the private chat that edits one panel message instead of posting new ones. Every callback re-checks from.id === OWNER_ID. Callback data must fit Telegram's 64-byte limit, so use a compact scheme such as a:ch:del:3.

| Section | What it does |
|---|---|
| Stats | Users: total, new and active (today, 7 days, 30 days), blocked the bot, language split. Output: stickers (static, video), GIFs, packs (Telegram, WhatsApp), conversion success rate, top features. Stars revenue once payments exist. |
| Broadcast | The owner sends or forwards any message. The bot shows a preview, audience (all, Persian, English, active in 30 days, Pro), mode (copy or forward), then asks to confirm. Live progress with pause, resume and cancel; final report: sent, failed, blocked. |
| Forced join | Channel management from section 6, max 10. |
| Users | Find by numeric ID or @username. View profile and usage; ban or unban with a reason; grant or revoke Pro with an expiry; add or remove points; reset today's quota; send the user a message. |
| Settings | Daily free quota per feature, input limits (size, duration), a feature flag per feature, maintenance mode with its own message, editable start and help texts per language, storage channel ID. |
| Errors and logs | Last 50 errors grouped by code and feature, gate problems, Bot API failures, with a clear button. |
| Secrets | Set or replace third-party API keys, stored in secrets and shown masked. The bot deletes the owner's message that contained the key right after saving it. |
| Backup | Export users, packs and settings as JSON documents to the owner's chat. |
| Moderation (later) | Reported public packs: hide, delete, ban the creator. Shown only once the gallery exists. |

Broadcast engine. If the existing Wanger bots already have a broadcast module, reuse it. Otherwise: store the job in broadcasts with a cursor and send in slices sized to the run-time limit measured in Phase 0, at most about 25 messages per second. On 429, wait retry_after; on 403, mark the user blocked_bot. The cursor moves only after a confirmed send, so no one gets a message twice. With no cron available, delivery continues three ways:

1. A "continue" button on the owner's progress message.
2. An admin page in the Mini App that calls admin_broadcastTick in a loop while it stays open (the fast path).
3. Small slices piggybacked on ordinary incoming updates, run after that user's reply is sent.

Owner notifications (each can be turned off): a daily summary, gate channel problems, and error spikes.

## 8. Bot UX, commands and languages

A beginner should reach a first sticker in under a minute, the chat should stay clean, and complex editing belongs in the Studio, never in dozens of inline buttons.

Commands (set with setMyCommands per language_code): /start, /menu, /studio, /packs, /lang, /help, /cancel, /deletemydata. Owner only: /admin.

Main menu (inline keyboard; Persian labels below, English equivalents in en.js):

- ساخت استیکر: opens the Studio in sticker mode.
- استودیو GIF: opens the Studio in GIF mode.
- پک‌های من: the user's Telegram and WhatsApp packs.
- تبدیل فرمت: quick conversions.
- حساب Wanger من: plan, points, today's quota, language.
- راهنما و تنظیمات.
- Later, behind feature flags: ساخت با هوش مصنوعی and گالری.

A persistent chat menu button opens the Studio (setChatMenuButton with web_app). The Studio is also the bot's Main Mini App in BotFather.

Chat flows

- /start: create or link the Wanger Account, ask the language on first start (pre-select from language_code), run the gate, then a short welcome and the menu.
- Deep links: pack_<id> opens a shared pack, studio opens the Studio, ref_<code> records a referral for later points.
- The user sends a photo, image file, video, GIF, round video or sticker: the bot replies with the actions that fit that type, such as "Open in Studio", "Quick sticker" (Studio with good defaults), "Make GIF", or for stickers "Add to my pack" (uses the existing file_id, no processing).
- Files over 20 MB sent in chat: explain the limit and offer to pick the file inside the Studio instead.
- /cancel clears any pending step. Conversation state lives in the user_state table with an expiry, never in memory.

Languages

- Persian is the default. Persian texts are short and natural, use Persian digits, and render RTL correctly, including mixed Persian and English.
- fa.js and en.js share identical keys; a test fails if any key is missing.
- The language can be changed with /lang and in the Studio settings, and is stored in Wanger Account.

## 9. Studio features

The Studio is the Mini App editor. It uses Telegram theme colors (themeParams), expand(), BackButton, MainButton and haptics, and must work on Android, iOS, Desktop and Web. Drafts autosave to IndexedDB on the device; nothing leaves the device until the user exports.

Inputs: JPG, PNG (alpha kept), WebP, HEIC where the webview decodes it, GIF, MP4, MOV, WebM, Telegram round videos, Telegram stickers (WebP, WebM, TGS), and several images at once.

Static sticker editor

- Background: automatic removal on the device; manual erase and restore brush with size and softness; zoom and pan; replace with a color or keep transparent.
- Shape: free crop, square, circle, rounded corners, rotate, flip, resize.
- Look: outline in any color with adjustable thickness, drop shadow, opacity, brightness, contrast, saturation, a few filters, ready-made frames.
- Text: multiple text layers; bundled OFL fonts (Vazirmatn plus two or three other Persian fonts, and two or three Latin fonts); size, color, letter spacing, outline, shadow, background box, rotate, move. Persian is shaped by the browser's own text engine: canvas direction = 'rtl' with fonts loaded through FontFace, so letters join and mixed Persian and English keep the right order.
- Drawing: pen, shapes, arrows, emoji and decoration layers.
- Layers with reordering; undo and redo for at least 50 steps.

Animated sticker editor

- Timeline with frame previews; pick start and end. Clips are cut to 3 s for Telegram and up to 10 s for WhatsApp.
- Audio is always removed. Speed, reverse, boomerang, and a seamless-loop helper that crossfades the end into the start.
- Round video to sticker: circle mask with transparent corners.
- Text and overlays: render each text layer once to a transparent bitmap with canvas, then composite it onto the frames. Never depend on FFmpeg drawtext for Persian.
- Animated background removal: Phase 4, experimental, max 3 s at 512 px, only on capable devices.

GIF studio

- Create: from a video, from images (slideshow with per-frame duration), by joining GIFs, from chosen video frames, a text animation, or a static sticker with a simple motion effect.
- Edit: trim, crop, aspect ratio, resize, speed, slow and fast motion, reverse, boomerang, loop count, captions, optional watermark, fps and quality.
- Convert: GIF to MP4 and back, GIF to WebM and back, video to animated WebP, frames to a ZIP of PNGs, first frame only, compress.
- Shortcut: pick any 3-second part of a GIF or video and send it straight into a Telegram video sticker.
- Delivery: a Telegram GIF goes out with sendAnimation, which accepts GIF or H.264 MP4 without sound. A real .gif file goes out with sendDocument and disable_content_type_detection: true; verify Telegram keeps it as a file, otherwise zip it.

Telegram pack management

- Create: title up to 64 characters (Persian allowed); auto-generated name `ws_<base36 user id>_<n>_by_<bot_username>` (ASCII, starts with a letter, no double underscores, max 64 characters). Read the bot username from getMe and cache it.
- Edit: add, delete, reorder and replace stickers; set 1–20 emojis and keywords per sticker; set the pack thumbnail; rename; delete the pack; share `https://t.me/addstickers/<name>`.
- Organize: copy stickers between the user's own packs, merge packs, duplicate a pack, export a backup list.
- Import: from any public pack, by link or by sending one of its stickers, the user picks stickers to add to their own pack by file_id, with no processing. Show a one-line note that this is for personal use.
- Formats: the current Bot API lets one set mix static, video and animated stickers; still enforce per-format limits. Custom emoji packs (100×100) come in Phase 4.
- A bot can only manage sets it created, which is why every name ends with `_by_<bot_username>`.

Screenshot to pack (Phase 3): find several stickers in one image. With alpha: connected components on the alpha channel. Without alpha: estimate the background from the borders, threshold, clean up with morphology, then connected components (pure JS or OpenCV.js). Show numbered boxes, let the user adjust or drop them, then process each crop.

Batch mode (Phase 3): several inputs, one set of settings, one export.

WhatsApp packs are covered in section 10.

## 10. Export standards and the encoding pipeline

Every number below lives in tgcloud/lib/core/limits.js and src/engine/limits.ts, and a test checks that both match. The values were checked on 11 November 2026 against Telegram stickers, the Telegram VP9 guide, Telegram sticker import and the WhatsApp sticker requirements. Re-check them in Phase 0.

Telegram

| Output | Format | Canvas | Max size | Other rules |
|---|---|---|---|---|
| Static sticker | PNG or WEBP | one side exactly 512 px, other ≤ 512 | 512 KB | transparent background; white outline and soft shadow look best |
| Video sticker | WEBM, VP9, no audio stream | one side exactly 512 px, other ≤ 512 | 256 KB | ≤ 3 s, ≤ 30 fps (constant), should loop |
| Animated sticker | TGS (gzipped Lottie) | 512×512 | 64 KB | ≤ 3 s, 60 fps; import and convert only, never generated from video |
| Custom emoji | PNG, WEBP, WEBM or TGS | exactly 100×100 | as for stickers | Phase 4 |
| Pack thumbnail | WEBP or PNG; WEBM or TGS | 100×100 | 128 KB; 32 KB for WEBM or TGS | optional |

WhatsApp

| Output | Format | Canvas | Max size | Other rules |
|---|---|---|---|---|
| Static sticker | WebP | exactly 512×512 | 100 KB | transparent background |
| Animated sticker | animated WebP | exactly 512×512 | 500 KB | ≤ 10 s total, every frame ≥ 8 ms; the first frame must show the complete sticker, because WhatsApp stops on it after looping |
| Tray icon | PNG | 96×96 | 50 KB | static, even for animated packs |

A WhatsApp pack holds 3 to 30 stickers, all static or all animated, never mixed, with 1 to 3 emojis per sticker plus a pack name and publisher.

Fitting. Telegram keeps the aspect ratio with the long side at exactly 512 px. WhatsApp always outputs 512×512 with the art centered on a transparent canvas and a small transparent margin, so outlines are never clipped.

Size targeting (deterministic and bounded, so it stays fast on phones):

1. Encode at the default quality for the target.
2. If the file is too big, binary-search the quality: at most 6 encodes.
3. Still too big: lower the frame rate (30, 24, 20, 15) for animations; switch lossless to lossy for static WebP.
4. Still too big: ask the user to shorten or simplify. Never cut content silently.
5. Telegram never drops below the 512 px side and WhatsApp never leaves 512×512. Show the final size and settings before upload.

VP9 WebM keeps alpha (yuva420p or the WebCodecs equivalent), uses a constant frame rate, and two-pass encoding where the encoder supports it. Animated WebP keeps alpha and loops forever.

Validators. Pure functions in lib/core read file headers and return a list of rule violations: PNG IHDR; WebP RIFF chunks (VP8, VP8L, VP8X, ANIM, ANMF sizes and frame durations); WebM EBML (codec V_VP9, no audio track, duration, frame rate, dimensions); GIF logical screen; TGS gzip plus Lottie JSON (w, h, fr, ip, op). The engine runs them before upload and the server runs them again in upload_commit.

Delivery to WhatsApp

- Phase 3: a ZIP with the stickers, the tray icon and a short README, plus a .wastickers package behind a feature flag. Before enabling that flag, verify the current de facto format used by importer apps.
- The same files go to the storage channel (section 4), so the pack can be edited and exported again later.
- The help text explains importing in general terms and does not promote any specific app.
- Phase 6 (optional, outside Serverless): an Android companion app using WhatsApp's official sticker-pack integration (ContentProvider plus the ENABLE_STICKER_PACK intent). iOS needs a paid Apple developer account, so it waits for Kimi's decision.

Both platforms. One project can export to Telegram and WhatsApp in one go; each output is validated against its own rules.

## 11. Data model (tgcloud/schema.js)

SQLite with no foreign keys: store parent IDs as plain columns and keep integrity in code (create parents first, delete children first, sweep orphans during housekeeping). Timestamps are integer unix seconds, and every column used for lookups gets an index.

| Table | Key columns |
|---|---|
| users | tg_id (PK), first_name, username, lang, joined_at, last_active_at, blocked_bot, banned, ban_reason, plan, plan_until, points, wanger_id, referrer_id |
| usage_daily | tg_id, day (YYYYMMDD), feature, count; unique on (tg_id, day, feature) |
| channels | id, chat_id, username, title, invite_link, position, enabled, added_at |
| membership_cache | tg_id (PK), ok_until |
| user_state | tg_id (PK), step, payload (json), expires_at |
| pending_actions | tg_id (PK), action (json), expires_at; resumed after the gate passes |
| jobs | id (random token), tg_id, source_file_id, source_kind, size, status, created_at, expires_at |
| uploads | upload_id (PK), tg_id, total_size, sha256, status, created_at |
| upload_chunks | upload_id, idx, data (blob), created_at; unique on (upload_id, idx) |
| packs | id, tg_id, platform (telegram or whatsapp), tg_name, title, kind, publisher, wa_identifier, sticker_count, is_public, created_at, updated_at |
| pack_items | id, pack_id, position, file_id, file_unique_id, format, emojis (json), keywords (json) |
| broadcasts | id, source_chat_id, source_message_id, mode, audience, status, cursor_tg_id, sent, failed, blocked, created_at, finished_at |
| settings | key (PK), value (json): feature flags, quotas, texts, storage channel, maintenance, account_provider, housekeeping timestamp |
| secrets | key (PK), value, updated_at |
| rate_limits | tg_id, bucket, tokens, updated_at; unique on (tg_id, bucket) |
| errors | id, at, tg_id, scope, code, message; trimmed to the latest 1,000 rows |
| stats_daily | day, metric, value; unique on (day, metric) |
| payments (Phase 5) | id, tg_id, charge_id, stars, product, created_at, refunded |
| gallery, reports (Phase 5) | public pack listings, likes and abuse reports |

Housekeeping without cron. At most once every 10 minutes (timestamp in settings), an incoming update runs cleanup after the user's reply is sent: expired jobs, uploads and chunks, states, pending actions and caches, plus trimming errors.

## 12. Quotas, points and payments

Phases 1 to 4 are free for users, with daily quotas per feature that the owner sets in the admin panel. Processing happens on the user's device, so quotas mainly protect Bot API traffic, storage and abuse limits.

- Quotas come from getEntitlements and are counted in usage_daily only after a successful export, never for failed attempts.
- Pro plan (Phase 5, behind a flag): paid with Telegram Stars, the required currency for digital goods sold in bots. Use createInvoiceLink with currency XTR and a 30-day subscription_period; answer pre_checkout_query within 10 seconds; on successful_payment store telegram_payment_charge_id; support refunds with refundStarPayment. Pro raises quotas and unlocks heavy features, while basic sticker making stays free.
- Wanger Points (Phase 5): earned only for real activity (packs created and shared, referrals that become active users, events), with daily caps and duplicate detection so they cannot be farmed. Spent on AI credits, templates or Pro discounts. Points live in Wanger Account so they work across bots, and every award or spend carries an idempotency key.
- No ads in this plan. Growth comes from forced join, shared pack links and referrals.

## 13. Security, privacy and reliability

- Authorization. Owner check on every admin path. Ownership of jobs, uploads and packs is checked against ctx.initData.user.id or from.id on every call. Never trust a user ID sent by the client.
- Input validation. Every endpoint checks types, lengths, enums and sizes, and rejects unknown fields.
- Rate limiting. Per-user token buckets in rate_limits for endpoints and heavy chat actions, with a friendly "slow down" message.
- Privacy. Media is processed on the user's device; only exported files reach Telegram. Temporary chunks are deleted within 30 minutes. /deletemydata removes the user's records here (packs metadata, usage, state) and explains that Telegram sticker sets are deleted from the pack menu. User media is never used to train AI. Logs never contain file bytes, tokens, keys or users' message text.
- Content rules (for AI features later): refuse sexual content, anything involving minors, real people without consent, and hate. The character feature accepts only a photo of the user themself, after an explicit confirmation. Public gallery items can be reported and moderated.
- Errors. Map Bot API errors to friendly fa/en messages: pack name taken, pack full, file too big, invalid sticker, user blocked the bot, flood wait. On 429 respect retry_after; retry only idempotent calls. Every failed conversion shows the user a short error code and logs it for the owner.
- Resumable work. Multi-step actions (create pack then add stickers, broadcast, upload commit) can be retried safely, with no duplicate stickers or messages.
- Maintenance mode. Everyone except the owner gets the maintenance message.
- Telegram limits. 64-byte callback data, 4,096-character messages, about 30 messages per second overall and 1 per second per chat. Follow Telegram's Bot Developer Terms.

## 14. Phases and acceptance criteria

Each phase ends with the Persian report and a full stop (section 1, rule 1). The "Done when" lines are the acceptance tests.

**Phase 0: discovery and spike (no user features)**

- Read the docs and the existing Wanger bots; look for Wanger Account (section 5).
- Measure on tgcloud: run time and CPU limits for handlers and endpoints, endpoint request and response size, WebAssembly and crypto.subtle, database and static hosting limits. Check for cron, runtime env vars and a secrets store.
- Device spikes inside Telegram's webview on Android, iOS and Desktop: encode a 3 s, 512 px VP9 WebM with alpha and an animated WebP, with WebCodecs and with the ffmpeg.wasm single-thread core; encode a static WebP with libwebp WASM on iOS; run one segmentation model. Record time and memory.
- Done when: docs/SPIKE_REPORT.md and a proposed docs/DECISIONS.md (chunk sizes, engine path per platform, model choice, Wanger Account approach) are written and Kimi approves them.

**Phase 1: core bot**

- Scaffold, schema, i18n (fa, en), /start with language choice, Wanger Account adapter (local provider), forced-join gate with owner channel management (seeded with the three channels), owner panel (stats, broadcast, users, settings, logs, secrets, backup), main menu, "add this sticker to my pack", and full Telegram pack management by file_id.
- Done when: a non-member is blocked on every entry point and passes right after joining, with the pending action resumed; no admin function works for any ID other than 5557901897 (tests call every admin handler with another ID); a test broadcast survives an interruption with no duplicates; packs can be created, edited and shared.

**Phase 2: Studio MVP (static stickers)**

- Mini App hosted on tgcloud, gate in endpoints, file picking and job hand-off from chat, transfer protocol, static editor (background removal, manual erase and restore, crop, outline, shadow, Persian and English text, undo and redo), Telegram static export into packs.
- Done when: a JPEG sent in chat becomes a valid static sticker in the user's pack in under 60 s on a mid-range Android phone; Persian text renders with correct joining and order; outputs pass the validators on Android, iOS and Desktop.

**Phase 3: animated, GIF and WhatsApp**

- Video, GIF, round video and sticker inputs; timeline; Telegram video stickers; GIF studio and conversions; size targeting; WhatsApp static and animated packs (ZIP, .wastickers flag); storage channel; screenshot to pack; batch mode; TGS conversion.
- Done when: a 10 s 1080p MP4 becomes a valid VP9 video sticker (≤ 3 s, ≤ 256 KB, 512 px side, ≤ 30 fps, no audio); a WhatsApp pack of 3 to 30 stickers passes every WhatsApp rule; GIF to MP4 and MP4 to GIF both work.

**Phase 4: Studio Pro.** Templates and effects, meme factory, custom emoji packs, animated background removal (experimental), smart share links with QR and share stats, editor polish.

**Phase 5: AI, community, payments.** AI sticker generation and emoji or caption suggestions through free-tier providers behind one AiProvider interface; character studio (own photo only); public gallery with likes, reports and moderation; Stars subscription; Wanger Points; HubAccountProvider once the hub exists.

**Phase 6: companion app** (optional, outside Serverless), only with Kimi's approval; see section 10.

For phases 4 to 6, propose the "Done when" criteria at the start of the phase and wait for Kimi's approval.

## 15. Code standards, tests and deliverables

- Backend. Plain JavaScript ES modules with JSDoc types and relative .js imports. Handlers stay thin: parse, ban and maintenance check, gate, then call lib/. Pure logic lives in lib/core/ with no sdk imports, so it runs under node --test.
- Front-end. Strict TypeScript and React. Code-split the editor, the GIF studio and every heavy wasm or model. Touch targets of at least 44 px; layouts work from 360 px wide.
- Config. One config module per side for limits and defaults; no magic numbers inside features.
- Tests. Unit tests for limits, validators, size targeting, callback-data packing, i18n key parity and permission checks. Handler tests with JSON5 fixtures through npx tgcloud run. Engine tests in Vitest with small media fixtures. A manual device checklist per phase in docs/QA.md.
- Scripts. npm run dev, npm run build, npm test, and npm run deploy (build, then push with TGCLOUD_TOKEN taken from WangerStickers_BOT_TGCLOUD_TOKEN through a small cross-platform Node script). Scripts never run migrate without a prompt.
- Docs to keep current. README.md (setup; BotFather steps: enable Serverless, CLI token, Main Mini App URL, menu button, commands; deploy and migrate), docs/ARCHITECTURE.md, docs/DECISIONS.md, docs/ADMIN_GUIDE.fa.md (Persian, for Kimi), docs/SPIKE_REPORT.md, docs/QA.md, CHANGELOG.md per phase, THIRD_PARTY_LICENSES.md, and the project's AGENTS.md updated with these conventions.
- Git. Small commits with clear messages. Ignore .tgcloud/, .env*, dist/ and node_modules/.

## 16. Start now: Phase 0 only

1. Create wanger-stickers/ with the official tools: the Vite React + TypeScript app first, then npm create @tgcloud/bot . inside it. Do not deploy.
2. Read the docs and the other Wanger bots, run the tgcloud measurements, and search for Wanger Account.
3. The device spikes need a deployed test Mini App. Ask Kimi before the first push, or use a separate test bot if she gives you one.
4. Write docs/SPIKE_REPORT.md and a proposed docs/DECISIONS.md, then stop. Send Kimi the Persian report with the questions that must be answered before Phase 1.

---

## Addenda

### A1 — 2026-11-11: publish a pack to the community channel (owner's request, with the brief)

Owner's words (Persian, verbatim):

> یک اپشن هم بزار براش کسی که پک استیکر میزاره اگه خواست بزنه روی اون و ربات تو چنلی که به عنوان مقصد براش تعیین کردیم پخشش کنه تا همه ازش استفاده کنن.

Meaning: add an option so that a user who makes a sticker pack can, **if they want**, tap it and the
bot posts the pack in the **destination channel the owner has set**, so everyone can use it.

The design proposal is docs/DECISIONS.md **D11** (opt-in per pack, owner-set destination channel,
owner approval by default, withdraw, limits, schema). Proposed placement: Phase 1 for Telegram packs
(it needs only file_ids), behind the feature flag `pack_publish`; WhatsApp packs in Phase 3.
