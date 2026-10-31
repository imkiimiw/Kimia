# AGENTS.md — meme bot

Orientation for AI assistants (and humans) working in `memebot/`. Keep it short and true.
Platform SDK reference: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). Platform limits and the
plan's constraints: [docs/PLATFORM.md](docs/PLATFORM.md). Features and setup: [README.md](README.md).

## Ground rules

- **Isolation**: everything for this bot lives in `memebot/`. Never import from, edit, or reuse the
  config of the other bots in this repository.
- **CLI only through `npm run tg -- …` / `npm run deploy`.** The wrapper reads
  `Meme_BOT_TGCLOUD_TOKEN` (the CLI access token `app<id>:<secret>`, never the bot token) and runs
  from `memebot/` with `memebot/.tgcloud/`. A bare `npx tgcloud` at the repository root hits the to-do bot.
- **Phases**: the owner builds this bot phase by phase. Finish a phase, summarise it, and wait for
  the go-ahead before the next one. Phases 1 (core), 2 (moderation, admin panel), 3 (favourites,
  private collection, keyword editing, hashtags, type filter) and 4 (public channel feed, likes,
  score ranking, profiles, weekly leaderboard, meme of the day) and 5 (stats; moderator role) are
  built and deployed.
- **One channel**: the bot posts only to `ENV.backupChannelId` / `ENV.motdChannelId` (both default
  to @WangerChaos, -1004475337598, in `scripts/gen-env.mjs`). It is public, so `backupMode` is
  `public`: only approved memes, as clean copies, never the uploader's name; removals delete the
  post. Never post to forced-join channels or anywhere else.
- **Free only.** Anything a free tier or the platform can't do goes into `docs/PLATFORM.md` with an
  alternative, not into code.

## Platform rules that bite

- Deployed code: `tgcloud/` only. Relative imports **with `.js`**; the SDK by name. No npm, no
  filesystem, **no env vars** (deploy-time values go through `scripts/gen-env.mjs` → `lib/env.js`),
  no `Intl`, no timers, no `URL`/`Buffer`/`TextEncoder`, no regex `\p{…}`, no `String#normalize`.
- **No scheduler.** Nothing may depend on the bot waking up by itself.
- About 3 s of CPU per update; `Date.now()` is frozen during one. Inline queries arrive per keystroke:
  keep them to a few indexed queries and one `answerInlineQuery` (`npm test` checks the query counts).
- **Only `/* */` comments, explicit semicolons**: a module must still parse with its line breaks
  removed (a BotFather paste can lose them). **No literal invisible characters**: write `\u200C`
  (locales may keep emoji variation selectors). Careful: some editors and tools decode `\uXXXX` when
  writing a file; `npm test` catches it.
- Every DB call is awaited; SQL only through the `sql` tag; no foreign keys; drops only via `.deprecated()`.

## Conventions

- Every user-visible string is in `tgcloud/lib/locales/<lang>.js`, with the same keys in every
  language (fa is the default). Strings are Telegram HTML; user content goes in through `esc()` /
  `iso()` (escape + bidi isolation). Numbers passed to `t()` get the language's digits.
- Every query is in `lib/store.js` / `lib/adminstore.js`: index-backed, `LIMIT`ed, and filtered by `user_id` for user data.
  Ids from `callback_data` are always re-checked against the caller.
- New `callback_data` codes go in the table in `lib/router.js`. Keep them ≤ 64 bytes.
- Handlers return `{ trace }` (every Bot API call with its view name), shown by `npm run tg -- run …`.
- Search words come only from `lib/normalize.js` (`indexWords` for keywords, `parseQuery` for
  queries). Change both sides together. `#tags` are indexed as words starting with `#`; query
  modifiers (fav, types) come from each locale's `_words` via `aliasMap`, leading words only.
- Owner = `ENV.ownerId` (`MEMEBOT_OWNER_ID`, default 5557901897). Staff = the `admins` table with
  `role` admin | mod. `roleOf()` (lib/bot.js) → owner | admin | mod | null, read fresh on every
  message and button, never cached. Owner-only panel codes: `admin.OWNER_ONLY`; the only codes a
  moderator may use: `admin.MOD_ALLOWED` (the approval queue). Any role is exempt from forced
  join, anti-spam, the daily limit and approval.
- Meme status: `pending` (only the uploader sees it) → `approved` | `rejected`; `approved` →
  `hidden` (reports) → `approved` | `rejected`; `private` (owner only, never public) → publish →
  `pending` | `approved`. A private meme's `file_unique_id` column holds `store.privateKey()`
  (`p<uid>:<id>`) so the UNIQUE column never blocks a public copy; dedupe checks both keys. Changes that two admins could race on are
  compare-and-set in `lib/adminstore.js`. Inline visibility is `store.visibleTo()`, nowhere else.
- Settings live in kv (`config.SETTINGS`); `getSettings()` reads them all, plus the channel count,
  in one query. Changing channels or the join switch bumps `join:ver` (all cached checks go stale).
- Deploys are migrate-first (`npm run deploy`): schema changes must stay additive so the old code
  keeps working until the push.
- Ranking = `memes.score` = uses + LIKE_WEIGHT × likes, kept up to date where uses and likes change
  (`store.recordUse`, `socialstore.toggleLike`); week/day counters only for approved memes.
  Channel hooks in `lib/backup.js`: `memePublished` / `memeRemoved` / `keywordsChanged` must be
  called wherever a meme becomes public, stops being public, or changes keywords.
- Callbacks outside the private chat (inline messages, channel posts) may only do `lk`; `ctx.chatId`
  is then the presser's private chat, so nothing is ever sent into a channel or group.
- Work without a scheduler runs in `lib/jobs.js sideTasks` after messages, buttons and
  chosen_inline_result (never inline queries): broadcast batches, the meme of the day, daily pruning.
- Stats (`lib/statsstore.js`): a search is counted once per typed query (settled on send, on a
  non-continuation, or on clearing), after the inline answer is sent — keep it after the answer.

## Tests

`npm test` = `gen-env` → `test/static.mjs` (platform rules) → `test/unit.test.mjs` (normalisation,
locales, query syntax, calendar) → `test/e2e.mjs` (41 scenarios: Phases 1–3 with the channel as an
archive and moderation first off, then on; Phase 4 in public mode: the real handlers against `test/sdk/`, a local
SQLite stand-in for the SDK, and `test/mock-telegram.mjs`, a strict mock Bot API, with web and timer
globals removed like the isolate).

To check SQL on the real database without deploying, put a temporary module in
`tgcloud/endpoints/` and `npm run tg -- run endpoints/<name> '{}' --ctx '{ initData: { user: { id: 1 } } }'`
(run executes local code on the platform). Use fake ids, clean up in `finally`, and delete the
module before any push. The database whitelists SQL functions (`sqlite_version()` is refused).
Smoke tests with `npm run tg -- run handlers/…` touch the real database: always use fake user ids
(99000000x), never a real user's — handlers write state and stats.
Writing `\uXXXX` escapes through a tool that takes JSON input can turn them into the real
character before the file is written; check with `npm test` (static check) after such edits.
