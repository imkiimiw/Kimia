# Wanger Converter — `@Wanger_Converterbot`

Persian-first Telegram bot that detects, fixes and (in later phases) converts files. Runs on
Telegram Serverless; heavy work goes to an optional Python worker ([worker/](worker/README.md), from C4).
Plan: [docs/SPEC.md](docs/SPEC.md) · limits: [docs/LIMITS.md](docs/LIMITS.md) ·
state: [docs/PROGRESS.md](docs/PROGRESS.md) · choices: [docs/DECISIONS.md](docs/DECISIONS.md).

## What it does now (C4)

- Send any file (≤ 20 MB, Telegram's limit for bots): the real type is detected from the content,
  not the name; a wrong extension can be fixed (a renamed copy, same bytes); safe renames.
- PDF: extract / remove / rotate / reorder / split pages; JPG/PNG → PDF; several PDFs and photos → one PDF.
- Archives: ZIP / TAR / TAR.GZ opened safely (zip-slip, links, bombs, encryption refused); ZIP creation.
- Albums: several files at once → one batch → ZIP, one PDF, batch rename (incl. numbering), fix extensions.
- OCR with Google's Gemini (photos, PDFs ≤ 5 pages) once the owner stores `GEMINI_API_KEY` (one-time user consent).
- With a hosted worker (`WORKER_URL` + `WORKER_SECRET`): image convert (JPG, PNG, WEBP, GIF, BMP, TIFF,
  ICO, AVIF, HEIC), resize, crop, rotate/flip, compress, remove EXIF, filters, watermark, text on image,
  and Persian-correct text → image. Hidden until the worker answers; see [docs/HOSTING.md](docs/HOSTING.md).
- Executables, scripts, macro documents and disguised files are only reported.
- Forced join to the Wanger channels, bans, maintenance, admins, broadcast and job overview in
  `/panel` (until the Wanger Hub / Mother Bot exist).

## Commands (run in `bots/converter/`, Node 22)

```bash
npm install
npm test                                   # 236 tests: unit + end-to-end on a local SDK emulation
(cd worker && python -m pytest -q)         # 149 worker tests (see worker/README.md)
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
3. `/secret set GEMINI_API_KEY …` / `WORKER_URL` / `WORKER_SECRET` / `HUB_KEY` store keys (the message
   is deleted; values are never shown). `WORKER_URL` must be `https://host` on port 443 — Serverless
   reaches no other port. `/panel → 🧩 Worker` shows whether the worker answers.
