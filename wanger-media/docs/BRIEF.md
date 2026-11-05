# WANGER MEDIA BOT — brief for Claude Code

> The owner's brief, saved verbatim on 2026-11-05 (Phase 0) so every session can read it.
> Bot: `@Wanger_mediabot` (app9080356648). Owner's note with it: "This is a separate bot with its own
> token, and I give you all permissions to build it."

## 1. Goal

A multilingual (Persian / English / Russian) Telegram bot: people send a link from a supported platform and get the media back, in private chat or in groups. It has forced channel membership, a user dashboard and an admin panel inside the bot. It runs entirely on **Telegram Serverless**; the deployed code lives in `tgcloud/`.

One person runs it on a zero budget. Prefer simple, proven solutions over impressive architecture, and be honest about what the platform can't do.

## 2. Working rules (every session)

- Work only on the phase I name (§11). Never start the next phase on your own.
- Start of a phase: read `docs/PROGRESS.md`, then show a short plan (files, steps, risks) before coding.
- End of a phase: run the tests, fix failures, update `docs/PROGRESS.md` (done / remaining / what you need from me), then stop and summarize.
- Log assumptions and technical choices in `docs/DECISIONS.md`, one line each with the reason.
- Ask me only about money, accounts, credentials or legal/policy choices. Decide everything else and log it.
- Never fake functionality: no placeholder success messages, no buttons for unbuilt features, nothing marked SUPPORTED before it is implemented and tested.
- Deploying: ask me before `npx tgcloud push`. For schema changes run `npx tgcloud migrate --dry-run`, then `--safe` after my OK; I apply destructive changes myself. Never use `push --force`. `npx tgcloud run` is fine, but assume it uses the bot's real database, so use fake IDs.
- Never open `.tgcloud/` (it holds credentials) and never touch files outside this project folder.
- Code, comments, commit messages and docs in English. Talk to me in Persian.

## 3. Platform constraints (details: AGENTS.md, docs/tgcloud-sdk.md)

- Plain JavaScript in a V8 sandbox. Imports: only `sdk` (`sdk/db`, `sdk/api`, `sdk/fetch`) and our own modules, by relative path ending in `.js`. No npm packages, filesystem, Python, FFmpeg or yt-dlp at runtime.
- Only `.js` files under `tgcloud/` are deployed, so locales, config and anything the bot reads at runtime are JS modules (e.g. `tgcloud/lib/i18n/fa.js`), not JSON or Markdown.
- Database: SQLite through a Drizzle-like DSL. No foreign keys: keep integrity in code. Deploying code and migrating the schema are separate steps.
- Limits others have observed on early-access accounts (verify): a query fails if it scans more than ~50k rows, one insert is capped at ~10k rows, and separate writes are slow. So index every lookup, batch writes, and keep running counters for statistics instead of counting large tables.
- Sizes: `fetch` responses ≤ 30 MB in total; uploads to Telegram ≤ 50 MB (photos ≤ 10 MB); `api.getFileContent` ≤ 20 MB; when sending a file by URL, Telegram fetches it itself, ≤ 20 MB (photos ≤ 5 MB).
- The current docs show no background jobs or cron (confirm in Phase 0). Everything must finish within one invocation or run as small, resumable, idempotent batches. Do housekeeping, like deleting expired rows, opportunistically.
- Handlers: `message`, `callback_query`, `my_chat_member`; add other update types only when needed.
- Third-party API keys are entered by the owner in the admin panel, stored in the database and never shown again. Never put secrets in source files or git.

## 4. Fixed configuration

- Owner: Telegram ID `5557901897`, in `tgcloud/lib/config.js`. Permanent super admin: can't be banned, restricted or demoted. Only the owner manages forced-join channels and grants or revokes SUPER_ADMIN.
- Forced-join channels, seeded on first run: `@HIDE_i_SEEK`, `@Nepenthw_ir`, `@wangerBots`. Maximum 10, managed by the owner in the bot's private chat.
- Languages: `fa`, `en`, `ru`; a missing key falls back to `en`. In Persian texts, put links on their own line so right-to-left text doesn't scramble them.

## 5. Telegram behaviour to design around

