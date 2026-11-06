# Wanger Media (`@Wanger_mediabot`)

A multilingual (فارسی / English / Русский) Telegram bot: people send a link to a public post and get
the media back, in private chats or in groups. Forced channel membership, a user dashboard and an
admin panel are built in. It runs entirely on [Telegram Serverless](https://core.telegram.org/bots/serverless)
— no server, VPS or paid service.

**Status:** Phases 0–7 done and deployed (version 1.1.0). What each platform can do, honestly: [docs/PLATFORMS.md](docs/PLATFORMS.md).
Progress: [docs/PROGRESS.md](docs/PROGRESS.md) · decisions: [docs/DECISIONS.md](docs/DECISIONS.md) ·
the original brief: [docs/BRIEF.md](docs/BRIEF.md).

## What it does

| Where | What |
|---|---|
| Private chat | `/start` → language → forced join → disclaimer → menu: ⬇️ Download, 📥 My downloads, ⚙️ Settings (language, preferred quality), ❓ Help, ℹ️ About. Send a link and the media comes back with the source link. |
| Groups | Links of switched-on platforms are answered with the media (up to 3 per message); everything else is ignored silently. `/settings` (group admins), `/status` (settings, usage, what the bot can see), `/platforms`, `/help`. |
| Admin panel | `/admin` for staff: overview, users (ban, quota, note), forced-join channels, platforms (methods, health check, blocklist, cache purge), switches and limits, texts, broadcast, audit log, staff. |

Platforms that send files: **X/Twitter** (photos, videos, GIFs), **Instagram** (public photos, videos,
carousels), **Pinterest** (images, video pins), **Snapchat** (public Spotlight videos), **Discord** (direct
attachment links). Platforms that send an **information card** (title, author, cover, link — their files
can't be fetched honestly): TikTok, Facebook, Threads, YouTube, Reddit, Twitch, Spotify, SoundCloud.
LinkedIn is refused with the reason. Every method starts **off**; the owner switches each one on in
`/admin` → 🧩 Platforms (after reading its risk note for public methods).

## Setup on Windows (one time)

1. Install **Node.js 22 LTS** from <https://nodejs.org> (the "Windows Installer (.msi)"; keep the defaults).
2. Get this project: download the repository as a ZIP from GitHub and unzip it, or `git clone` it.
3. Open **PowerShell** in the `wanger-media` folder (Shift + right-click the folder → "Open in Terminal")
   and run:
   ```powershell
   npm install
   npm test
   ```
   `npm test` runs the local test suite (no network, no bot needed).

## Enable Serverless and connect the CLI

1. In Telegram open **@BotFather** → your bot → **Serverless** → switch it on.
2. In the same place open **CLI Access** and copy the **access token** (it looks like `app123…:…`; it is
   *not* the bot token).
3. Give it to this project's CLI wrapper through an environment variable — never put it in a file you
   commit:
   ```powershell
   # this window only
   $env:Media_BOT_TGCLOUD_TOKEN = "app9080356648:…"
   # or permanently for your user (open a new window afterwards)
   setx Media_BOT_TGCLOUD_TOKEN "app9080356648:…"
   ```
4. Check the link: `npm run tg -- status` and `npm run tg -- webhook`.

Always run the CLI as `npm run tg -- <command>` from `wanger-media/`: the wrapper uses only
`Media_BOT_TGCLOUD_TOKEN`, so it can never touch the other bots in this repository.

## Deploy: migrate, then push

Deploying code never changes the database; schema changes are a separate step, done first.

```powershell
npm test                                  # everything green?
npm run tg -- migrate --local --dry-run   # what would change in the database (nothing is applied)
npm run tg -- migrate --local --safe      # apply only additive ("safe") changes
npm run tg -- push                        # deploy the code; the webhook follows the handlers
npm run tg -- webhook                     # should say "in sync"
```

Never use `push --force`. Changes that drop data are shown as warnings by `migrate` and are applied
by hand only after a backup decision.

After the first deploy: `/admin` → ⚙️ Switches & limits → **🔧 Apply commands and descriptions** sets
the command menus and the bot description in fa, en and ru.

## Forced-join channels

1. Make the bot an **administrator** of every forced-join channel (no special rights are needed). Telegram
   only lets a bot check membership in channels where it is an admin.
2. Manage the list in `/admin` → 📢 Channels (owner only): add by `@username`, a `t.me` link, a numeric id or
   by forwarding a post from the channel; switch a channel off, re-check it, remove it. Up to 10.
3. If a check fails (for example the bot lost its admin rights) users see "couldn't check" instead of being
   let through, and the owner gets an alert. Changes reach everyone within 5 minutes.

## Groups and privacy mode

1. Add the bot to the group. It introduces itself and says what it can see.
2. By default Telegram bots run in **privacy mode**: in groups they only see commands, replies to them and
   messages that mention them — not ordinary links. To have links picked up automatically, either:
   - make the bot an **admin** of the group, or
   - in @BotFather → `/setprivacy` → choose the bot → **Disable**, then **remove the bot from the group and
     add it again** (Telegram applies the change only on re-adding).
3. `/status` in the group always tells you which case applies.
4. Group admins tune the bot with `/settings`: auto-download, admins only, silent mode, links per message,
   max file size, cooldowns, language and allowed platforms. By default only the platforms that send files
   are on in groups; information-card platforms (YouTube, Spotify, …) are switched on there.

## Using the admin panel

- **Roles:** owner (id `5557901897`, can't be banned or demoted), super admin, admin, moderator, support —
  each with permission flags. Only the owner appoints super admins and manages channels.
- **🧩 Platforms:** switch methods on/off (a risk note comes first for public and third-party methods),
  pause a platform instantly, run a 🩺 health check, see recent failures, block a post / account / domain,
  purge the cached files of a link.
- **📣 Broadcast:** send the message (any type) → Start. There is no scheduler on Serverless, so it advances
  in batches: 25 messages each time you press "Send next batch", plus a few on the side of normal traffic.
  Nobody gets it twice; users who blocked the bot are marked.
- **⚙️ Switches & limits:** maintenance, downloads on/off, forced join (also for groups), daily quota,
  cooldown, max file size. **✏️ Texts:** the welcome and forced-join texts per language.
- **📜 Audit log:** every sensitive action, newest first.

## Honest limits

- Telegram Serverless: ≈ 3 s CPU per update, no scheduler, a query fails above ≈ 50 000 rows read — the code
  is built around these (see docs/PLATFORMS.md §1).
- Files up to 20 MB are fetched by Telegram itself; larger ones (up to 50 MB) are downloaded and uploaded by
  the bot; above that a smaller ready-made quality is sent, or the user is told the file is too big.
- Login-only, private, age-restricted and DRM content is never fetched; nothing is re-watermarked.
- Platform terms often forbid automated downloading even of public posts: that is why every method starts
  off and shows its risk note. Users accept that they are responsible for what they download.

## Development

- `npm test` — Vitest: the SDK is emulated on node:sqlite (`test/sdk/`), Telegram and the web are faked
  (`test/helpers/`), recorded real platform responses are fixtures (`test/fixtures/`).
- Code map and rules: [AGENTS.md](AGENTS.md).
