# Architecture

Wanger Music runs entirely on Telegram Serverless: each update runs the code in `tgcloud/` in a
fresh V8 isolate (≈ 3 s CPU, ≈ 30 s wall, no timers, no module state between invocations, no
transactions — see [PLATFORM_NOTES.md](PLATFORM_NOTES.md)). Everything that must last is in the
bot's SQLite database.

## Layers

```
handlers/*.js, endpoints/*.js        thin: hand the payload to the boundary and the router
        │
lib/core/boundary.js                 error boundary · update dedupe · piggyback tick · stats flush
lib/core/context.js                  DI: builds repositories + services once per invocation
        │
lib/bot/router.js  ── routes.js      order of checks; one registry of callback routes and flows
lib/bot/user.js, lib/admin/*_ui.js   screens (views + routes + flows); no SQL, no sdk
        │
services: users/ forcejoin/ broadcast/ settings/ audit/ alerts/ bot/flows.js jobs/ core/health.js
          music/catalog.js music/ingest.js music/providers/catalog.js stats/service.js
        │
lib/repositories/*.js                ALL SQL (raw sql`…`, one statement per state change)
lib/telegram/client.js               ALL outbound Bot API calls (+ trace, blocked hook)
        │
sdk  (db, api)
```

Pure modules (no `sdk`, unit-tested directly): `config/static.js`, `core/util.js`,
`core/logger.js`, `core/version.js`, `telegram/{html,errors,limiter,chatref}.js`,
`bot/{codec,keyboards}.js`, `i18n/*`, `permissions/policy.js`, `forcejoin/gate.js`,
`music/{normalize,classify,duplicates}.js`, `search/terms.js`, `publishing/{captions,rules}.js`.
`tests/unit/guard.test.mjs` fails if one of them reaches `sdk`, if anything but `core/context.js`
imports a repository, if SQL appears outside `repositories/`, or if a handler grows logic.

## One update

```
handlers/message.js
 └ runHandler('message')                          core/boundary.js
    ├ createApp()  → settings loaded (1 query), bootstrap once (seed force-join, tick row)
    ├ dedupe: INSERT INTO processed_updates … ON CONFLICT DO NOTHING RETURNING → skip if seen
    ├ onMessage()                                 bot/router.js
    │   ├ private chat only, upsert user (writes at most every 10 min)
    │   ├ banned → one notice on /start, else silence
    │   ├ /cancel → clear the flow
    │   ├ force-join gate (owner/admins bypass; cached pass; parallel getChatMember)
    │   ├ owner: command menus set up once (COMMANDS_VERSION)
    │   ├ pending flow step (permission re-checked) → flow handler
    │   └ command / text
    ├ maybePiggyback(): one conditional UPDATE on tick.last_at elects a tick (never inline)
    ├ app.stats.flush(): the update's analytics counters in one upsert (also after an error)
    └ on any error: JSON log → error_log → throttled owner alert → return { ok: false }
```

Callback queries go through `onCallback`: decode (strict codec, ≤ 64 bytes) → route lookup →
argument types → **permission check on the server** (+ private chat for admin routes) → gate →
route → exactly one `answerCallbackQuery`, also on errors. Stale or forged data → «این منو منقضی
شده؛ دوباره /admin را بزن» for staff, a neutral text for everyone else (admin features stay invisible).

## Permissions

`permissions/policy.js` is the only place that knows the owner id. Owner = `OWNER_ID` (always
everything). The `admin` role gets `panel.open`, `catalog.manage`, `approvals.review`,
`stats.view`. Everything else (`admins.manage`, `forcejoin.manage`, `destinations.manage`,
`sources.manage`, `broadcast.send`, `settings.manage`, `users.ban`, `users.view`, `system.view`) is
owner-only. Owner-only services call `assertCan()` again, so a route mistake can't open them.

## Force-join

`forcejoin/service.js#check`: staff bypass (setting) → cached pass (`users.force_join_ok_until`) →
`getChatMember` for every enabled channel in parallel (one quick retry on 429/5xx) →
`gate.js#evaluate` with the failure mode → pass stored for the TTL; failures are never cached.
Per channel, `last_check_status` is kept (ok / bot_not_admin / not_found / error) and a broken
channel alerts the owner at most once an hour. Any list change bumps `forcejoin.version` and clears
all passes in one statement, so it applies at once. The inline gate (Phase 3) is ready:
`gate.js#inlineGateAnswer` (no results, `is_personal`, `cache_time: 0`, button → `/start join`).

