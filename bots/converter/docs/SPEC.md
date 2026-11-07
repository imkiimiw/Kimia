# Wanger Converter Bot — the owner's spec (saved verbatim)

> Saved on 2026-11-07 (Phase C0) so every session can read it; chat history doesn't carry over.
> The owner's note sent with it (Persian): «جوین اجباری هاشو اینا رو هم حواست باشه» — "keep its forced
> joins and those things in mind too".
> **After C0 the feature matrix in §5 is superseded by `docs/LIMITS.md` §4** (measured on the platform),
> and the spec conflicts found in C0 are listed in `docs/LIMITS.md` §5. Everything else below is unchanged.

---

# Wanger Converter Bot — Spec v2

> For Claude Code · First child bot of the Wanger ecosystem · Owner: Kimi (Telegram ID `5557901897`)
> Read `docs/WANGER_ECOSYSTEM.md` first. Forced join, broadcast, bans, maintenance, stats and the working rules (phase by phase, stop after each phase and wait for my command) all come from there.

## 0. Product

A Persian-first Telegram bot that converts and processes files. Users send a file (or text) and get the result back in the chat. It must be dead simple for non-technical users and **honest**: an operation appears in a menu only if it is implemented, tested, and its engine is available right now.

## 1. Key decisions (and why)

1. **The bot runs on Telegram Serverless (JavaScript).** It owns everything users see: menus, file intake, type detection, the ecosystem gate, job tracking, and light processing in pure JS.
2. **Heavy processing runs in an optional Python worker.** LibreOffice, FFmpeg, Tesseract, Pillow and PDF rendering need native binaries, which Serverless can't run. The bot works without the worker; worker-only operations stay hidden until a worker is connected and reports them.
3. **Telegram's Bot API limits are hard limits:** input ≤ 20 MB (bot download limit), output ≤ 50 MB (10 MB for photos). The old 50 MB input default was impossible.
4. **Admin is split.** Ecosystem-wide admin (broadcast, bans, forced join, maintenance, global stats) lives in the Mother Bot. This bot's `/panel` covers only converter-specific things.
5. **No fake conversions.** Renaming an extension is never presented as a format conversion, and every output is validated before it is sent.

## 2. Architecture

```
User ⇄ Converter bot (Telegram Serverless, JS)
        ├─ gate → Wanger Hub /v1/gate            forced join · ban · maintenance
        ├─ light jobs in-bot (pure JS, ≤ 20 MB)  detect · rename · zip · PDF pages
        ├─ AI OCR → Gemini API                   optional, with user consent
        └─ heavy jobs → Converter Worker (Python, optional)
                        downloads input from Telegram · processes · sends the result
                        · edits the status message · reports events to the hub
```

Worker job flow:
1. The user picks an operation. The bot creates a job row with a display code (`WC-` + 6 Crockford base32 chars; the internal id is a ULID) and sends one status message.
2. The bot POSTs the job to the worker: `POST /v1/jobs`, signed with HMAC-SHA256 (shared secret, timestamp within ±300 s, idempotency key = job id). Body: job id, chat id, user id, status message id, file_id(s), operation, params, language.
3. The worker queues it (`light` and `heavy` queues), downloads the input from Telegram with the bot token, processes it in a sandboxed temp dir, validates the output, sends it with `sendDocument`, edits the status message, reports the event to the hub, and deletes the temp files.
4. `/status`, `/cancel` and `/history` ask the worker (`GET` / `DELETE /v1/jobs/{id}`, signed) and update the bot's job row lazily, including the output `file_id` for the result cache. Job ownership is always checked: a user can never see or cancel someone else's job.
5. Buttons on the result message (e.g. «🔁 کار دیگری با همین فایل») arrive at the bot as normal callbacks.

The worker uses the bot token only to download files and send/edit messages. It must never call `setWebhook`, `deleteWebhook` or `getUpdates`. Phase C0 confirms that sending from outside works while Serverless manages the webhook.

Bot secrets (`HUB_KEY`, `WORKER_URL`, `WORKER_SECRET`, `GEMINI_API_KEY`) are set by the owner in the bot's PM (`/connect`, `/secret set NAME value`), stored in a `secrets` table, and the owner's message is deleted, unless `docs/tgcloud-sdk.md` documents a platform secret store, which is preferred. Worker secrets (`BOT_TOKEN`, `WORKER_SECRET`, `HUB_KEY`) come from its environment. Secrets never go into code, git or logs.

