# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
This file is auto-loaded by Claude Code, Cursor, and similar tools — keep it short
and true. For the full SDK reference (db, Bot API, fetch), see
[docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).

## What this project is

A **Telegram Mini App bot** running on Telegram's serverless platform. You write
JavaScript modules (database schema, shared library code, update handlers); the
platform runs them in a V8 isolate. The `tgcloud` CLI syncs this local project
with the bot's cloud environment — think `wrangler`/`vercel` + `drizzle-kit`.

There is no server to run locally and no `node_modules` to import from at runtime:
the only things available inside a module are the platform SDK and other modules
in this project.

## Layout

Everything the platform runs lives in the **`tgcloud/`** folder. The rest of the
project root is yours (a mini-app front-end, config, docs).

| Path                  | What it is                                                        |
|-----------------------|-------------------------------------------------------------------|
| `tgcloud/schema.js`   | Database schema — tables as **named exports**. One file.          |
| `tgcloud/lib/`        | Shared modules. Subdirectories allowed (`lib/internal/util.js`).  |
| `tgcloud/handlers/`   | Update handlers, **one level only**. Names match Telegram Bot API update types (`message`, `callback_query`, …). |
| `tgcloud/endpoints/`  | Functions the Mini App calls (`POST /api/<name>`), **one level only**. |
| `tgcloud.jsonc`       | Project config. Its `"static"` block names the build folder hosted as the Mini App. |
| `docs/`               | Reference docs (this project's, for you). Not deployed.           |
| `.tgcloud/`           | CLI state (credentials, snapshot, cached layout). **Never edit or read from here** — it's gitignored machine state. |

Only `.js` files under `tgcloud/` (`schema.js`, `lib/`, `handlers/`, `endpoints/`) are deployed
as code, plus — when `tgcloud.jsonc` names one — the front-end's build folder as
the Mini App's static files. Everything else (Markdown, config, `.tgcloud/`, the
front-end's sources) is local-only. Module names are relative to `tgcloud/`: the
file `tgcloud/handlers/message.js` is the module `handlers/message`.

## Mini App front-end

If the project root holds a front-end (Vite, React, Vue, …), its **build output**
is deployed next to the bot and served as the Mini App at
`https://app<app_id>.tgcloud.ai/` — `push` prints the exact URL.

- `tgcloud.jsonc` → `{ "static": { "source": "dist" } }` — `source` names the
  build folder; the other keys of the `static` object are the serving config
  (e.g. `"spa": true` serves `index.html` for unknown extension-less paths —
  client-side routing; `immutable`, `headers`, `redirects`). `tgcloud init` writes
  the file when it recognizes the front-end; after that it's a normal project
  file. JSON with comments and trailing commas (a project may use a strict-JSON
  `tgcloud.json` instead — never both). `"static": "dist"` is accepted as a
  shorthand for `{ "source": "dist" }`.
  `"static": false` removes the deployed site on the next push.
- **Build before you push.** `push` uploads the folder as it is on disk; it never
  runs the build. `npm run deploy` (build + push) is the safe default.
- The front-end is ordinary browser code with npm packages — none of the
  `tgcloud/` module rules apply to it, and `tgcloud/` modules can't import it.
  It talks to the bot's code only through **endpoints** (below).
- The site is served from the host root, so the bundler's default `base` (`/`)
  is right. Don't add `X-Frame-Options` or a restrictive `frame-ancestors`:
  Telegram Web opens Mini Apps in an iframe.

## Endpoints — the Mini App's server side

`tgcloud/endpoints/<name>.js` is called by the Mini App as `POST /api/<name>` on
the same host as the static site. Use it for anything the front-end can't do
itself: the database, the Bot API, secrets.

- `export default async function (input, ctx)` — `input` is the JSON body (an
  object); the return value goes back as JSON.
- `ctx.initData` is the Mini App's init data **verified by the platform** (same
  shape as `Telegram.WebApp.initDataUnsafe`): `ctx.initData.user` is the caller.
  There is no `ctx.user`. Invalid init data → `401`, the endpoint never runs.
- Refuse with `throw new EndpointError('Out of stock', { code: 'OUT_OF_STOCK' })`
  (`import { EndpointError } from 'sdk'`) → `400`, the Mini App gets
  `description` + `parameters`. Any other exception → generic `500`; never
  rely on its message reaching the client.
- Front-end call: `Telegram.WebApp.Serverless.call('<name>', input, (err, result) => …)`
  from the official `telegram-web-app.js` — it sends the init data; `err` has
  `message` (description), `type` (`'ENDPOINT_ERROR'` for your `EndpointError`)
  and `parameters`. Don't hand-roll `fetch` + init data.
- Names: letters, digits, `_`, not starting with a digit (`getProfile`).
  Scaffold with `npx tgcloud add endpoints/<name>`; test with
  `npx tgcloud run endpoints/<name> '{}' --ctx '{ initData: { user: { id: 1 } } }'`.