- Rate limits: about 1 message/s per chat, 20/min per group, 30/s overall. Honour `retry_after` on 429.
- `callback_data` is at most 64 bytes: use short codes.
- An update may arrive twice: remember recent `update_id`s and skip repeats, make writes idempotent, and ignore double taps on buttons.
- Privacy mode: in groups the bot sees ordinary messages only when privacy mode is off in BotFather (then the bot must be removed and re-added) or when it is a group admin. Detect this, show setup steps, and never claim to see messages it can't.
- `getChatMember` on a channel works only if the bot is an admin there. An API error means "unknown", never "member"; tell the owner which channel is misconfigured. Cache positive results for a few minutes.
- Bots can't read posts from channels they aren't in, so t.me post links are out of scope.
- Cache `(normalized URL, variant) → file_id` so a repeated link is re-sent instantly without fetching again.

## 6. Download policy

The bot can't know whether a stranger's link belongs to the user, so the policy is explicit and controlled by the owner.

- Each platform adapter may offer up to three methods:
  - `official`: a documented official API that returns the media, using owner-provided credentials.
  - `public`: what the platform serves publicly without login (oEmbed, Open Graph tags, public JSON).
  - `external`: an HTTP download service the owner may run later. Define a small JSON contract for it now; don't build the service. The hard limits below apply to it too.
- Every method starts OFF. The owner enables methods per platform. Enabling `public` or `external` first shows a short risk note kept in the adapter (summarized from `docs/PLATFORMS.md`: terms of service, copyright), and the change is audit-logged.
- Never, whatever the settings: DRM content; private, login-only, age-gated or paywalled content; logging in or using anyone's account or cookies; working around blocks, geo limits or rate limits; removing or cropping watermarks.
- Captions always include the source link and platform name.
- On first use, users accept a short disclaimer: they are responsible for having the right to download and share what they request.
- Owner tools: blocklist (URL / account / domain), purge cached file_ids for a URL, disable a platform instantly.
- Before any fetch, the policy engine checks in this order: global switches → ban, quota and cooldown → forced membership (private chats) → platform and method enabled → URL host on that platform's allowlist and not blocklisted → size limits. If a check can't be evaluated, deny with a clear reason. Record the decision.
- Delivery: send by URL when Telegram can fetch it (≤ 20 MB); otherwise fetch the bytes (≤ 30 MB) and upload them as `InputFile`. Albums go through `sendMediaGroup`. If a file is too big, say so and offer a smaller variant if one exists. No transcoding or merging: offer only variants that are already complete files.

## 7. Platforms

TikTok, Pinterest, Instagram, Facebook, LinkedIn, YouTube, X/Twitter, Reddit, Snapchat, Twitch, Threads, Discord, Spotify, SoundCloud.

- One adapter per platform in `tgcloud/lib/platforms/`, behind a common interface (`identify`, `capabilities`, `resolve`, `healthCheck`) and a registry. No single giant downloader function.
- Capability statuses: SUPPORTED, LIMITED, METADATA_ONLY, REQUIRES_OAUTH, REQUIRES_APPROVAL, UNAVAILABLE, TEMPORARILY_DISABLED. They must be truthful and covered by tests.
- Spotify is DRM-protected: metadata only (title, artists, cover, link). Never fetch the audio from somewhere else to fill the gap.
- Discord: only direct attachment links (cdn.discordapp.com); message links are UNAVAILABLE.
- Platforms that require login, block automated requests or serve audio and video as separate streams (often YouTube, Instagram, Reddit video) are LIMITED or METADATA_ONLY here. Say so plainly; don't work around it.
- Order: the first 3 platforms (you propose them in Phase 0, I confirm), then one platform per session.

## 8. Features