## Music catalog (Phase 2)

```
admin sends/forwards an audio (private chat, no command, outside flows)
 └ bot/router → admin/import_ui.handleMedia (catalog.manage)
    ├ document / voice / other → "send it as music"
    └ music/ingest.importAudio
       ├ hard duplicate? same file_unique_id, or same origin chat + message → refused (removed tracks still block)
       ├ metadata: audio title/performer, else "Artist - Title" from the file name
       ├ music/normalize: display text, keys, version markers, featured artists → dup_key = artist|title|version
       ├ soft duplicate? same dup_key, duration ±3 s → duplicate_of (flagged, never deleted)
       ├ language: manual > source default > artist hint (artist's other tracks) > script heuristic
       └ INSERT … ON CONFLICT DO NOTHING (public_id random, 9 chars) → draft
    → first audio of a run: import card; the rest of a run (≤ 60 s apart): one summary message
```

Lifecycle (`music/catalog.js`, all conditional UPDATEs, all audited): draft → active (needs title +
artist and no undecided duplicate; first activation sets `activated_at`, copies to the archive
channel if set) ⇄ hidden → removed (stays in the table, so its file stays blocked) → restore → draft;
the owner can purge a removed track. Activate/hide/remove bump `catalog.version`. The 🔗 line on a
card links other versions of the same song (e.g. a remix); ⚠️ marks a soft duplicate.
`music/providers/catalog.js` is the MVP `MusicProvider` (only active tracks; audio = Telegram file).
The archive backlog (active tracks without a copy) is worked by the tick, ≤ 3 per tick and
≤ 18 per minute (`telegram/limiter.js#windowAllows`).

## Search and inline mode (Phase 3)

- **Index** (`search/terms.js`, pure): each ACTIVE track is stored in `track_terms` under the
  normalized tokens of title / artist / album / featured artists / the artists' aliases, plus
  space-free variants (neighbour pairs and the whole field). `catalog.activate` and edits index a
  track; hide / remove / purge drop its terms; a rebuild cursor (`search.reindex_cursor`) lets
  the tick index everything again in batches.
- **Query** (`repositories/search.js`): ≤ 64 chars, ≤ 5 tokens; all tokens must match (earlier ones
  exactly, the last as a prefix) — `INTERSECT` of primary-key lookups; ranked exact title/artist →
  prefix → plays → newest. Empty query: most played, then newest.
- **Inline** (`handlers/inline_query` → `bot/search_ui.onInlineQuery`): first-time user row → ban →
  force-join gate (cached pass; non-members get the join button) → one query → one
  `answerInlineQuery` (cached audio by file_id, `is_personal`, `cache_time`, `next_offset`). No
  dedupe, no tick. An expired query id is a warning, not an error.
- **Private chat**: plain text or `/search` → 10 buttons per page (`s:get:<publicId>` sends the audio,
  `s:pg:<n>` pages; the query is read back from the message), plus an inline-search button.
  `/start t_<publicId>` sends a track (after the gate), `/start search` asks for a name.
- **Plays**: `chosen_inline_result` (deduped by update_id) and private sends add one to `play_count`.
- **Artists** (`admin/artists_ui.js`): aliases such as "shadmehr" → «شادمهر عقیلی»; adding/removing
  one re-indexes that artist's active tracks.

## Source channels (Phase 4)

`handlers/channel_post` → `publishing/sources.handlePost`: a post counts only if its channel is a
registered, enabled source with import mode draft or active, and it carries an `audio`. Then the
Phase 2 pipeline runs as `SYSTEM_ACTOR` (audit actor 0, `added_by` 0, `source_type
telegram_channel`, `source_id`, origin = the post itself or its forward origin), with the source's
default language (high confidence) when set. Mode active activates a complete, non-duplicate track
at once (and so indexes it); otherwise it stays a draft and the owner is told (≤ 1/h per source).
Nothing is ever published. Unregistered channels, other posts and duplicates are skipped. When
the bot becomes admin of an unknown channel (`my_chat_member`), the owner gets Source · Destination
(Phase 5) · Force-join · Ignore; nothing is registered until they choose. Bots can't read channel
history, so only posts made after the bot became admin arrive.