## 3. Telegram constraints to design around

- **Sizes:** `MAX_INPUT_MB` = 20. If an output would exceed 50 MB, offer a smaller variant (stronger compression, lower resolution, or splitting); never fail silently. Bigger files would need a self-hosted Local Bot API Server: out of scope for v2, but keep the Telegram file gateway swappable.
- **Photos are recompressed** when sent as "photo". Accept them, with a tip: «برای کیفیت اصلی، تصویر را به‌صورت فایل بفرستید». Results are sent as documents unless the user picks "send as photo".
- **GIFs sent normally arrive as MP4 animations.** For GIF tools, ask users to send the GIF as a file; otherwise treat animations as short videos.
- **Albums** arrive as separate updates that share a `media_group_id`. Collect them into one batch; a single status message updates («📥 ۳ فایل دریافت شد») with a «✅ تمام شد، ادامه» button, because Serverless has no timers to debounce with.
- **`callback_data` ≤ 64 bytes:** use compact codes (e.g. `o:img.rs:K3P9`) and keep wizard state in the DB. A test checks every button.
- **Text ≤ 4096 chars, captions ≤ 1024, Copy Text button ≤ 256 chars.** Use `parse_mode` HTML and escape all user-provided text (filenames included).
- **Serverless execution limits are unpublished.** Measure them in C0 and move any "light" operation that doesn't fit comfortably to the worker.

## 4. UX (Persian-first)

- `/start`: a short welcome and a two-column main menu: 📁 تبدیل فایل · 🖼 ابزار تصویر · 📝 استخراج متن · 🎨 متن به تصویر · 📄 ابزار PDF · 📚 اسناد · 🎵 صوت · 🎬 ویدیو · 📦 فشرده‌سازی · ⚙️ تنظیمات · ❓ راهنما · 🌐 ربات‌های دیگر Wanger. Hide any category with no available operation.
- The main path is **send a file, get suggestions**: «🖼 تصویر دریافت شد — <code>JPEG</code>، <code>2.4 MB</code>» then «چه کاری انجام بدهم؟» with at most 6 relevant buttons plus «بیشتر ▸».
- Navigation edits the same message. Every screen has «🔙 بازگشت» and «❌ لغو».
- Progress: one status message, edited at most every ~3 s (⏳ در صف · 📥 دریافت · ⚙️ پردازش · 📤 ارسال · ✅ انجام شد). No status message for jobs under ~2 s; use chat actions instead.
- Errors: friendly Persian with the job code, e.g. «❌ تبدیل انجام نشد: فایل خراب است یا قابل خواندن نیست. کد پیگیری: <code>WC-7K3P9Q</code>». Never show stack traces.
- Help (❓) explains the 20 MB limit, the "send as file" tip, what each section does, and links to `/privacy`.
- Commands: `/start /help /settings /language /status /cancel /history /privacy /deletemydata`. Owner/admins: `/panel`, `/connect`, `/secret`.
- Per-user settings: language (fa/en), default output (document/photo), OCR engine, Persian digits on/off.
- All strings live in locale modules (fa default, en). Adding a language means adding one file. Wrap filenames, extensions, sizes and codes in `<code>` so mixed RTL/LTR text renders correctly.

## 5. Feature matrix and phases

"Bot" = pure JS on Serverless (≤ 20 MB, if the C0 limits allow it). "Worker" = Python worker.

