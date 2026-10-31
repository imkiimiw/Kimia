# AGENTS.md — Aegis

Orientation for AI coding assistants (and humans) working on **Aegis**, a public Telegram group &
channel management/security bot on **Telegram Serverless**. Keep it short and true. Platform SDK
reference: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). Product spec: `docs/SPEC.md` (Persian, the
source of truth — it must be added to the repo; it was not present when Phases 1–8 were built, and
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
- **Module cap**: the platform refuses a deploy with too many modules (104 refused, 88 deploy;
  `test/static.mjs` fails above 95). Prefer adding to an existing module; to merge, make the old
  module a section — `export const name = (() => { …; return { … }; })();` — so callers keep
  `name.fn()` (see `engines/social.js`, `ui/social.js` → `qa`, `ui/panel_social.js`).

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
- Security: signals are pure (`core/signals.js`), settings and memory in `engines/guards.js`,
  federations in `engines/feds.js`, the work in `ui/security.js` (after locks, before commands).
  Anything that must happen "later" (captcha timeout, end of a lock) is done lazily by `sweep()` —
  on the chat's next update and at most every minute globally (`jobs.js`). Never rely on timing.
- Advanced settings: the work in `ui/advanced.js` (service messages before security, message rules
  after it, member commands before moderation), the panel in `ui/panel_adv.js`, topics in
  `ui/panel_topics.js`. Timed jobs (night lock, scheduled cleanup) are rows in `aegis_schedules`
  claimed once by `advanced.sweep()`; message ids for cleanup / self-destruct go to `aegis_msg_log`
  (48 h, Telegram's deletion limit). Times of day are fixed UTC offsets (`core/clock.js`, no Intl).
- Channels: the work in `ui/channel.js` (posts, edits, join requests, joins, admin alerts, the
  discussion group, direct messages, sweep), panels in `ui/panel_channel.js` and `ui/panel_posts.js`,
  the dashboard in `ui/dashboard.js`. Post content is stored and re-published by file_id
  (`core/content.js`), never by copying a message that may be gone. Channel settings live in the
  same settings table (`ch_*`, `dg_*` for the discussion group, `dm_*` for direct messages).
- Social (Phase 8): data in `engines/social.js` (sections `stats`, `badges`, `contests`, `polls`,
  `questions`, `appeals`); the work in `ui/social.js` (counting, points and thanks, contests, polls,
  reactions; section `qa`: questions, anonymous Q&A, appeals, review); panels in
  `ui/panel_social.js` (sections `panelQa`, `panelAnalytics`); pure rules in `core/levels.js`
  (levels, badges, thanks, health score). Counting runs only for messages that passed locks and
  security; command words match only the whole message. Contests and polls end lazily (`sweep`).
- Multi-step inputs → `lib/core/state.js`; new callback_data codes → document them in the module
  header and in `lib/router.js`; keep callback_data ≤ 64 bytes.

## Tests

`npm test` = locale completeness/staleness → static platform rules → unit tests → end-to-end
scenarios (local sdk emulation in `test/sdk/`, strict mock Bot API in `test/mock-telegram.mjs`).
`npm run test:cloud` = smoke test on the real platform with fake users (it temporarily adds
`tgcloud/endpoints/zz_devtools.js` — never push while it runs).
