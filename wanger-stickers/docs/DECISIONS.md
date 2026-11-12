# Decisions — Wanger Stickers

**Status: APPROVED by Kimi on 2026-11-12** ("تایید میکنم"), with her answers to §Q recorded in
§A below — where §A differs from a section, §A wins. Evidence is in
[SPIKE_REPORT.md](SPIKE_REPORT.md); the brief is [BRIEF.md](BRIEF.md).

## A — Kimi's answers (2026-11-12)

| Question | Answer | Effect |
|---|---|---|
| Q1 CLI token | Put in `Motion_BOT_TGCLOUD_TOKEN` | `scripts/tg.mjs` reads it (and `WangerStickers_BOT_TGCLOUD_TOKEN`), and refuses any token not for app9292593567 (@Wanger_Motionbot). |
| Q2 Test push | Allowed | Spike pushed (revisions 1–5); a menu button «Spike» in the owner's chat only. |
| Q3 Publish channel | **A new channel, set in the admin panel** (section «📢 کانال انتشار») | `publish.chat` setting; the bot must be an admin that can post (checked). |
| Q3 Approval | **Manual** | Always; no auto mode in Phase 1. |
| Q3 Who approves | **The owner, plus admins she adds** ("ادمین هم بتونم بیارم تایید کنه") | New role **reviewer** (`staff` table, `core/roles.js`): may approve / reject / remove publications and see the queue — nothing else. Banning from publishing stays owner-only. |
| Q3 Creator credit | **The creator's name and @username are optional toggles** — shown only if the creator turns them on | Two toggles on the confirm screen, both off by default; stored per post (`show_name`, `show_username`). |
| Q3 Post format | (not changed) | Format A: the pack's first sticker + URL buttons. |
| Q4 iOS fallback | **Build a libvpx WASM encoder** (BSD) | Planned for Phase 3 (video stickers), only if the iPhone spike shows no VP9 `VideoEncoder`. |
| Q5 GitHub Actions tick | **No** | Only piggyback, owner buttons and the Mini App tick (D8). |
| Q6 Decisions | **Approved** | — |
| Wanger Account / mother bot | (no answer) | Local provider only (D6). |

---

## D1 — Project layout and tooling

- `wanger-stickers/` is its own tgcloud project (brief §2): Vite 8 + React 19 + strict TypeScript at
  the root, `tgcloud/` next to it (made with `create-vite` and `npm create @tgcloud/bot .`).
- CLI only through `npm run tg -- <command>` (`scripts/tg.mjs`): the token comes from
  `WangerStickers_BOT_TGCLOUD_TOKEN` and is passed as `TGCLOUD_TOKEN` to that child process only;
  a generic `TGCLOUD_TOKEN` is ignored; `wanger-stickers/.tgcloud/` keeps the CLI away from the other
  bots. `npm run deploy` = build + push; it **never** migrates (brief §15). Same pattern as
  wanger-media / aegis.
- `tgcloud.jsonc`: `"static": { "source": "dist", "spa": true, "immutable": ["/assets/*"] }`.
- **One limits file**: `tgcloud/lib/core/limits.js` (pure JS) and `src/engine/limits.ts` re-exports
  it, so server and engine read the same frozen object. *Deviation:* the brief asks for two copies
  plus a parity test; one source can't drift at all. (game_bot shares pure modules the same way.)
- Tests: `node --test tests/*.test.mjs` (Node strips TypeScript types, so engine modules are tested
  too). Vitest is added in Phase 2 when engine tests need media fixtures (brief §15).
- Module budget **≤ 85** deployed modules (a 104-module deploy was refused for another bot); a
  guard test counts them from Phase 1.

## D2 — Media engine: one encoder path per output, chosen by capability detection

