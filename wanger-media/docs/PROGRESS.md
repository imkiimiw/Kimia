# Progress

**Current state: all phases (0–8) done; Phase 8 deployed (cloud revision 8, version 1.2.0,
2026-11-06). Open with the owner: switching methods on in /admin → 🧩 Platforms (all are off), the
Telegram test of Phase 3, and — only if wanted — a server for the large-file relay (Phase 8).**

## Phase 8 — External service and uploader (2026-11-06) ✅ deployed (revision 8) · service not hosted

Done:
- Research (docs/PHASE8.md): what a service can lift (cloud Bot API 50 MB → local Bot API server
  2000 MB; ≈ 30 s wall time) and what it must not (blocks, DRM, cookies); the final contract
  (health, relay, resolve); hosting needs; the uploader per platform (all need the owner's accounts
  and an app review or audit; Spotify and Twitch have no upload API).
- Bot: `lib/external.js` + owner-only Admin › Platforms › 🔌 External service (address, key — never
  shown, message deleted — relay on/off, max size, test, remove; audit-logged). Large-file relay in
  private chats; the method `external` on every adapter except Spotify (OFF, risk note, needs the
  service configured); `drm` reason; audio items in delivery; POSTs never follow redirects.
- Reference relay `external-service/` (Node 22, no dependencies; Docker Compose with
  telegram-bot-api and Caddy; README with setup for the owner); smoke-tested locally (health, auth,
  refusals) — the full path needs the owner's server.
- Not built: an uploader (blocked on the owner's developer accounts and approvals); a resolve engine
  (would break the hard limits for the platforms that need one).
- Tests: **251 passing** (17 new: owner-only config, key never shown/logged and its message deleted,
  key sent only to the service, relay job contents and fall-backs, never in groups, resolve with
  host checks and code mapping, the relay service's checks).
- Deployed under the owner's standing approval: no schema change → `push` (revision 8); webhook in
  sync; read-only check afterwards: no errors, the service is not configured (nothing changes for
  users until the owner sets it up).
- Open risk (Unverified): using a local Bot API server for the same bot without `logOut` — test with
  a test bot first (external-service/README.md).

## Phase 7 — Remaining platforms (2026-11-06) ✅ deployed (revision 7)

Done:
- Ten new adapters, each with recorded fixtures, unit tests, an end-to-end path and a live check from
  Serverless (docs/PLATFORMS.md §8): **Instagram** (LIMITED: embed page — photos, carousels, videos it
  includes; copyright-blocked reels → cover + note), **Discord** (LIMITED: attachment links; images,
  GIFs, MP4 only, extension and Content-Type both checked), and information cards for **TikTok,
  Facebook, Threads, YouTube, Reddit, Twitch, Spotify, SoundCloud** (METADATA_ONLY). **LinkedIn** is
  refused with the reason.
- Pipeline: result status `meta` (cover by URL after the allowlist/redirect probe, else a text card;
  cached; quota given back, cooldown kept; counters `dl_meta`, `dl_meta:<platform>`, `g_meta:<chat>`;
  history ℹ️; overview counts cards). Hints after refusals (Discord message/expired links, Twitch clips).
- Groups: default allowed platforms = the ones that send files; card platforms are switched on by
  group admins (13 toggles, 3 per row). Admin › Platforms lists 13 platforms, 2 per row.
- No schema change. Health checks: all 13 adapters OK from Serverless.
- Tests: **234 passing** (33 new: link forms incl. look-alike hosts, every recorded response, cards,
  cache, quota refund, cover refused / redirected off the allowlist, Instagram album / cover / missing,
  Discord file types and expired links, cards in groups, overview).
- Deployed under the owner's standing approval: `migrate --local --safe` (no changes) → `push`
  (revision 7); webhook in sync; read-only check afterwards: modules load, no errors logged.
- Not verifiable live: a valid signed Discord attachment link (none available; the expired path and
  the CDN were checked).

## Phase 6 — Launch (2026-11-06) ✅ deployed (revision 6)

Done:
- `lib/botprofile.js`: localized command menus (private, groups, owner's /admin) and descriptions
  (long + short) in fa, en (default), ru; owner button in Admin › Switches; applied once at launch
  (14 calls OK, read back).
- README walkthrough: Windows setup, Serverless + CLI token, migrate → push, forced-join channels,
  groups and privacy mode, the admin panel, honest limits.
- Version 1.0.0. Tests: **201 passing** (profile scopes/languages/limits, owner-only button).
- Final review: the error boundary, gates and permission checks re-read; no open issues found.
  Not done (outside this folder, brief §2): a CI job in `.github/workflows/ci.yml`.


## Phase 5 — Groups (2026-11-06) ✅ deployed (revision 5)

Done:
- `lib/groups.js`: links of usable platforms picked up in groups (text and text_link entities, up to
  `max_links`), media replied with the source link; everything else ignored silently; ordinary chat
  costs no write.
- Per-group settings via `/settings` (admins only, re-checked on every press, anonymous admins,
  double-tap guard): auto-download, admins-only, silent, links per message, max MB, member and group
  cooldowns, language, allowed platforms; audit-logged.
- `/status` (settings, today's usage, honest privacy diagnosis), `/platforms`, `/help`; intro when
  the bot is added (adder's language).
- Forced join in groups: owner switch (Admin › Switches), off by default; one prompt per member per
  6 hours; positive checks cached per member.
- Channel posts / automatic forwards ignored.
- Schema: table `group_members`, `groups.last_dl_at`, `groups.last_cb`, `groups.last_cb_at_ms`.
- Tests: **197 passing** (13 new group tests: intro and privacy diagnosis, pick-up, silence, cooldowns,
  max links, admins-only, banned, silent mode, channel forwards, forced join prompt, settings by
  admins only incl. demotion, double tap, /status, /help) + query plans for the group flows.


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


7 Remaining platforms (one per session) · 8 `external` service (only on request).

## What I need from the owner

1. Phase 3 test (still open): `/admin` → 🧩 Platforms → switch methods on → send one public link
   each from X, Pinterest and Snapchat Spotlight.
2. Later, not now: privacy mode is ON. For groups (Phase 5), either turn it off in BotFather
   (`/setprivacy` → Disable, then remove and re-add the bot) or make the bot admin in each group.
