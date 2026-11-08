# Progress

**Current state: Phase C4 done and DEPLOYED (2026-11-08, cloud revision 4). Bot tests 236/236, worker
tests 149/149 (also inside the Docker image). Worker tools stay hidden until the owner hosts the worker
and stores WORKER_URL + WORKER_SECRET (docs/HOSTING.md). Owner's standing instruction: continue through
C8, deploy each phase, full report per phase (docs/reports/). Next: C5 (Tesseract OCR + advanced PDF).**

**Update 2026-11-08 (after the C4 report):** the owner's Gemini key is stored (tested against Google
first; never in code/git/logs) and a real OCR ran on Serverless with an exact result — «📝 استخراج متن»
is live. The bot is admin in all three forced-join channels (re-checked: all `ok`). The owner asked me
to write the ecosystem document: `docs/WANGER_ECOSYSTEM.md` at the repository root (local rules now,
Hub / Mother Bot / wanger-client contract for later).

## Phase C4 — Worker foundation, image tools, text → image ✅ deployed (revision 4)

Done (details in docs/reports/C4.md, choices in DECISIONS.md):
- `worker/`: FastAPI API with HMAC + nonce signing, SQLite queue (light/heavy, per-user caps,
  idempotent), sandboxed child per operation (process group, rlimits, minimal env), Bot API client
  that can't touch the webhook, plugin processors with a start-up self-test → `/v1/capabilities`.
- 13 image operations (Pillow 13, decoders restricted to the detected type) and text → image with
  correct Persian shaping (RAQM; Vazirmatn, Sahel, Samim; 4 sizes, 8 themes, auto-fit, RTL wrap).
- Docker (multi-stage, non-root, read-only, healthcheck), compose with Caddy for HTTPS, CI job
  (ruff, pytest, pip-audit, image build + smoke test), docs/HOSTING.md.
- Bot: `lib/worker.js`, `lib/wflow.js`, `lib/wtools.js`; «🖼 ابزار عکس» on image cards and in the menu,
  «✍️ متن به عکس», status message with «🚫 لغو», /cancel and /status for worker jobs, «⚙️ کار دیگری
  با نتیجه» on results, /panel → 🧩 Worker; everything hidden until the worker answers.
- Measured on Serverless: only ports 80/443 reachable; dead hosts cost 1.6–3.2 s; the bot's signing
  verified end to end against the Python verifier.

## Phase C3 — OCR with Gemini ✅ deployed (revision 3)

Done (details in docs/reports/C3.md): «📝 استخراج متن» on JPEG/PNG/WEBP/HEIC cards and PDFs ≤ 5 pages
when a key exists; one-time consent worded after Google's current terms (free/paid); strict prompt;
results in the message (copy button ≤ 256 chars) or a UTF-8 .txt; DOCX (RTL) from either; budgets
(bot per Pacific day / per minute, per user per day), Google's 429 pauses until midnight Pacific;
/panel → 🤖 Gemini (key status, model, usage, paid switch, resume); privacy text updated. Found and
fixed on Serverless: big base64 strings run out of JS heap → the request body is built as bytes.

## Phase C2 — Archives, PDF page tools, batches ✅ deployed (revision 2)

Done (details in docs/reports/C2.md, choices in DECISIONS.md):
- Vendored fflate + @cantoo/pdf-lib (`lib/vendor/`); pure modules `archive.js`, `pdf.js`, `images.js`,
  `ops.js` (operation registry), `errors.js`; screens in `cards.js`; batches in `batch.js`.
- Archives: ZIP / TAR / TAR.GZ / GZ indexed and checked at intake (entries, unpacked size, ratio,
  paths, links, devices, encryption, methods), extraction with bounded inflation and CRC checks;
  ≤ 10 files sent, more → paginated list or store-only ZIP parts ≤ 50 MB; ZIP of one file or a batch.
- PDF: page count at intake; extract / remove / reorder / rotate (all or typed pages) / split (every
  N or typed ranges; > 5 parts → one ZIP); JPG/PNG → PDF with EXIF orientation; batch → one PDF.
- Batches: albums and files sent while a batch is open → one status message, «✅ تمام شد، ادامه»,
  batch menu (ZIP, one PDF, rename incl. numbering, fix extensions, list); forced-join resume of
  whole albums; one notice per album.
- Generic job runner (multiple inputs/outputs, document albums, ZIP bundling, lazy inspection of
  result files, staff retry of any job).
- Platform: JSON append and document albums verified on Serverless; migration 5 additive steps.

## Phase C1 — Foundation ✅ deployed (revision 1)

Done:
- **Handlers** `message`, `callback_query`, `my_chat_member` (thin) → `lib/router.js`: error boundary,
  update de-duplication, double-tap guard, the order of checks, the `callback_data` table (≤ 64 bytes).
- **Gate** (`lib/gate.js`, local provider until the Wanger Hub exists): forced join to @HIDE_i_SEEK,
  @Nepenthw_ir, @wangerBots (seeded once, race-safe), «✅ عضو شدم» re-check, **resume** of what the user
  was doing (the file they sent / the command); fail-open + one throttled owner alert for channels the
  bot can't check; bans (owner immune, one notice a day) and maintenance (staff exempt).