| Output | Primary (measured) | Fallback | Excluded |
|---|---|---|---|
| Telegram **video sticker** (VP9 + alpha WebM) | 1) WebCodecs VP9 with `alpha: 'keep'` where supported; 2) **two WebCodecs encoders (colour + alpha plane) + our WebM muxer** (`src/engine/webm/mux.ts`) — works on Chromium today | ❓ only if iOS lacks a VP9 `VideoEncoder`: a **libvpx WASM build (BSD)** made by us (recommended) or an **LGPL ffmpeg.wasm build** (libvpx + libwebp only). Both are build work → ask first. Last resort: an opaque sticker on a solid background, clearly offered as such | default ffmpeg.wasm core (GPL; also crashed in tests) |
| Telegram **static sticker** | libwebp WASM (`@jsquash/webp`, Apache-2.0) for WebP; PNG from canvas | canvas `toBlob('image/webp')` only where it really returns WebP | — |
| WhatsApp **static** | libwebp WASM, 512×512, size-targeted ≤ 100 KB | — | — |
| WhatsApp **animated** | **libwebp WebPAnimEncoder** in WASM (`wasm-webp`, MIT; libwebp BSD) — pinned/vendored | our muxer (`src/engine/webp/animmux.ts`, full frames) | — |
| GIF (sendDocument) | gifenc (MIT) — to spike in Phase 3 | — | — |
| MP4 H.264 (sendAnimation) | WebCodecs `avc1` + mp4-muxer (MIT) — to spike in Phase 3 | GIF | — |
| TGS import | `DecompressionStream('gzip')` (fflate where missing) + lottie-web (MIT) | — | — |

Details:
- **Two-pass encoding** (brief §10) is not available in WebCodecs → replaced by the bounded bitrate
  search (≤ 6 encodes). Constant frame rate is guaranteed by feeding exact timestamps.
- **Size targeting:** the brief's fps ladder 30/24/20/15 is kept for Telegram; for WhatsApp animated
  it continues **12/10/8** (measured: a 3 s clip fits at 10 fps, long clips often need ≤ 8 fps), then
  "please shorten" (never silent cuts). The final size and settings are shown before upload.
- Transparent pixels get their colour bled from the nearest opaque pixel before encoding, so lossy
  codecs don't produce dark fringes around the outline.
- Engine public API as in the brief (`toTelegramStatic`, `toTelegramVideo`, …); `src/engine/` never
  imports React, Telegram or i18n (reusable by Wanger Converter).

## D3 — Background removal model

- **Default: U²-Netp** (Apache-2.0 weights, 4.4 MB ONNX, 320 px input) — general objects (pets,
  things, people). **"Person" mode: MODNet q8** (Apache-2.0, 6.3 MB, 512 px) — cleaner on people,
  broken on non-people, so it is opt-in.
- Runtime: **onnxruntime-web, WASM, single thread** (Telegram doesn't open Mini Apps
  cross-origin-isolated → no SharedArrayBuffer → no threads). transformers.js is not needed.
  WebGPU may be added later as an optional execution provider.
- Low-memory fallback: run U²-Netp at 256 px; manual erase/restore brush always available.
- Models are lazy-loaded on first use and kept in the browser's Cache Storage.
- Excluded: BRIA RMBG (non-commercial), @imgly/background-removal (AGPL), the ISNet ONNX on Hugging
  Face (tagged AGPL), BiRefNet (MIT but ≥ 115 MB).

## D4 — Where heavy assets live

Total lazy assets ≈ 27 MB (ORT wasm 14.8 MB, models 4.4 + 6.3 MB, codecs ≈ 1.1 MB, fonts).
- **Preferred: self-hosted in the static build** (no third party at run time) — *if* the device
  spike shows tgcloud serves files of ≥ 15 MB.
- **Otherwise:** pinned jsDelivr URLs (exact versions); since wasm/models are fetched by code (not by
  `<script integrity>`), the engine checks each file's SHA-256 with `crypto.subtle` before use.
- Vite keeps every heavy library in its own chunk (`import()`), loaded only when its feature opens.

## D5 — Transfer protocol: sizes (to confirm with the endpoint measurement)

- **Preferred path is no transfer:** the user picks the file in the Studio; only the exported file
  goes up.