**Groups as sources** (added after Phase 8, on the owner's request): a group or supergroup where the
bot is admin is a source too (`sources.chat_type` = channel / supergroup / group; `source_type` stays
`telegram_channel`, "a Telegram chat", so no CHECK constraint had to change). Being admin is also what
makes Telegram deliver every group message to a bot (privacy mode only lets commands through
otherwise). Group messages arrive on `handlers/message`; the router sends them to the same
`handlePost` before anything else — no user rows, no replies in the group. Chatter without audio
skips the dedupe row and the piggyback tick. A basic group that becomes a supergroup
(`migrate_to_chat_id`) keeps its source row with the new id. When the owner or an admin makes the
bot admin of a group, the prompt offers Source · Ignore only.

**Bulk activation**: «✅ فعال‌سازی همه» on a forwarded-batch summary activates that admin's ready
drafts of that batch (created between the batch start and the next batch); «✅ فعال‌سازی همه‌ی
آماده‌ها» on 🎵 Music → drafts activates every ready draft (e.g. a source in draft mode). Both run
`catalog.activateMany` (activate() per track, ≤ 300 per press, 15 s budget; drafts without
title/artist or with a pending duplicate stay). Setting `import.auto_activate`: staff imports are
activated right away when they're ready.

**Language corrections** (after Phase 8): new tracks get a script guess only when it is reliable
(setting `music.language_auto`, default `confident`: Persian script → fa; Latin letters → unknown,
since many Persian songs are titled in Latin letters). The track card sets the language in one tap.
When the language or genre of an ACTIVE track changes, `publisher.reroute` cancels its waiting
publications (approval / queue) for channels it no longer matches and routes it to the channels it
now matches (same no-backfill rule); published posts are not touched.

**Undecided languages** (fix, 2026-11-07): a track whose language nobody decided (`language_source =
heuristic` and unknown or low — partial index `idx_tracks_undecided_language`) matches no channel. So:
the owner is asked once per source without a default language (on import, and from the tick processor
`languages`, ≤ 1 per source per 12 h): Persian / English / other / mixed. The answer becomes the
source's default and is applied to its undecided tracks (`catalog.applySourceLanguage`, batches of
200), which are re-routed. A person's choice on one track spreads to the same artist's undecided
tracks (`language_source = artist`). Decisions (manual / source / artist) are never overwritten.
The monitor warns (System Status + owner alert) while active tracks are undecided.

## Destination channels (Phase 5)

`publishing/destinations.js` + `admin/destinations_ui.js`. Adding (one-tap buttons for the
channels the owner named, the "bot added" prompt, or forward / @username / id) checks with
`getChat` + `getChatMember` that it is a channel and the bot may post (edit/delete recommended).
New channels: disabled, auto-publish off, approval on, rules language preset. Rules
(`publishing/rules.js`, pure): listed languages; optional genre list; excluded genres; a minimum
language confidence (below it → approval in Phase 6). Schedule: minimum interval, active hours in
the channel's time zone, daily limit. Caption template (`publishing/captions.js`): validated by a
preview the owner receives (cover + audio with the caption, using the newest matching active
track, or a sample). Health: `my_chat_member` and «🔄 Check rights» update `bot_rights`; losing
post rights disables the channel and alerts the owner. Removal is soft (`removed_at`); adding again
restores the row (disabled) with its settings. **Nothing is posted to any channel in Phase 5.**

## Automatic publishing (Phase 6)

- **Routing** (`publishing/publisher.routeTrack`, called by `catalog.activate`): for every channel
  that is enabled with auto-publish on and whose `publishing_since` ≤ the track's `activated_at`,
  `rules.matches` decides; one row per (track, channel) via `INSERT … ON CONFLICT DO NOTHING`
  (`pending_approval` when the channel requires approval or the confidence is below its minimum,
  else `queued`). Tracks activated earlier are never queued automatically: the owner's
  «⏪ Earlier tracks» shows a count and a sample first (≤ 200 per run).
- **Approval**: a digest per reviewer (owner + admins) at most every `digest.interval_seconds`
  while items wait; the review screen sends the audio with the channel's rendered caption and a
  card ✅ Approve · ❌ Reject · ⏭ Next; decisions are `UPDATE … WHERE status = 'pending_approval'`,
  so a second reviewer sees who already decided.
