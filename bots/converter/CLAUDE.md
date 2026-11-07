@AGENTS.md

# Wanger Converter — working notes for Claude

Read `docs/PROGRESS.md` first, then `docs/SPEC.md` (the owner's spec v2, verbatim) and
`docs/LIMITS.md` (measured platform limits; its §4 matrix and §5 conflicts override the spec).
Work only on the phase the owner names (C0…C8); at the end of a phase: tests green, docs updated,
a short report, then **STOP and wait for the owner's command**. Talk to the owner in Persian; code,
comments, commits and docs in English.

- This folder is its own tgcloud project (`@Wanger_Converterbot`, app9216103899). Run the CLI only as
  `npm run tg -- <command>` from `bots/converter/` (token from `Converter_BOT_TGCLOUD_TOKEN`); never
  bare `npx tgcloud`. The repository root and the other folders are other bots: never touch them.
- Ask the owner before `push`, before `migrate --safe`, and before anything that messages real users.
  Never `push --force`, never destructive migrations.
- Platform spikes: `npm run spike -- <core|lib|size> …` (stages `spikes/` into `tgcloud/` for one
  `tgcloud run` and removes it). Never push while a spike runs.
- pdf-lib on Serverless: `load(…, { parseSpeed: Infinity })`, `save({ objectsPerTick: Infinity,
  useObjectStreams: false })` — always. WebAssembly: synchronous APIs only.
- Tests: `npm test` must stay green (165 at the end of C1), including the query-plan and module guards.
- Never read or edit `.tgcloud/` (credentials).
