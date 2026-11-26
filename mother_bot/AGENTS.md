# AGENTS.md — Wanger mother bot

A **Telegram Serverless (tgcloud)** bot, its own project inside this repository. Platform rules (module
system, `sdk`, db, endpoints) are the same as every tgcloud bot here: see [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md)
and the repository root's AGENTS.md. Run the CLI **inside this folder** (`mkdir -p .tgcloud` first, or it acts on
the parent project); behind an HTTPS proxy use `NODE_USE_ENV_PROXY=1`.

## What it is

One place for every Wanger bot. Users: an assistant that answers questions about the bots (keyword search over
the catalog; Gemini optional, grounded in the same catalog), quick access (categories, newest, bot pages),
error reports with automatic triage, a status board, opt-in news, a customer club with discount codes, and an
activity history. Team: a panel for the catalog, tickets, incidents, health, maintenance/slow mode, bans,
central forced join, broadcasts, stats and campaigns. Persian UI only.

## Rules this code follows

- **Owner = numeric id `5557901897`** (`lib/config.js`); team members are `users.role > 0`. Owner-only screens
  are checked in `lib/admin.js` / `lib/admin2.js` (`ownerOnly`, and the owner gate in `adminCallback2`).
- **Child bots talk to the mother through the hub**, a private channel where both are admins (endpoints only
  accept verified Mini App calls, so there is no public URL). Format and kinds: `lib/hubout.js` (outgoing) and
  `lib/hub.js` (incoming); the child side is `client/mother-client.js` (copied into each child as
  `tgcloud/lib/mother.js`, guide in `client/README.md`). The mother reads hub posts only from the configured
  `kv.hub_chat` and only for bots in the catalog, and deletes them after reading.
- **Child tokens** (optional) live only in `bots.token`; `lib/children.js` calls the child's Bot API with
  `fetch`, never puts the token in a trace, a log or a message. The token message is deleted on receipt.
- **No scheduler**: due work runs on the side of updates (`lib/due.js`: maintenance ends, health checks, the
  monthly club campaign, broadcasts, cleanup), queued sending wakes the bot with a stopped poll (`lib/wake.js`),
  and `endpoints/tick.js` is the optional outside clock (`.github/workflows/mother-tick.yml`).
- **Every query is index-backed and LIMITed**; ids from callback_data are re-checked against the user.
- Handlers return `{ trace }` (every Bot API call with its view name) for `npx tgcloud run`.
- The mother never locks users out with forced join (so everyone can ask and report); the central forced-join
  list is pushed to the child bots.

## Tests

`npm test`: static checks (`test/static.mjs`: syntax, platform imports, isolate globals, layout, callback_data,
the client's imports) and 38 end-to-end scenarios (`test/e2e.mjs`) on the local sdk emulation (`test/sdk/`) with
a strict mock Bot API (`test/mock-telegram.mjs`). The e2e suite runs the real `client/mother-client.js` as a
child bot and delivers hub posts both ways; child Bot APIs and Gemini are answered by `fetchHooks.route`.
