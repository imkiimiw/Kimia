@AGENTS.md

# Wanger Music — working notes for Claude

**Read `docs/SPEC.md` and `docs/PLATFORM_NOTES.md` before each phase.** One phase at a time; at the
end: all tests green, docs updated, the report (SPEC §15), then STOP and wait for the owner.

- **Current phase: 3 done. Next: Phase 4 — sources (channel_post).** See docs/ROADMAP.md for the deploy state.
- Stack: Telegram Serverless (tgcloud CLI 0.2.0), plain JS ES modules in `tgcloud/`, SQLite via
  `sdk/db` (raw SQL with the `sql` tag), Node 22 for local tests. No runtime dependencies.
- This folder is its own tgcloud project (bot `@Wange_Musicbot`, app9280424458). The repo root and
  the other folders are OTHER bots: never touch them.

## Commands (run in wanger-music/)
- `npm test` — unit + e2e (local SDK emulation on node:sqlite + fake Telegram)
- `tsc -p jsconfig.json` — optional type check (global TypeScript)
- `npm run tg -- <cmd>` — the CLI with the token from `Music_BOT_TGCLOUD_TOKEN` (never bare `npx tgcloud`)
- `npm run deploy` — tests → stamp version → migrate --local --safe → push → migrate --safe (owner's OK first)
- `npm run smoke` — read-only production check · `npm run smoke -- --staging` — fixtures on a staging bot

## Architecture rules
- handlers → services → repositories → sdk. Handlers are thin (`core/boundary` + `bot/router`).
- SQL only in `lib/repositories/`; only `core/context.js` builds them (DI). Services get deps as args.
- Pure modules (config, util, logger, html, errors, limiter, chatref, codec, keyboards, i18n,
  policy, gate, music/normalize, music/classify, music/duplicates, search/terms, publishing/captions)
  never import `sdk` — `tests/unit/guard.test.mjs` enforces this and the layering.
- One place each: permissions `permissions/policy.js`, config `config/static.js`, Telegram error
  classification `telegram/errors.js`, rate limits `telegram/limiter.js`, outbound calls `telegram/client.js`.
- No transactions on this platform: every state change is ONE statement (conditional UPDATE, upsert).
- All texts in `lib/i18n/{fa,en}.js`; parse_mode HTML; t() escapes vars, tp() for buttons/toasts.
- Invisible characters (ZWNJ…) are written as `\u200c` escapes, never literally (`node scripts/fix-invisible.mjs` repairs them).
- Music text goes through `lib/music/normalize.js` only (display / key / compact); dup_key = artist|title|version keys.
- Search: `track_terms` holds terms of ACTIVE tracks only (catalog calls index.add/remove); the inline path
  never writes except a first-time user row / force-join pass, and never runs a tick.
- Keep ≤ 85 modules (the platform refused a 104-module deploy). Add handlers only in their phase.
- Ask the owner before: new dependencies, deploys, migrate warnings, anything that posts to a real
  channel or messages real users. Destination channels (@WangerBeat, @WangerFlow) are Phase 5.
