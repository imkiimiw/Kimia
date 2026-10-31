# Platform check — Telegram Serverless + inline mode

Checked on 2026-10-31 against the official pages:
[core.telegram.org/bots/serverless](https://core.telegram.org/bots/serverless) (CLI 0.2.0, "Recent
changes: October 6, 2026"), [Inline bots](https://core.telegram.org/bots/inline),
[answerInlineQuery](https://core.telegram.org/bots/api#answerinlinequery) and the
`InlineQueryResultCached*` / `InlineQueryResultsButton` / `ChosenInlineResult` types. A ✱ marks
numbers that are **not published** and were measured by the earlier bots in this repository (Aegis,
Whisper), so they can change without notice.

## 1. Limits

| Area | Limit | Source |
|---|---|---|
| Runtime | One V8 isolate per update. No npm packages, no filesystem. Network only through the SDK's `fetch`. | Official |
| Missing globals | No `setTimeout`/`setInterval`, `Intl`, `URL`, `Buffer`, `TextEncoder`, `atob`/`btoa`. Write Persian digits and dates by hand. | ✱ measured |
| CPU per update | **≈ 3 s**, then «CPU timer exceeded». `Date.now()` stays frozen for the whole update. | ✱ measured |
| Wall time / memory | Not published. | — |
| Scheduler / cron / background jobs | **None.** Code runs only while handling an update or an endpoint call. | Official (none described) + ✱ |
| Environment variables in deployed code | **None.** The only env var is `TGCLOUD_TOKEN`, and only the CLI reads it. | Official |
| Modules | A deploy with 104 modules was refused; 88 and 94 deployed. | ✱ measured |
| Database | One SQLite store per bot, kept between updates. Every call is async. **No foreign keys** (declaring one throws). Tables, columns and indexes are dropped only with `.deprecated()`. Type changes are manual. A batch insert counts against SQLite's variable limit (rows × columns). | Official |
| Database size / row quota | **Not published.** | — |
| SQL functions | The database runs with a function whitelist: `sqlite_version()` fails with "not authorized to use function". `count`, `RETURNING`, upserts and subqueries work (checked on the real database). | ✱ measured |
| Media storage | None of its own. Files live on Telegram's servers and the bot keeps `file_id`s, which is what this plan does anyway. | Official |
| Bot API uploads | 50 MB per file, 10 MB per photo. | Official |
| Bot API downloads (`getFile`) | **20 MB.** | Official |
| Outbound `fetch` response | **30 MB** total, streaming included. | Official |
| Mini App hosting | Static files at `https://app<id>.tgcloud.ai/` plus `endpoints/`. No size limits published. | Official |
| Pricing | No price or quota is published for the platform. | Official |
| Tokens | Deployed code never sees the bot token: `api` is already authenticated. The CLI uses a separate **CLI access token** (`app<id>:<secret>`, from BotFather → Serverless → CLI Access). | Official |

### Inline mode (Bot API)

| Rule | Value |
|---|---|
| Results per `answerInlineQuery` | **max 50** |
| `next_offset` | **≤ 64 bytes**. Send `""` when there are no more results. |
| Query text | ≤ 256 characters. A new update arrives on every keystroke. |
| Result `id` | 1–64 bytes, unique within one answer |
| `cache_time` | Default 300 s. Telegram caches answers on the server. |
| `is_personal` | Caches the answer for that user only |
| "Switch to PM" | The old `switch_pm_text` / `switch_pm_parameter` were **replaced by `button`** (`InlineQueryResultsButton`). Its `start_parameter` is 1–64 characters of `A-Z a-z 0-9 _ -`. |
| Cached result types | `photo`, `gif` / `mpeg4_gif`, `video`, `sticker`, `voice`. **`title` is required for video and voice.** Stickers take no caption. |
| Usage feedback (`chosen_inline_result`) | Arrives only after you enable **`/setinlinefeedback`** in BotFather. Set it to 100%: lower sampling makes usage counts wrong. |
| Answer deadline | Must be fast. The Bot API page gives no number; a late answer fails with "query is too old". |
| Inline mode itself | Turned on in BotFather with **`/setinline`** (the placeholder text). The Bot API can't turn it on. |

## 2. What in the plan won't work as written, and what to do instead

| # | Plan item | Problem | What I'll do |
|---|---|---|---|
| 1 | Bot token env var | Deployed code has no env vars and needs no bot token. Only the CLI needs a token, and it is the **CLI access token**, not the BotFather bot token. | `Meme_BOT_TGCLOUD_TOKEN` (the owner chose this name over the originally planned `MemeBot_BOT_TGCLOUD_TOKEN`; it points to app8856706875) holds the CLI access token. `memebot/scripts/tg.mjs` hands it to the CLI as `TGCLOUD_TOKEN` for that one process. It is never written to disk, and `memebot/.tgcloud/` keeps the CLI away from your other bots. |
| 2 | Backup channel id (and later the meme-of-the-day channel) in env vars | Deployed code can't read env vars. | At deploy time, `scripts/gen-env.mjs` reads `MEMEBOT_BACKUP_CHANNEL_ID` (env or `memebot/.env`) and writes it into `tgcloud/lib/env.js`. A channel id isn't secret, so it can sit in code. Phase 2 can add an override from the admin panel. |
| 3 | "Meme of the day auto-posted" (Phase 4), weekly leaderboard posts | **No scheduler.** | **Built:** the first message, button press or sent meme after 12:00 Tehran posts it. Inline queries aren't used, because they must answer fast. Tries are claimed atomically (at most one every 30 minutes) and the day is recorded, so it posts once. With no traffic at all it posts late. The leaderboard is viewed on demand (`/top`) and needs no scheduler. |
| 4 | Broadcast to all users (Phase 2) | No background jobs, ≈ 3 s CPU per update, Telegram's ~30 msg/s limit. | A resumable queue in the DB, moved forward in batches by the admin's "next batch" button and on the side of other updates (as in your to-do bot / Aegis). It won't run unattended. |
| 5 | Forced join checked in inline mode (Phase 2) | `getChatMember` on every keystroke would be slow and rate-limited. The bot must be an **admin** of each channel. | Membership is cached in the DB for a few minutes. Non-members get `button: {text, start_parameter}` (the modern "switch_pm"). |
| 6 | "Memes survive if file_ids break" | A `file_id` stays valid for *this* bot. It mainly "breaks" if you move to a different bot. A bot also can't read channel history. | Keep the backup channel's `message_id` for every meme. A new bot made admin of the channel can `forwardMessage` by that id and gets a fresh `file_id`. The bot must be an admin with "Post messages". Forwards show the uploader's name, which is fine in a private channel. |
| 7 | Ranking by usage count | Usage arrives only through `chosen_inline_result`, which needs `/setinlinefeedback`. | Turn it on (100%). One user re-sending the same meme counts at most once an hour. |
| 8 | Duplicate detection by `file_unique_id` | Catches the same file, including forwards. A **re-encoded** copy (screenshot, re-saved, compressed again) gets a new id. | As planned. Near-duplicate detection would need image hashing, which is too heavy for the 3 s CPU budget. |
| 9 | Stats "searches" and "searches with no results" (Phase 5) | Inline queries come **per keystroke** ("س", "سل", "سلا", …), so raw counts are inflated. | Count a search only when the user stops refining it (the next query from that user isn't an extension of it), and keep daily totals, not a raw log, so the DB stays small (its quota isn't published). |
| 10 | AI keyword suggestions, NSFW flag, OCR (Phase 6, Gemini free tier) | Possible, with real caveats: **(a)** the Gemini API isn't offered in Iran (not on Google's country list), so the API key must be created from a supported country (Telegram's servers make the calls, so the bot side is fine); **(b)** on the free tier **Google uses your inputs to improve its products**, and uploaded memes would be sent to Google; **(c)** free-tier per-minute/per-day caps; **(d)** no env vars, so the API key can't be an env var, and putting it in a module exposes it in BotFather → Library. | One Gemini call per upload, on a small thumbnail (≤ 640 px; video, GIF and sticker thumbnails too), returning keywords, OCR text and a safety flag together. The key goes into the DB through an owner-only command (the bot deletes the message holding it). When the quota runs out, uploads still work without AI. Nothing AI ever runs in inline mode. Voice: no image, so no AI. Local OCR (Tesseract and the like) is not possible: no npm/wasm loading, 3 s CPU. |
| 11 | "Report" / "like" / "favourite" buttons on memes sent through inline mode | A button under every sent meme clutters other people's chats, and anyone in that chat can press it. | **Phases 2–3 (built):** reports and favourites work by sending or forwarding the meme to the bot, which recognises it by `file_unique_id` and offers ⭐ and 🚩. Likes (Phase 4) can be an optional 👍 button. |
| 14 | "Backup channel" given as the public channel @WangerChaos | Forwarding every upload to a **public** channel would publish private-collection memes (users are told only they can see them) and memes still waiting for approval, and every forward shows the uploader's name. | **Built:** `public` mode (default): only approved memes, posted as clean copies (keywords + bot, 👍), deleted again when removed. The channel message ids are still stored for recovery. `MEMEBOT_BACKUP_MODE=all` restores "forward everything" for a private channel. |
| 13 | Private collection with "no approval" | `file_unique_id` is UNIQUE (Phase 1), so a private copy would block anyone else's public upload of the same file, and making it non-unique needs a table rebuild (migrations here are additive only). | **Phase 3 (built):** a private meme stores `p<uploader>:<file_unique_id>` in that column. Dedupe checks both keys, and publishing switches the key back (refused if the file is public already: you get that one as a favourite). |
| 12 | Phase 1 had no moderation | Every upload was public at once. | **Phase 2 (built):** new memes are `pending` until approved; trusted users and admins skip the queue. |

Everything else in the plan (file_id-only storage, the five types, `InlineQueryResultCached*`,
pagination, `is_personal`, Persian normalisation, daily limits, anti-spam, ban lists, trust levels,
favourites, private collections, categories, likes, profiles, stats) fits the platform and the
free-only rule.

## 3. Design consequences used in the code

- **Search** is a word table (`meme_words`) searched by index range (prefix match). It doesn't
  depend on SQLite FTS5, which the platform doesn't document. A one-letter word matches exactly, so
  a one-letter query can't scan the whole table.
- **Inline answers** take 1 indexed query for a keyword search (2 when nothing is found), at most 4 small ones for the empty-query page, and one Bot API call. Nothing slow runs on that path (`npm test` checks these numbers).
- **Time**: Tehran is fixed at UTC+3:30 (Iran dropped DST in 2022). Daily limits reset at 00:00 Tehran time.
- **No literal invisible characters in the source**: ZWNJ and the other invisible characters are
  written as escapes (`\u200C`). Only `/* */` comments are used, so a module pasted into BotFather
  still works even if its line breaks are lost.