- **Upload:** raw chunks of **256 KB** (≈ 342 KB of base64 JSON) — conservative until `spike_echo`
  shows the real request limit; raised to 1 MB if allowed. Each `upload_chunk` decodes its chunk and
  stores raw bytes (`upload_chunks.data` blob), so `upload_commit` never base64-decodes megabytes in
  one invocation (3 s CPU). Commit reads chunks one statement at a time, checks size + SHA-256
  (`crypto.subtle`, pure-JS fallback vendored), runs the validators, acts, deletes the chunks.
- **Small files in one call:** a file that fits one chunk (every video sticker, most static stickers)
  goes as `upload_commit({ inline: b64, … })` — one round trip instead of three.
- **Max upload: 20 MB** in Phase 3 (GIF/MP4 deliveries), below the 50 MB Bot API upload limit;
  raised only after measuring DB and CPU behaviour.
- **Download of chat media into the Studio** (`media_download`): the first call streams the file
  (`api.getFileStream`, ≤ 20 MB) into short-lived `job_chunks` (raw 1 MB blobs); later calls return
  one chunk as base64. Rows expire with the job (30 min).
- Unfinished uploads expire after 30 minutes (housekeeping).

## D6 — Wanger Account

- Nothing exists in the repository (SPIKE_REPORT §5) → `tgcloud/lib/wanger/account.js` with the
  brief's interface, backed by **LocalAccountProvider** on this bot's `users` table. `wanger_id` stays
  `NULL` until a hub exists. Setting `account_provider = 'local'`.
- **HubAccountProvider is not written** until the hub's contract exists (no invented hub). Its
  contract in the brief (HMAC-SHA256, timestamp, 5 s timeout, idempotency keys, read-only cache when
  down) is kept as the target. ❓ Is the mother bot planned, and what is its name/owner?

## D7 — Reuse from the other Wanger bots (copied, never imported)

Phase 1 copies and adapts (origin in a header comment): wanger-music's forced join
(`forcejoin/gate.js`, `service.js`), broadcast engine (`broadcast/service.js`: lease + per-message
cursor, piggybacked), owner panel structure, error boundary + error log + throttled owner alerts,
Telegram client/error classes/limiter, i18n (`t()` escapes, `tp()` plain; invisible characters as
`‌` escapes), update de-duplication by `update_id`, and its local SDK emulation for tests;
game_bot's endpoint gate (`JOIN_REQUIRED`) and Mini App broadcast tick. Known platform facts they
found are built in: `getChatMember` "member not found" = not joined; no transactions (one statement
per state change); ≤ 4000 bound values and ≤ 5000 rows written per statement.

## D8 — Work without a scheduler

No cron exists (re-checked). Housekeeping, broadcasts and queued channel posts (D11) move forward:
(1) piggybacked after an update's reply, at most every 10 min for housekeeping; (2) owner buttons;
(3) the Mini App admin page calling `admin_tick` while open. ❓ Optional: a GitHub Actions schedule
calling a `tick` endpoint, as wanger-music does (`.github/workflows/wanger-music-tick.yml`) — free,
but it needs the CLI token as a GitHub secret and a file outside `wanger-stickers/` (your approval).

## D9 — Languages and text direction

- `lib/i18n/fa.js`, `en.js` (same keys, parity test), Persian default, Persian digits in Persian
  texts; the Studio has its own `src/i18n/` built from the same keys.
- Canvas text layers: base direction from the first strong character (Persian → rtl, Latin → ltr),
  Unicode isolates (U+2066–U+2069) around opposite-direction runs, Vazirmatn (+ 2–3 OFL Persian and
  Latin fonts) loaded through FontFace. Shaping is the browser's (measured: joining and ZWNJ correct).

## D10 — Telegram pack names

