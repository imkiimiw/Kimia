# Limits — Telegram Serverless, measured for the Converter bot (Phase C0)

Measured on **2026-11-06/07** for **`@Wanger_Converterbot`** (app/bot id 9216103899, CLI 0.2.0) with
temporary probe modules run by `tgcloud run` (never deployed; the cloud project is still at revision 0).
The probes are in [`spikes/`](../spikes/README.md) and can be re-run with `npm run spike -- …`.

Legend: **Official** = in [core.telegram.org/bots/serverless](https://core.telegram.org/bots/serverless)
(latest change: 2026-10-06) or the scaffold's `docs/tgcloud-sdk.md` · **Measured** = observed here ·
**Other bot** = measured by another bot in this repository · **Unknown** = not documented, not measurable yet.

How time was measured: `Date.now()` **does not advance during synchronous work** (0 ms across a loop of
2·10⁸ iterations) and catches up after any I/O (189 ms after one `SELECT 1`; a `SELECT 1` costs 1–2 ms).
Every step was therefore timed as *work → tiny DB query → read the clock*.

## 1. The C0 checklist

| Spike (spec §5 C0) | Result | Source |
|---|---|---|
| **CPU per invocation** | **≈ 3.0–3.2 s, cumulative across `await`s.** A synchronous loop of 2.6·10⁹ iterations finished (2 361 ms); 3.4·10⁹ was stopped: `Terminated: CPU timer exceeded` (3 011 ms). The same loop cut into slices with an I/O call between them was stopped at 2.98–3.25 s of accumulated work — waiting on I/O doesn't count, work does. | Measured |
| **Wall clock per invocation** | **≈ 30 s** (under `tgcloud run`). 25 s and 29.75 s of chained HTTP waits finished; 32, 45 and 60 s ended with `HTTP 500` after 30–31 s. | Measured |
| **Memory** | **Not a constraint: ≈ 7.9 GB.** 7 936 MB of touched typed arrays were allocated; 8 192 MB → `Terminated: Memory limit exceeded`. A separate JS-heap (objects) limit was not measured. | Measured |
| **Max module size** | **1 048 576 bytes (1 MiB) per module**: `Module code is too long (max 1048576 bytes)`; a 1 047 527-byte module loads. Module *count*: an earlier bot here had a 104-module deploy refused (88 and 94 worked). | Measured / Other bot |
| **Vendored ZIP library on 15 MB** | **Fits easily** — fflate 0.8.3, sync API (table in §2). Deflate level 6 of 15 MB of text: 425 ms; inflate: 63 ms; store: 34 ms; 1 000 entries: 231 ms; reading the index only: 2–3 ms. | Measured |
| **Vendored PDF library on 15 MB** | **Fits, with three mandatory options** — @cantoo/pdf-lib 2.11.1 (table in §3). A 15 MB JPG→PDF, merge, split: 5–27 ms per step. A real 22.5 MB / 756-page / 126 988-object PDF: load 0.72–0.77 s, full re-save 0.22 s. Cost follows the **object count, not the file size**. | Measured |
| **`getFileStream` + `InputFile`, 19 MB** | **Works: 3.0 s wall for the round trip.** Upload of 19 922 944 bytes as `InputFile`: 0.98 s → `getFileStream`: first chunk after 1.58 s, whole file after 2.15 s (1 743 chunks of ≤ 16 366 bytes, CRC-32 identical) → re-upload of those bytes: 0.87 s. `getFileContent` of the same (now warm) file: 0.56 s. A 20.1 MB file → `400 Bad Request: file is too big`. | Measured |
| **`fetch` to the hub** | **No hub exists yet** (no URL, no `docs/WANGER_ECOSYSTEM.md`, no `wanger-client` anywhere in the repository). Measured instead against a public echo service with the request shape planned for the hub/worker: an HMAC-SHA256-signed JSON `POST` took 256 ms; body and signature header arrived unchanged. `crypto.subtle` (HMAC, SHA-256) works. | Measured |
| **WebAssembly** | **Available, synchronous APIs only.** `WebAssembly.validate`, `new WebAssembly.Module(bytes)` + `new WebAssembly.Instance` (a generated 699 KB module compiled in 9 ms), `WebAssembly.instantiate(module)` and a 1 GB `WebAssembly.Memory` work. **`WebAssembly.compile(bytes)` and `WebAssembly.instantiate(bytes)` kill the invocation** (`HTTP 500`, not catchable). `eval` and `new Function` work too. | Measured |
| **Sending with the bot token from outside** | **Not measured — blocked.** This session has only the CLI token (`app…:…`), not the bot token, and nothing is deployed yet, so the webhook isn't set (`url: (none set)`, 4 updates pending): a test now would prove little. Standard Bot API behaviour: only `getUpdates` conflicts with a webhook; send/edit methods don't. Ready to run after the first push: [`spikes/outside-send.mjs`](../spikes/outside-send.mjs) (only getMe, getWebhookInfo, sendMessage, editMessageText, deleteMessage). | Unknown |

## 2. ZIP / GZIP (fflate 0.8.3, 15 MB = 15 728 640 bytes)

Times exclude generating the input (37 ms for 15 MB of text).

| Operation | Serverless | Node 22 here | Output |
|---|---|---|---|
| ZIP store (level 0) / unzip | 34 / 5 ms | 58 / 10 ms | 15.7 MB |
| ZIP deflate level 1 / inflate | 181 / 85 ms | 379 / 119 ms | 3.17 MB |
| ZIP deflate level 6 / inflate (text) | 425 / 63 ms | 694 / 99 ms | 2.18 MB |
| ZIP deflate level 6 / inflate (random bytes) | 255 / 5 ms | 504 / 14 ms | 15.73 MB |
| 1 000 entries (15 MB total), level 6 / index only / unzip all | 231 / 3 / 58 ms | 489 / 2 / 71 ms | 2.79 MB |
| GZIP level 6 / gunzip | 414 / 65 ms | 724 / 63 ms | 2.18 MB |
| CRC-32 (own table code; fflate exports none) | 32 ms | 47 ms | — |

Rates for planning: deflate-6 ≈ **28 ms/MB** (text), level 1 ≈ 12 ms/MB, inflate ≈ **4–6 ms/MB**,
index-only check ≈ 3 ms per 1 000 entries. Only the sync APIs are usable (the async ones need Workers / `setTimeout`).

## 3. PDF (@cantoo/pdf-lib 2.11.1)

**Mandatory options**, or it fails on Serverless:
- `PDFDocument.load(bytes, { parseSpeed: Infinity, … })` — otherwise the parser yields to `setTimeout`
  every 100 objects: `ReferenceError: setTimeout is not defined` (measured on the real PDF below).
- `doc.save({ objectsPerTick: Infinity, useObjectStreams: false })` — `objectsPerTick` for the same
  reason; `useObjectStreams` defaults to **true** and a full re-save of the 127k-object PDF with it ran
  out of CPU (`CPU timer exceeded`; ≈ 39 s in Node here). Without it: 222 ms.

| Case | Serverless | Node 22 here |
|---|---|---|
| JPG → PDF: 30 JPEGs, 15 MB → embed / save | 11 / 21 ms (15.7 MB) | 27 / 48 ms |
| load that PDF / merge it with itself (60 pages) / save (31.5 MB) / split 5 pages | 10 / 13 / 27 / 5 ms | 18 / 33 / 54 / 9 ms |
| PNG → PDF, 2000×1500 (7.9 MB PNG): embed / save | 128 / 243 ms | 236 / 481 ms |
| PNG → PDF, 3000×2000 (15.4 MB PNG): embed / save | 233 / 483 ms | — |
| **Real PDF** — ISO 32000-1 (22.5 MB, 756 pages, 126 988 objects, text-heavy): fetch | 0.66–1.35 s | — |
| … load | **716–771 ms** | 1 685–1 699 ms |
| … split: copy 10 pages + save / copy 400 pages + save (3.8 MB) | 5 + 11 ms / 27 + 96 ms | 4 + 6 ms |
| … rotate all pages + full save, no object streams (22.7 MB) | 3 + 222 ms | 1 + 484 ms |
| … full save **with** object streams (pdf-lib's default) | **CPU timer exceeded** | ≈ 39 s |

Rates for planning: parsing ≈ **5.7 µs per object** on Serverless; JPEG pages cost almost nothing (pdf-lib
copies JPEG bytes without decoding); PNG → PDF ≈ **0.12 s per megapixel** (decode + re-deflate). The
object count can be read cheaply before parsing (trailer / xref-stream `/Size`), so a guard is possible.

## 4. Feature matrix after C0 (replaces spec §5's "Where") — status after C4 in the last column

| Feature | Where | Condition measured in C0 | Status |
|---|---|---|---|
| Type detection (magic bytes, ZIP central directory) | **Bot** (C1) | Download the whole file: a head-only read of a cold file saves nothing (2.24 s for the first 80 KB of 19 MB; the full file right after: 0.56 s). | ✅ C1 |
| 🔧 Detect & Fix, safe rename, batch rename | **Bot** (C1) | Download + re-upload ≈ 3 s per 19 MB file. Names: Telegram keeps ≤ 64 chars of the base and ≤ 16 of the extension (§5 #2). Batches: ≤ 4 downloads in parallel. | ✅ C1, batch rename C2 |
| ZIP create (from a batch) | **Bot** (C2) | ≤ 50 MB output; store already-compressed types (JPEG, MP4, ZIP…), deflate the rest (≈ 28 ms/MB → ≤ 50 MB ≈ 1.4 s CPU). | ✅ C2 |
| ZIP / TAR / TAR.GZ extract with protections | **Bot** (C2) | Index check first (ms); inflate ≈ 5 ms/MB, so `ARCHIVE_MAX_UNPACKED_MB` 200 ≈ 1 s CPU; TAR needs no library. | ✅ C2 |
| PDF page tools (merge, split, extract/remove/reorder/rotate) | **Bot** (C2) | The three options of §3; guard on the **object count** (≈ 200 000 objects per job ≈ 1.2 s), not on MB; larger → worker (or a clear refusal while there is none). Encrypted PDFs: reported (worker opens them with a password). | ✅ C2 |
| JPG → PDF | **Bot** (C2) | Trivial (ms). | ✅ C2 |
| PNG → PDF | **Bot** (C2) | ≤ ≈ 12 MP per job (≈ 1.5 s); larger → worker. | ✅ C2 |
| OCR via Gemini | **Bot** (C3) | `fetch` works, 30 MB response cap, ≈ 30 s wall per invocation; inline request ≤ 20 MB → images ≤ 14 MB, PDFs ≤ 5 pages. | ✅ C3 (needs the owner's key) |
| Image convert / ops | **Worker** (C4) | Kept on the worker: Pillow 13 covers every format of the spec (AVIF/HEIC included) with one tested code path; a WASM codec in the bot would cover a fraction, inside 3 s CPU and 1 MiB modules. | ✅ C4 (needs a hosted worker) |
| Text → Image | Worker (C4) | Correct Persian shaping needs HarfBuzz/RAQM — not in pure JS here. | ✅ C4 (needs a hosted worker) |
| Tesseract OCR, advanced PDF, documents, audio/video, 7Z | Worker (C5–C7) | Native binaries; unchanged. | C5–C7 |

## 5. Conflicts between the spec and what was found (the measurement wins)

| # | Spec item | Finding | Proposed instead (C1 unless noted) |
|---|---|---|---|
| 1 | Header, §1.4, §2: `docs/WANGER_ECOSYSTEM.md`, the Mother Bot, Wanger Hub (`/v1/gate`, `/v1/events`), vendored `wanger-client` | **None of them exist** in this repository; no hub URL. The gate (forced join, bans, maintenance), broadcast and global stats would have no home. | **Waiting for the owner** (PROGRESS.md): build the gate behind one interface with a **local provider** (forced join to @HIDE_i_SEEK, @Nepenthw_ir, @wangerBots as in the other Wanger bots, plus ban and maintenance switches and a minimal broadcast in `/panel`), and a hub provider later. |
| 2 | §6: filenames max 120 characters | Telegram itself keeps **≤ 64 characters of the base name** (counted in characters: 64 Persian letters = 132 bytes were kept) and **≤ 16 of the extension**, and **removes emoji** (`emoji-🙂.txt` → `emoji-.txt`). Persian names arrive intact. | Sanitizer: base ≤ 64 chars, extension ≤ 16, emoji removed by us — what the user is shown is what arrives. |
| 3 | §2: "C0 confirms that sending from outside works" | Not confirmable in C0 (no bot token; no webhook set before the first push). | Run `spikes/outside-send.mjs` after the first push in C1 (needs the bot token — owner). |
| 4 | §2 secrets: a platform secret store "if documented" | None is documented (official docs: only the CLI's `TGCLOUD_TOKEN`). | The `secrets` table, as the spec says. |
| 5 | §5: "pure JS on Serverless (≤ 20 MB)" for PDF | Fits only with the options of §3; size is the wrong guard. | Object-count guard; never `useObjectStreams`. |
| 6 | §9 `JOB_TIMEOUT_LIGHT_S` = 30 | The platform's own wall limit is ≈ 30 s, and CPU can't be timed from inside (clock frozen during work). | In-bot jobs plan for ≤ 20 s wall and ≤ 2 s CPU, enforced by **pre-checks on input size / object count / pixels**, not by timers. |
| 7 | §11 `duration_ms` | `Date.now()` only moves across I/O. | Durations are read after awaited calls (they include CPU spent before them). |

## 6. Other measured facts

| Area | Finding |
|---|---|
| Speed | Serverless ran these workloads **1.5–2.4× faster** than Node 22 in this container. |
| Globals present | `TextEncoder`, `TextDecoder` (incl. `utf-16le`, `latin1`), `crypto` (+ `subtle`), `Intl` (incl. `Intl.Segmenter` — «سلام» = 4 graphemes; `Asia/Tehran`; `toLocaleString('fa-IR')` → `۱٬۲۳۴٬۵۶۷`), `WebAssembly`, `SharedArrayBuffer`, `Atomics`, `WeakRef`, `FinalizationRegistry`, `String#normalize`, `eval`, `new Function`. |
| Globals absent | `setTimeout`, `setInterval`, `queueMicrotask`, `URL`, `URLSearchParams`, `atob`, `btoa`, `CompressionStream`, `DecompressionStream`, `Blob`, `Response`, `ReadableStream`, `AbortController`, `structuredClone`, `performance`, `Buffer`, `process`, `OffscreenCanvas`, `ImageDecoder`, `createImageBitmap`, a global `FormData` (the SDK exports its own). Dynamic `import()` → `Not supported`. |
| `fetch` | User-Agent `TelegramCloud/1.0 (app9216103899; +https://core.telegram.org/bots)` (spoofable, so the worker/hub must rely on HMAC, not on it). An unknown host fails in 17 ms with a bare `fetch: request failed`. Transient `fetch: request failed` after ≈ 5.0 s happened in 2 of ≈ 12 fetch-heavy runs → retry once when the wall budget allows. 22.5 MB downloaded in 0.66–1.35 s. Response cap 30 MB (Official). |
| Telegram files | First access to a file is slow (0.5 s for 3 MB, 1.6–2.2 s for 19 MB), later ones fast (0.56 s for 19 MB). **Parallel downloads work**: 4 cold 3 MB files in 1.17 s in parallel vs 2.16 s one after another. An album of 8 × 3 MB documents (one `sendMediaGroup`): 0.86 s. Upload ≈ 0.7–1.0 s per 20 MB. `getFileStream(...).file` has `file_unique_id`, no `file_path`. |
| `tgcloud run` results | A returned object with **numeric keys** fails: `Invalid run result: Cannot convert: v8::Object key is not a string` (the work itself had run). Handlers' `{ trace }` results must use string keys. |
| Bot | `@Wanger_Converterbot`: `can_join_groups: true`, privacy mode on (`can_read_all_group_messages: false`), inline off, no main Mini App. `getWebhookInfo` → `403 Method getWebhookInfo is restricted`. |
| Forced-join channels | `getChatMember` in @HIDE_i_SEEK, @Nepenthw_ir, @wangerBots → `400 Bad Request: member list is inaccessible` in all three: **the bot is not an admin there yet**, so it can't check membership. |
| Owner's chat | Reachable (the owner has started the bot). The file spikes used it with `disable_notification` and deleted every test message (verified: `message to delete not found` afterwards). |

## 6b. Measured in C2 (Serverless, 2026-11-08)

| Check | Result |
|---|---|
| `json_insert(…, '$.files[#]', …)`, `json_array_length` | Work (the album resume queue relies on them). |
| `sendMediaGroup` with two `InputFile` documents | Works, 102 ms; names kept. Test messages deleted. |
| Loading the C2 module graph (41 modules, 696 KB of vendored code) | A no-op update: 34–36 ms (was 8 ms in C1) — the cost of evaluating pdf-lib. |
| Migration | 5 additive steps (new table, three columns, an index); all indexes present afterwards. |

## 6c. Measured in C3 (Serverless, 2026-11-08)

| Check | Result |
|---|---|
| Gemini API from Serverless | Reachable: an invalid key → `400 INVALID_ARGUMENT / API_KEY_INVALID` in 73 ms. |
| **JS heap vs. typed arrays** | A 14 MB image's base64 built by small string concatenations → `Terminated: Memory limit exceeded`; 5 MB was fine (175 ms). Flat strings up to 128 MB and joins of 1-MB parts work. → Never build big data out of many small strings; use typed arrays. |
| Byte-built request body | 14 MB image → 19.5 MB JSON body in 21–23 ms; uploaded to Google in 0.7 s. |
| Migration | 1 additive column. No-op update after C3: 34 ms (44 modules). |

## 6d. Measured in C4 (Serverless, 2026-11-08)

| Check | Result |
|---|---|
| **Outbound ports** | Only **80 and 443** are reachable: `:8080`, `:8443`, `:81`, `:9` fail in 4–11 ms (portquiz.net answers on every port; `http://portquiz.net/` → 200 in 52 ms). → `WORKER_URL` must be `https://host` on the default port (validated by `/secret`). |
| Private / reserved addresses | `10.255.255.1`, `192.0.2.1`, `*.invalid` fail in 6–10 ms (blocked or unresolvable). |
| An unresponsive public host on 443 | `1.2.3.4` fails after 1.6 s, `203.0.113.50` after 3.2 s → reads of the worker are not retried; the capabilities cache keeps a dead worker from being asked more than every 2 min. |
| `crypto.subtle` HMAC-SHA256 | Matches Python's `hmac` byte for byte; the bot's own `signedHeaders` + a byte body sent to an echo service arrived unchanged (headers, Persian JSON body, query string) in 260 ms, and the worker's `verify()` accepted the echoed request. |
| Deploy | No schema change; 13 modules pushed (revision 4); webhook in sync; no-op update 38 ms (47 modules); 0 errors. |
| Worker container (local Docker) | Non-root, read-only root FS, no capabilities: 3 jobs (convert, text → image, watermark) in 0.5–0.75 s each, ≈ 0.7 s of it the sandboxed child's start-up. Healthcheck `healthy`. Image 295 MB. |

## 7. Still unknown

- Whether **webhook invocations** get the same CPU / wall limits as `tgcloud run` (the other Wanger bots run in production on the same assumptions without trouble).
- How many updates may run **concurrently** (assume parallel: every state change is one atomic statement).
- The JS-heap limit (as opposed to typed arrays); a total project-size limit; the exact module-count limit.
- Sending from outside with the bot token (§1, last row) — the worker does exactly this; it can only be checked once the owner hosts it with the real `BOT_TOKEN`.
- The hub's latency and behaviour — it doesn't exist yet.
