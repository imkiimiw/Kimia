# Decisions

One line each: the choice — the reason. Newest phase last.

## Phase 0 (2026-11-05)

- The bot lives in `wanger-media/` as its own tgcloud project (app9080356648, `@Wanger_mediabot`) — the repository already holds other bots and the root is the to-do bot.
- The CLI runs only through `npm run tg -- …` (`scripts/tg.mjs`) with `Media_BOT_TGCLOUD_TOKEN` (trimmed; a generic `TGCLOUD_TOKEN` is ignored) — a stray token must never reach another bot; the stored value had a leading space.
- The owner's brief is saved verbatim as `docs/BRIEF.md` — later sessions need it and chat history doesn't carry over.
- Platform facts were measured with a temporary, gitignored, read-only probe (`tgcloud run`, deleted afterwards) — brief §3 asked to verify, and `tgcloud run` uses the real database, so the probe created no tables.
- Every outbound request sends an honest User-Agent naming the bot; no browser impersonation — impersonating a browser would be working around blocks (§6).
- No cookies are ever stored or sent, not even anonymous ones a page sets — §6 forbids using cookies; this is why TikTok video is out of reach.
- Third-party scraper services (FxTwitter, vxTwitter, cobalt, paid scraper APIs…) don't count as `public` and aren't used — `public` means what the platform itself serves; using one would be the owner's legal choice (asked in PROGRESS).
- X `public` = X's own embed JSON (`cdn.syndication.twimg.com`), not FxTwitter like `x_downloader_bot` — it's the platform's own public data and was verified from Serverless.
- Pinterest `public` = the official embed widget's JSON plus `i.pinimg.com` originals — both verified from Serverless; pin pages are 1.5 MB HTML and slower.
- Snapchat `public` = the Open Graph `og:video`/`og:image` of public Spotlight pages only — the only Snapchat link type verified to expose a file.
- Spotify uses oEmbed + Open Graph (title, artists, cover), not the Web API, and never its 30-s `og:audio` preview — no credentials or Premium needed; the brief says metadata only.
- X posts flagged `possibly_sensitive` are refused — they may be age-gated, which §6 forbids, and we can't tell which.
- Proposed first 3 platforms: X/Twitter, Pinterest, Snapchat (Spotlight) — all verified to serve real media publicly from Serverless; Discord is the low-risk substitute.
- Until an adapter is implemented and tested the bot reports the platform as UNAVAILABLE — nothing is SUPPORTED before it is built (§2).
- URLs are parsed by our own strict parser — the isolate has no `URL` or `URLSearchParams` (measured), and a pure parser is testable.
- Work is bounded by request counts and size checks, not by our own timeouts — there is no `setTimeout`/`AbortController` (measured), so a `fetch` can't be cancelled.
- A request that fails is retried at most once, and only if the invocation has time left — ~5 s `fetch: request failed` stalls happen (3 of ~40 probe requests).
- Multi-row writes stay ≤ 1 000 bound parameters per statement — 4 000 worked and 4 096 failed (measured), so 1 000 leaves a wide margin.
- Every query is index-backed and `LIMIT`ed, and statistics come from running counters — a query fails once it reads ≈ 50 000 rows (measured).
- Module budget: ≤ 90 deployed modules, enforced by a test from Phase 1 — earlier bots here had a 104-module deploy refused.
- Tests use Vitest (dev dependency only), as the brief says, not `node:test` like the other bots — the brief is explicit.
- No GitHub Actions "tick" is planned; housekeeping and broadcast batches piggyback on updates and buttons — the brief asks for zero external infrastructure; it's an option if the owner wants unattended progress.
- Files above Telegram's 20 MB by-URL limit are fetched as bytes; going past 30 MB with Range chunks (as `x_downloader_bot` does, up to 50 MB) is decided in Phase 3 after measuring memory and CPU — the brief caps bytes at 30 MB, and X variants often sit between 20 and 50 MB.

