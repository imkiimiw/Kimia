@AGENTS.md

# Wanger Music — working notes for Claude

**Read `docs/SPEC.md` and `docs/PLATFORM_NOTES.md` before each phase.** One phase at a time; at the
end: all tests green, docs updated, the report (SPEC §15), then STOP and wait for the owner.

- **All 8 phases done and deployed** (owner's explicit OK). Changes now are maintenance: every deploy
  still needs the owner's OK; staging first (`node scripts/staging.mjs deploy`, docs/OPERATIONS.md).
- Stack: Telegram Serverless (tgcloud CLI 0.2.0), plain JS ES modules in `tgcloud/`, SQLite via
  `sdk/db` (raw SQL with the `sql` tag), Node 22 for local tests. No runtime dependencies.
- This folder is its own tgcloud project (bot `@Wange_Musicbot`, app9280424458). The repo root and
  the other folders are OTHER bots: never touch them.

## Commands (run in wanger-music/)
- `npm test` — unit + e2e (local SDK emulation on node:sqlite + fake Telegram)
- `tsc -p jsconfig.json` — optional type check (global TypeScript)
- `npm run tg -- <cmd>` — the CLI with the token from `Music_BOT_TGCLOUD_TOKEN` (never bare `npx tgcloud`)
- `npm run deploy` — tests → stamp version → migrate --local --safe → push → migrate --safe (owner's OK first)
- `npm run smoke` — read-only production check · `npm run smoke -- --staging` — fixtures on the staging bot
- `npm run query-review` — query plans of every statement in the tests · `node scripts/backup.mjs …` — backups

## Architecture rules
- handlers → services → repositories → sdk. Handlers are thin (`core/boundary` + `bot/router`).
- SQL only in `lib/repositories/`; only `core/context.js` builds them (DI). Services get deps as args.
- Pure modules (config, util, logger, html, errors, limiter, chatref, codec, keyboards, i18n,
  policy, gate, music/normalize, music/classify, music/duplicates, search/terms, publishing/captions,
  publishing/rules)
  never import `sdk` — `tests/unit/guard.test.mjs` enforces this and the layering.
- One place each: permissions `permissions/policy.js`, config `config/static.js`, Telegram error
  classification `telegram/errors.js`, rate limits `telegram/limiter.js`, outbound calls `telegram/client.js`.
- No transactions on this platform: every state change is ONE statement (conditional UPDATE, upsert).
- All texts in `lib/i18n/{fa,en}.js`; parse_mode HTML; t() escapes vars, tp() for buttons/toasts.
- Invisible characters (ZWNJ…) are written as `\u200c` escapes, never literally (`node scripts/fix-invisible.mjs` repairs them).
- Music text goes through `lib/music/normalize.js` only (display / key / compact); dup_key = artist|title|version keys.
- Search: `track_terms` holds terms of ACTIVE tracks only (catalog calls index.add/remove); the inline path
  writes nothing before the answer except a first-time user row / force-join state, and never runs a tick.
- Analytics: count events only with `app.stats.count(metric, dim)` (buffered, flushed once by the boundary);
  every metric is listed in `stats/service.js#METRICS` (a guard test checks it); never a text as a dimension,
  never per-user rows. `force_join_ok_until = -1` means "gated" (conversion stats). Derived numbers are
  recomputed by `stats.aggregate()`; don't count them as events.
- Source imports run as `SYSTEM_ACTOR` (policy.js; audit actor 0) and never publish. Sources are channels or groups
  (`sources.chat_type`; group messages reach `handlePost` through handlers/message, never touching users).
- Destinations: rules/hours in `publishing/rules.js` (pure: matches(), withinHours()); captions in
  `publishing/captions.js`; previews go to the owner only; removal is soft (removed_at).
- Publishing: routing only on activation (publishing_since → no backfill), one row per (track, channel),
  the worker claims with a lease; error actions come from `telegram/errors.js#publishAction`; an expired
  lease is `uncertain` and is NEVER re-sent automatically.
- Keep ≤ 85 modules (the platform refused a 104-module deploy; 83 used). Add handlers only in their phase.
- Platform limits per SQL statement (measured): ≤ 4096 bound values ("Run error") and ≤ 10 000 rows
  written ("rows_written limit exceeded"). Batch mass writes (≤ 5000 rows); the local SDK enforces both.
- `npm run query-review` must stay green (every full scan of a growing table needs a reason in its list).
- Staging: `@Wangermusic_bot` via `scripts/staging.mjs` (token in WANGER_STAGING_TGCLOUD_TOKEN or a file
  named by WANGER_STAGING_TOKEN_FILE — never in the repo). Load tests, fixtures and restores run there.
- Ask the owner before: new dependencies, deploys, migrate warnings, anything that posts to a real
  channel or messages real users. Destination channels (@WangerBeat, @WangerFlow) exist only once the owner adds them.
