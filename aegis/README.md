# 🛡 Aegis — Telegram group & channel management / security bot

Aegis runs entirely on **Telegram Serverless** (code, database, webhook and Mini App are hosted by
Telegram; no VPS, no paid service). It is built in 10 phases; this README describes what is
deployed **now**.

| Phase | Scope | State |
|---|---|---|
| 1 | Core: skeleton, config, DB + migrations, webhook, i18n (5 languages), /start, language picker, user tracking, forced join, owner panel (stats, forced-join channels, broadcast) | ✅ deployed |
| 2 | Adding the bot, configuration & access control: registration + warning, required rights, appoint/edit/remove admins through Aegis, «پیکربندی», access levels, revocation, change log, /shutdown /activate /status | ✅ deployed |
| 3–10 | Lists/punishments, locks, security, advanced settings, channel panel, reports, fun & media, full Super Admin panel | not started |

Design decisions taken without the master spec (it isn't in the repository yet) are listed in
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md).

Features that can't be built for free on this platform, or only partly, are listed in
[docs/NOT_BUILT.md](docs/NOT_BUILT.md).

## What Phase 2 does

**Adding Aegis to a group or channel** (main menu: «➕ Add to group / channel» — these links already
ask Telegram for the needed admin rights, and Aegis sets them as its default admin rights):
- The chat is registered, its admins are read, and **at once** a warning goes to the group (in the
  group's language) and to the private chat of the admin who added Aegis (in theirs):
  *Telegram lets a bot change or remove only the admins it appointed itself — appoint admins
  through Aegis's panel, otherwise anti-betrayal and admin restrictions can't act on them.* It
  lists the required rights — delete, restrict, ban, invite, pin, promote — with ✅/❌, the admins
  already appointed outside Aegis, and buttons «⚙️ Open private panel» and «🛡 Grant missing
  permissions». In a channel nothing is posted (subscribers would see it): only the private message.
- When Aegis's rights change, a short notice says what's missing (or that all is fine).

**«پیکربندی» / config**
- In a group: an admin gets a button to that group's private panel (ordinary members are never
  answered or blocked; anonymous admins are told to use the private chat).
- In private: the list of groups and channels where you're an admin with access.
- Opening a panel goes through the forced-join check (the owner is exempt); a link opened before
  choosing a language or joining is kept and opens afterwards.

**A chat's private panel** — every action re-checks you live with Telegram:
- 🛡 **Permissions**: Aegis's required rights, a grant link, re-check.
- 👮 **Admins**: 👑 owner, ✅ appointed through Aegis, ⚠️ appointed outside Aegis (with how to fix it).
  **Appoint** (pick with Telegram's user picker, a forwarded message, a numeric ID or a known
  @username; choose rights; confirm), **edit rights**, **remove** (asks first). You can never give a
  right you or Aegis don't have; rights you can't give stay as they are; nobody can touch the owner,
  an admin appointed outside Aegis (Telegram forbids it), or an Aegis admin at your level or above
  that you didn't appoint. Basic groups can't appoint (Telegram: supergroups only).
- 🔑 **Access levels**: Full (also admins and access) · Settings · View · None. By default from
  Telegram rights («Add new admins» → Full, «Change info» → Settings, other admins → View); the
  owner sets any level up to Full (asks first for Full), Full admins only below Full.
- 🌐 **Chat language** for everything Aegis posts there · 🔔 **reminder** about admins appointed
  outside Aegis (right after one appears, then at most daily on group activity) · 📜 **change log**.
- **Former admins lose access at once**: on Telegram's chat_member update or on the next re-check
  their cached rights and manual level are deleted (logged).

**Owner** (private chat only): **/status** (state, version, users, chats, broadcast, errors, webhook
queue) · **/shutdown** (asks first; until /activate nobody but the owner is answered, nothing is
posted in groups, broadcasts stop, membership is still recorded; survives deploys) · **/activate**.
Plain words work too: «وضعیت», «خاموش», «فعال‌سازی».

