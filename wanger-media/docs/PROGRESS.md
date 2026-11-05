# Progress

**Current state: Phase 0 (Discovery) done — waiting for the owner. Next: Phase 1 (Foundation), only
when the owner names it.** Nothing is deployed (cloud revision 0, no tables).

## Phase 0 — Discovery (2026-11-05) ✅

Done:
- Project folder `wanger-media/` set up as its own tgcloud project: `package.json` (CLI 0.2.0 as dev
  dependency), `scripts/tg.mjs` (CLI only with `Media_BOT_TGCLOUD_TOKEN`), `.gitignore`,
  `tgcloud.jsonc`, `AGENTS.md`, `CLAUDE.md`, `docs/tgcloud-sdk.md`, the brief as `docs/BRIEF.md`.
- Token checked: it belongs to `@Wanger_mediabot` (app9080356648); cloud empty, webhook in sync,
  5 updates waiting.
- Limits in brief §3 confirmed on this bot (details in `docs/PLATFORMS.md` §1): CPU ≈ 3 s; no
  cron/timers; query fails at ≈ 50 000 rows read; ≤ 4 000 bound parameters per statement (that's the
  real "insert cap"); `fetch` 30 MB per response with occasional ≈ 5 s stalls; no `URL`/`atob`/
  `AbortController` globals; egress from the Netherlands; privacy mode is ON.
- All 14 platforms researched (official API, `public` behaviour measured from Serverless, terms) →
  `docs/PLATFORMS.md`. Choices → `docs/DECISIONS.md`.
- Proposal for Phase 3: **X/Twitter, Pinterest, Snapchat (Spotlight)**; substitute: Discord.

Tests: none yet. Phase 0 has no app code; the test setup (Vitest + SDK mocks) is part of Phase 1.

## Remaining

Phase 1 Foundation · 2 User dashboard · 3 Download core (first 3 platforms) · 4 Admin panel ·
5 Groups · 6 Launch · 7 Remaining platforms (one per session) · 8 `external` service (only on request).

## What I need from the owner

1. **Confirm the first 3 platforms** (X/Twitter, Pinterest, Snapchat Spotlight) or name substitutes.
2. **Make `@Wanger_mediabot` an admin** in `@HIDE_i_SEEK`, `@Nepenthw_ir` and `@wangerBots` (no
   rights needed beyond being admin). Without it `getChatMember` fails and forced join can't work.
3. **Legal/policy choice:** X, Pinterest and Snapchat all forbid automated collection in their terms,
   even of public posts. The `public` methods will be built OFF by default with a risk note, and you
   switch them on per platform. Do you accept building them on that basis?
4. **Legal/policy choice:** third-party scraper services (FxTwitter, cobalt, paid scraper APIs) are
   not used. Recommended: keep it that way. Say so if you want otherwise.
5. Later, not now: privacy mode is ON. For groups (Phase 5), either turn it off in BotFather
   (`/setprivacy` → Disable, then remove and re-add the bot) or make the bot admin in each group.
6. Optional, costs money or accounts, **not needed for Phases 1–6**: X API credits (pay-per-use),
   SoundCloud Artist Pro (API registration), a free Twitch developer app (needs 2FA), Reddit API
   approval (likely closed to new requests).
