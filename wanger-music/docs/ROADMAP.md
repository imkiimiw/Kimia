# Roadmap

One phase at a time (docs/SPEC.md §13). Each ends with all tests green, the docs updated, a report,
and a stop until the owner says "implement Phase N".

| Phase | Scope | Status |
|---|---|---|
| 1 | Core: config, i18n, router + callback codec, error boundary, logging, update dedupe, users, permissions + admins, force-join (+ management), /start /help /lang /cancel /admin, admin menu, ⚙️ Settings, 🧪 System Status, tick (piggyback / manual / opsTick + GitHub Actions), 📣 Broadcast, audit log | **Built and tested locally — not deployed yet (waiting for the owner's OK)** |
| 2 | Music core: `tracks`, ingestion by send/forward, import card + bulk summary, normalization, duplicates, language classification, provider interface, 🎵 Music, removal, optional archive | **Built and tested locally — not deployed yet.** Deferred (optional in the spec): re-uploading a file with a new cover/tags |
| 3 (next) | Search + inline: `track_terms`, private search, `inline_query` + `chosen_inline_result` handlers, pagination, inline force-join gate (already built: `forcejoin/gate.js#inlineGateAnswer`), deep links | — |
| 4 | Sources: `channel_post` handler, source management, import pipeline, "bot added to a channel" prompt | — |
| 5 | Destination channels: add/edit/enable/remove with rights checks, rules, captions with preview, approval, schedule fields, health. **Channels named by the owner: @WangerBeat (English), @WangerFlow (Persian)** | — |
| 6 | Automatic publishing: routing, queue, worker on the tick, approvals, retries, cooldown, windows, history, uncertain handling | — |
| 7 | Analytics: `stats_daily`, 📊 dashboard | — |
| 8 | Hardening: reviews, load test on staging, backup export/restore, monitoring, recovery docs | — |

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

## Module budget

58 of ≤ 85 modules used after Phase 2 (+9). The platform refused a 104-module deploy for another bot.
Rough plan: Phase 3 ≈ +6, Phase 4 ≈ +4, Phase 5 ≈ +4, Phase 6 ≈ +5, Phase 7 ≈ +3, Phase 8 ≈ +2 → ≈ 82.