| Feature | Where | Phase |
|---|---|---|
| Type detection by magic bytes, incl. ZIP-based formats (DOCX/XLSX/PPTX/ODF/EPUB/APK) and MP4 vs M4A | Bot | C1 |
| 🔧 Detect & Fix type: a renamed copy with the correct extension (re-uploads the same bytes; original untouched) | Bot | C1 |
| Safe rename: prefix, suffix, numbering, normalize; extension change only to one that matches the detected type; batch rename | Bot | C1 |
| ZIP create (from a batch); ZIP / TAR / TAR.GZ extract with protections (vendored `fflate` or similar, as one self-contained ESM file in `tgcloud/lib/vendor/`) | Bot | C2 |
| PDF page tools: merge, split, extract / remove / reorder / rotate pages, JPG/PNG → PDF (vendored pure-JS PDF library such as pdf-lib or a maintained fork; check maintenance) | Bot | C2 |
| OCR via Gemini (optional key, user consent) | Bot | C3 |
| Image convert: JPG, PNG, WEBP (incl. animated), GIF, BMP, TIFF, ICO; AVIF and HEIC/HEIF only if the Pillow build supports them | Worker | C4 |
| Image ops: resize, crop, rotate, flip, compress, strip metadata, watermark, add text, grayscale, blur, sharpen, color mode | Worker | C4 |
| Text → Image | Worker | C4 |
| OCR with Tesseract (fas, eng, ara, deu, fra, spa, tur); scanned-PDF OCR | Worker | C5 |
| PDF: text extraction, PDF → images, compress, watermark (incl. Persian), password-protected PDFs | Worker | C5 |
| Documents via LibreOffice (§7.5) | Worker | C6 |
| PDF → DOCX: only as «🧪 آزمایشی» with a quality warning, or not at all, decided after testing real Persian PDFs | Worker | C6 |
| Audio and video via FFmpeg (§7.6) | Worker | C7 |
| 7Z extract (check the library's license); RAR only if a permissively licensed extractor works, otherwise shown as unsupported | Worker | C7 |

Phases (stop after each one and wait for my command):
- **C0 Recon & feasibility (no features).** Scaffold with `npm create @tgcloud/bot bots/converter`; read its `AGENTS.md` and `docs/tgcloud-sdk.md`; add `bots/converter/CLAUDE.md` that imports `@AGENTS.md`. Run spikes and record the results in `docs/LIMITS.md`: handler wall time, CPU and memory; max module size; the vendored zip and PDF libraries on a 15 MB file; a `getFileStream` + `InputFile` round trip of a 19 MB file; `fetch` to the hub; WebAssembly availability; sending with the bot token from outside. Then update the matrix above, moving operations between bot and worker if needed.
- **C1 Foundation.** Handlers (`message`, `callback_query`, `my_chat_member`), the gate via `wanger-client`, menus and i18n, settings, file intake (document, photo, audio, voice, video, video note, animation), size checks, detection, Detect & Fix, rename, the jobs table, `/status /cancel /history /privacy /deletemydata`, `/panel`, rate limits (atomic upserts), tests.
- **C2** Archives, PDF page tools, batches.
- **C3** Gemini OCR.
- **C4** Worker foundation (API, queue, sandbox, capabilities, Docker) + images + text → image.
- **C5** Worker: Tesseract OCR + advanced PDF.
- **C6** Worker: documents (LibreOffice).
- **C7** Worker: audio and video (+ 7Z).
- **C8** Hardening, load test, documentation, deployment guide.

## 6. Detection, Detect & Fix, renaming

- Never trust the filename or Telegram's `mime_type`. Read the leading bytes, plus the ZIP central directory for container formats.
- Keep a signature table in `lib/detect/` with a test for every format in §5. Unknown type: «نوع فایل شناسایی نشد», offering only rename and zip.
- Mismatch: «نوع واقعی: <code>PNG</code> — پسوند فعلی: <code>.jpg</code>. یک نسخه با پسوند <code>.png</code> بسازم؟» [✅ بله] [❌ نه].
- Executables and scripts (PE/ELF/Mach-O, APK, `.bat .cmd .ps1 .sh .vbs .js`, macro-enabled Office files): report the detected type only. No conversions and no renaming to a harmless-looking extension. The bot must never help disguise a file.
- Filename sanitizing: Unicode NFC; remove control characters and the bidi controls U+202A–U+202E and U+2066–U+2069 (the "RTLO trick" makes `photo[U+202E]gnp.exe` display as `photoexe.png`); remove path separators; max 120 characters; keep Persian letters; use a fallback name if nothing is left.

## 7. Feature details

### 7.1 OCR
- One OCR interface, two engines: `GeminiOcr` (in the bot, optional) and `TesseractOcr` (worker). Only available engines are shown; if both exist, the user chooses «دقیق (هوش مصنوعی)» or «آفلاین» in settings.
- Gemini: send the image bytes with a strict prompt (return only the text, keep paragraphs and line breaks, don't translate or summarize). Before first use, ask for one-time consent: the image goes to Google's Gemini API, and free-tier content may be used by Google to improve its products. Check the current terms and show accurate text. Enforce a daily budget below the free-tier limits, with a friendly «سهمیه امروز تمام شد». Check the current model names.
- Tesseract: `fas eng ara deu fra spa tur` (use `tessdata_best` for fas/ara if the image size allows; measure it). Preprocess: EXIF transpose, grayscale, upscale small text, adaptive threshold, deskew. Auto mode: OSD script detection; Arabic script → `fas+eng` by default (Persian-first; the user can switch to Arabic); Latin script → `eng` plus the user's chosen languages. Script detection can't tell Persian from Arabic, and the help text says so.
- Output: short results in the message (plus a Copy Text button when ≤ 256 chars); over ~3500 chars as a `.txt` (UTF-8), with an optional `.docx` using RTL paragraphs. Show average confidence and the detected language when available.
- `OCR_MAX_PAGES` = 20 (Tesseract takes seconds per page, so 50 pages can't reliably finish in 120 s). The timeout scales with the page count.
- Benchmark: a small Persian/English test set (screenshots, photos of print). Report character accuracy per engine in `docs/OCR_BENCHMARK.md`. No accuracy claims without numbers.

### 7.2 Text → Image
- Flow: the user sends text (≤ 1000 chars) → picks a size preset → the image is generated **immediately** with a default theme → adjustment buttons: 🎨 تم (8 presets) · 🔠 اندازه متن (− / + / خودکار) · ↔️ چینش · 🌈 گرادیان · 🌓 سایه · 🔤 فونت · ♻️ ساخت دوباره. Custom hex colors only under «پیشرفته». Don't ask ten questions up front.
- Presets: Square 1080×1080 · Instagram post 1080×1350 · Story 1080×1920 · Landscape 1920×1080 · Telegram post 1280×720 · Custom (max 4096 px per side).
- Rendering: Pillow with the RAQM layout engine (libraqm, FriBiDi and HarfBuzz must be available; check `features.check('raqm')` at startup). If it's missing, disable the feature rather than render broken Persian. Bundle fonts with their license files: Vazirmatn (OFL) plus 1–2 other OFL fonts; each font must cover Persian, Latin and both digit sets. Auto-fit the font size, wrap lines RTL-aware, apply bidi to mixed text, keep safe padding.
- Emoji aren't supported in v2: strip them and tell the user.
- Output: PNG as a document, with an optional photo preview.
- Golden-image tests: Persian ligatures (e.g. «لا»), final and medial «ی», mixed «سلام Hello ۱۲۳», a long unbreakable word.

### 7.3 Images
- Always: fix EXIF orientation; when converting transparency to JPG, use a background color (white by default, changeable); animated → static format uses the first frame with a notice; handle CMYK and 16-bit; keep the ICC profile unless the user strips metadata.
- Compress shows before/after size. If the result isn't smaller, say so and offer the original.
- Batch: the same operation for every file; ≤ 5 results as separate files, more as one ZIP.
- `MAX_IMAGE_PIXELS` = 50 MP and `MAX_SIDE` = 12000 (12000×12000 RGBA needs ~576 MB of RAM for a single image). Treat Pillow's `DecompressionBombError` as a failure.

### 7.4 PDF
- Page ranges are typed like `1-3,7,10-`; validate them and show a friendly error.
- Text extraction warns that Persian text in PDFs is often stored broken or in visual order, and offers OCR instead.
- Compress = structural optimization + image downsampling. Report the real size change; never claim compression if the size didn't drop.
- Encrypted PDFs: the bot reports them; the worker can open them if the user sends the password (never stored or logged).
- Licensing: avoid AGPL libraries (PyMuPDF, Ghostscript) unless I approve. Prefer pypdf, pypdfium2 and pikepdf, and check each license at implementation time.

### 7.5 Documents (LibreOffice, headless)
- Conversions: DOC/DOCX/ODT/RTF/TXT → PDF/DOCX/ODT/TXT/HTML; XLS/XLSX/ODS → PDF/CSV/XLSX; PPT/PPTX/ODP → PDF; HTML/Markdown → PDF/DOCX.
- One `soffice` process per job with its own profile (`-env:UserInstallation=file:///tmp/jobs/<id>/lo`), `--headless --norestore --nolockcheck`, a hard timeout, and a process-group kill. Never run two conversions on one profile. Macros are never executed.
- HTML and Markdown are rendered **offline**: no remote resources and no `file://` access (SSRF / local-file leak). Markdown goes to HTML through a safe renderer that drops raw HTML.
- Install fonts with Persian coverage in the worker image (Vazirmatn, Noto Naskh Arabic) and test with a real Persian DOCX.
- Validate the output (it opens; page count > 0) before sending.

### 7.6 Audio and video (FFmpeg)
- Always run `ffprobe` first and enforce `AUDIO_MAX_MIN` / `VIDEO_MAX_MIN`.
- Force the input demuxer from a whitelist that matches the detected type; use `-nostdin -protocol_whitelist file`; pass arguments as a list, never through a shell. Reject concat, playlist and HLS inputs (this blocks the "playlist inside AVI" local-file trick).
- Audio: MP3, WAV, OGG (Opus/Vorbis), FLAC, M4A (AAC) in any direction; voice note → MP3; any audio → Telegram voice note (`sendVoice`, Opus); trim (start/end as mm:ss); loudness normalize (EBU R128 `loudnorm`).
- Video: MP4 (H.264/AAC), WEBM (VP9/Opus), MKV, AVI; compress (presets کم / متوسط / زیاد, or a target size ≤ 50 MB with two-pass); resize (1080p / 720p / 480p); trim; extract audio; thumbnail at a chosen second.
- Stream to disk; never load whole media files into RAM. The help text says inputs are limited to 20 MB by Telegram.

### 7.7 Archives
- Before extracting, read the index only. Reject when there are more than `ARCHIVE_MAX_ENTRIES` entries, the total size exceeds `ARCHIVE_MAX_UNPACKED_MB`, any entry's ratio exceeds `ARCHIVE_MAX_RATIO`, or there are absolute paths, `..`, symlinks, hardlinks, device files, or encrypted entries (unsupported in v2). Nested archives are never auto-extracted.
- Extract into a fresh per-job directory with sanitized names. Never execute anything.
- Returning files: up to 10 are sent individually (files over 50 MB are skipped, with a note). More than 10: a paginated list to choose from, or "send everything as ZIP parts ≤ 50 MB".

## 8. Worker (Python) — technical spec

- Python 3.12+, FastAPI, and a Redis- or SQLite-backed job queue (choose one and justify it in `docs/DECISIONS.md`). Two queues, `light` and `heavy`; per user at most 1 heavy and 2 light jobs at once.
- **Processor plugins**, so new tools never touch the core. Each processor declares an `id`, the input types it accepts, and its operations. Each operation declares an id short enough for `callback_data`, a pydantic params schema, a queue, a timeout and its required system tools; `process(input_path, params, workdir) -> Result`.
- **Capabilities are the source of truth.** At startup a registry self-checks the engines (`ffmpeg -version`, `tesseract --list-langs`, `soffice --version`, Pillow features) and publishes only working operations at `GET /v1/capabilities`. The bot builds its menus from that (cached 10 min). `docs/SUPPORTED_CONVERSIONS.md` is generated from the same registry, so the docs can't lie.
- **Sandbox:** non-root user; per-job temp dir (mode 0700) on a size-limited volume; cleanup in `finally` plus a sweeper for anything older than `TEMP_RETENTION_MIN`; subprocesses with list arguments, a minimal environment (no secrets passed to tools), `prlimit` limits (CPU seconds, address space, file size) and a timeout that kills the whole process group. Output is validated before upload. Stronger isolation (nsjail/bubblewrap, a network-less sidecar) can come later.
- **API security:** HMAC on every request (timestamp ±300 s, constant-time compare, replay protection by job id), rate limiting, and no endpoint that accepts arbitrary URLs or commands.
- **Telegram:** `getFile` downloads streamed to disk; multipart `sendDocument`; bounded retries on 429/5xx.
- **Docker:** multi-stage, Debian slim, only the needed packages (tesseract + the chosen language packs, ffmpeg, LibreOffice writer/calc/impress rather than the full suite, fonts, FriBiDi/raqm), non-root, healthcheck. Report the final image size in `docs/PROGRESS.md`. Provide `docker compose` for local development.
- **Hosting:** free options need research in C4 (candidates to check: an Oracle Cloud Always Free VM, the Google Cloud Run free tier; both need a card at signup, so verify the current terms). Document the choice with exact commands. Until a host exists, worker features stay hidden.

## 9. Limits (defaults; the owner can override them via this bot's `settings_json` in the Mother Bot)

| Setting | Default |
|---|---|
| `MAX_INPUT_MB` / `MAX_OUTPUT_MB` | 20 / 50 |
| `MAX_IMAGE_PIXELS` / `MAX_SIDE` | 50 MP / 12000 |
| `JOB_TIMEOUT_LIGHT_S` / `JOB_TIMEOUT_HEAVY_S` | 30 / 120 (OCR adds time per page) |
| `OCR_MAX_PAGES` | 20 |
| `ARCHIVE_MAX_ENTRIES` / `ARCHIVE_MAX_UNPACKED_MB` / `ARCHIVE_MAX_RATIO` | 1000 / 200 / 100 |
| `BATCH_MAX_FILES` | 20 |
| `RATE_JOBS_PER_HOUR` / `RATE_BURST_PER_MIN` | 10 / 3 (owner and admins unlimited) |
| `AUDIO_MAX_MIN` / `VIDEO_MAX_MIN` | 60 / 10 |
| `TEMP_RETENTION_MIN` | 30 |
| `JOB_HISTORY_DAYS` | 30 |

## 10. Data (the bot's own SQLite) and `/panel`

- `jobs`: id (ULID), code, user_id, operation, status (`QUEUED / DOWNLOADING / PROCESSING / UPLOADING / COMPLETED / FAILED / CANCELLED / EXPIRED`), engine (`bot` / `worker`), input type and size, output type and size, error_code, timings, created_at. Never file contents; filenames only if needed for display, deleted with the job.
- `batches`, `pending_actions` (forced-join resume), `user_settings`, `rate_counters`, `secrets`, `errors` (sanitized, last N, for `/panel`).
- `result_cache`: (input `file_unique_id` + operation + params hash) → output `file_id`, kept 24 h, so an identical request is answered instantly without reprocessing.
- Retention: jobs for `JOB_HISTORY_DAYS`, batches and pending actions for 1 day. Serverless has no cron, so clean up opportunistically (e.g. ~1% of invocations, and whenever `/panel` opens).
- `/panel` (owner/admins): today's jobs, failed jobs with error codes and a retry button, active jobs, worker health and capabilities, Gemini quota used, current limits, a read-only list of forced-join channels, and «🧠 مدیریت در بات مادر».

## 11. Logging

- Structured JSON logs. Bot: a small wrapper around `console.*`. Worker: structlog. Fields: update_id/request_id, job_id, user_id, operation, input_type, output_type, duration_ms, status, error_code; levels INFO / WARNING / ERROR.
- Never log tokens, keys, file contents, OCR text or full filenames.
- Job events go to the hub (`/v1/events`) for stats and alerts. The worker exposes `/healthz` and `/readyz`.

## 12. Testing

- Bot (JS): unit tests for detection, sanitizing, keyboards (every `callback_data` ≤ 64 bytes), i18n completeness (fa/en keys match), rate limits, gate behavior with a mocked hub (including hub down → fail open), and state machines. Handler smoke tests through `npx tgcloud run`.
- Worker: pytest. Fixtures are generated in code (no copyrighted files). Every processor gets a success test, a corrupted-input test and an oversize test. Engine tests run inside the Docker image in CI.
- Required malicious cases: zip-slip, symlink/hardlink tar, a small generated zip bomb, a decompression-bomb PNG, a polyglot file, a wrong extension, an RTLO filename, an executable renamed `.jpg`, the HLS/concat trick for FFmpeg, HTML pointing at remote and `file://` resources, huge dimensions, a 0-byte file, truncated JPEG/PDF, password-protected PDF/ZIP.
- CI (GitHub Actions): ESLint/Prettier for JS; ruff + mypy for Python; all tests; the worker Docker build; `pip-audit`; a check that the vendored `wanger-client` is in sync.

## 13. Deliverables (by the end of C8)

Source code; tests; Dockerfile(s) and compose for the worker; `.env.example` files; migrations; `README.md` (BotFather and enabling Serverless, `npx tgcloud login / push / migrate`, connecting to the hub with `/connect`, worker deployment, troubleshooting — all with exact commands); `ARCHITECTURE.md`; `SECURITY.md`; `LIMITS.md`; `SUPPORTED_CONVERSIONS.md` (generated); `KNOWN_LIMITATIONS.md`; `OCR_BENCHMARK.md`; and the commands to run everything locally and to run the tests.

## 14. Out of scope for v2 (keep only interfaces and hooks)

A Local Bot API Server (files up to 2 GB), AI extras (summarize, translate, describe, generate images), paid tiers / Telegram Stars, a web dashboard, video inputs over 20 MB.