- **Worker** (`publishing/worker.js`, tick processor `publications`): skipped while paused or in the
  global 429 cooldown; first expired leases → `uncertain` (owner alerted); then per channel that is
  ready (`rules.channelReady`: interval, active hours in the channel's zone, daily limit) it claims
  one due row (`UPDATE … WHERE id IN (SELECT … LIMIT 1) AND status = 'queued' RETURNING *`, lease
  60 s), sends (cover first for cover_then_audio), and records the outcome. Failures go through
  `telegram/errors.js#publishAction`: 429 → requeue at retry_after + global cooldown (attempt not
  counted); 5xx / network → backoff 1, 2, 4… min (jitter, cap 60) and failed after 6 attempts;
  channel errors → failed + channel disabled + alert; file errors → failed + track hidden + alert;
  caption errors → failed + alert. ≤ `publishing.per_tick` posts per tick, one per channel.
- **Cover** (cover_then_audio): a track's cover is often the audio's own thumbnail, which Telegram
  won't send as a photo ("can't use file of type Thumbnail as Photo", production 2026-11-08): the
  worker downloads it once, uploads it as a photo and keeps that photo's file_id; any other cover
  error skips the cover — the audio is the post (only channel / transient errors stop the post).
- **Queue on the channel card**: queued / awaiting approval, and when the next post can go
  (`rules.channelReady`); «▶️ send the next post now» (`worker.sendNow`) skips the interval and the
  active hours (explicit owner choice) but not pause, cooldown or the daily limit.
- **At most once**: an expired lease is `uncertain` and is never re-sent automatically; the owner
  chooses «ثبت به‌عنوان منتشرشده» or «ارسال دوباره».
- **Removal**: hide / remove cancels the track's waiting rows; «🧹 Delete channel posts» deletes its
  published posts (failures reported); purge deletes the rows first (children first).

## Analytics (Phase 7)

`stats_daily (date, metric, dimension, value)`, PK `(date, metric, dimension)`, WITHOUT ROWID;
date = the local day in the `time_zone` setting. Aggregated only: no per-user rows, no search texts
(a guard test checks that no dimension is a text). Every metric is listed in `stats/service.js#METRICS`.

- **Event counters** — `app.stats.count(metric, dim)` buffers in memory; the boundary writes the
  buffer once at the end of the update (`INSERT … VALUES …, … ON CONFLICT DO UPDATE SET value =
  value + excluded.value`). The inline answer is sent before anything is written.
  - `users.active`: the day's first activity of a user (private chat, or inline after the answer) is a
    conditional `UPDATE users SET last_seen_at = now WHERE … AND last_seen_at < local midnight` —
    exactly one per user per day, so it equals `count(last_seen_at >= midnight)`.
  - `search.inline` (+ `_empty`): first page, ≥ 3 characters, user past the gate — Telegram sends a
    query per keystroke, so this is more than "searches" (documented on the dashboard).
    `search.private` (+ `_empty`): text or /search, not pagination.
  - `play.inline` (chosen result, needs `/setinlinefeedback`), `play.private` (result buttons and
    `t_<id>`), `track.play` per track (top tracks) — each only when `play_count` really went up.
  - `fj.gated` / `fj.converted`: `force_join_ok_until = -1` marks "stopped by the gate"; one
    conditional `UPDATE` sets it (counted once), and a pass that replaces `-1` is a conversion.
  - `source.post` / `source.import` / `source.duplicate` per source.
- **Derived numbers** — `users.new`, `users.total`, `tracks.activated`, `pub.published` per channel
  are recounted from the tables for today and yesterday (overwrite; channels that lost their posts
  get 0) by the tick processor `stats` (≤ every 15 min) and whenever 📊 opens, so they equal a
  direct count; yesterday's late events are picked up after midnight.
- **Retention** — once per local day: rows older than 400 days, `track.play` older than 90.
- **📊 dashboard** (`admin/stats_ui.js`, `stats.view`): today / 7 / 30 days — users (total, new,
  active in the period, active today, blocked or never started), searches, plays, force-join
  conversions, tracks, top 5, per channel (published in the period, all time, awaiting approval,
  queued, failed, uncertain — live), per source; «📈 Daily» (14 days) and «🔥 Most played» (period +
  all time).

## Phase 8: backups, monitoring, flood guard, platform limits

- **Backup** (`backup/service.js`, `repositories/backup.js`): `BACKUP_TABLES` lists the core tables
  and their columns (a test keeps it equal to the schema). Export reads each table in key order
  (keyset pages of 1000), builds one JSON document and sends it to the owner (`tg.sendDocument`);
  `backup.last` keeps its `file_id`. Restore (`scripts/backup.mjs`) sends chunks through a temporary
  owner-only module: validated (table, columns ⊂ schema incl. the key, values = number/string/null)
  and upserted (`ON CONFLICT (pk) DO UPDATE … ON CONFLICT DO NOTHING`), then `finishRestore`
  clears/rebuilds the search index. Weekly export: tick processor `backup` (setting `backup.weekly`).
- **Monitoring** (`core/health.js`): `healthWarnings()` (errors in the last hour, failed/uncertain
  publications in 24 h, scheduled tick, cooldown, the webhook report the GitHub job passes to
  `opsTick`) → System Status; tick processor `monitor` → owner alerts, ≤ 1 per kind per 3 h.
- **Flood guard**: `users.flood()` — one conditional `UPDATE` counts the update in a 60 s window
  (`flood_at`, `flood_n`); over 30 → ignored (one notice); staff exempt.
- **Platform limits** (measured): ≤ 4096 bound values and ≤ 10 000 rows written per statement.
  Mass writes are batched (≤ 5000); the local SDK enforces both, so tests catch a regression.
- **Unreachable sender**: a failed reply to the update's own sender (blocked / chat gone / 429 for
  that chat) is a warning, not an error (`boundary.senderUnreachable`).

