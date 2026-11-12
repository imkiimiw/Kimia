# Changelog

## Phase 1 — core bot (2026-11-12, not deployed yet)

- Schema: 20 tables (users, quotas, forced join, conversation state and pending actions, packs and
  their sticker mirror, publications, reviewers, bulk ops, broadcasts, settings, secrets, rate
  limits, errors, stats, update de-duplication, alerts, audit log).
- /start with the language choice (fa / en), main menu, help & settings, «حساب Wanger من», /lang,
  /cancel, /deletemydata; commands registered per language and /admin for the owner only.
- Wanger Account adapter with the local provider (no hub exists).
- Forced join on every entry point (messages, buttons); pending action resumed after «عضو شدم»;
  10-minute pass cache; broken channels skipped with a throttled owner alert; owner management
  (add by username/id/link/forward, max 10, reorder, enable/disable, invite link, preview, gate on/off).
- Telegram pack management by file_id: add a sent sticker, new pack, browse, reorder, emojis,
  keywords, replace, delete, rename, pack icon (100×100 file checked by its header), share, JSON
  backup, delete pack; import a public pack (all or by number), copy, duplicate, merge — bulk ops
  resumable across invocations.
- **Channel publishing** (owner's request): a new channel set in the panel, manual approval by the
  owner or **reviewers she adds**, creator name / @username only if the creator turns them on,
  withdraw / remove (48 h deletion rule), queue with a gap between posts, no automatic re-send.
- Owner panel: stats, broadcast (copy/forward, 5 audiences, pause/resume/cancel, at-most-once
  delivery), users (ban bot/ecosystem, Pro, points, quota reset, message, publish ban), settings,
  feature flags (unbuilt features can't be turned on), texts, maintenance mode, notifications,
  errors, secrets (message deleted), backup.
- Tests: 60 (unit, guards, and end-to-end acceptance suites for the gate, packs, publishing,
  permissions and broadcast).
- Measured on @Wanger_Motionbot (Phase 0 completed): see docs/SPIKE_REPORT.md §3a.

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
