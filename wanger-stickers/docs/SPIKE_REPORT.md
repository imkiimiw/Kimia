# Phase 0 spike report — Wanger Stickers

Date: **2026-11-11**. Scope: brief §14 Phase 0 (no user features). Decisions that follow from these
findings are proposed in [DECISIONS.md](DECISIONS.md).

Legend: **Official** = stated on an official page today · **Measured** = observed in this session ·
**Measured (other bot)** = measured on Telegram Serverless by another Wanger bot in this repository
(date given) · **Pending** = needs something this session did not have (see §1).

## 0. Summary

| Item (brief §14 Phase 0) | Status | Result |
|---|---|---|
| Read docs and the other Wanger bots | ✅ done | §2, §6. Reuse map in DECISIONS D7. |
| Look for Wanger Account | ✅ done | **Nothing exists** in the repository (no hub, contract or notes) → local provider only (§5). |
| Re-check every Telegram / WhatsApp number | ✅ done | All in `tgcloud/lib/core/limits.js`; 6 additions/corrections vs the brief (§2). |
| tgcloud measurements on this bot | ⏳ **pending** | No `WangerStickers_BOT_TGCLOUD_TOKEN` in this session. `npm run probe` is ready (read-only, deploys nothing). Facts measured by the other bots: §3. |
| Device spikes inside Telegram (Android, iOS, Desktop) | ⏳ **pending** | Needs one push to a test bot (your OK). The spike page is built and was run in a local headless Chromium as a baseline (§4). |
| VP9 + alpha with WebCodecs | ✅ baseline | Chromium's WebCodecs **refuses alpha** for VP9; **two encoders (colour + alpha plane) + our own WebM muxer** give a transparent VP9 sticker: 96–161 KB, ≈ 0.5 s for 3 s / 512 px / 30 fps; plays with transparency in Chromium and decodes with alpha in ffmpeg. |
| VP9 + alpha with ffmpeg.wasm (single-thread) | ❌ baseline | The GPL 0.12.10 core crashed Chromium while loading (headless shell) / `memory access out of bounds` (full Chromium). Not needed on the Chromium path; iOS decides whether we need any fallback. |
| Animated WebP | ✅ baseline | libwebp's own WebPAnimEncoder (WASM): 233 KB for 3 s at 10 fps. 10 s clips need ≤ 8 fps or simpler art for WhatsApp's 500 KB (§4.3). |
| Static WebP with libwebp WASM | ✅ baseline (iOS pending) | 13–17 KB, 70–160 ms per 512×512 sticker. |
| One segmentation model | ✅ baseline | U²-Netp (4.4 MB, Apache-2.0): 1.9 s; MODNet q8 (6.3 MB, Apache-2.0, people only): 1.6 s; one thread. |
| SPIKE_REPORT + proposed DECISIONS | ✅ this file + DECISIONS.md | Waiting for your approval. |

## 1. What this session could and could not do

- **No CLI token for this bot.** The environment has no `WangerStickers_BOT_TGCLOUD_TOKEN`. (It has a
  `Motion_BOT_TGCLOUD_TOKEN` — a different name, presumably another bot; it was **not** used.) So: no
  measurement on this bot's runtime, no `getMe` (the bot's username — needed for pack names
  `…_by_<username>` — is unknown), no test deployment.