## Background work: the tick (no cron on this platform)

`jobs/tick.js#runTick(trigger, budget)` runs processors in order — maintenance (prune
`processed_updates` > 48 h, expired flows, old errors, stale leases), then one broadcast batch
(Phase 6 adds publications and digests) — each within the time budget. Triggers:

1. **piggyback** after message / callback_query / my_chat_member updates, at most once per
   `tick.interval_seconds`, elected by one conditional `UPDATE` (2 s budget);
   processors in order: maintenance → broadcast batch → publications → approval digests →
   archive backlog → search index rebuild → stats (aggregation, retention) → weekly backup → monitor;
2. **manual**: 🧪 System Status «▶️ اجرای تیک» and the broadcast's «▶️ ادامه» (8 s budget);
3. **scheduled**: `endpoints/opsTick.js` (owner id only) run every 30 min by
   `.github/workflows/wanger-music-tick.yml`, which pulls the **deployed** modules first.

Limitation: background work happens only when one of these runs, so its timing depends on traffic
and the schedule.

## Broadcast

draft → running ⇄ paused → done | cancelled, every change a conditional `UPDATE`. A batch takes a
lease (`lock_until`), copies the owner's message to the next `broadcast.batch_size` users
(non-blocked, non-banned, by id), and stores each outcome right after its send (a crash repeats at
most one message). 403 → user marked blocked; 429 → stop, global `telegram.cooldown_until`; 5xx →
one retry, then failed; pace ≤ 25 msg/s. The progress message is edited after every batch; the
final report is sent when done.

## Data

Phase 1: `users`, `force_join_channels`, `settings`, `audit_log`, `user_flows`, `processed_updates`,
`error_log`, `alerts`, `broadcasts` (+ `progress_chat_id`, `progress_message_id`, `lock_until`).
Phase 2: `tracks` (spec columns + `duplicate_of`, `archive_chat_id`; 8 indexes incl. the partial
unique origin index) and `import_sessions` (bulk-summary counters).
Phase 3: `track_terms` (PK term + track_id, WITHOUT ROWID), `artists`, `artist_aliases`; tracks
index `(status, play_count, activated_at)` for the empty inline query.
Phase 4: `sources`.
Phase 5: `destination_channels` (spec columns + `bot_rights` JSON and `removed_at`).
Phase 6: `publications` (spec columns + `cover_message_id`, `deleted_at`; UNIQUE track+channel;
indexes status+next_attempt, channel+status, channel+published_at) and
`destination_channels.publishing_since`.
Phase 7: `stats_daily` (see Analytics) and `users` index `created_at`.
Phase 8: `users.flood_at`, `users.flood_n`; publications index `(channel_id, id)`.
After Phase 8: `sources.chat_type` (groups as sources), `destination_channels.signature` (🆔 channel link in captions).
No foreign keys (the platform forbids them); enums and booleans are CHECK-constrained; 8 indexes
back every lookup (`users.last_seen_at`, `lower(username)`, admins partial index, …).

## Tests

`npm test`: `tests/unit/` (pure modules, services with in-memory fakes, the guard) and
`tests/e2e/` (the real handlers against `tests/sdk/` — node:sqlite with the real schema, refusing
what the platform refuses — and `tests/helpers/fake-telegram.mjs`, a strict fake Bot API).
`npm run smoke`: a read-only production check with `tgcloud run`; `--staging` runs
`tests/fixtures/updates/*.json5` on the staging bot. `npm run query-review`: query plans of every
statement the tests run (CI). Staging: `scripts/staging.mjs` (mirror + CLI), `scripts/loadtest.mjs`,
`scripts/backup.mjs` — see docs/OPERATIONS.md.
