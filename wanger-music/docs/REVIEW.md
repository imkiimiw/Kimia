# Phase 8 review (2026-11-06)

Security, error handling, rate limits, indexes and queries, a load test and a backup/restore test on
the staging bot `@Wangermusic_bot`. Every finding is either fixed (🔧) or listed as a known
limitation (⚠️). ✅ = checked, nothing to change.

## Security

| | Finding | Result |
|---|---|---|
| ✅ | Every admin callback route checks its permission on the server and requires the private chat | Table-driven test over the whole route registry (a normal user gets only a neutral answer); owner-only operations are checked again in the service |
| ✅ | Callback data | Strict codec (≤ 64 bytes, typed arguments); forged or stale data → neutral answer |
| ✅ | SQL | Every value is bound (`sql` tag). Identifiers come only from fixed lists (`EDITABLE` in tracks/sources/destinations, `BACKUP_TABLES`); a test feeds an injection-shaped column name to restore |
| ✅ | HTML | `t()` escapes every variable; every `raw()` use was read (all dynamic parts go through `esc()`); the fake Telegram parses the HTML of every message in every test |
| ✅ | Logs | The logger writes whitelisted fields only — no message texts, tokens or raw updates |
| ✅ | Secrets | None in code. `.gitignore` covers `.tgcloud/`, `secrets.js`, `.env`, `endpoints/zz_*`. CLI tokens only in environment variables (or a token file outside the repository) |
| ✅ | Endpoints | `opsTick` is owner-only through the platform-verified init data; its webhook input is reduced to a boolean, two counts and a 200-character text. Temporary `zz_*` modules (smoke, backup, seed) are never deployed: `deploy` refuses while one exists and the staging mirror skips them |
| 🔧 | Anyone can make the bot an admin of their channel, and each such channel sent the owner a prompt (throttled per channel only) | Only the owner or an admin making the bot admin is prompted; anyone else is logged and ignored. Channels can still be added by hand (📡 / 📢) |
| 🔧 | No limit on how fast one user can send messages or press buttons | Flood guard: more than 30 per minute → ignored, with one notice; staff are never limited (one conditional `UPDATE` per update; two new `users` columns) |
| ⚠️ | A backup holds user ids, usernames and names | It is sent only to the owner's private chat; keep the file private. Restore is a script, never a bot button |
| ⚠️ | Play counts can be inflated by choosing the same result again and again | Each choice really sends the audio; counts are popularity hints, not money |
| ⚠️ | A user who leaves a force-join channel keeps results until the pass expires | By design: the pass is cached for `forcejoin.ttl_seconds` (default 10 min) |

## Error handling

| | Finding | Result |
|---|---|---|
| 🔧 | A reply to a sender who deleted the chat / blocked the bot (or a 429 for that one chat) was a "severe error": error row + owner alert (seen on staging with fixture users) | Logged as a warning, the user is marked unreachable (not for 429), no error row, no alert. The same error on another chat is still an error |
| 🔧 | One broken `file_id` among inline results makes Telegram refuse the whole answer → the user got nothing (seen on staging) | Fallback answer (empty list + «🔎 search in the bot») and a throttled owner note |
| 🔧 | **Platform limit: ≤ 4096 bound values per statement** ("Run error"), found by the staging restore | Measured; backup upserts are split by value count; every other statement stays ≤ ~700; the local SDK now enforces the limit |
| 🔧 | **Platform limit: ≤ 10 000 rows written per statement** ("rows_written limit exceeded"), found by the staging restore | Measured; restore clears, search-index clear, stats retention, error retention, pass invalidation and channel queue cancel now work in batches of ≤ 5000; the local SDK enforces the limit (rolled back, like the platform) |
| 🔧 | The search index rebuilt only 20 tracks per tick (a restored catalog of 5000 tracks would take 250 ticks) | It rebuilds batch after batch until the tick's budget; the restore script drives it right away |
| 🔧 | `dayStart()` was an hour off on daylight-saving days (worker daily limits, stats days in such zones) | Fixed in Phase 7 (Tehran has no DST) |
| ✅ | Boundary | Never rethrows; error row + throttled alert; analytics counters are flushed after errors too |
| ⚠️ | Whether the platform re-delivers an update after a throw is undocumented | Handlers always return normally (unchanged decision) |

## Rate limits (spec 10.8)

| | Item | Result |
|---|---|---|
| ✅ | Broadcast | ≤ 25 messages/s, batches, 429 → global cooldown, 403 → user marked blocked |
| ✅ | Publishing worker | One post per channel per tick, channel interval / hours / daily limit, 429 cooldown, backoff |
| ✅ | Archive channel | ≤ 3 per tick, ≤ 18 per minute |
| ✅ | Owner alerts | One per kind per 30 min (errors) / 1–3 h (channels, monitoring) |
| 🔧 | Update dedupe rows were pruned 500 per tick: above ~8 updates/s the table would grow forever | 5000 per tick |
| 🔧 | Flood guard (above) | 30 per user per minute |
| ⚠️ | `tgcloud run` itself is rate-limited by the platform ("Too many requests: retry after N") after ~100 calls in a minute | Scripts wait and retry; the 30-minute GitHub job makes 2 calls |

## Indexes and queries

`npm run query-review` runs the whole test suite with `EXPLAIN QUERY PLAN` on every statement
(277 distinct statements) and fails on any full scan of a growing table that is not on its reviewed
list. Result: **0 unexpected scans**; 28 accepted, each with its reason — totals on owner/admin
screens (`users.stats`, `catalog.counts`, `publisher.counts`, index size), the newest-errors walk,
pass invalidation (rare owner action), and backup export/restore (reading or clearing a whole table
is the point). It runs in CI.

- 🔧 New index `idx_pub_channel_id (channel_id, id)`: a channel's history no longer sorts all its rows.
- Sorts in a temporary b-tree after an index lookup (25) were read one by one: each sorts only the
  rows the index found (search ranking of matched tracks, a day of stats, a channel's open queue).

## Load test (staging, 2026-11-06)

5000 synthetic tracks (Persian and English, ~30 000 index terms), 2000 users; `node scripts/loadtest.mjs run`
(real handlers through `tgcloud run`, 4 in parallel, 90 runs):

| Handler | Server time p50 | p95 | max |
|---|---|---|---|
| `inline_query` (empty, prefixes, words, Persian, misses, page 2) | 96 ms | **166 ms** | 188 ms |
| `message` (private search) | 147 ms | 273 ms | 273 ms |
| `chosen_inline_result` | 24 ms | 118 ms | 118 ms |

The spec's target (inline p95 < 800 ms) is met with a wide margin. The times include one Bot API
round trip (fake query ids make Telegram refuse the answer). No errors from 4 parallel runs. Wall
time per call is ~1.7 s of CLI overhead, not bot time.

## Backup and restore (the Phase 8 "done when")

On staging: export (7124 rows, 1.65 MB, built in 658 ms) → download through the bot → `restore
--replace` (every table emptied and reloaded, 28 chunks, search index rebuilt) → export again →
**every row of every table identical** (only internal timestamps and the backup's own audit rows
differ). Locally, the e2e tests do the same into a brand-new database and check that search works.
