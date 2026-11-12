# Wanger Stickers

Telegram bot + Mini App (part of the Wanger bots) that turns photos, videos, GIFs, round videos and
stickers into Telegram and WhatsApp stickers and GIFs. Runs entirely on
[Telegram Serverless](https://core.telegram.org/bots/serverless); all media processing happens on
the user's device inside the Mini App.

> **Status: Phase 1 (core bot) built and tested — not deployed yet.** Bot: @Wanger_Motionbot.
> Owner's guide (Persian): [docs/ADMIN_GUIDE.fa.md](docs/ADMIN_GUIDE.fa.md) · code map:
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · decisions (approved): [docs/DECISIONS.md](docs/DECISIONS.md)
> · platform facts: [docs/SPIKE_REPORT.md](docs/SPIKE_REPORT.md) · plan: [docs/BRIEF.md](docs/BRIEF.md).

Phase 1 features: language choice (fa/en), forced join with resume, pack management by file_id
(add, browse, reorder, emojis, keywords, replace, rename, icon, backup, import, copy, duplicate,
merge, delete), publishing a pack to the community channel with manual review, and the owner panel
(stats, broadcast, forced join, users, settings, flags, texts, maintenance, errors, keys, backup).

## Setup

Node.js ≥ 18 (tests use Node 22's TypeScript stripping).

```bash
cd wanger-stickers
npm install
export WangerStickers_BOT_TGCLOUD_TOKEN='app<id>:<secret>'   # or Motion_BOT_TGCLOUD_TOKEN (BotFather → bot → Serverless → CLI Access)
npm run tg -- status
```

The CLI is only ever run through `npm run tg -- <command>`: it passes the token as `TGCLOUD_TOKEN`
to that one process and works on `wanger-stickers/.tgcloud/` only, so it can't touch the other bots
in this repository. Never commit the token or put it in a file inside the repo.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (outside Telegram, the spike page still runs; endpoint rows are skipped) |
| `npm run build` | type-check + build `dist/` |
| `npm test` | unit tests (`tests/*.test.mjs`) |
| `npm run probe` | Phase 0: measure the Serverless runtime with `tgcloud run` (read-only, nothing deployed) |
| `npm run build:spike` | build + the spike's large test files and the U²-Netp model in `dist/spike/` |
| `npm run spike:local` | run the spike page in a local headless Chromium (baseline only) |
| `npm run deploy` | build, then `tg push` — **ask Kimi first**; never migrates |
| `npm run tg -- migrate --local --dry-run` | show what the database would change (applies nothing) |
| `npm run tg -- migrate --local --safe` | apply additive schema changes (**ask Kimi first**; never `--yes` on warnings) |

## BotFather (when Phase 1 starts)

Enable Serverless; create the CLI access token; set the Main Mini App URL to the address `push`
prints (`https://app<app_id>.tgcloud.ai/`); the menu button and the commands are set by the bot
itself (`setChatMenuButton`, `setMyCommands`) in Phase 1.
