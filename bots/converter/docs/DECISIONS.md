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
