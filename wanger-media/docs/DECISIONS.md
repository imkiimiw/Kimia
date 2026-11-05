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
