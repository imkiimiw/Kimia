# Progress

**Current state: Phase 1 (Foundation) done and deployed (cloud revision 1, 2026-11-06). Next: Phase 2
(User dashboard), only when the owner names it.**

## Phase 1 — Foundation (2026-11-06) ✅

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
- Tests: **76 passing** (`npm test`) — i18n, roles (owner vs user, immunity, ranks), codec,
  forced-join classification, Bot API errors, /start flows, gate, seeding (also concurrent),
  duplicates and double taps, housekeeping, error boundary, my_chat_member, query plans (no scans of
  growing tables), module rules (budget, imports, purity, no secrets, no missing globals).
- Platform: `tgcloud run handlers/message` (fake id 100000001) → every module loads on Serverless;
  it stopped at "no such table" as expected. `migrate --local --dry-run` → 14 new tables, nothing
  dropped or changed.

Deployed with the owner's OK (2026-11-06):
1. `migrate --local --safe` → 14 tables; all 5 indexes verified in `sqlite_master`.
2. Fake-id checks on the real database (user 100000001): first run seeded the 3 channels (real chat
   ids and titles; the bot is admin in all three), language picker, language saved, gate with 3
   missing channels ("member not found"), redelivered update skipped, block recorded. The fake rows
   (user, 3 counter rows, update ids 1–4) were deleted afterwards; temporary modules removed.
3. `push` → 21 modules, revision 1. Webhook: `message, callback_query, my_chat_member`, in sync,
   queue empty. `migrate --dry-run` → in sync. The queued updates were handled without errors
   (2 users, 1 group recorded; counters match).

Two fixes found while preparing the real-database checks (tests added): "user not found" no longer
blames a channel, and editing a message in a chat the bot can't reach is not an error.

Not done here: a CI job — `.github/workflows/ci.yml` is outside this folder (brief §2).

## Phase 0 — Discovery (2026-11-05) ✅

Folder and CLI wrapper set up; Serverless limits measured on this bot; 14 platforms researched →
`docs/PLATFORMS.md`; first platforms proposed and confirmed: X/Twitter, Pinterest, Snapchat.

## Remaining phases

2 User dashboard · 3 Download core (X, Pinterest, Snapchat) · 4 Admin panel · 5 Groups · 6 Launch ·
7 Remaining platforms (one per session) · 8 `external` service (only on request).

## What I need from the owner

1. **Try it in Telegram:** send `/start` to @Wanger_mediabot (you skip the gate as owner; a second
   account shows the gate and the "check again" flow).
2. Later, not now: privacy mode is ON. For groups (Phase 5), either turn it off in BotFather
   (`/setprivacy` → Disable, then remove and re-add the bot) or make the bot admin in each group.