**Private chat**
- `/start`: language picker on first run (Telegram's language preselected) → forced-join check (a button per missing channel plus "Check again") → disclaimer (first time) → main menu.
- Main menu: Download (or simply send a link), My downloads (paginated), Settings (language, preferred quality), Help, About.
- One status message per request: "processing…", then the result or a specific, localized error. Back and Home on every screen; expired menus handled gracefully.

**Groups**
- Detect supported links (plain text and `text_link` entities), up to 3 per message by default; reply with the media and source link.
- Per-group settings that only group admins can change, via `/settings`: auto-download on/off, allowed platforms, admin-only mode, max file size, per-user and group cooldowns, silent mode, group language.
- Commands `/settings`, `/status` (settings and usage), `/platforms`, `/help`, registered with `setMyCommands` in fa, en and ru.
- Forced membership applies in private chats. In groups it is off by default; if the owner turns it on, non-members get one rate-limited join prompt instead of the download.
- Channels: no auto-download.

**Admin panel** (`/admin`; every action re-checks permissions)
- Roles: owner, SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT, each with permission flags (manage users, view stats, manage platforms, broadcast, manage admins…).
- Overview from running counters: users (total / active / new), groups, downloads succeeded and failed per platform. No invented numbers.
- Users: search by ID or @username, profile and history, ban/unban, quotas, notes.
- Forced-join channels (owner only: add, remove, toggle, check the bot is admin there); platforms (methods on/off, credentials, health check, recent errors); global switches (maintenance, downloads on/off, limits); broadcast; audit log; editable welcome and forced-join texts.
- Broadcast runs in small resumable batches across invocations (for example a "Send next batch" button and/or a small batch piggybacked on incoming updates), honours 429 `retry_after`, and marks users who blocked the bot.
- Sensitive actions are written to the audit log. Stored credentials are never displayed.

## 9. Security

- Parse URLs strictly. Fetch only hosts on the matched platform's allowlist (including its media CDNs); never IP literals, localhost or private ranges; re-check every redirect target.
- Check the size (Content-Length or a Range request) before downloading bytes.
- Check permissions server-side on every admin action and every group-settings change.
- Never log secrets, credentials or full user messages.

## 10. Tests and docs

- Test locally with Node and Vitest (dev dependency only, never deployed), with aliases mapping `sdk`, `sdk/db`, `sdk/api` and `sdk/fetch` to mocks. Keep logic in pure functions so it is testable. Tests never call real platforms.
- Must cover: owner vs ordinary user on admin actions; forced join (member / not member / API error is not "member"); identical key sets in fa, en and ru; URL identification including unsupported and malicious URLs; the policy engine denies by default; duplicate updates and double taps; size limits; group settings changeable only by group admins; privacy-mode diagnostics; one platform failing doesn't break the others.
- After unit tests, a short check with `npx tgcloud run` and fake IDs.
- Docs, kept short: `README.md` (setup on Windows, enabling Serverless in BotFather, CLI login, push and migrate, privacy mode and adding the bot to groups, making the bot admin in the forced-join channels, using the admin panel); `docs/PLATFORMS.md` (per platform: official API and approval needs, what each method can do on Serverless, limits, terms-of-service and copyright notes, status; mark anything unverified); `docs/DECISIONS.md`; `docs/PROGRESS.md`.

## 11. Phases

Each phase ends with passing tests, updated docs and a stop.

0. **Discovery** (no app code): read AGENTS.md and docs/tgcloud-sdk.md and confirm the limits in §3 (execution time, cron, database). Research each platform's official API, public metadata and terms. Write `docs/PLATFORMS.md`, `docs/DECISIONS.md` and `docs/PROGRESS.md`, propose the first 3 platforms, and list what I need to create or obtain.
1. **Foundation**: schema (users, user settings, roles, forced channels, groups, group settings, download history, file cache, counters, bans, audit log, system settings, processed updates), config, i18n, `/start` and language, roles and owner checks, forced join, idempotency, test setup.
2. **User dashboard**: menu, settings, history, disclaimer, help and about.
3. **Download core** with the first 3 platforms: registry, policy engine, resolvers, delivery, file_id cache, limits, history, counters, plus a minimal owner-only screen to switch platforms and methods on (it moves into the admin panel in Phase 4). Done when I confirm in Telegram that a public link from each one arrives.
4. **Admin panel** (§8), including broadcast.
5. **Groups** (§8).
6. **Launch**: localized commands and bot descriptions, README walkthrough, final review.
7. **Remaining platforms**, one per session, each with tests and an updated `PLATFORMS.md`.
8. **Only when I ask**: the `external` download service (for large files and platforms Serverless can't handle) and an uploader. Research the uploader first: some platforms (e.g. Spotify) have no upload API, others require app review, and Serverless has no public endpoint for OAuth callbacks.