## Module system — the rules that bite

- **Import project modules by relative path WITH the `.js` extension; import
  the SDK by name.** (from `tgcloud/handlers/message.js`:)
  - ✅ `import { users } from '../schema.js'`
  - ✅ `import { addItem } from '../lib/cart.js'`
  - ✅ `import { db, api, fetch } from 'sdk'` / `import { eq, sql } from 'sdk/db'`
  - ❌ `import { users } from '../schema'` → a relative import must end in `.js`
  - ❌ `import x from '../../src/x.js'` → nothing outside `tgcloud/` is reachable
  - A module's *name* is its path inside `tgcloud/` without `.js` (`lib/cart`);
    `tgcloud run` takes it, and `from 'lib/cart'` (no extension) also resolves —
    but write relative imports.
- **No filesystem, no npm packages** at runtime. Only `sdk` (and its submodules
  like `sdk/db`) and your own project modules exist.
- A handler module's `export default` is what the platform invokes, with the
  update's **payload** as the first argument — for `handlers/message` that's the
  `Message` (i.e. `update.message`), for `handlers/callback_query` the
  `CallbackQuery`, and so on. The full `Update` (with `update_id`) is on the
  second argument: `ctx.update`. An endpoint's `export default` gets
  `(input, ctx)` — see *Endpoints* above.

## Platform SDK (`import … from 'sdk'`)

- **`db`** — the database (query builder + schema DSL). Full API: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).
- **`api`** — the Telegram Bot API. `api.<method>({...})` (e.g. `api.sendMessage`,
  `api.getMe`) returns the **unwrapped** result and **throws `BotApiError`** on
  failure (`import { BotApiError } from 'sdk'`; it has `.code`/`.description`/`.parameters`).
- **`fetch`** — outbound HTTP, web-`fetch`-like (`res.status/ok`, `res.json()`,
  `res.text()`, streaming via `for await`, redirects followed).
- **`EndpointError`** — the one way an endpoint refuses a call (see *Endpoints*).

## Database — the rules that bite

Full API in [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). The non-obvious parts:

- **Every DB call is async — always `await`.** `.all()`, `.get()`, `.values()`,
  `.run()`, `db.$count()` and the raw `db.run/all/get` all return Promises.
- **No foreign keys.** `.references()` and `foreignKey()` **throw at declaration**
  — the runtime runs with FKs off, so they'd be silently inert. Enforce integrity
  in application code (delete children before parents, etc.).
- **Drops happen only via `.deprecated('reason')`** on a column/table/index.
  Deleting the declaration does *not* drop anything.
- **Type changes aren't automatic** — do them by hand with `db.run(...)`.

## Deploy & migrate workflow

**Deploying never touches the database.** Schema sync is a separate, explicit step.

The CLI is a local dev-dependency, so run it with `npx tgcloud <command>` (or use
the `npm run` scripts in package.json — e.g. `npm run deploy`):

```
npx tgcloud status     # what changed locally vs the cloud
npx tgcloud push       # deploy modules (and the static build) to the cloud
npx tgcloud migrate    # apply tgcloud/schema.js changes to the database (interactive)
npx tgcloud run <module> [args]   # execute a handler or endpoint server-side
npx tgcloud pull       # bring the local project in line with the cloud
npx tgcloud login      # link this project to a bot
npx tgcloud webhook    # show the bot's webhook and whether it matches your handlers
```

After you change `tgcloud/schema.js`, `push` reports what the DB *would* change but applies
nothing — run `npx tgcloud migrate` to actually apply it.

The platform manages the bot's webhook for you, derived from your deployed
`handlers/*`, and refreshes it on `push`. If it ever drifts — e.g. someone called
`setWebhook` with the raw bot token — `npx tgcloud webhook` shows the mismatch and
`npx tgcloud webhook sync` repairs it.

## This bot

A game bot whose main surface is a **Mini App** (Preact + TypeScript + Vite in `app/`, built to
`dist/`), in en / fr / ru / fa. Ten games: Hokm, backgammon, Ludo, chess, tic-tac-toe, Reversi, dots
and boxes, rock-paper-scissors (rooms, 2–4 players, each playable against bots) and the solo games
Codeword and Fusion. Codeword and Fusion are this project's own designs (a word version of Bulls and
Cows, and a placement merge puzzle); the rest are traditional games. Don't add recreations of
existing commercial games.

