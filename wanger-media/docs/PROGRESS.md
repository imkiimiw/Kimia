# Progress

**Current state: Phase 1 (Foundation) built and tested locally — waiting for the owner's OK to
create the tables and deploy.** Nothing is deployed yet (cloud revision 0, no tables).

## Phase 1 — Foundation (2026-11-06) ✅ code · ⏳ deploy

Done:
- `tgcloud/schema.js`: 14 tables — users, user_settings, roles, forced_channels, groups,
  group_settings, downloads, file_cache, counters, bans, audit_log, settings, processed_updates,
  error_log.
- `lib/`: config, util, i18n (fa/en/ru, identical keys, English fallback), roles (owner + 4 staff
  roles with permission flags), codec (`callback_data` ≤ 64 bytes), tg (Bot API + trace + error
  kinds), db/{users,system,channels,groups}, join (forced join), alerts (throttled owner notices),
  ui (screens), router. Handlers: `message`, `callback_query`, `my_chat_member`.
- `/start`: language picker on first run (Telegram's language preselected, ✓) → forced-join gate
  (a button per missing channel + "check again") → home. The home screen says downloading isn't
  available yet and offers only 🌐 Language. `/language` reopens the picker.
- Forced join: member / left / kicked / restricted / "member not found" / API error (= unknown,
  user held, channel marked, owner alerted ≤ every 3 h); positive results cached 5 min; owner and
  staff exempt; global switch `switch.forced_join`.
- First run seeds @HIDE_i_SEEK, @Nepenthw_ir, @wangerBots once (chat id, title, bot admin status).
- Idempotency: processed update_ids (pruned after 2 days by piggybacked housekeeping); double taps
  ignored; all writes single statements.
- Ban check (owner immune) and maintenance switch (staff exempt) — the screens to change them are
  Phase 4.
- `my_chat_member`: user blocked/unblocked; groups recorded with default settings; forced channel
  demotion → owner alert. Running counters: users, users_new, users_active, groups_active,
  groups_joined.
- Error boundary: error_log + owner alert (≤ every 30 min per source) + "something went wrong".
- Tests: **74 passing** (`npm test`) — i18n, roles (owner vs user, immunity, ranks), codec,
  forced-join classification, Bot API errors, /start flows, gate, seeding (also concurrent),
  duplicates and double taps, housekeeping, error boundary, my_chat_member, query plans (no scans of
  growing tables), module rules (budget, imports, purity, no secrets, no missing globals).
- Platform: `tgcloud run handlers/message` (fake id 100000001) → every module loads on Serverless;
  it stopped at "no such table" as expected. `migrate --local --dry-run` → 14 new tables, nothing
  dropped or changed.

Remaining for Phase 1 (after the owner's OK):
1. `npm run tg -- migrate --local --safe` (creates the 14 tables).
2. A few `tgcloud run` checks with fake ids on the real database, then delete the fake rows and
   reset the counters they touched (the seeded channels stay — they are real).
3. `npm run tg -- push` (the webhook goes live; the 5 queued updates are then delivered).
4. The owner sends `/start` to @Wanger_mediabot to see it work.

Not done here: a CI job — `.github/workflows/ci.yml` is outside this folder (brief §2).

## Phase 0 — Discovery (2026-11-05) ✅

Folder and CLI wrapper set up; Serverless limits measured on this bot; 14 platforms researched →
`docs/PLATFORMS.md`; first platforms proposed and confirmed: X/Twitter, Pinterest, Snapchat.

## Remaining phases

2 User dashboard · 3 Download core (X, Pinterest, Snapchat) · 4 Admin panel · 5 Groups · 6 Launch ·
7 Remaining platforms (one per session) · 8 `external` service (only on request).

## What I need from the owner

1. **OK to create the tables and deploy** (the 3 steps above). Nothing destructive: 14 new tables.
2. Later, not now: privacy mode is ON. For groups (Phase 5), either turn it off in BotFather
   (`/setprivacy` → Disable, then remove and re-add the bot) or make the bot admin in each group.
