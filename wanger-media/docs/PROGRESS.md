# Progress

**Current state: Phase 4 deployed (cloud revision 4, 2026-11-06). Working through Phases 5–8 under
the owner's standing approval (CLAUDE.md). The owner's Telegram test of Phase 3 is still open.**

## Phase 4 — Admin panel (2026-11-06) ✅ deployed (revision 4)

Done:
- `/admin` (and a 🛠 button in the menu) for every staff role; sections by permission, every button
  and input re-checked (`lib/admin/index.js`).
- 📊 Overview from counters (users total / active today / new today and 7 days / blocked, groups,
  downloads today and per platform today / all time).
- 👥 Users: search by id or @username; profile with quota use, downloads, last 5, note; ban 1/7/30
  days or forever, unban, personal quota (used by the download policy), note; history pages; role.
- 📢 Channels (owner): add by @username / t.me link / numeric id / forwarded post (bot must be
  admin), switch on/off, re-check, remove with confirmation, max 10.
- 🧩 Platforms (MANAGE_PLATFORMS): Phase 3 switches plus blocklist (post / account / domain), cache
  purge by link, recent failures per platform.
- ⚙️ Switches and limits: maintenance, downloads, forced join (owner), daily quota, cooldown, max MB.
- ✏️ Texts: welcome and forced-join texts per language (plain text, {name}), reset to default.
- 📣 Broadcast: any message → draft → start → 25-message batches by button + 5 piggybacked on any
  update; lease, per-message cursor, 429 pause, blocked users marked and counted; cancel.
- 📜 Audit log pages; 👮 Staff: appoint by id/@username, roles by rank (SUPER_ADMIN only by the
  owner), per-person flags that only narrow, remove.
- Schema (dry run): `users.quota_override`, `users.note`, table `broadcasts`, index
  `idx_downloads_platform_status` — 4 additive changes.
- Tests: **184 passing** — every panel button refused for ordinary users with nothing changed,
  sections per role, ranks (moderator vs admin, owner immune), inputs and their expiry, channels,
  switches, texts, broadcast (batches, blocked users, 429 + piggyback, one at a time), staff and
  flags, blocklist/purge/failures, audit pages, query plans.
- Platform (no writes): modules load; all admin screens built from the real database.

Deployed under the owner's standing approval: `migrate --local --safe` (4 applied) → `push`
(revision 4); webhook and schema in sync; read-only check afterwards: no errors, broadcast table
reachable.


## Phase 3 — Download core (2026-11-06) ✅ deployed (revision 3) · ⏳ owner's test in Telegram

Done:
- Registry + 3 adapters behind one interface (`identify`, `capabilities`, `expand`, `resolve`,
  `healthCheck`, risk notes in fa/en/ru): **X** (`public` = X's embed JSON, `thirdparty` =
  FxTwitter), **Pinterest** (image and video pins; Idea Pins → cover image), **Snapchat** (Spotlight).
  The other 11 platforms are recognised and answered "not supported yet".
- Strict URL parsing (`lib/url.js`), policy engine in the brief's order, deny by default
  (`lib/policy.js`), quota + cooldown claimed atomically, blocklist (URL / account / domain).
- Delivery (`lib/delivery.js`): by URL ≤ 20 MB, else download (Range chunks) and upload ≤ 50 MB;
  albums via sendMediaGroup; upload fallback when Telegram can't fetch a URL; captions with platform
  and source link; file_id cache with stale-id recovery; history rows and counters per platform.
- Pipeline (`lib/download.js`): one status message per link, specific localized errors.
- Owner panel `/admin` (owner only): platforms, methods on/off with the risk note first, pause,
  health check; audit-logged. Everything starts OFF.
- Menu: ⬇️ Download (lists what is switched on); Help lists the platforms; About without the
  "Telegram Serverless" wording (owner's request); version 0.3.0.
- Schema: `users.dl_day / dl_count / last_dl_at`, table `blocklist` (dry run: 4 additive changes).
- Tests: **164 passing**, including recorded real responses as fixtures, the whole pipeline end to
  end, security (allowlists, redirects off the allowlist, malicious URLs), size limits, quota and
  cooldown, cache, fallbacks, one platform failing without breaking the others, owner-only panel,
  query plans.
- Live on Serverless (no messages, no database writes): all three adapters resolved real posts,
  probed sizes and picked variants; all three health checks pass.
- Found and fixed along the way: a HEAD to Snapchat's CDN crashes the invocation (now Range only);
  Pinterest video pins do expose an MP4; the owner's max size wasn't applied to by-URL sends; the
  Pinterest pinner name lives in `profile_url`; HTML entities in post texts.

Deployed with the owner's OK: `migrate --local --safe` (4 changes applied) → `push` (21 modules,
revision 3); webhook and schema in sync; read-only check: no errors, new columns present.

Remaining for Phase 3: the owner switches methods on in `/admin` and sends one public link from each
platform — Phase 3 is done when the media arrives (brief §11.3).


## Phase 2 — User dashboard (2026-11-06) ✅ deployed (revision 2)

Done:
- Flow: language (first run) → forced join → **disclaimer** (first use, versioned; owner exempt) →
  **main menu**: 📥 My downloads · ⚙️ Settings · ❓ Help · ℹ️ About. No Download button yet (Phase 3).
- My downloads: latest 100, 8 per page, newest first, 🔼/🔽 pager, honest empty state, escaped.
- Settings: language (returns to Settings in the new language) and preferred quality (auto / best /
  data saver; stored in `user_settings`; the screen says it applies once downloads exist).
- Help (commands; honest that downloading isn't available yet) and About (version 0.2.0, channel,
  what is stored about the user). Commands: /help, /about, /settings, /downloads (/history), /language.
- Back and Home on every non-home screen; expired or invalid buttons → toast + fresh screen; the
  gates (ban, maintenance, forced join, disclaimer) run before every screen and every setting change.
- New modules: `lib/menu.js`, `lib/db/downloads.js` (23 modules in all).
- Tests: **99 passing** — Phase 1 suite updated for the disclaimer step, plus dashboard flows,
  pagination (own rows only, cap at 100, clamping), settings, language from settings, gates on
  navigation, Back/Home on every screen in every language, callback validity, query plans (the
  history queries use the index; checked by removing the index and seeing the test fail).
- Bug found by the tests and fixed: the last history page could show entries beyond the latest 100;
  a disclaimer accepted before its version date kept reappearing.
- Platform (no writes): group-chat payloads with fake ids → ignored, all modules load; a temporary
  read-only module built all six screens from the real database.

Deployed with the owner's OK: `push` → 10 modules (8 changed, 2 new), revision 2; no schema change
(`migrate --local --dry-run` in sync); webhook in sync, queue empty. Read-only check afterwards: no
errors in `error_log`, counters consistent with the users table.

## Phase 1 — Foundation (2026-11-06) ✅ deployed


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

5 Groups · 6 Launch ·
7 Remaining platforms (one per session) · 8 `external` service (only on request).

## What I need from the owner

1. Phase 3 test (still open): `/admin` → 🧩 Platforms → switch methods on → send one public link
   each from X, Pinterest and Snapchat Spotlight.
2. Later, not now: privacy mode is ON. For groups (Phase 5), either turn it off in BotFather
   (`/setprivacy` → Disable, then remove and re-add the bot) or make the bot admin in each group.