- **Shared pure modules** — `tgcloud/lib/games/*` (rules), `tgcloud/lib/i18n/*` (every string),
  `tgcloud/lib/config.js`, `tgcloud/lib/payload.js` — are imported by the endpoints *and* by `app/`.
  They must never import `sdk` (Vite can't resolve it). Everything else in `tgcloud/lib/` is server-only.
- **Rule modules** export `SEATS, TURN_SEC, create, turn, act, auto, outcome, rematch, view` and keep
  a `log` of events with sequence numbers that the Mini App replays to animate. `act` returns
  `{ state }` or `{ error: CODE }`; `auto` is both the bot and the move made for a player out of time.
  Optional: `waiting(state)` (several players act at once: rps), `MIN_SEATS` (may start short of
  full: ludo), `LEAVER_BECOMES_BOT` (a leaver is replaced by a bot instead of losing: ludo).
- **Rooms** (`lib/rooms.js`): the server is the authority. Every write is a compare-and-set on
  `rooms.ver`. There is **no scheduler**: `advance()` runs on each request (bots, turn timeouts →
  auto move, `MAX_TIMEOUTS` → forfeit, the end of the game). `getState(room, since)` is the polling
  endpoint (`{ same: true }` when unchanged). A game is recorded (stats, points) only if humans
  played on both sides — games against bots are practice.
- **Invitations must work with no BotFather setup.** `lib/links.js` asks `getMe` (cached 10 min in
  settings) whether the bot has a Main Mini App: if so links are `t.me/<bot>?startapp=<payload>`,
  else `t.me/<bot>?start=<payload>` → the bot answers `/start <payload>` (`lib/bot.js`) with a
  `web_app` button to `APP_URL?sp=<payload>`. The Mini App reads the payload from `start_param`,
  `tgWebAppStartParam` or `sp`. Never hard-code a link form that depends on BotFather settings.
- **Inline mode** is the entry point: every result reserves a room with the inviter seated
  (`here: false` until they open it); a friend who joins triggers a private "… is waiting for you"
  with a button. The lobby's Invite sheet uses `prepareInvite` → `shareMessage` (reading the real
  failure from `shareMessageFailed`), then `switchInlineQuery` (chat types: users / bots / groups /
  channels only), then `t.me/share/url`; plus "copy the link". `chosen_inline_result` (inline
  feedback ON in BotFather, optional) stores `inline_message_id` so `lib/invite.js` can edit the
  invitation with the result.
- The bot sets its own menu button and command list (`ensureSetup` in `lib/bot.js`).
- **Client log**: the Mini App reports launches and client-side failures (`logEvent` in `app/tg.ts` →
  `endpoints/clientLog` → `client_log`, shown under 🧾 in the owner panel). When something "doesn't
  work in Telegram", read it first.
- `npm run test:ui` runs Telegram's **real** `telegram-web-app.js` (downloaded to `test/output/`), so its
  argument checks apply in tests too; never replace it with a permissive stub.
- **Strings**: every user-visible string is in `lib/i18n/*` and must be HTML-safe (no bare `&`, `<`,
  `>`): they are put into Telegram HTML messages. `npm test` checks this and that all four languages
  have every key.
- **Forced join** (`lib/join.js`) guards the bot, every endpoint (`lib/endpoint.js` → `NOT_JOINED`)
  and inline mode; passes are cached per user for `JOIN_CACHE_SEC` and per channel-list revision.
  Broken channels are skipped and the owner warned. The owner (`OWNER_ID` in `lib/config.js`) is exempt.
- **Owner panel** (`lib/admin.js`, `/admin` in private, owner only, silent for others): stats,
  the Mini App's log, channels (max 10, bot must be admin), broadcasts (`lib/broadcast.js`:
  copyMessage in locked batches with a cursor, resumed by the "next batch" button or by the Mini
  App's `?page=broadcast` page calling `broadcastTick` every second while open).
- **Codeword answers never reach the client** before the game ends; **Fusion scores are replayed**
  from the submitted moves and the server's seed (`lib/solo.js`).
- `APP_URL` in `lib/config.js` must be the address `push` prints (thumbnails, Play buttons).
- CSS: a grid item with its own `aspect-ratio` is not stretched — square boards set
  `grid-template-rows/columns: repeat(n, 1fr)` on the board instead (see `.rv-board`, `.ch-board`).
- Word lists: `npm run words -- <sources>` (`scripts/build-words.mjs`) regenerates `lib/words/*`.
  Thumbnails: `npm run thumbs`. Only **block comments** in `tgcloud/` (`npm test` checks).
- Tests: `npm test` (static checks; rule unit tests incl. chess perft and backgammon / Hokm / Ludo
  simulations; server e2e on the sdk emulation in `test/sdk/` + strict Bot API mock), `npm run
  test:ui` (the built Mini App in Chromium with several simulated accounts playing through the UI;
  screenshots in `test/output/`).
- **CLI**: behind an HTTPS proxy run it with `NODE_USE_ENV_PROXY=1`. It uses the nearest folder with
  `.tgcloud/`: make sure `game_bot/.tgcloud/` exists, or commands act on the repository root's bot.
  This bot's token is in `GAME_BOT_TGCLOUD_TOKEN` (pass it as `TGCLOUD_TOKEN` for the command).
- Measured platform limits (sibling projects' notes): ≈ 3 s CPU and ≈ 30 s wall clock per
  invocation, no transactions (one statement = one atomic change), no scheduler or timers.