## Owner's answers (2026-11-06)

- First platforms confirmed: X/Twitter, Pinterest, Snapchat (Spotlight).
- The bot is admin in @HIDE_i_SEEK, @Nepenthw_ir and @wangerBots (owner).
- `public` methods may be built (OFF by default, risk note, owner switches them on per platform).
- Free third-party services may be used if they make the bot faster — evaluated in Phase 3 as an extra method per platform: OFF by default, risk note, its hosts allowlisted like any other.

## Phase 1 (2026-11-06)

- Raw SQL with the `sql` tag only, no query builder — rows stay plain, the local emulator stays small, and every statement can be checked with EXPLAIN.
- All SQL lives in `lib/db/` (a guard test enforces it) — one place to audit indexes and the 50 000-rows-read limit.
- A query-plan test runs every Phase 1 flow and fails if a statement scans a growing table — the rows_read limit fails at runtime, so it is enforced before deploy.
- The local emulator refuses > 4 000 bound parameters, transactions, PRAGMA and multi-statement strings — mirrors the measured platform.
- A getChatMember error holds the user (with a "couldn't check" note) and alerts the owner at most every 3 h per channel — brief: unknown is never "member", and a check that can't be evaluated denies.
- 429, network and 5xx errors don't mark a channel broken; 403 → `not_admin`, chat-not-found → `error` — only setup errors say something about the channel.
- "member not found" means not a member — measured on this platform by `x_downloader_bot`.
- The owner and all staff skip the forced-join gate — they run the bot; the brief requires the gate for users.
- A positive forced-join result is trusted for 5 minutes (`users.join_ok_until`) — brief: cache positive results "a few minutes".
- Updates are handled at most once: the update_id is recorded before processing — a redelivery must never send twice; a crash mid-way costs one retry by the user.
- A double tap = same message + same callback_data within 1.5 s, claimed by one conditional UPDATE — different buttons stay instant and parallel taps can't both pass.
- No waiting on 429 in interactive replies — there are no timers, and busy-waiting would burn the 3 s CPU budget; the user can retry.
- The users row is written at most once per user per day (plus on a profile change) — writes are slow, and the "active users" counter only needs the first activity of the day.
- Counter days are Tehran dates (fixed UTC+03:30) — the owner is in Iran and Iran has had no DST since 2022.
- Seed channels are inserted if missing, then the `seed.channels` flag is set; never re-seeded — the owner may remove a seed channel later (Phase 4).
- Seeding resolves each channel's chat id and title (getChat) and the bot's admin status — checks keep working after a username change, and a misconfigured channel is reported at once.
- `error_log` table added (not in the brief's list) — Serverless shows no logs for webhook invocations.
- The Phase 1 home screen says plainly that downloading isn't available yet and offers only the Language button — no placeholders, no buttons for unbuilt features.
- Group messages are ignored without any database write until Phase 5; `my_chat_member` already records groups silently — group counts are right from day one.
- `callback_data` codes are single letters plus arguments (`h`, `l`, `L:<lang>`, `j`) — the 64-byte limit leaves room for later screens.
- Invisible characters (ZWNJ) are written as `\u200c` escapes in source, enforced by a test — literal ones are invisible in review and easy to break.
- Vitest runs with `pool: 'forks'` — node:sqlite is used by the SDK emulator.
- Real-database checks use a fake user id (100000001) before `push`, and their rows are deleted with targeted statements afterwards — "No invented numbers": the counters must only count real users.
- Temporary `zz_*` modules are deleted before every `push` — the CLI uploads every file under `tgcloud/`, `.gitignore` doesn't apply to it.

## Phase 2 (2026-11-06)

- The main menu has no Download button until Phase 3 — brief §2: no buttons for unbuilt features; "My downloads", Settings, Help and About are built.
- The disclaimer comes after the forced-join gate and before every menu screen; the owner is exempt, staff are not — it is about the user's own downloads; the owner runs the bot.
- The disclaimer is versioned by `DISCLAIMER_VERSION_AT`: anyone who accepted earlier must accept again; an acceptance is stored as max(now, that date) — changing the text in substance needs a new acceptance, and an acceptance must never fall "before" its own version.
- The preferred quality (auto / best / data saver) is stored now and its screen says it applies once downloads exist — the brief puts it in Phase 2; saying so plainly keeps it from being fake.
- "My downloads" shows the latest 100 entries, 8 per page, by offset on `idx_downloads_user`; the count reads at most 100 index entries — bounded work far below the 50 000-rows-read limit, without keyset complexity.
- Every non-home screen has Back (to its parent: home, or settings for the quality and language pickers) and Home — brief §8.
- The language picker opened from Settings carries `:s` in its callback_data and returns to Settings — the user stays where they were.
- Arrows are avoided on the history pager (🔼 Newer / 🔽 Older) — left/right arrows read backwards in right-to-left Persian.
- About states what is stored about the user (id, name, username, language, settings, activity dates, download history) — honest privacy note; matches the schema.
- Phase 2 platform check without database writes: fake ids in group-chat payloads (ignored → every module loads) plus a temporary read-only module that builds each screen from the real database — a fake user can't pass the real forced-join gate, so a fake private run would only add rows to clean up.

## Phase 3 (2026-11-06)

- The owner's "free third-party services" permission is a fourth method, `thirdparty` (FxTwitter for X), OFF by default with its own risk note — it is neither the platform's public data nor the owner's own `external` service.
- X tries `public` first, then `thirdparty` only when public fails temporarily (5xx, network) — a "not found" from X is the answer, asking a third party again wouldn't change it.
- Private chats handle the first link of a message only; groups (Phase 5) take up to 3 — one status message per request, and an invocation has ≈ 30 s wall time.
- The status message is deleted on success (the media is the result) and replaced by the reason on failure — brief §8: one status message per request.
- Quota and cooldown are claimed atomically before any fetch; a failed request gives the quota back but keeps the cooldown — failing links can't be hammered, and users aren't charged for platform errors.
- Defaults: 30 downloads per user per Tehran day, 15 s cooldown, 50 MB max; staff and the owner are exempt — the owner can change them in Phase 4 (settings key `limits`).
- Variant choice: auto = best that Telegram fetches by URL (≤ 20 MB, fast), else best uploadable; best = best uploadable; small = smallest; the owner's max applies to both paths (a test caught it missing on the URL path).
- When the original is over the limit a smaller ready-made variant is sent with a note instead of asking — "offer a smaller variant" without an extra round trip; no transcoding.
- Bytes above one fetch's 30 MB are downloaded in 25 MB Range chunks up to Telegram's 50 MB upload limit (as `x_downloader_bot` does); without Range support such a file is refused — the brief's 30 MB cap was set before this was measured.
- A variant of unknown size goes by URL only (Telegram enforces its own limit) and is never downloaded by the bot — brief: check the size before downloading bytes.
- Uploads aren't started after 15 s of an invocation — the wall limit is ≈ 30 s and an interrupted upload helps nobody.
- Every redirect hop is checked against the platform's allowlist, also for size probes; a media URL that redirects off the allowlist is dropped entirely — Telegram would follow that redirect when fetching by URL.
- HEAD is used only for CDNs measured safe (X, Pinterest); everything else is probed with a one-byte Range GET — a HEAD to Snapchat's CDN crashes the invocation (measured).
- Pinterest video pins send their MP4 from the widget JSON's `video_list` (never the HLS playlist); Idea Pins send their cover with a note — measured in Phase 3, correcting Phase 0.
- X posts flagged `possibly_sensitive` and X tombstones are refused as age-restricted — brief §6 forbids age-gated content.
- Blocklist values: `url` = platform:id (catches every link form of a post), `account` = platform:name, `domain` = a host or any parent — checked before fetching and again with the author after resolving.
- The file_id cache is keyed (platform:id, quality); a refused file_id drops the cache row and the media is fetched again; partial deliveries are never cached.
- Captions: post text (decoded, t.co links removed, clipped), author, platform + source link on its own line, notes, then `@Wanger_mediabot`; ≤ 1024 characters.
- The minimal owner panel is `/admin` with platforms only (owner id check on every command and button) — brief §11.3; roles come with the full panel in Phase 4.
- Real responses recorded from Serverless are the test fixtures (`test/fixtures/`), captured hex-encoded through `tgcloud run` — tests never call real platforms and the parsers are checked against what the platforms really send.

## Phase 4 (2026-11-06)

- The owner asked to start Phase 4 right after the Phase 3 deploy without waiting — brief §2's "never start the next phase on your own" is overridden by that instruction; deploys still wait for the owner's OK.
- `/admin` opens for every staff role; each section appears only with its permission, and every button and every text input is checked again in `lib/admin/index.js` — buttons are never trusted on their own.
- Section → permission: overview VIEW_STATS · users VIEW_USERS (ban/unban/quota/note also need MANAGE_USERS and a higher rank) · channels and the forced-join switch: owner only · platforms, blocklist, cache purge MANAGE_PLATFORMS · switches, limits, texts MANAGE_SETTINGS · broadcast BROADCAST · audit VIEW_AUDIT · staff MANAGE_ADMINS — brief §4 and §8; "owner tools" of §6 are treated as platform moderation tools, so admins can use them in an emergency.
- Platform switches moved from owner-only (Phase 3) to MANAGE_PLATFORMS — brief §8 lists platforms under the role-based panel.
- Text input (search, quota, note, channel, blocklist value, purge link, limits, texts, broadcast message, new staff) is a pending state in `settings` ('input:<id>', 10 minutes, /cancel) — no schema change, and only staff messages pay the extra lookup.
- Users are found by numeric id or exact @username (index on lower(username)); there is no full user list — a list would have to scan the table.
- Bans: 1, 7, 30 days or permanent; the owner is immune and nobody acts on an equal or higher rank (lib/roles.js).
- A per-user quota (`users.quota_override`) replaces the global daily quota in the download policy; staff remain exempt.
- Staff notes are stored on the user row and never shown to users; the audit log records only their length — brief §9: never log full messages.
- Channel changes reach users within 5 minutes (when their cached membership pass ends) instead of resetting every pass — resetting would write every user row and could hit the rows-read limit.
- A channel can be added only if the bot is admin there (checked with getChatMember) — brief §5: membership checks only work then; private channels keep their invite link for the join button.
- Custom welcome / join texts are plain text (escaped; {name} filled in) per language in `settings` — staff can't inject HTML into what users see.
- Overview numbers come only from counters; a new counter `users_blocked` is kept exact by conditional updates wherever the blocked flag changes (block/unblock updates, a 403 on send, broadcast) — brief §8: no invented numbers.
- Broadcast copies the staff member's message with copyMessage (any type, no "forwarded" header) to every user in id order: 25 per button press, 5 piggybacked on any update; a lease stops parallel batches, the cursor advances after every message (nobody gets it twice), a 429 pauses until retry_after, a 403 marks the user blocked. One broadcast at a time.
- Broadcast batches read users by id range including blocked ones (skipped in code) — filtering on `blocked` in SQL could read far more than 25 rows when many users have blocked the bot.
- Staff permission flags can only narrow a role's defaults; going back to the defaults stores NULL.
- Credentials screens are not built: no built adapter has an official method that needs a key yet — brief §2: no buttons for unbuilt features.

## Owner's standing approval (2026-11-06)

- "Do all phases to the end, one by one; report each phase when done; I approve all of them" — each phase is deployed (safe migration + push) when its tests pass, without asking; destructive migrations, `push --force`, money and accounts stay with the owner (CLAUDE.md records the instruction for later sessions).
