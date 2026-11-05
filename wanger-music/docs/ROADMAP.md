# Roadmap

One phase at a time (docs/SPEC.md §13). Each ends with all tests green, the docs updated, a report,
and a stop until the owner says "implement Phase N".

**Deploy state (2026-11-05):** Phases 1–6 deployed to production with the owner's explicit OK
(commit `2d7a9be`: migrate applied 17 safe steps, 78 modules pushed, webhook in sync; read-only smoke
check green). Phase 7 deployed the same day (commit `e97e5f8`): 2 safe steps (`stats_daily`,
`idx_users_created`), 21 modules updated (81 in all), webhook in sync; the smoke check found the
dashboard equal to direct SQL counts (today and 7 days).

| Phase | Scope | Status |
|---|---|---|
| 1 | Core: config, i18n, router + callback codec, error boundary, logging, update dedupe, users, permissions + admins, force-join (+ management), /start /help /lang /cancel /admin, admin menu, ⚙️ Settings, 🧪 System Status, tick (piggyback / manual / opsTick + GitHub Actions), 📣 Broadcast, audit log | **Deployed** |
| 2 | Music core: `tracks`, ingestion by send/forward, import card + bulk summary, normalization, duplicates, language classification, provider interface, 🎵 Music, removal, optional archive | **Deployed.** Deferred (optional in the spec): re-uploading a file with a new cover/tags |
| 3 | Search + inline: `track_terms` (+ `artists`, `artist_aliases`), private search, `inline_query` + `chosen_inline_result` handlers, pagination, inline force-join gate, deep links, inline caption template | **Deployed** |
| 4 | Sources: `channel_post` handler, `sources` table, 📡 Sources (add / enable / mode off·draft·active / default language / remove), import pipeline as the system actor, "bot added to a channel" prompt (Source · Destination · Force-join · Ignore) | **Deployed** |
| 5 | Destination channels: `destination_channels`; add (one-tap for @WangerBeat = English, @WangerFlow = Persian, or forward / @username / id) with the bot's rights checked; rules (languages, genres, excluded genres, min confidence); caption template with a preview to the owner; post format; schedule (interval, hours, daily limit, time zone); approval; enable / auto-publish; rights check; soft removal; health from my_chat_member. **Posts nothing.** | **Deployed** |
| 6 | Automatic publishing: `publications`; routing on activation (idempotent, no backfill; explicit owner backfill with preview), approval queue + digest + review screen, worker on the tick (lease, interval / hours / daily limit, 429 cooldown, backoff, permanent errors), uncertain handling, history per track/channel, cancel on removal, delete channel posts, pause switch | **Deployed** |
| 7 | Analytics: `stats_daily` (event counters written once per update; derived numbers recomputed for today + yesterday by the tick every 15 min and on open; retention 400 days, plays per track 90), 📊 dashboard (users total/new/active/blocked, inline + private searches, plays, top tracks, force-join conversions, publications per channel, sources), daily table, top tracks | **Deployed** |
| 8 (next) | Hardening: reviews, load test on staging, backup export/restore, monitoring, recovery docs | — |

## Interfaces already in place for later phases

- `runTick` has a processor list (`lib/jobs/tick.js`): Phase 6 adds `publications` and `digests`.
- `telegram/errors.js` already classifies file, caption, rights and chat errors for the worker;
  `telegram/limiter.js` has the backoff (1, 2, 4… min, cap 60) and the global 429 cooldown.
- `client.inspectChannel()` resolves a channel and the bot's rights — reused by sources and
  destinations.
- `ADMIN_SECTIONS` + `CURRENT_PHASE` (static config): a section's placeholder turns into the real
  screen when its phase is built.
- Settings for later phases exist already (`inline.*`, `digest.interval_seconds`).
- Phase 2 → later: `catalog.version` is bumped on every activate/hide/remove (Phase 3 cache keys);
  `catalog.activate()` and `catalog.remove()` mark where Phase 6 starts routing / cancels publications;
  `ingest.importAudio(actor, message, { sourceType, sourceId, sourceDefaultLanguage })` is the Phase 4 pipeline;
  `music/providers/catalog.js` implements the `MusicProvider` interface (search is a prefix search until Phase 3).

- Phase 3 → later: `publishing/captions.js` (template renderer: escaping, empty lines dropped, 1024 limit)
  is ready for Phase 5 channel templates.

- Phase 4 → later: the "bot added" prompt's 📢 Destination button is wired to `destinations.manage`
  and answers "Phase 5" until destinations exist.

- Phase 5 → Phase 6: `publishing/rules.js#matches(track, channel)` (match + needsApproval) and
  `withinHours()`, `hoursOf()`; destinations keep `min_interval_seconds`, `daily_limit`,
  `time_zone`, `last_published_at` for the worker; `destinations.onBotStatusChange` already disables
  a channel that loses post rights.

- Phase 7 → Phase 8: `stats/service.js` documents every metric (`METRICS`); `app.stats.count()` is the
  one way to count an event; monitoring can read `stats_daily` (e.g. rising `pub` failures) and the
  error log.

## Module budget

81 of ≤ 85 modules used after Phase 7 (+3: `repositories/stats`, `stats/service`, `admin/stats_ui`).
The platform refused a 104-module deploy for another bot. Phase 8 ≈ +2 → ≈ 83.
