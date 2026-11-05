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
        │
lib/repositories/*.js                ALL SQL (raw sql`…`, one statement per state change)
lib/telegram/client.js               ALL outbound Bot API calls (+ trace, blocked hook)
        │
sdk  (db, api)
```

Pure modules (no `sdk`, unit-tested directly): `config/static.js`, `core/util.js`,
`core/logger.js`, `core/version.js`, `telegram/{html,errors,limiter,chatref}.js`,
`bot/{codec,keyboards}.js`, `i18n/*`, `permissions/policy.js`, `forcejoin/gate.js`.
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

## Background work: the tick (no cron on this platform)

`jobs/tick.js#runTick(trigger, budget)` runs processors in order — maintenance (prune
`processed_updates` > 48 h, expired flows, old errors, stale leases), then one broadcast batch
(Phase 6 adds publications and digests) — each within the time budget. Triggers:

1. **piggyback** after message / callback_query / my_chat_member updates, at most once per
   `tick.interval_seconds`, elected by one conditional `UPDATE` (2 s budget);
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

## Data (Phase 1)

`users`, `force_join_channels`, `settings`, `audit_log`, `user_flows`, `processed_updates`,
`error_log`, `alerts`, `broadcasts` (+ `progress_chat_id`, `progress_message_id`, `lock_until`).
No foreign keys (the platform forbids them); enums and booleans are CHECK-constrained; 8 indexes
back every lookup (`users.last_seen_at`, `lower(username)`, admins partial index, …).

## Tests

`npm test`: `tests/unit/` (pure modules, services with in-memory fakes, the guard) and
`tests/e2e/` (the real handlers against `tests/sdk/` — node:sqlite with the real schema, refusing
what the platform refuses — and `tests/helpers/fake-telegram.mjs`, a strict fake Bot API).
`npm run smoke`: a read-only production check with `tgcloud run`; `--staging` runs
`tests/fixtures/updates/*.json5` on a staging bot.