`ws_<base36 user id>_<n>_by_<bot_username>` — e.g. the owner's third pack is
`ws_2jx14jt_3_by_<bot>`; with a 32-character username that is 49 characters (limit 64). `n` comes
from a per-user counter that is never reused; on "name is already occupied" the next `n` is tried.
The username is read from `getMe` and cached in `settings` (Phase 0 couldn't read it — no token).

## D11 — NEW: publishing a pack to the community channel (owner's request, BRIEF Addendum A1)

**Goal.** A user who made a Telegram pack can — only if they want — tap a button, and the bot posts
the pack in the destination channel the owner chose, so everyone can add it.

**User flow (private chat and Studio "My packs")**
1. Pack screen → **«📢 انتشار در کانال»**. Shown only if the feature is on, the pack is a Telegram
   pack made by this bot for this user, it has at least *N* stickers (setting, default 3), and it is
   not already published or waiting.
2. A confirm screen shows the post exactly as it will appear, plus: «نام من کنار پک نمایش داده شود؟»
   (default **no** — anonymous), and one line: the pack becomes public, anyone can add it, I may
   only publish stickers I have the right to share, and how withdrawing works.
3. Confirm → «در انتظار تأیید» (approval mode) or published (auto mode). The user gets a message
   with a link to the post when it is out, or the reason if it was declined.
4. **Withdraw** at any time from the pack screen («حذف از کانال»).

**Owner (admin panel → «📢 کانال انتشار»)**
- Set the channel by @username, id or a forwarded post. The bot must be an admin with
  `can_post_messages` (checked with `getChatMember`; refused otherwise); `can_delete_messages` is
  recommended (for withdrawals). Lost rights (`my_chat_member`) → alert, queue paused.
- Mode: **approval (default)** or auto; minimum stickers; posts per user per day (default 2);
  minimum gap between channel posts (default 30 s); on/off.
- Approval card in the owner's chat: the pack's cover sticker + title, sticker count, creator (id,
  name), how many stickers were imported from other people's packs, and buttons
  ✅ انتشار · ❌ رد (with optional reason) · 🚫 محروم از انتشار. In auto mode, packs containing
  imported stickers still go to approval.
- Remove any published post from the panel.

**The channel post (proposed format A, Phase 1)** — one message per pack, so channel rate limits are
never an issue: `sendSticker` with the pack's cover (by file_id; stickers can't carry a caption) and
an inline keyboard:
`[ ➕ افزودن «عنوان پک» ]` → `https://t.me/addstickers/<name>` and
`[ 🎨 پک خودت را بساز ]` → `https://t.me/<bot>?start=pub_<id>` (brings new users through the gate).
If the user agreed, a third row shows `ساخته‌ی <first name>`.
❓ Alternatives: **B** (Phase 2+) a preview collage of the pack rendered on the user's device, sent
as a photo with a caption (title, count, creator, hashtags) and the same buttons; **C** a text post
whose `t.me/addstickers` link shows Telegram's own preview.

**Rules**
- Only packs this bot created for this user (`_by_<bot>`, owner = the user); `getStickerSet` right
  before posting (the pack must still exist and have ≥ N stickers).
- One live publication per pack. New stickers added later appear automatically (the post links the
  live pack). Re-publishing after a withdrawal: allowed after 7 days (setting).
- Users banned from publishing (`users.publish_banned`) don't see the button.
- **Withdraw / remove:** `deleteMessage` works only for posts < 48 h old (Bot API); older posts get
  their buttons removed (`editMessageReplyMarkup`) and the publication is marked withdrawn. Deleting
  the pack itself (`deleteStickerSet`) also kills the link. `/deletemydata` withdraws all of the
  user's publications the same way.
- Gate: publishing re-checks membership without cache (like pack creation).

