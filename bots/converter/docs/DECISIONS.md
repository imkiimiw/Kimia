# Decisions

One line each: the choice — the reason. Newest phase last.

## Phase C0 (2026-11-07)

- The bot lives in `bots/converter/` as its own tgcloud project (`@Wanger_Converterbot`, app9216103899) — the spec names this path; the repository root and the other folders are other bots.
- The CLI runs only through `npm run tg -- …` (`scripts/tg.mjs`) with `Converter_BOT_TGCLOUD_TOKEN` (trimmed; a generic `TGCLOUD_TOKEN` is ignored) — a stray token must never reach another bot (same pattern as Wanger Media / Wanger Music).
- The owner's spec is saved verbatim as `docs/SPEC.md`, with a header pointing to the C0 corrections — later sessions need it and chat history doesn't carry over.
- Probes live in `spikes/` and are copied into `tgcloud/` only for one `tgcloud run` by `scripts/spike.mjs`, which always deletes them — the CLI uploads every file under `tgcloud/`; nothing was pushed in C0 (cloud still at revision 0).
- Probes touch the database only with `SELECT 1` — `tgcloud run` uses the bot's real database, which has no tables yet.
- Time is measured as work → tiny DB query → `Date.now()` — the clock is frozen during synchronous work on this platform (measured).
- PDF library: **@cantoo/pdf-lib 2.11.1** (MIT; maintained fork, last release 2026-09; ships a single self-contained ESM bundle of 614 KB, under the 1 MiB module limit) — pdf-lib 1.17.1 is unmaintained since 2021; @pdfme/pdf-lib ships no single-file bundle.
- ZIP library: **fflate 0.8.3** (MIT, 91 KB, one ESM file), sync APIs only — the async ones need Workers / `setTimeout`, which don't exist here.
- CRC-32 is our own table code — fflate exports none and TAR/PNG/checksums need it.
- pdf-lib always runs with `parseSpeed: Infinity` (load) and `objectsPerTick: Infinity, useObjectStreams: false` (save) — without them it calls the missing `setTimeout` or runs out of CPU (measured).
- In-bot PDF work is guarded by the object count (trailer `/Size`), not the file size — parse cost is ≈ 5.7 µs per object; a 22.5 MB JPEG-only PDF costs milliseconds while 127k objects cost 0.7 s.
- In-bot jobs plan for ≤ 2 s CPU and ≤ 20 s wall, enforced by pre-checks (bytes, entries, objects, pixels) — the platform stops at ≈ 3 s CPU / 30 s wall and CPU can't be timed from inside.
- Detection downloads the whole file (≤ 20 MB) — a head-only read of a cold file was no faster (first-access latency dominates).
- Batches download at most 4 files in parallel — parallel `getFileContent` works and halves the wait (measured); 4 keeps memory and Telegram load modest.
- The 19 MB round trip and filename tests used the owner's private chat, silently (`disable_notification`), and deleted every test message — the spec requires the round trip and it's the only chat this bot can reach.
- The rename limit will follow Telegram (base ≤ 64 characters, extension ≤ 16, emoji removed) instead of the spec's 120 — Telegram truncates silently (measured); listed for the owner in LIMITS.md §5 #2.
- No secret store exists on the platform, so bot secrets go into a `secrets` table as the spec says — official docs list none.
- Image tools stay in the worker for now; in-bot WASM codecs are recorded as a candidate, not promised — sync WebAssembly works, but no real codec was tested (spec: nothing is offered before it's tested).
- The bot token was not requested in C0 — it's a credential; the outside-send test is more meaningful after the first push sets the webhook, and the script for it is ready.

## Phase C1 (2026-11-07)

- The gate is a **local provider** (`lib/gate.js`) behind one `check()` until the Wanger Hub exists — no hub, Mother Bot or `wanger-client` exists; the owner asked to keep forced join in mind and said "start" after the C0 proposal.
- Forced-join rules follow the other Wanger bots: the three seed channels once, "member not found" = not a member, a positive result trusted 5 min — one ecosystem, one behaviour.
- A channel that can't be checked (bot not admin, chat gone, network) is **skipped (fail-open)**, the owner is alerted ≤ every 3 h, the pass is not cached, and a known-bad channel isn't asked again for 10 min — spec: "hub down → fail open"; today the bot is admin in none of the three, and locking everyone out would be worse.
- Until a Mother Bot exists, `/panel` also holds bans, maintenance, admins (`staff` table), forced-join channels and a minimal broadcast — C0 proposal #2; the spec puts these in the Mother Bot, which doesn't exist.
- Owner-only: maintenance, keys, admins, broadcast, channel changes; admins get the overview, failed/active jobs with retry, bans and the channel list (read-only) — the spec gives `/panel` to admins; ecosystem switches stay with the owner.
- `/secret` is owner-only (the spec says owner/admins) — the keys are the owner's credentials; `/connect` isn't built — there is no hub to connect to.
- Persian-first: the default language is fa whatever Telegram's language; the first `/start` offers «🌐 English» — spec §4 "Persian-first".
- Settings in C1: language and Persian digits. "Default output" and "OCR engine" stay hidden (columns exist) until a tool uses them — no settings that do nothing.
- Main menu: «🗂 ابزار فایل» (not in the spec's list) holds Detect & Fix and rename, and «📜 تاریخچه» opens /history; conversion categories stay hidden until they have an operation — renaming is not a conversion (spec §1.5), so it can't sit under «📁 تبدیل فایل».
- Album batching, batch rename and numbering move to C2 with "batches" (the spec's C2) — in C1 every file of an album gets its own card (limited by RATE_INTAKE_PER_MIN).
- RATE_INTAKE_PER_MIN = 10 added next to the spec's job limits — every received file is downloaded for detection.
- Rate limits use fixed clock windows (minute, hour) and one conditional upsert each — atomic without transactions; a refused hour slot gives the minute slot back.
- Detection downloads the whole file (≤ 20 MB) and keeps its result compactly in `files.type` (`id`, `!zip` polyglot, `#enc`) — a card can be re-rendered without the bytes.
- Executables, scripts (incl. text files named `.js/.sh/.bat/…`), macro documents and polyglots get no actions at all — spec §6: report only, never help disguise a file.
- A ZIP hidden behind another type (polyglot) counts as dangerous — the classic disguise; the ZIP reader finds directories shifted by prepended data.
- Without an extension, Telegram still treats the text after the last dot as one and cuts it to 16 characters, so the sanitizer turns such dots into `_` — measured behaviour; names arrive exactly as shown.
- A status message only for inputs ≥ 8 MB, a chat action otherwise — spec: none under ~2 s; 19 MB took 3 s in C0.
- Result cache: key = user + input file_unique_id + operation + output-name hash, 24 h, deleted with the user's data — a rename re-sent by file_id costs no download.
- Jobs keep the input file_id and the output name (params) so staff can retry; names leave with the job (30 days or /deletemydata) — spec §10 allows names "if needed".
- No timers: in-bot jobs are bounded by input size, and a job still "running" 120 s later is shown and stored as EXPIRED (`INTERRUPTED`).
- Statistics come from running counters per Tehran day (`counters`); "users" counts first starts — no full-table counts (50 000-rows-read limit).
- Housekeeping runs when update_id % 100 = 0 (~1 %) and whenever /panel opens — spec §10; bounded deletes (LIMIT 500/1000).
- Every update writes its update_id first (de-duplication); a double tap = same message + same data within 1.5 s — Telegram may redeliver; one conditional UPDATE decides.
- Errors: boundary → `errors` table (sanitized) + owner alert ≤ every 30 min per source + a friendly line — there is no production log viewer.
- Broadcast: copyMessage in batches of 25 behind a 25-s lease, a 429 stops the batch at the last delivered user, the sender is skipped, blocked users are marked — the to-do bot's tested design.
- Limits can be overridden through the `limits` setting (JSON, numbers only); no UI yet — the spec puts it in the Mother Bot.
- Groups and channels are ignored without any database write — the bot is for private chats (privacy mode is on).
- Owner alerts are always Persian — the owner's language.
- Tests: node:test + the SDK emulator adapted from wanger-music (no dependencies); the test clock starts at a fixed instant — clock windows made a test flaky once.
- Raw SQL with the `sql` tag only, all of it in `lib/db/` (guard test) — one place to audit indexes; a query-plan test fails on any full scan of a growing table.

## Phase C2 (2026-11-08)

- fflate 0.8.3 and @cantoo/pdf-lib 2.11.1 are vendored unmodified in `tgcloud/lib/vendor/` with their MIT text as a header comment — only `.js` files are deployed, and the license must travel with the copy.
- Archive safety follows spec §7.7 with one refinement: the ratio rule applies to entries ≥ 1 MB — small, very compressible files (100 KB of zeros) are not bombs; a lying size header can't inflate past it either (streaming inflate in 16-KB steps, abort on the declared size).
- ZIP entries are CRC-checked after extraction; TAR headers are checksum-checked; GZIP members are CRC-checked — a damaged archive is reported, never half-sent.
- `.tar.gz` / `.tgz` open the TAR; a plain `.gz` gives its one file (name from the gzip header) — the common cases; bz2/xz/zstd/7z/rar say plainly they can't be opened in the bot.
- Archives are indexed and checked at intake (meta: count, size, names) — the card shows "۱۲ فایل، ۳۴ MB" or the refusal before the user taps anything.
- > 10 files: a paginated list (8 per page, one file per tap, re-extracted from the archive) or "all as store-only ZIP parts ≤ 50 MB" — spec §7.7; storing (not deflating) keeps CPU inside the 3-s budget.
- Every PDF is parsed at intake when its trailer says ≤ PDF_MAX_OBJECTS (200 000) objects — page count on the card, encrypted/damaged reported up front; page ranges are validated against it before a job starts.
- Reorder = the typed order first, then every page not mentioned in its original order — "3,1,2" on a 10-page file shouldn't drop pages 4–10.
- Split offers every 1/2/5/10 pages (only options giving 2..100 parts) or typed ranges; > 5 parts arrive as one store-only ZIP — spec §7.3's "≤ 5 separate, more as one ZIP".
- JPG/PNG → PDF: one A4 page per image (portrait or landscape by its shape), fitted and centered; JPEG EXIF orientation (all 8 values) applied with a transformation matrix, the JPEG bytes embedded untouched; PNG ≤ 12 MP per job (≈ 1.5 s measured).
- Batches: one open batch per user (partial unique index); an album opens it, any file sent while it's open (10 quiet minutes) joins it, «📚 چند فایل با هم» on a card starts one; slots are reserved atomically; one status message (the first to claim it wins, a racing duplicate is deleted).
- Batch actions: ZIP, one PDF (PDFs + JPG/PNG in order), rename (prefix / suffix / numbering / tidy-up) and fix extensions; dangerous and empty files are always left out; total ≤ BATCH_TOTAL_MB (50) — one invocation must download, process and upload within ~30 s.
- Batch renames arrive as document albums (sendMediaGroup, chunks of 2–10; verified on Serverless) with the status message turned into the summary.
- RATE_INTAKE_PER_MIN raised from 10 to 20 = BATCH_MAX_FILES — two albums of ten must fit.
- Album items get one notice per album (maintenance, rate, "batch full") via a once-claim — ten files mustn't produce ten replies.
- Forced join with an album: every file is queued with one atomic JSON append (`json_insert … '$.files[#]'`, verified on Serverless) and the join screen is shown once; after «✅ عضو شدم» the album is resumed as one batch.
- Results and files from before C2 are inspected lazily when their card is opened (one download, meta stored) — PDFs extracted from an archive get PDF tools too, without parsing every output during the job.
- A job is generic now (`runJob`: inputs, params, outputs) with the operations as pure functions in `lib/ops.js`; staff retry rebuilds any job from its stored inputs and params.
- Loading pdf-lib with every update costs ≈ 27 ms (a no-op went from 8 to 35 ms, measured) — accepted; dynamic `import()` doesn't exist here.

## Phase C3 (2026-11-08)

- Model: `gemini-3.6-flash` by default (Google's model page, 2026-11-08: stable; `gemini-2.5-flash` is deprecated and rerouted on 2026-12-01); the owner can switch in /panel → 🤖 Gemini among the stable `gemini-3.5-flash-lite` and the alias `gemini-flash-latest` — model names change; a 404 reports GEMINI_MODEL.
- The key goes only in the `x-goog-api-key` header to generativelanguage.googleapis.com — never in a URL, a log, a trace or an error row; it is read from `secrets` at call time.
- Consent wording follows Google's Gemini API terms (effective 2026-03-23): free tier → content may be used to improve Google's products and read by human reviewers, don't send personal/confidential data; paid tier → not used for improvement, logged briefly for abuse detection. The owner states which tier the key is on (panel switch) — the bot can't see billing.
- A consent given under the free-tier wording covers both tiers; one given under the paid wording only the paid tier (stored as +/− timestamp) — switching back to free asks again.
- EEA/UK/Switzerland: Google allows only paid services for apps serving users there; the bot can't locate users, so the panel says so and the decision stays with the owner (report).
- Budgets (free-tier numbers aren't on Google's docs page any more): bot-wide GEMINI_DAILY_BUDGET 200 per Pacific day (Google resets at midnight Pacific) and GEMINI_RPM 8, per user GEMINI_USER_DAILY 20 (staff exempt); a 429 from Google pauses OCR until midnight Pacific (owner can resume) — never surprise the owner with errors or bills.
- OCR inputs: JPEG, PNG, WEBP, HEIC (what Gemini reads) and PDFs ≤ GEMINI_PDF_MAX_PAGES (5) — a PDF must finish inside the ~30 s wall clock; ≤ GEMINI_MAX_MB (14) per file — the inline request limit is 20 MB after base64.
- Strict prompt (only the text, keep paragraphs and line breaks, no translation/summary, `[NO_TEXT]` when empty), temperature 0, code fences stripped — spec §7.1.
- Results: ≤ 3500 characters in the message (the status message turns into it) with «📋 کپی متن» (Bot API copy_text) when ≤ 256 characters; longer → UTF-8 .txt with a BOM; «📄 DOCX» rebuilds a right-to-left DOCX from the message text or the .txt — the bot never stores OCR text.
- Script shown as Persian/Arabic, Latin or mixed — Persian and Arabic can't be told apart from the characters alone (spec §7.1); no confidence figure (Gemini gives none) — no invented numbers.
- The request body is built as bytes (base64 into a Uint8Array) — on Serverless the old string encoder died with "Memory limit exceeded" at 14 MB (millions of small string concatenations); the byte body takes 21 ms and uploads 19.5 MB in 0.7 s (measured).
- `gemini.js` is pure (request/response); the only network code is `jobs.js#geminiOcr` — the operations stay testable without a network.
- `fetch` in the test emulator takes an installable handler; tests never reach Google.