- **Menus and i18n**: fa (default) and en with identical keys; two-column main menu; Back / Cancel
  everywhere; navigation edits the same message; Persian digits (and «٫») and Jalali dates for fa.
- **Settings**: language, Persian digits. **Commands**: /start /help /settings /language /status
  /cancel /history /privacy /deletemydata; staff: /panel; owner: /secret.
- **File intake**: document, photo (largest size + "send as file" tip), audio, voice, video, video
  note, animation (GIF tip); size check before any download (20 MB); intake rate limit.
- **Detection** (`lib/detect/`): magic bytes for ~70 types, ZIP central directory (DOCX/XLSX/PPTX,
  ODF, EPUB, APK, JAR, macro documents), MP4 vs M4A by track handlers, WebM vs MKV, Ogg codecs, OLE
  streams (DOC/XLS/PPT/MSI, macros), text sniffing (HTML/XML/SVG/JSON/SRT/VTT/scripts), polyglots.
- **File card** «🖼 تصویر دریافت شد — JPEG، 2.4 MB» + «چه کاری انجام بدهم؟»; mismatch question
  [✅ بله] [❌ نه]; executables / scripts / macro documents / polyglots: reported only.
- **Detect & Fix** and **safe rename** (new name, prefix, suffix, Persian tidy-up, extension only
  among the detected type's own): a re-upload of the same bytes as a document; sanitizer with RTLO
  removal and Telegram's measured limits (64 + 16 characters, no emoji).
- **Jobs**: ULID + `WC-XXXXXX` code, DOWNLOADING → UPLOADING → COMPLETED/FAILED (EXPIRED for dead
  invocations), friendly errors with the code, output validated (size), result cache 24 h, a status
  message for inputs ≥ 8 MB, «🔁 کار دیگری با همین فایل» on every result.
- **Rate limits** (atomic upserts): 3 jobs/min, 10 jobs/hour, 10 files/min; owner and admins unlimited.
- **/panel**: users / files / jobs today from running counters, active and failed jobs (+ retry that
  sends the result to the user), worker and Gemini status, limits; channels (status, add with
  validation, remove, switch, re-check), bans, maintenance, admins, broadcast (resumable batches),
  keys (names only). Every button re-checks the permission.
- **Housekeeping** (~1 % of updates + every /panel): old jobs, files, cache, pending, rate rows,
  processed updates, errors.
- **Tests: 165 passing** (`npm test`): detection of every format (incl. truncated, empty, polyglot,
  exe-as-jpg, RTLO), sanitizer and renames, i18n completeness and HTML validity, every
  `callback_data` ≤ 64 bytes, gate classification, end-to-end flows (start, gate + resume, fail-open,
  intake of every media kind, fix, rename, cache, rate limits, errors, history/status ownership,
  settings, cancel, deletemydata), panel permissions and every panel action, broadcast (429 resume,
  nobody twice), secrets never shown, duplicates and double taps, groups ignored, housekeeping;
  guards: module rules (imports, missing globals, size, count, pure modules, SQL only in lib/db,
  Bot API only in lib/tg, no secrets, invisible characters escaped) and query plans (no full scan of
  a growing table).
- **Platform checks (read-only)**: `migrate --local --dry-run` → 15 new tables, all additive,
  nothing applied; `tgcloud run` of all three handlers with no-op payloads → all 31 modules load on
  Serverless.
- CI: a `wanger_converter` job in `.github/workflows/ci.yml` (npm ci + npm test).

Not in C1 (by plan): batches, ZIP/PDF tools (→ C2, done); OCR (C3); the worker (C4+). `/connect` waits for the hub.

## What I need from the owner

Deployed under the owner's standing approval: `migrate --local --safe` → 15 tables + 12 indexes
(verified in sqlite_master) → `push` (31 modules) → webhook in sync (message, callback_query,
my_chat_member); the 9 waiting updates were handled: 1 user, 1 file card, 0 errors; the three
channels seeded with their real chat ids, status `not_admin`.

1. **Make `@Wanger_Converterbot` an admin** in @HIDE_i_SEEK and @wangerBots (done for @Nepenthw_ir) —
   until then forced join is skipped for those two (fail-open) and you get an alert every 3 h.
2. **`docs/WANGER_ECOSYSTEM.md`** — still missing; the local gate stays until the hub exists.
3. Bot token (optional, for the outside-send test after the push): as the environment secret
   `Converter_BOT_TOKEN`, never in chat or git.

## Phase C0 — Recon & feasibility ✅ (2026-11-07)

Scaffold, CLI wrapper, spec saved, platform spikes → `docs/LIMITS.md` (CPU ≈ 3 s cumulative, wall
≈ 30 s, memory ≈ 7.9 GB, module ≤ 1 MiB, fflate + @cantoo/pdf-lib fit, 19 MB round trip 3 s,
WebAssembly sync only, Telegram name limits); matrix updated; nothing moved to the worker.

## Remaining phases

C4 Worker + images + text → image ·
C5 Tesseract + advanced PDF · C6 Documents · C7 Audio/video + 7Z · C8 Hardening.