**Reliability.** The `pack_posts` row is the idempotency key: a post is claimed with one conditional
`UPDATE … WHERE status='approved' … RETURNING` plus a lease; the channel `message_id` is stored right
after `sendSticker`; a row that already has a `message_id` is never sent again. 429 → stays queued
(retry by the D8 mechanisms); an expired lease without `message_id` is shown to the owner as
"uncertain", never re-sent automatically (wanger-music's rule).

**Data (Phase 1 schema additions)**
- `pack_posts`: id, pack_id, tg_id, chat_id, status (`pending`, `approved`, `posting`, `published`,
  `rejected`, `withdrawn`, `removed`, `failed`), show_creator, message_id, reason, requested_at,
  decided_at, decided_by, published_at, removed_at, lease_until; indexes (tg_id, requested_at),
  (status, requested_at), (pack_id).
- `pack_items.origin` (`made` | `import` | `copy`) — to show imported stickers on the approval card.
- `users.publish_banned`; setting `publish` = { enabled, chat_id, username, title, mode,
  min_stickers, daily_limit, min_gap_sec, republish_days }.
- Callback data (≤ 64 bytes): user `pk:pub:<packId>`, `pk:pubok:<packId>:<0|1>`, `pk:unpub:<postId>`;
  owner `a:pb:ok:<postId>`, `a:pb:no:<postId>`, `a:pb:ban:<postId>`, `a:pb:rm:<postId>`.
- Stats: requested / approved / rejected / withdrawn; bot starts from posts (`pub_<id>`).

**Phase and flag.** Phase 1 (Telegram packs exist by file_id there), hidden behind the feature flag
`pack_publish` until it works end to end. WhatsApp packs (Phase 3): ❓ post the pack's ZIP as a
document in the same channel? (WhatsApp packs can't be added by link.) The Phase 5 gallery reuses
`pack_posts` and `packs.is_public`. Wanger Points for shared packs (Phase 5) use `pub_<id>` as the
idempotency key.

## D12 — Feature flags (all in `settings`, owner-editable)

`studio`, `gif_studio`, `convert`, `pack_import`, `pack_publish` (D11), `whatsapp`, `wastickers`,
`screenshot_to_pack`, `batch`, `ai`, `gallery`, `payments`. A button is drawn only when its flag is
on *and* the feature is complete (brief §1 rule 7).

## D13 — Schema additions to brief §11 (Phase 1)

From the other bots' experience: `processed_updates` (update_id de-duplication), broadcasts get
`progress_chat_id`, `progress_message_id`, `lease_until` (wanger-music); `job_chunks` (D5);
`pack_posts`, `pack_items.origin`, `users.publish_banned` (D11); `users.pack_counter` (D10).

## D14 — Other deviations from the brief (the docs or the bots win)

| Brief | Instead | Why |
|---|---|---|
| limits in two files + parity test | one file, re-exported | can't drift (D1) |
| VP9 two-pass encoding | bounded bitrate search | WebCodecs has no two-pass |
| fps ladder 30/24/20/15 | + 12/10/8 for WhatsApp animated | measured sizes (D2) |
| "pure-JS WebM muxer" (webm-muxer) | our own small muxer | webm-muxer 5.x writes AlphaMode but not the alpha frames |
| ffmpeg.wasm single-thread as an engine option | not used | GPL core; crashed in tests; WebCodecs path works |
| emojis + keywords "1–20" | emojis 1–20; keywords 0–20, ≤ 64 chars total | Bot API |
| — | sets have max 120 stickers (200 for emoji) | Bot API |
| Phase 0 has no endpoints | two owner-only spike endpoints (`spike_echo`, `spike_report`), deleted in Phase 1 | measuring HTTP limits needs them |

## Q — Questions for Kimi before Phase 1 (answered on 2026-11-12, see §A)

1. **CLI token**: set `WangerStickers_BOT_TGCLOUD_TOKEN` (BotFather → the bot → Serverless → CLI
   Access) so I can run `npm run probe` and read the bot's username. Is `Motion_BOT_TGCLOUD_TOKEN`
   (present in this environment) perhaps meant for this bot? I did not use it.
2. **Test push**: may I push the spike (static site + 2 owner-only endpoints, no handlers, no
   tables) to this bot — or do you give me a separate test bot? Then please run the spike page on an
   Android phone, an iPhone and Telegram Desktop ("Run all + heavy", "Send to my chat").
3. **Publishing (D11)**: which channel is the destination (one of @HIDE_i_SEEK / @Nepenthw_ir /
   @wangerBots, or a new one)? Approval or automatic? Creator's name shown by default? Post format
   A, B or C? WhatsApp ZIPs in the same channel later?
4. **iOS fallback (D2)**: if iPhones can't encode VP9, may I build a libvpx WASM encoder (BSD), or
   should iPhone users get only static stickers for now?
5. **Wanger Account (D6)**: is the mother bot planned? Until then everything stays local.
6. **GitHub Actions tick (D8)**: yes/no?
7. Approve **D1–D14** (or tell me what to change).
