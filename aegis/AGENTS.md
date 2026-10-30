# AGENTS.md — Aegis

Orientation for AI coding assistants (and humans) working on **Aegis**, a public Telegram group &
channel management/security bot on **Telegram Serverless**. Keep it short and true. Platform SDK
reference: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). Product spec: `docs/SPEC.md` (Persian, the
source of truth — it must be added to the repo; it was not present when Phases 1–4 were built, and
the choices made without it are in [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)).

## Ground rules

- **Isolation**: everything Aegis lives in `aegis/`. Never import from, edit, or reuse config of the
  other bots in this repository. Always run the CLI through `npm run tg -- …` / `npm run deploy`
  (they use `aegis/.tgcloud/`; a bare `npx tgcloud` elsewhere can hit another bot).
- **Phases**: the work is split into 10 phases; build only the phase the owner names.
- **Free only**. Anything that can't be built for free on this platform goes to `docs/NOT_BUILT.md`
  (with the reason) and its menu entry stays hidden. Never promise more than the Bot API allows.
- **Secrets**: the CLI token is `Aegis_BOT_TGCLOUD_TOKEN` (env or `aegis/.env`), never committed.

## Platform rules that bite

- Deployed code: `tgcloud/` only — `schema.js`, `lib/`, `handlers/` (flat, named after update
  types), `endpoints/` (flat). Import project modules by relative path **with `.js`**; the SDK by
  name (`sdk`, `sdk/db`). No npm packages, no filesystem, no env vars, no `Intl`, no timers.
- **No scheduler.** Background work runs on the side of updates (`lib/jobs.js`), on button presses,
  or from the owner's open Mini App page. Never design a feature that needs the bot to wake up alone.
- Every DB call is `await`ed; no foreign keys; drops only via `.deprecated()`.
- Only **block comments** in `tgcloud/`; no literal invisible characters in source (write `\u200F`).

## Conventions

- Tables and indexes: `aegis_*` / `idx_aegis_*`. Every query is keyed, index-backed or `LIMIT`ed.
- Every user-visible string: `locales/<lang>/<ns>.json` in **all five** languages (fa, en, ru, zh,
  fr), then `npm run locales`. Strings are Telegram HTML; user content goes through `iso()` (escape +
  bidi isolation). `t()` adds the right-to-left marks for Persian.
- Entry points return `{ trace }`; Bot API calls go through `lib/core/tg.js` with a view name.
- Owner = `OWNER_ID` (numeric, from `AEGIS_OWNER_ID`), checked on every owner message and button.
- Chat settings: every panel action goes through `guard()` in `lib/ui/guard.js` — a live
  getChatMember re-check plus the needed access level (`lib/engines/admins.js`); never trust a
  cached admin row or a chat id from callback_data alone. In groups, never block or answer ordinary
  members because of forced join or configuration.
- Admins: only ones Aegis promoted can be edited (Telegram's `can_be_edited`); appoint through
  `admins.applyRights`, which records `aegis_promotions` (later phases' anti-betrayal reads it).
- Sensitive actions → `audit.log()`; failures → `errors.record()`; risky actions → a confirm step.
- Punishments only through `engines/punish.js` (`apply`/`undo`/`lift`): it records executor, reason
  and source, keeps the mirror lists in sync, logs, and respects **Audit Mode** for anything Aegis
  decides on its own (sources `step`, `blacklist`, `betrayal`). Per-chat options live in
  `engines/settings.js` (validated, logged); destructive admin actions go through
  `betrayal.after()` so anti-betrayal counts them for the person, never for the bot.
- Moderation in groups (`ui/moderation.js`): live role check every time; ordinary members are never
  answered; the owner, admins, Aegis and VIPs are never targets.
- Locks: detection is pure (`core/msgscan.js`, unit-tested), the 42 definitions and settings live in
  `engines/locks.js`, enforcement in `ui/enforce.js` runs **before** commands on every group message
  and edit (a deleted message goes no further). Keep the per-message path to a few indexed queries.
- Multi-step inputs → `lib/core/state.js`; new callback_data codes → document them in the module
  header and in `lib/router.js`; keep callback_data ≤ 64 bytes.

## Tests

`npm test` = locale completeness/staleness → static platform rules → unit tests → end-to-end
scenarios (local sdk emulation in `test/sdk/`, strict mock Bot API in `test/mock-telegram.mjs`).
`npm run test:cloud` = smoke test on the real platform with fake users (it temporarily adds
`tgcloud/endpoints/zz_devtools.js` — never push while it runs).
