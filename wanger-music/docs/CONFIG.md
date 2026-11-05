# Configuration

The platform has no `.env` and no environment variables for deployed code
([PLATFORM_NOTES.md](PLATFORM_NOTES.md)), so configuration lives in three places:

| Where | What | Who changes it |
|---|---|---|
| `tgcloud/lib/config/static.js` | Fixed values: owner id, bot id/username, seed lists, limits, setting defaults | A code change + deploy |
| `settings` table | Runtime values, edited in ⚙️ Settings (validated, audited) | The owner, in the bot |
| `force_join_channels` table | The force-join list (seeded once from static config) | The owner, in 🔐 Force Join |

Secrets: **none needed.** Bot API calls are authenticated by the platform; the code never sees a
token. If a later provider needs an API key, it goes in the git-ignored
`tgcloud/lib/config/secrets.js` (with a committed `docs/secrets.example.js`), never in the repo.

## Static values (`lib/config/static.js`)

| Key | Value | Notes |
|---|---|---|
| `OWNER_ID` | `5557901897` | Always full access; not a database role; can't be demoted or banned |
| `BOT_ID` | `9280424458` | From `getMe` (used to check the bot's own rights in channels) |
| `BOT_USERNAME` | `Wange_Musicbot` | The real username (the spec's working name was `WangerMusicBot`) |
| `FORCE_JOIN_SEED` | @HIDE_i_SEEK `-1002407928564`, @Nepenthw_ir `-1001816009903`, @wangerBots `-1001910797391` | Inserted only into an empty table, only once (`forcejoin.seeded`) |
| `LIMITS.forceJoinMax` | 10 | Enforced in the insert statement itself |
| `LIMITS.flowTtlSeconds` | 900 | Multi-step input expires after 15 min |
| `LIMITS.lastSeenWriteSeconds` | 600 | `users.last_seen_at` is written at most every 10 min |
| `LIMITS.processedUpdatesKeepSeconds` | 172800 | Update dedupe rows are pruned after 48 h |
| `LIMITS.errorLogKeep` | 2000 | Newest error rows kept |
| `LIMITS.alertErrorEverySeconds` | 1800 | One owner alert per error kind per 30 min |
| `LIMITS.alertForceJoinEverySeconds` | 3600 | One alert per broken force-join channel per hour |
| `COMMANDS_VERSION` | 1 | Bump when command menus change; the owner's next update re-syncs them |
| `CURRENT_PHASE` | 1 | Sections of later phases show an honest placeholder |

## Settings (`settings` table, ⚙️ Settings)

| Key | Default | Range / values | Used for |
|---|---|---|---|
| `ui.default_language` | `fa` | `fa`, `en` | Language of users who never chose one (/lang) |
| `forcejoin.failure_mode` | `open` | `open` (skip a channel that can't be checked), `closed` (treat as not joined) | §7.3 |
| `forcejoin.ttl_seconds` | `600` | 60–86400 | How long a passed membership check is trusted |
| `forcejoin.bypass_staff` | `true` | on/off | Owner and admins skip force-join |
| `inline.page_size` | `20` | 5–50 | Phase 3 |
| `inline.cache_time` | `60` | 0–3600 | Phase 3 |
| `tick.interval_seconds` | `60` | 10–3600 | Minimum gap between piggyback ticks |
| `tick.budget_ms` | `8000` | 1000–20000 | Manual / scheduled tick and «▶️ ادامه» (wall limit ≈ 30 s) |
| `tick.piggyback_budget_ms` | `2000` | 500–5000 | Tick run after a normal update |
| `broadcast.batch_size` | `25` | 1–100 | Recipients per batch |
| `digest.interval_seconds` | `3600` | 300–86400 | Phase 6 approval digests |
| `time_zone` | `Asia/Tehran` | Asia/Tehran, UTC, Europe/Istanbul, Asia/Dubai, Europe/Berlin, Europe/London, America/New_York | Dates in the panel; schedules later |
| `archive.chat_id` | empty | a channel where the bot can post | Phase 2 archive |

Internal state keys (not editable): `system.bootstrapped`, `forcejoin.seeded`, `forcejoin.version`,
`tick.last_at`, `tick.last`, `telegram.cooldown_until`, `commands.version`.

## Outside the bot

| Name | Where | What |
|---|---|---|
| `Music_BOT_TGCLOUD_TOKEN` | Environment of whoever runs the CLI | The **CLI access token** (`app<id>:<secret>`, BotFather → bot → Serverless → CLI Access). `scripts/tg.mjs` passes it to the CLI as `TGCLOUD_TOKEN`. |
| `WANGER_MUSIC_TGCLOUD_TOKEN` | GitHub → repository secrets | The same CLI token, for `.github/workflows/wanger-music-tick.yml` |
| `WANGER_STAGING_TGCLOUD_TOKEN` | Environment (optional) | A staging bot's CLI token, for `npm run smoke -- --staging` |

## Planned (not configured yet)

Destination channels arrive in **Phase 5** and are stored in the database, never in code. The owner
named them on 2026-11-05: **@WangerBeat** (`-1004370326177`) for English music and **@WangerFlow**
(`-1004391543350`) for Persian music. The bot is already an admin with post/edit/delete rights in
both. Nothing is posted anywhere until the owner adds and explicitly enables a channel.
