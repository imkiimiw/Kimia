# Wanger Converter — `@Wanger_Converterbot`

Persian-first Telegram bot that detects, fixes and (in later phases) converts files. Runs on
Telegram Serverless; heavy work will go to an optional Python worker (phase C4+).
Plan: [docs/SPEC.md](docs/SPEC.md) · limits: [docs/LIMITS.md](docs/LIMITS.md) ·
state: [docs/PROGRESS.md](docs/PROGRESS.md) · choices: [docs/DECISIONS.md](docs/DECISIONS.md).

## What it does now (C2)

- Send any file (≤ 20 MB, Telegram's limit for bots): the real type is detected from the content,
  not the name; a wrong extension can be fixed (a renamed copy, same bytes); safe renames.
- PDF: extract / remove / rotate / reorder / split pages; JPG/PNG → PDF; several PDFs and photos → one PDF.
- Archives: ZIP / TAR / TAR.GZ opened safely (zip-slip, links, bombs, encryption refused); ZIP creation.
- Albums: several files at once → one batch → ZIP, one PDF, batch rename (incl. numbering), fix extensions.
- Executables, scripts, macro documents and disguised files are only reported.
- Forced join to the Wanger channels, bans, maintenance, admins, broadcast and job overview in
  `/panel` (until the Wanger Hub / Mother Bot exist).

## Commands (run in `bots/converter/`, Node 22)

```bash
npm install
npm test                                   # 203 tests: unit + end-to-end on a local SDK emulation
npm run tg -- status                       # this bot only (token from Converter_BOT_TGCLOUD_TOKEN)
npm run tg -- migrate --local --dry-run    # see schema changes, applies nothing
npm run tg -- migrate --local --safe       # apply additive schema changes (owner's OK)
npm run tg -- push                         # deploy (owner's OK)
npm run tg -- webhook                      # must say "in sync"
```

The CLI token comes from BotFather → the bot → Serverless → CLI Access, set as the environment
variable `Converter_BOT_TGCLOUD_TOKEN` — never in the repository.

## After the first deploy

1. Make the bot an **admin** in @HIDE_i_SEEK, @Nepenthw_ir and @wangerBots (Telegram only lets admins
   check membership). Until then those channels are skipped and the owner gets an alert every 3 h.
2. `/panel` (owner): channels, bans, maintenance, admins, broadcast, keys.
3. `/secret set GEMINI_API_KEY …` / `WORKER_URL` / `WORKER_SECRET` / `HUB_KEY` store keys for later
   phases (the message is deleted; values are never shown).
