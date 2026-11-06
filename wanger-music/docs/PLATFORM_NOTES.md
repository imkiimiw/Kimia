# Platform notes — Telegram Serverless (verified)

Checked on **2026-11-05** for bot **app9280424458** (`@Wange_Musicbot`, CLI 0.2.0) against
[core.telegram.org/bots/serverless](https://core.telegram.org/bots/serverless) ("Recent changes:
October 6, 2026"), the scaffold's `AGENTS.md` and `docs/tgcloud-sdk.md`, and a **temporary probe
module run with `npx tgcloud run`** (never deployed, deleted afterwards; it used no persistent
tables and only read-only Bot API calls).

Legend: **Official** = stated in the official docs · **Measured** = observed with `tgcloud run` today
(may change without notice; production webhook invocations were not measured because nothing is
deployed yet) · **Unknown** = neither documented nor measurable without deploying.

## Answers to the Section 2 questions

| # | Question | Answer | Source |
|---|---|---|---|
| 1a | CPU time per invocation | **≈ 3 s.** A loop of 3·10⁹ iterations died with `CPU timer exceeded` after 3.3 s; 3·10⁸ (≈ 1 s) was fine. | Measured |
| 1b | Wall-clock time | **≈ 30 s** under `tgcloud run`: three chained 9-second HTTP waits (28 s) succeeded, five (≈ 45 s) failed at 31 s with `HTTP 500` from the server. The webhook path's limit is unknown. | Measured |
| 1c | Memory | ≥ 512 MB could be allocated (32 × 16 MB typed arrays); the real cap is unknown. | Measured |
| 1d | Concurrency | **Unknown.** Assume updates can run in parallel (Telegram may deliver several at once): every state change is a single atomic statement. | Unknown |
| 1e | Clock | `Date.now()` does **not** advance during synchronous CPU work (0 ms across a 1 s loop) but does advance across `await`s (I/O). Time budgets are therefore checked between awaited calls and backed by item caps. | Measured |
| 2 | Module-level variables between invocations | **Not kept between `tgcloud run` calls** (each run had a new random boot id and a counter of 1). Production is unknown → treated as *not surviving*; in-memory caches are per-invocation only. | Measured |
| 3 | Transactions / atomic batches | **None.** `db` has no `transaction`/`batch`; raw `BEGIN`, `ROLLBACK`, `SAVEPOINT` → `not authorized`; a two-statement string → `Tail of the query is ignored`. Atomicity = **one statement**: conditional `UPDATE … WHERE`, `INSERT … ON CONFLICT`, `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING`, multi-row `INSERT`. `WITH` (CTE) queries work. | Measured |
| 4 | FTS5 full-text tables | **Not available.** `CREATE VIRTUAL TABLE … USING fts5` and `fts4` → `not authorized` (tested in the TEMP schema; `CREATE TEMP TABLE` is refused too). The schema DSL has no virtual-table builder, so migrations can't create one either. Search (Phase 3) uses the `track_terms` table with index range/GLOB queries, as the spec planned. | Measured |
| 5 | Native scheduler / cron / delayed execution | **None.** No cron in the docs or the CLI; no `setTimeout`/`setInterval`/`queueMicrotask` in the isolate. Code runs only while an update, an endpoint call or `tgcloud run` is being handled. → the tick mechanism (spec 10.7) with the GitHub Actions fallback. | Official (none described) + Measured |
| 6 | Config / secrets / environment variables | **None for deployed code.** `TGCLOUD_TOKEN` is read only by the CLI. Bot API calls are pre-authenticated, so the MVP needs no secret. Static values live in `tgcloud/lib/config/static.js`, runtime values in the `settings` table. | Official |
| 7a | A handler throws | The docs only say an endpoint's exception becomes a generic 500 with the message in "your logs", and `tgcloud run` exits non-zero. Whether Telegram/the platform **re-delivers** a webhook update after a handler throws is **unknown**. → every handler and endpoint runs inside an error boundary that never rethrows; side-effect updates are de-duplicated by `update_id` in case of redelivery. | Official + Unknown |
| 7b | Production logs | **No log viewer for webhook invocations**: the CLI has no `logs` command; `console.*` output is shown by `tgcloud run` and by BotFather when a handler is run from there. → errors go to the `error_log` table, severe ones are alerted to the owner (throttled), and 🧪 System Status shows the last ones. | Official + Measured |
| 8a | Web Crypto | **Available**: `crypto.getRandomValues`, `crypto.randomUUID`, `crypto.subtle`. Public ids use `getRandomValues` (with a fallback). | Measured |
| 8b | `Intl` time zones | **Available**: `new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran' })` works. (An older bot in this repo found no `Intl` on 2026-10-31, so the code keeps a fixed-offset fallback: Tehran = UTC+03:30, no DST since 2022.) | Measured |

## Other measured facts

| Area | Finding |
|---|---|
| Globals | Present: `crypto`, `Intl`, `TextEncoder`, `String#normalize`, regex `\p{…}`. **Missing:** `setTimeout`, `setInterval`, `queueMicrotask`, `URL`, `structuredClone`, `performance`, `Buffer`, `process`. Dynamic `import()` → `Not supported`. |
| SQL functions | Work: `unixepoch()`, `strftime`, `datetime`, `json_extract`, `json_set`, `json_each`, `json()`, `lower`, `GLOB`, `LIKE`, `instr`, `substr`, `replace`, `printf`, `coalesce`, `iif`, `max/min` (scalar), `abs`, `hex`, `random()`, `unicode`, `char`, `trim`, `group_concat`, `total`, `changes()`, `last_insert_rowid()`. Refused: `sqlite_version()`, `PRAGMA …`. |
| Bot API | `getMe` → id **9280424458**, username **`Wange_Musicbot`** (the spec's "WangerMusicBot" is not the real username), name "Wanger Music", `supports_inline_queries: true` (inline mode is already on). |
| `getChatMember` for a non-member | **400 "Bad Request: member not found"** (not `status: left`), even when the bot is admin — measured on the platform by another bot in this repository (x_downloader_bot, 2026-11-05). Classified as *not a member* (`telegram/errors.js`); before this fix the open failure mode would have skipped the channel. The test fake answers the same way. |
| `getWebhookInfo` | **Refused**: `403 Method getWebhookInfo is restricted`. The platform manages the webhook; its state is visible only through `npx tgcloud webhook`. |
| Channels | The bot is **administrator with post/edit/delete rights** in all three force-join channels — @HIDE_i_SEEK (`-1002407928564`), @Nepenthw_ir (`-1001816009903`), @wangerBots (`-1001910797391`) — and in the two planned destination channels @WangerBeat (`-1004370326177`) and @WangerFlow (`-1004391543350`). |
| Cloud project | Revision 0, no modules, no tables, webhook "in sync" (nothing deployed yet). |
| Module count | Not documented. An earlier bot in this repo measured: a deploy of **104 modules was refused**, 88 and 94 deployed. This project keeps a budget of **≤ 85 modules** for all eight phases (a test enforces it). |

## Conflicts between the spec and the platform (official/measured wins)

| Spec item | Conflict | What is built instead |
|---|---|---|
| §0/§4 bot username `@WangerMusicBot` | The real username is `@Wange_Musicbot`. | `BOT_USERNAME = 'Wange_Musicbot'` in `lib/config/static.js`; deep links and help texts use it. |
| §7.5 System Status "getWebhookInfo (pending updates, last error)" | `getWebhookInfo` is restricted for bots on this platform (403). | System Status says the webhook is managed by the platform and shows `npm run tg -- webhook` as the way to check it. If the method ever starts working, the same screen shows its data. |
| §6 `broadcasts` table | The tick has to edit the progress message and must not run the same batch twice in parallel. | Three extra columns: `progress_chat_id`, `progress_message_id`, `lock_until` (a lease). |
| §7.3 "bump a forcejoin_version … invalidates all passes" | A pass is a timestamp per user; with no transactions, comparing versions would need an extra column. | On any list change the service bumps `forcejoin.version` **and** clears all active passes in one statement (`UPDATE users SET force_join_ok_until = 0 WHERE force_join_ok_until > now`). |
| §2 "Assume `tgcloud run` uses the bot's real database" | Confirmed (no tables visible = the real, still-empty database). | Smoke tests run only on a staging bot, or read-only on production. |
| §5 layout (many small modules) | The platform appears to cap the number of modules (~100). | Small related modules are merged (e.g. `core/util.js` holds ids + time). |

## Phase 2 additions (2026-11-05)

| Check | Result |
|---|---|
| `migrate --local --dry-run` with the Phase 2 schema | 11 new tables, all "safe"; the server's diff includes all 8 `tracks` indexes (the CLI prints only the CREATE TABLE text) — nothing applied |
| `tgcloud run handlers/message` with an audio payload | all 58 modules load on the platform; the boundary returns `{ ok: false }` because no table exists yet |
| `String#normalize`, regex `\p{…}` | used by `lib/music/normalize.js` (measured available); explicit fallbacks keep Persian/Arabic folding working without them |

| Spec item | Decision |
|---|---|
| §6 `tracks` | Two extra columns: `duplicate_of` (the soft-duplicate flag) and `archive_chat_id` (which channel `archive_message_id` belongs to). One extra table, `import_sessions`, counts a run of forwards atomically for the bulk summary (updates may arrive in parallel). |
| §13 "a remix of an existing song is flagged, not blocked" vs §8.3 "“Song (Remix)” is not “Song”" | A remix has its own dup_key, so it is neither blocked nor a soft duplicate; its card shows a 🔗 line linking the other version(s). True soft duplicates (same version, ±3 s) get ⚠️ and can't be activated until the admin picks keep both / replace / discard. |
| §8.1 optional re-upload with a new cover/tags | Deferred (optional). Edits change the bot's catalog; Telegram keeps showing the file's own embedded title/performer/thumbnail (a Bot API rule), and the card says so. The 🖼 cover is stored for Phase 6 posts. |
| §8.4 "mixed → unknown" | A text counts as one script when ≥ 90 % of its letters are in it; below that it is mixed → unknown (needs review). |

## Phase 3 additions

| Check | Result |
|---|---|
| `migrate --local --dry-run` | `track_terms` with `PRIMARY KEY (term, track_id) WITHOUT ROWID` accepted; 14 tables in all, all "safe" |
| FTS5 | Still not available (see §4 above), so search is the `track_terms` table: exact lookups and prefix ranges (`term >= q AND term < q + U+FFFF`) on its primary key, combined with `INTERSECT`. Never a `%…%` scan. |
| Module state | Not kept between invocations (§2), so no in-memory LRU. Telegram's per-user cache (`cache_time` from settings, `is_personal: true`) is the only cache; no DB cache table (not needed at this size). `catalog.version` is kept for a cache key if one is ever added. |

| Spec item | Decision |
|---|---|
| §9 inline users who never started the bot | They get a users row (needed for the force-join pass) with `is_blocked = 1` (the bot can't message them yet); their first `/start` clears it. 👥 Users labels that number "can't receive messages". |
| §9 "chosen_inline_result → play_count and stats" | play_count (Phase 3) and `play.inline` + `track.play` in stats_daily (Phase 7). Needs BotFather `/setinlinefeedback` (owner). |
| §9 one-letter queries | A one-letter last token matches exactly (not as a prefix), so it can't scan the whole index. |
| §7.4 private search pagination | Stateless: the query is read back from the first line of the results message. |

## Phase 5 additions

| Spec item | Decision |
|---|---|
| §6 `destination_channels` | Two extra columns: `bot_rights` (JSON: post / edit / delete, checked_at) and `removed_at` (soft removal, so publication history keeps its channel; re-adding restores the row, disabled). |
| §13 "I provide the real channels in this phase" | @WangerBeat (`-1004370326177`, English) and @WangerFlow (`-1004391543350`, Persian) appear as one-tap "add" buttons (`SUGGESTED_DESTINATIONS`); each tap checks the bot's rights with Telegram and adds the channel disabled. Nothing is registered until the owner taps. |
| §10.2 rules, empty language list | No language selected = no track matches (shown as a warning), never "all languages". |

## Phase 6 additions

| Spec item | Decision |
|---|---|
| §10.3 "no backfill: tracks activated before a channel was enabled" | `destination_channels.publishing_since` is set when the channel becomes enabled + auto-publish (cleared when either turns off); routing requires `track.activated_at ≥ publishing_since`. |
| §10.8 "at least 1 s between messages to the same chat" | One post per channel per tick. Exception: cover_then_audio sends the cover photo and the audio back to back (one logical post); there is no way to wait without sleeping, and two messages are far below Telegram's ~20/min per channel. |
| §10.6 "400 file errors → flag the track for review" | The track is hidden (it leaves search and routing, as its file is broken for inline too) and the owner is alerted. |
| §6 `publications` | Two extra columns: `cover_message_id` (to delete the cover too) and `deleted_at` («🧹 Delete channel posts»). |
| §10.4 reviewers | Owner + admins (`approvals.review`); admins see 🗳 Approvals in /admin. Uncertain / failed actions, backfill, history and post deletion are owner-only. |
| Caption language | Language/genre names in captions use the channel's first rules language (English channel → English names, otherwise Persian). |

## First production deploy (Phases 1–6, 2026-11-05)

| Check | Result |
|---|---|
| `migrate --safe` | 17 steps applied, 0 skipped (all additive); a second `migrate --dry-run` → "No schema changes" |
| `push` | 78 modules accepted; webhook "in sync" (message, channel_post, inline_query, chosen_inline_result, callback_query, my_chat_member) |
| Read-only smoke (`npm run smoke`) | version 0.1.0 / `2d7a9be`, bot `Wange_Musicbot`, DB round trip 2 ms, tick ran (piggyback), 3 force-join channels ok, 0 errors |
| Inline latency (`tgcloud run handlers/inline_query`, owner id, fake query ids) | 38–125 ms per run with an empty catalog (the answer fails with QUERY_ID_INVALID, classified as an expired query: no error row). The 800 ms p95 target is far away; a staging bot with a real catalog is still needed for the spec's p95 measurement. |

## Phase 7 additions

| Check / spec item | Result / decision |
|---|---|
| `migrate --local --dry-run` | 2 safe steps: `stats_daily` (`PRIMARY KEY (date, metric, dimension) WITHOUT ROWID`) and `users.idx_users_created` |
| Production deploy (commit `e97e5f8`) | both steps applied by `migrate --safe`; 21 modules pushed (81 in all); `npm run smoke`: `stats_match: true` for today and 7 days, DB round trip 2 ms, 0 errors |
| §13 Phase 7 "searches: inline queries arrive per keystroke, so count only first-page queries of 3+ characters, or sample" | First pages of ≥ 3 characters, from users who passed the gate, are counted (no sampling: deterministic and testable). The dashboard says this overstates real searches. |
| "users: active" | Exact distinct users per local day: the day's first activity is one conditional `UPDATE` of `last_seen_at` (also for inline users, after the answer). `last_seen_at` therefore now also moves for inline-only use (once a day). |
| "force-join conversions" | `force_join_ok_until = -1` marks a user stopped by the gate; leaving that state through a pass is a conversion. The rate shown (converted ÷ gated in the period) is approximate: the two may belong to different days. |
| "publications per channel (published, failed, pending)" | Published per day is recounted from `publications.published_at` (so a purge lowers it); waiting / queued / failed / uncertain are live counts. |
| §13 "Done when: the dashboard numbers match direct database counts on staging" | There is no staging bot. `tests/e2e/stats.e2e.test.mjs` compares every dashboard number with SQL on the tables (local emulation), and the production smoke check compares the live dashboard with direct counts **read-only** (it may write the day's derived rows, nothing else). |
| `dayStart` on daylight-saving days | Fixed: the offset is read at the found midnight (it was read at `now`, so a DST day started an hour off). Tehran has no DST; Berlin / London / New York benefit. |

## Phase 8 additions (measured on the staging bot, 2026-11-06)

| Check | Result |
|---|---|
| **Bound values per statement** | **≤ 4096.** 292 rows × 14 values = 4088 worked; 4102 failed with a bare `Run error` (also 1030 × 4 = 4120). Every statement stays under 4000; the local SDK enforces 4096. |
| **Rows written per statement** | **≤ 10 000.** An `INSERT … SELECT` of 10 000 rows worked, 10 001 failed with `Sqlite query rows_written limit exceeded` and wrote nothing. Index entries don't count (deleting 5000 tracks with 9 indexes worked); the limit is per statement, not per invocation. Mass writes go in batches of ≤ 5000; the local SDK enforces it (rolled back). |
| `tgcloud run` output | 1 MB strings come back intact in one run (backups are downloaded in ≈ 1 MB base64 slices). |
| `tgcloud run` input | One shell argument (Linux caps it at 128 KiB): restore chunks are ≤ 96 KB. |
| `tgcloud run` rate limit | After ~100 calls in about a minute: `Too many requests: retry after N` (2–14 s seen). Scripts wait and retry. |
| `sendDocument` with `InputFile` | Works (a 1.65 MB JSON backup); `getFileContent` downloads it back. |
| Staging bot | `@Wangermusic_bot`, id 9217669709; inline mode is off in BotFather, so its inline answers fail with `USER_BOT_INVALID` (search itself runs; timings are valid). |
| Load test (5000 tracks, 4 parallel) | inline p95 166 ms, private search p95 273 ms, chosen p95 118 ms — see docs/REVIEW.md. |
| `ON CONFLICT (pk) DO UPDATE … ON CONFLICT DO NOTHING` (two upsert clauses) | Works (restore merges). |

## Design consequences

- **State**: everything important is in the database; no module-level caches are relied on.
- **Atomicity**: one statement per state change; claims are `UPDATE … WHERE <expected state> RETURNING`.
- **Statement size**: ≤ 4000 bound values and ≤ 5000 rows written per statement (platform caps 4096 / 10 000).
- **Background work**: `runTick` (maintenance → broadcast → publications → digests → archive →
  search index → stats), run
  piggyback after updates (never inline), by the owner's buttons, and by `endpoints/opsTick.js`
  from a GitHub Actions schedule (fallback for the missing scheduler).
- **Budgets**: piggyback tick 2 s, manual/scheduled tick 8 s (both settings; wall limit ≈ 30 s,
  CPU ≈ 3 s), plus item caps (25 broadcast messages per batch by default).
- **Errors**: error boundary → `error_log` → throttled owner alert → normal return.
