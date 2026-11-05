# Architecture

Wanger Music runs entirely on Telegram Serverless: each update runs the code in `tgcloud/` in a
fresh V8 isolate (≈ 3 s CPU, ≈ 30 s wall, no timers, no module state between invocations, no
transactions — see [PLATFORM_NOTES.md](PLATFORM_NOTES.md)). Everything that must last is in the
bot's SQLite database.

## Layers

```
handlers/*.js, endpoints/*.js        thin: hand the payload to the boundary and the router
        │
lib/core/boundary.js                 error boundary · update dedupe · piggyback tick
lib/core/context.js                  DI: builds repositories + services once per invocation
        │
lib/bot/router.js  ── routes.js      order of checks; one registry of callback routes and flows
lib/bot/user.js, lib/admin/*_ui.js   screens (views + routes + flows); no SQL, no sdk
        │
services: users/ forcejoin/ broadcast/ settings/ audit/ alerts/ bot/flows.js jobs/ core/health.js
          music/catalog.js music/ingest.js music/providers/catalog.js
        │
lib/repositories/*.js                ALL SQL (raw sql`…`, one statement per state change)
lib/telegram/client.js               ALL outbound Bot API calls (+ trace, blocked hook)
        │
sdk  (db, api)
```

Pure modules (no `sdk`, unit-tested directly): `config/static.js`, `core/util.js`,
`core/logger.js`, `core/version.js`, `telegram/{html,errors,limiter,chatref}.js`,
`bot/{codec,keyboards}.js`, `i18n/*`, `permissions/policy.js`, `forcejoin/gate.js`,
`music/{normalize,classify,duplicates}.js`.
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

## Background work: the tick (no cron on this platform)

`jobs/tick.js#runTick(trigger, budget)` runs processors in order — maintenance (prune
`processed_updates` > 48 h, expired flows, old errors, stale leases), then one broadcast batch
(Phase 6 adds publications and digests) — each within the time budget. Triggers:

1. **piggyback** after message / callback_query / my_chat_member updates, at most once per
   `tick.interval_seconds`, elected by one conditional `UPDATE` (2 s budget);
   processors in order: maintenance → broadcast batch → archive backlog → search index rebuild;
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
No foreign keys (the platform forbids them); enums and booleans are CHECK-constrained; 8 indexes
back every lookup (`users.last_seen_at`, `lower(username)`, admins partial index, …).

## Tests

`npm test`: `tests/unit/` (pure modules, services with in-memory fakes, the guard) and
`tests/e2e/` (the real handlers against `tests/sdk/` — node:sqlite with the real schema, refusing
what the platform refuses — and `tests/helpers/fake-telegram.mjs`, a strict fake Bot API).
`npm run smoke`: a read-only production check with `tgcloud run`; `--staging` runs
`tests/fixtures/updates/*.json5` on a staging bot.