## What Phase 1 does

**For everyone (private chat)**
- `/start` → on first contact a **language picker** (فارسی · English · Русский · 简体中文 · Français);
  change it any time with `/language`. Persian is laid out right-to-left (every line carries a
  right-to-left mark; names and titles are direction-isolated so a Latin name can't flip a line).
- **Forced join**: until the user is a member of every forced-join channel, the bot shows only the
  join buttons, «✅ I joined» and the language picker. A passed check is cached for 5 minutes.
- Commands also work as **plain words in Persian or English** (and Russian/Chinese/French):
  `start/شروع/منو`, `language/زبان`, `help/راهنما`, `cancel/لغو`, owner: `panel/پنل/مدیریت`.

**For the owner (numeric id `AEGIS_OWNER_ID`, default `5557901897`) — `/panel` or «پنل»**
- 📊 **Statistics**: users who started the bot, active (can receive messages), blocked the bot,
  new today (from 00:00 Tehran time) and in the last 7 days, used the bot in 24 h / 7 days, number of
  groups and channels the bot is in, total members across them (`getChatMemberCount`, cached 1 h),
  errors in the last 24 h.
- 🔒 **Forced join**: list with ✅ / ⚠️ (bot is not an admin → that channel is skipped so nobody is
  locked out, and the owner is warned in the panel and by a private message at most every 3 h);
  add by `@username`, `t.me` link, `-100…` id or a forwarded post; remove (with confirmation);
  reorder ⬆️⬇️; turn on/off; max **10**. Defaults: `@HIDE_i_SEEK`, `@Nepenthw_ir`, `@wangerBots`.
- 📣 **Broadcast** to all bot users, or all groups, or all channels:
  1. choose the audience and **copy** (no “forwarded from”, link buttons allowed) or **forward**;
  2. send the message (text, photo, video, file, GIF, audio, voice…; a forwarded post keeps its URL buttons);
  3. optional **link buttons** (`Text - https://…`, `|` between buttons in a row);
  4. exact **preview** + confirm card → **Send**.
  Sending is a **queue** (one runs, others wait), saved after every message (**resumable** —
  a crash never re-sends), honours Telegram's **429 retry_after**, marks users who blocked the bot
  (and chats that removed it) **inactive**, retries a group that became a supergroup at its new id,
  pauses itself if the original message is deleted. **Pause / resume / cancel** (with confirmation),
  a live progress card, and a final report: **sent / failed / blocked**.

> **No scheduler exists on Telegram Serverless**, so a running broadcast moves forward when the owner
> presses «▶️ Send next batch», while the owner keeps the **📡 Live sending** Mini App page open
> (≈ 25 messages/second), and a few messages on the side of every other update the bot receives.

## Setup

Requirements: Node.js 22+, a bot with **Serverless** and **CLI Access** enabled in @BotFather.

```bash
cd aegis
npm install
cp .env.example .env          # fill in Aegis_BOT_TGCLOUD_TOKEN (BotFather → bot → Serverless → CLI Access)
npm test                      # locales, static platform rules, unit tests, end-to-end scenarios
npm run deploy                # locales + env.js → push → migrate --safe → webhook check
npm run test:cloud            # smoke test on the real platform with fake users (cleans up after itself)
```

- `scripts/tg.mjs` passes `Aegis_BOT_TGCLOUD_TOKEN` to the CLI as `TGCLOUD_TOKEN` for that process
  only, and always runs from `aegis/` with its own `aegis/.tgcloud/` — it can never deploy over
  another bot in this repository. Any CLI command: `npm run tg -- status`, `npm run tg -- run …`.
- The token is never committed or deployed. Deployed modules get **no** environment variables on
  this platform, so `AEGIS_OWNER_ID` (not a secret) is written into `tgcloud/lib/env.js` by
  `scripts/gen-env.mjs` during `npm run build` / `npm run deploy`.
- After the first push, put the Mini App address the CLI prints into `APP_URL` in
  `tgcloud/lib/config.js` (currently `https://app8940801714.tgcloud.ai/`).
- **Make Aegis an admin in every forced-join channel** — Telegram only lets a bot check membership
  where it is an admin. Until then those channels are skipped (⚠️ in the panel).
- Webhook: managed by the platform (`https://cloud.telegram.org/app<id>/webhook`), refreshed on push
  from the handlers present (`message`, `callback_query`, `my_chat_member`, `chat_member`).
- In groups Aegis should be an **admin**: then Telegram delivers it every message (needed for
  «پیکربندی» as a plain word); without admin rights only `/config` reaches it (privacy mode).

## Database and migrations

Tables (all prefixed `aegis_`): `users`, `chats`, `chat_admins`, `access`, `promotions`,
`join_channels`, `kv`, `states`, `updates`, `audit`, `errors`, `broadcasts` — see `tgcloud/schema.js`.

- **Schema** changes: edit `tgcloud/schema.js`, then `npm run deploy` (`tgcloud migrate --safe`
  adds tables/columns/indexes; drops only via `.deprecated()`; type changes are manual).
- **Data** migrations (seeding, backfills): `tgcloud/lib/core/migrations.js`, applied once each,
  in order, on the first update after a deploy (`aegis_kv.data_version`).

## Engineering notes

- **Idempotent updates**: every `update_id` is recorded; a redelivery is skipped, an update stuck
  "in progress" for 60 s (a dead invocation) is processed again.
- **Errors**: every failure is caught at the entry point, written to `aegis_errors` and the console
  as one JSON line, and the owner gets at most one note per 30 minutes.
- **Audit log** (`aegis_audit`, append-only): forced-join changes, broadcasts, chats joined/left,
  registrations, Aegis's rights, admin appointments/edits/removals (and changes made outside Aegis),
  access levels and revocations, chat settings, shutdown/activate, data migrations. A chat's part of
  it is its 📜 change log.
- **Housekeeping** runs on the side of updates (old update ids, expired inputs, stale member counts).
- **i18n**: every string lives in `aegis/locales/<lang>/<namespace>.json`; `npm run locales`
  compiles them into `tgcloud/lib/i18n/strings/*.js` (deployed code can't read files).
  `npm test` fails if any key is missing in any language, placeholders differ, HTML is invalid,
  or the code uses a key that doesn't exist.
- Only **block comments** in `tgcloud/` (a paste that loses line breaks still works); no globals the
  isolate lacks (`Intl`, timers, `URL`, `Buffer`…) — `test/static.mjs` enforces both.

## Layout

```
aegis/
  tgcloud/
    schema.js                 aegis_* tables
    handlers/                 message, callback_query, my_chat_member, chat_member  → lib/router.js
    endpoints/bcLive.js       owner-only: the live broadcast page's batches
    lib/
      router.js               order of checks, callback_data table
      jobs.js                 work on the side of updates (broadcast chunks, housekeeping)
      config.js, env.js       settings; env.js is generated (AEGIS_OWNER_ID)
      core/                   tg (Bot API + trace), kv, dedupe, errors, audit, state, migrations, commands, bot, util
      engines/                users, chats, join, broadcast, buttons, rights, admins, system — one per engine
      ui/                     start, owner, owner_bc, group (in-group messages), panel (a chat's panel), system
      i18n/                   t(), digits, RTL; strings/ is generated from ../../locales
  locales/<lang>/*.json       fa, en, ru, zh, fr
  webapp/                     the 📡 live broadcast Mini App page (plain HTML/JS)
  scripts/                    tg.mjs (CLI wrapper), build-locales.mjs, gen-env.mjs
  test/                       static.mjs, unit/, e2e.mjs (sdk emulation + strict mock Bot API), cloud/smoke.mjs
  docs/                       NOT_BUILT.md, ASSUMPTIONS.md, tgcloud-sdk.md (platform SDK reference)
```
