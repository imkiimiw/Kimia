# Wanger Media (`@Wanger_mediabot`)

A multilingual (فارسی / English / Русский) Telegram bot that returns media for links from supported
platforms, running only on [Telegram Serverless](https://core.telegram.org/bots/serverless).

**Status: Phases 1–2 deployed (foundation; dashboard: menu, history, settings, help, about).**
See [docs/PROGRESS.md](docs/PROGRESS.md). Tests: `npm test`.
The full setup walkthrough (Windows, BotFather, CLI login, push/migrate, groups, admin panel) is
written in Phase 6.

- Plan: [docs/BRIEF.md](docs/BRIEF.md) · Platforms and Serverless limits: [docs/PLATFORMS.md](docs/PLATFORMS.md)
  · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- CLI (from this folder): `npm install`, then `npm run tg -- status`. The CLI access token
  (BotFather → the bot → Serverless → CLI Access) is read only from the environment variable
  `Media_BOT_TGCLOUD_TOKEN`; it is never stored in this repository.