- **Nothing was pushed, migrated or sent.** No BotFather change, no message to anyone.
- Prepared instead:
  - `npm run probe` → copies `spike/probe.js` to `tgcloud/endpoints/zz_probe.js`, runs each test
    with `tgcloud run` (local code on the platform, nothing deployed), always deletes the copy,
    writes `docs/probe-results.json`. Read-only: no tables, no messages; Bot API calls are `getMe`,
    `getChat` and `getChatMember` (the bot's own record in the three gate channels).
  - The device spike page (the whole Mini App in Phase 0) + two owner-only spike endpoints
    (`spike_echo` for HTTP size limits, `spike_report` to send the results to your chat).
  - `npm run spike:local` → the same page in a local headless Chromium (§4).

## 2. Official docs re-checked (2026-11-11)

Pages: [Stickers](https://core.telegram.org/stickers), [WebM/VP9 guide](https://core.telegram.org/stickers/webm-vp9-encoding),
[Sticker import](https://core.telegram.org/import-stickers), [Bot API](https://core.telegram.org/bots/api) (10.4, 9 Nov 2026),
[Serverless](https://core.telegram.org/bots/serverless) (last change 6 Oct 2026), [WhatsApp sticker README](https://github.com/WhatsApp/stickers/blob/main/Android/README.md).

Every number of brief §10 is confirmed. Differences and additions (the docs win):

| # | Topic | Brief | Official | What `limits.js` holds |
|---|---|---|---|---|
| 1 | Stickers per set | not stated | addStickerToSet: **120** (regular), **200** (custom emoji); createNewStickerSet takes **1–50** initial stickers | `set.maxStickersRegular/Emoji`, `set.initialStickersMax` — pack screens must show "full" |
| 2 | Keywords | "1–20 emojis and keywords" | emojis **1–20**; keywords **0–20 with ≤ 64 characters in total** | `keywordsMax`, `keywordsTotalChars` |
| 3 | Static sticker size | 512 KB | only the import page says 512 KB; the stickers page and the Bot API give no number | 512 KB kept (conservative) |
| 4 | TGS frame rate | 60 fps | stickers page 60; import page 30–60 | 60 (TGS is import/convert only) |
| 5 | Deleting a channel post | — | `deleteMessage`: only messages **< 48 h** old | matters for D11 (withdrawing a published pack) |
| 6 | WhatsApp emojis | 1–3 | `emojis (required)`, "up to a maximum of three"; identifier `a-z A-Z 0-9 _ - . space`, < 128 chars | `emojiPerStickerMin: 1`, `identifierPattern` |

Not in the brief, worth knowing: Bot API 10.3–10.4 added **ephemeral messages** (a bot can answer a
button press with a message only that user sees, even in place of the original message) — useful to
keep chats clean later; nothing changed for stickers. The Serverless page still documents no cron,
no runtime environment variables, no secrets store and **no static hosting size limits**; it does
not mention WebAssembly or Web Crypto.

## 3. Telegram Serverless facts

Re-measure all of these on this bot with `npm run probe` once the token exists; the numbers below
are from the other Wanger bots and may have changed.

| Area | Finding | Source |
|---|---|---|
| CPU per invocation | **≈ 3 s**, then `CPU timer exceeded` | Measured (other bot: wanger-music, wanger-media, 2026-11-05) |
| Wall clock | ≈ 30 s under `tgcloud run`; webhook path unknown | Measured (other bot) |
| Memory | ≥ 512 MB allocatable; real cap unknown | Measured (other bot) |
| `Date.now()` | frozen during synchronous CPU work, advances across `await` | Measured (other bot) |
| Module state | not kept between invocations | Measured (other bot) |
| Scheduler / timers | **none** (no cron; no `setTimeout`/`setInterval`/`queueMicrotask`) | Official (none described) + Measured (other bot) |
| Env vars / secrets store | **none** for deployed code; `TGCLOUD_TOKEN` is CLI-only | Official |
| Transactions | **none** (`BEGIN` → not authorized); one statement = one atomic step | Measured (other bot) |
| Statement limits | ≤ 4096 bound values; ≤ 10 000 rows written per statement; ≈ 50 000 rows read per query | Measured (other bot, 2026-11-05/06) |
| Globals | present: `WebAssembly`, `crypto` (incl. `subtle`, `randomUUID`), `TextEncoder/Decoder`, `Intl`. **absent:** `URL`, `atob`/`btoa`, `DecompressionStream`, `AbortController`, `structuredClone`, `Blob`, `Buffer`. Dynamic `import()` not supported. (memebot found no `TextEncoder`/`Intl` on 2026-10-31 → the runtime changes; re-measure.) | Measured (other bot) |
| Outbound `fetch` | 30 MB per response; a stall of ≈ 5 s can happen | Official + Measured (other bot) |
| Bot API files | download ≤ 20 MB; upload ≤ 50 MB (photo 10 MB) | Official |
| `getChatMember`, non-member | **400 "member not found"** (not `status: left`) — must count as *not joined* | Measured (other bot) |
| `getWebhookInfo` | refused (403); the platform owns the webhook | Measured (other bot) |
| Module count | a 104-module deploy was refused; 88/94 deployed → keep **≤ 85** | Measured (other bot) |
| `tgcloud run` | input = one shell argument (≤ 128 KiB on Linux); output ≥ 1 MB fine; ≈ 100 runs/min then `Too many requests` | Measured (other bot) |
| **Endpoint HTTP request / response size** | **unknown** — measured by the spike page (`spike_echo`: 64 KB … 8 MB requests, 256 KB … 16 MB responses) | Pending |
| **Static hosting per-file / total size** | **unknown** (not published) — the spike build contains 1/5/10/20 MB files, the 14.8 MB ORT wasm and the 4.4 MB model | Pending |
| DB size limit | not published | Pending (probe measures blob sizes per statement) |
| WASM inside the isolate | present per wanger-media; the probe also instantiates a module (not needed: media never runs server-side) | Pending re-check |
| Base64 / SHA-256 cost server-side | decides the upload chunk size (D5) | Pending (`probe`: `base64`, `sha256`, `dbBlobParam`, `dbBlobResult`) |

## 4. Device spikes

### 4.1 Harness

The Phase 0 Mini App (`src/spike/`) runs on the device, on the same synthetic 3-second 512×512
transparent animation (a moving outlined blob + «سلام Wanger ۱۲۳» in Vazirmatn), and records time,
size, validity (our own header readers, `tgcloud/lib/core/inspect.js`) and — where the browser
exposes it — memory:

| Test | What it does |
|---|---|
| Capabilities | Telegram platform/version, cores, memory, SharedArrayBuffer, WASM SIMD, OffscreenCanvas, WebCodecs (VP9 with/without alpha, H.264), canvas WebP, DecompressionStream, WebGPU… |
| VP9 + alpha (WebCodecs) | one encoder, `alpha: 'keep'`, 3 bitrates, muxed by webm-muxer |
| VP9 + alpha (2 encoders) | colour and alpha plane encoded separately, muxed by `src/engine/webm/mux.ts`; then played back in a `<video>` and the alpha is read back |
| Static WebP | libwebp WASM (jsquash) at q90/75/50/lossless + the canvas encoder |
| Animated WebP ×2 | per-frame libwebp + our muxer (`src/engine/webp/animmux.ts`); libwebp's WebPAnimEncoder (wasm-webp) |
| Persian text | canvas `direction = 'rtl'` with Vazirmatn via FontFace (visual check) |
| Background removal ×2 | U²-Netp and MODNet q8 in onnxruntime-web (WASM); optional own photo |
| ffmpeg.wasm | GPL single-thread core **from a CDN, spike only**: VP9 yuva420p + libwebp_anim |
| Endpoint sizes | request/response ladders through `Telegram.WebApp.Serverless.call` (inside Telegram only) |
| Static hosting | downloads the 1/5/10/20 MB files of the build |

"Send to my chat" posts the JSON as a document to the tester's own chat (`spike_report`; owner and
listed testers only). Device checklist: [QA.md](QA.md).

### 4.2 Local baseline (headless Chromium 153, cloud container, 4 cores — NOT a phone, NOT a Telegram webview)

Raw: [spike-results/chromium-local.json](spike-results/chromium-local.json). Phones will be slower;
use these numbers only to compare methods.

| Test | Result |
|---|---|
| Capabilities | WASM SIMD ✓, OffscreenCanvas ✓, WebCodecs ✓, VP9 encode ✓ but **VP9 + alpha ✗**, H.264 encode ✓, canvas WebP ✓, DecompressionStream ✓, **crossOriginIsolated ✗ / SharedArrayBuffer ✗** |
| VP9, one encoder, alpha `keep` | **not supported** (all 3 bitrates); without alpha: 111.5 KB at 400 kbps, 0.3 s |
| **VP9, two encoders + own muxer** | 500k+120k → **161 KB**; 350k+80k → **125 KB**; 220k+60k → **96 KB**; ≈ 0.5 s each; 90 frames, 30 fps, 3.000 s, no audio track, AlphaMode 1; Chromium plays it **with transparency** (corner alpha 0, sticker alpha 255); ffmpeg's libvpx decoder reads the alpha too |
| Static WebP (libwebp) | q90 17.3 KB / 161 ms · q75 13.9 KB / 68 ms · q50 12.8 KB / 73 ms · lossless 33.6 KB / 239 ms; all with alpha |
| Animated WebP, own muxer (full frames) | 3 s @15 fps q60 → 686 KB ✗ · 6 s @12 → 1066 KB ✗ · 10 s @10 → 1453 KB ✗ |
| **Animated WebP, WebPAnimEncoder** | 3 s @15 q60 → 372 KB ✓ · **3 s @10 q45 → 233 KB ✓** · 6 s @12 q50 → 570 KB ✗ · 10 s @10 q45 → 776 KB ✗ · 10 s @8 q30 → 580 KB ✗; 1.3–4 s |
| Persian text | joined letters ✓, ZWNJ ✓; mixed Persian + Latin follows the Unicode bidi rules of an RTL paragraph (a Latin phrase inside «…» lands visually where a Persian reader may not expect) |
| U²-Netp (320 px) | model 4.4 MB; session 0.6 s; inference **1.9 s**; 1 thread. Real photos: clean cat, person with a faint halo |
| MODNet q8 (512 px) | model 6.3 MB (from Hugging Face); session 0.8 s; inference **1.6 s**. Real photos: clean person, **broken on the cat** (portrait-only model) |
| ffmpeg.wasm 0.12.10 | renderer crash while loading (headless shell); `RuntimeError: memory access out of bounds` in full Chromium. Not investigated further (GPL; not on the proposed path) |
| Endpoint sizes | skipped (needs Telegram init data) |
| Static hosting | local server only — no information about tgcloud |

### 4.3 What the baseline already tells us

1. **Transparent VP9 works without ffmpeg** where WebCodecs has a VP9 encoder: encode colour and the
   alpha plane with two `VideoEncoder`s and write WebM's standard alpha layout (BlockAdditions +
   AlphaMode) ourselves. Size is comfortable (96–161 KB of the 256 KB budget at 30 fps). Two things
   remain to prove: **Telegram accepts the file** (`uploadStickerFile` + `createNewStickerSet` on a
   test bot) and **iOS** (WKWebView) has a VP9 `VideoEncoder` at all.
2. **Animated WebP for WhatsApp must use WebPAnimEncoder** (it writes only the changed rectangles and
   mixes lossy/lossless per frame): half the size of full frames. The test clip changes almost every
   pixel of the subject every frame (a worst case); still, **10-second clips at 512×512 will often
   need ≤ 8 fps or simpler art** to fit 500 KB. The size-targeting fps ladder needs **12, 10, 8**
   after the brief's 30/24/20/15 for WhatsApp, and the "ask the user to shorten" step will be common
   for long clips.
3. **Our own animated-WebP muxer** stays as the dependency-free fallback (valid files, passes the
   inspector), but it is not size-competitive.
4. **Background removal:** U²-Netp (general objects, 4.4 MB) as the default and MODNet (people,
   6.3 MB) as a "person" mode. Telegram opens Mini Apps without cross-origin isolation, so
   **onnxruntime runs single-threaded** — 2 s on this desktop-class CPU, likely 4–10 s on a
   mid-range phone (device runs will tell). Still inside "first sticker in under a minute".
5. **Canvas text** needs a per-layer base direction (first strong character: Persian → rtl,
   Latin → ltr) and Unicode isolates around embedded opposite-direction runs; the browser's shaping
   itself is fine.
6. **Assets:** the ORT wasm alone is 14.8 MB; with models (4.4 + 6.3 MB) and the codecs (≈ 1.1 MB)
   the heavy assets total ≈ 27 MB, all lazy-loaded. Whether tgcloud's static hosting serves files
   this large is the main open hosting question (§3).

### 4.4 Still to run on real devices (after one test push)

Android (Telegram app, a mid-range phone), iOS (Telegram app), Telegram Desktop, Telegram Web.
For each: "Run all + heavy", once with your own photo, then "Send to my chat". The checklist is in
[QA.md](QA.md). The key questions: VP9 encoder on iOS; times and memory on a mid-range Android; static
file size limit; endpoint request/response limits; whether Telegram accepts our VP9 alpha WebM as a
video sticker.

## 5. Wanger Account discovery

Searched every folder (aegis, wanger-media, wanger-music, game_bot, memebot, relay_bot, whisper_bot,
x_downloader_bot, the root to-do bot), all docs and the git history for "Wanger Account",
`wanger_id`, "mother bot", «بات مادر» / «ربات مادر», "account hub". **Nothing exists**: no hub, no
API contract, no shared module, no notes. Each Wanger bot keeps its own `users` table and its own
bans. → As the brief says for this case: build the adapter with the **LocalAccountProvider only**
and do not invent a hub (DECISIONS D6). Question for you: is the mother bot planned, and who builds
it?

## 6. What the other Wanger bots already solve (to reuse in Phase 1)

| Need | Best existing implementation | Notes |
|---|---|---|
| Forced join | wanger-music `lib/forcejoin/{gate,service}.js`; game_bot `lib/join.js` (endpoints → `NOT_JOINED`) | "member not found" = not joined; broken channel skipped + owner alert; pass cache per user |
| Broadcast | wanger-music `lib/broadcast/service.js` (lease + per-message cursor, piggyback tick); game_bot `broadcastTick` endpoint for the Mini App fast path | matches brief §7 exactly |
| Owner panel | wanger-music `lib/admin/*` (one edited panel message, compact callback data) | |
| Error boundary, error log, owner alerts | wanger-music `lib/core/boundary.js`, `alerts/` | handlers never rethrow; updates de-duplicated by `update_id` |
| Telegram client + error classes + limiter | wanger-music `lib/telegram/{client,errors,limiter}.js` | 429 `retry_after`, 403 blocked |
| i18n | wanger-music / wanger-media `lib/i18n/{fa,en}.js`, `t()` escapes, `tp()` plain; invisible characters as `‌` escapes | key-parity test |
| CLI token isolation | wanger-media `scripts/tg.mjs` | copied as `scripts/tg.mjs` here |
| Local SDK emulation for tests | wanger-music `tests/sdk/` (node:sqlite; enforces 4096 values / 10 000 rows) | Phase 1 copies it |
| Mini App + endpoints with Vite | game_bot (`tgcloud.jsonc` with spa + immutable, pure modules shared by app and server) | |

Copied code keeps its origin in a header comment (the brief: copy, never import across projects).

## 7. Licences checked (details in [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md))

| Component | Licence | Verdict |
|---|---|---|
| webm-muxer, mp4-muxer, @ffmpeg/ffmpeg, @ffmpeg/util, onnxruntime-web, wasm-webp, fflate, gifenc, lottie-web | MIT | ✅ |
| @jsquash/webp, @jsquash/png, @huggingface/transformers, @mediapipe/tasks-vision | Apache-2.0 | ✅ |
| libwebp (inside jsquash / wasm-webp) | BSD-3-Clause | ✅ |
| Vazirmatn | OFL-1.1 | ✅ |
| U²-Netp weights (xuebinqin/U-2-Net, file from rembg's release) | Apache-2.0 | ✅ |
| MODNet (Xenova/modnet ONNX) | Apache-2.0 | ✅ |
| BiRefNet_lite ONNX | MIT | ✅ licence, but 115 MB (fp16) → not for phones |
| mediabunny | MPL-2.0 | ⚠️ weak copyleft (file level) — not used; ask before adopting |
| **@ffmpeg/core 0.12.x (default core)** | **GPL-2.0-or-later** (x264, x265 …) | ❌ spike only (from a CDN, never bundled); ask before any use |
| **@imgly/background-removal** | **AGPL** (custom licence) | ❌ excluded |
| **BRIA RMBG-1.4 / 2.0** | **non-commercial** ("other") | ❌ excluded |
| **onnx-community/ISNet-ONNX** | tagged **AGPL-3.0** on Hugging Face | ❌ excluded (the original DIS weights are Apache-2.0; only a conversion we make ourselves would be clean) |

## 8. Risks and open questions

| Risk | Impact | Mitigation / next step |
|---|---|---|
| iOS has no VP9 `VideoEncoder` | no video stickers made on iPhones | device spike; fallbacks in D2 (libvpx WASM build, BSD; or an LGPL ffmpeg.wasm build) — both are build work, ask first |
| Telegram rejects our two-encoder VP9 alpha WebM | video stickers need another encoder | test with `uploadStickerFile` on the test bot right after the first push |
| Static hosting refuses ≥ 10 MB files | ORT wasm (14.8 MB) / models can't be self-hosted | pinned jsDelivr URLs with SRI (D4) |
| Phones take > 10 s for background removal | slow first sticker | smaller input (256 px) for U²-Netp, progress UI, cache the model in the browser cache |
| WhatsApp 10 s animated stickers over 500 KB | users can't export long clips | fps 12/10/8 ladder, ask to shorten, show the size before export |
| The runtime changes (globals appeared/disappeared within a week) | code relying on a global breaks | capability checks + fallbacks (pure-JS SHA-256, base64) |
