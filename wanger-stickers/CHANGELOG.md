# Changelog

## Phase 0 — discovery and spike (2026-11-11, not deployed)

- Project created with the official tools (`create-vite` react-ts, `npm create @tgcloud/bot .`);
  the scaffold's echo handler removed (no user features in Phase 0); empty schema.
- `tgcloud/lib/core/limits.js`: every Telegram and WhatsApp number, re-checked against the official
  pages (Bot API 10.4); `src/engine/limits.ts` re-exports it.
- `tgcloud/lib/core/inspect.js`: WebP (RIFF) and WebM (EBML) header readers.
- Engine prototypes: `src/engine/webm/mux.ts` (VP9 WebM with alpha in BlockAdditions),
  `src/engine/webp/animmux.ts` (animated WebP).
- Device spike Mini App (`src/spike/`), owner-only spike endpoints `spike_echo`, `spike_report`.
- Scripts: `tg.mjs` (token isolation), `probe.mjs` (platform probe via `tgcloud run`),
  `spike-assets.mjs`, `spike-local.mjs` (headless Chromium baseline).
- Docs: BRIEF (with Addendum A1: publish packs to a channel), SPIKE_REPORT, proposed DECISIONS,
  QA, THIRD_PARTY_LICENSES.
