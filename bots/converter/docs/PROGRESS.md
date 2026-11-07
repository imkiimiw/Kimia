# Progress

**Current state: Phase C0 (recon & feasibility) done — 2026-11-07. Nothing deployed (cloud revision 0).
Waiting for the owner's command to start C1, and for the answers below.**

## Phase C0 — Recon & feasibility ✅

Done:
- Scaffolded with `npm create @tgcloud/bot bots/converter` (create-bot 0.1.1, CLI 0.2.0); read its
  `AGENTS.md` and `docs/tgcloud-sdk.md` (identical to the other Wanger bots' copies); `CLAUDE.md`
  imports `@AGENTS.md`; `AGENTS.md` has a short "This bot" section.
- CLI wrapper `scripts/tg.mjs` (this bot only, token from `Converter_BOT_TGCLOUD_TOKEN`).
- Spec saved verbatim: `docs/SPEC.md`.
- Spikes (`spikes/`, run with `npm run spike`), results in **`docs/LIMITS.md`**:
  CPU ≈ 3 s per invocation (cumulative) · wall ≈ 30 s · memory ≈ 7.9 GB · module ≤ 1 MiB ·
  fflate and @cantoo/pdf-lib on 15–22 MB fit (pdf-lib only with three options) · 19 MB
  `getFileStream` + `InputFile` round trip 3.0 s · signed `fetch` 256 ms · WebAssembly: sync APIs only.
- Extra findings: Telegram truncates file names (base 64 / extension 16 characters, emoji removed);
  parallel downloads work; the bot is **not admin** in the three forced-join channels yet.
- Feature matrix updated (`docs/LIMITS.md` §4): nothing had to move from bot to worker; PDF tools get
  an object-count guard, PNG → PDF a megapixel guard; images are a *candidate* for in-bot WASM.
- Decisions in `docs/DECISIONS.md`.

Not done in C0:
- **Sending with the bot token from outside** — needs the bot token (owner) and is meaningful only
  after the first push sets the webhook. Script ready: `spikes/outside-send.mjs`.
- **`fetch` to the hub** — the hub doesn't exist; measured against a public echo service instead.

## What I need from the owner

1. **`docs/WANGER_ECOSYSTEM.md`** — the spec says to read it first, but it isn't in the repository, and
   neither are the Mother Bot, the Hub (`/v1/gate`, `/v1/events`) or `wanger-client`. Please send it, or
   confirm it doesn't exist yet.
2. **Forced join etc. until the hub exists** (your note: «جوین اجباری هاشو اینا رو هم حواست باشه»).
   Proposal for C1: the gate behind one interface with a **local provider** — forced join to
   @HIDE_i_SEEK, @Nepenthw_ir, @wangerBots (owner manages the list in `/panel`), ban, maintenance switch,
   and a minimal broadcast — like the other Wanger bots; it switches to the hub when the hub is ready.
   OK?
3. **Make `@Wanger_Converterbot` an admin** in @HIDE_i_SEEK, @Nepenthw_ir and @wangerBots — without it
   Telegram doesn't let the bot check membership ("member list is inaccessible", measured).
4. **File-name limit**: Telegram keeps only 64 characters of the name (+16 of the extension) and drops
   emoji, so the spec's 120 becomes 64. OK?
5. **Bot token** (BotFather) — for the outside-send test after the first push in C1, and for the
   worker in C4. Either add it to this environment as the secret `Converter_BOT_TOKEN`, or run
   `Converter_BOT_TOKEN=… NODE_USE_ENV_PROXY=1 node spikes/outside-send.mjs` yourself. Never in chat or git.
6. Optional: a short spike of **WASM image codecs** inside the bot — if it works, basic image tools
   (convert / resize / compress small images) could be offered without hosting a worker.

## Remaining phases

C1 Foundation · C2 Archives, PDF page tools, batches · C3 Gemini OCR · C4 Worker + images +
text → image · C5 Tesseract + advanced PDF · C6 Documents · C7 Audio/video + 7Z · C8 Hardening.
