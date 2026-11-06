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
