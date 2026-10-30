# 🛡 Aegis — Telegram group & channel management / security bot

Aegis runs entirely on **Telegram Serverless** (code, database, webhook and Mini App are hosted by
Telegram; no VPS, no paid service). It is built in 10 phases; this README describes what is
deployed **now**.

| Phase | Scope | State |
|---|---|---|
| 1 | Core: skeleton, config, DB + migrations, webhook, i18n (5 languages), /start, language picker, user tracking, forced join, owner panel (stats, forced-join channels, broadcast) | ✅ deployed |
| 2 | Adding the bot, configuration & access control: registration + warning, required rights, appoint/edit/remove admins through Aegis, «پیکربندی», access levels, revocation, change log, /shutdown /activate /status | ✅ deployed |
| 3 | Group lists (18), punishments with undo, warnings and step punishments, anti-betrayal, Audit Mode, log channel | ✅ deployed |
| 4 | Group locks: 42 locks, each with its own settings | ✅ deployed |
| 5 | Group security: anti-link, anti-ads/tabchi, anti-flood, anti-raid, captcha, quarantine, emergency lock, read-only, suspicious content, risk score with feedback, federations | ✅ deployed |
| 6–10 | Advanced settings, channel panel, reports, fun & media, full Super Admin panel | not started |

Design decisions taken without the master spec (it isn't in the repository yet) are listed in
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md).

Features that can't be built for free on this platform, or only partly, are listed in
[docs/NOT_BUILT.md](docs/NOT_BUILT.md).

## What Phase 5 does

**🔰 Security** (panel → 🔰 Security) — eight modules, each off by default, each with its own
settings; admins, Aegis, the anonymous admin, the linked channel and the VIP and trusted lists are
never caught:
- **Anti-link** — links even when disguised (full-width letters `ｓｐａｍ．ｃｏｍ`, look-alike dots
  `spam。net`, `site(dot)com`, zero-width characters inside, links on inline buttons); the «Allowed
  links» list and links to the group itself pass; everyone or new members only.
- **Anti-ads / tabchi** — a new member's first link, @username, phone or channel forward; the same
  ad posted in other groups that use Aegis (fingerprints kept a day); ad phrases in five languages
  together with a contact.
- **Anti-flood** — n messages in t seconds (3/5/8/12 in 3/5/10/30 s), or the same message 2/3/5
  times; deleted, punished once per window.
- **Anti-raid** — n joins in t seconds → raid mode for 10 min – 6 h: captcha or quarantine for
  everyone joining, an emergency lock, or only an alert; alert in the group and to the creator with
  «🔓 End raid mode».
- **Captcha** — newcomers are muted until they press the shown emoji (or solve a small sum); 1, 3
  or 10 minutes; unsolved → kick, ban or stay muted; admins can approve/remove from the message.
  With **join requests** the captcha goes to the requester's private chat and approves or declines
  the request.
- **Quarantine** — newcomers send text only (or nothing) for 10 min – 1 day; Telegram lifts it.
- **Suspicious content** — invisible characters (bidi overrides, zero-width, Hangul filler — not
  ZWNJ/ZWJ), look-alike letters (`раypal`), scam text («Telegram Support: verify your account»),
  deceptive hidden links, dangerous files (.apk .exe .bat .js .docm …, `photo.jpg.exe`, reversed
  names), the same media 3 times in a day or across groups.
- **Risk score** — adds up 18 signals (e.g. impersonating an admin or Telegram +40, the same ad in
  other groups +45, dangerous file +50, new member with a link +30) for every message and newcomer;
  explains the score to the admins (log channel, or the creator's private chat) and acts above the
  threshold (low/medium/high: 50/90, 40/70, 30/50). **✅ Right / ❌ Wrong** on each alert: wrong
  undoes the punishment; both adjust that group's weights (×1.1 / ×0.8, kept within 0.3–2×), shown
  in «📈 Risk alerts» with a reset.

**🚨 Emergency lock / 📖 read-only** — `/lockdown [duration] [reason]`, `/lockdown off`,
`/readonly [duration]`, `/readonly off` (or «قفل اضطراری», «فقط خواندنی» …), or the panel (asks
first; 10 min, 1 h, 6 h or until ended). Members can't write; the group's permissions are saved and
**restored automatically** when it ends — also when the time runs out.

**🌐 Federation** (panel → 🌐 Federation) — groups sharing one ban list. Create one (you own it)
or join with its code; the owner names federation admins. `/fban` and `/unfban` (reply, @username or
id, with a reason) ban or unban in every member group at once; a fed-banned person is banned again
when they join, write or ask to join any member group. Ban list with unban and CSV export; new
join code, rename, leave, delete (asks first).

## What Phase 4 does

**🔐 Locks** (panel → 🔐 Locks) — 42 locks in four groups:
- **Media (14)**: photos · videos · GIFs · stickers · animated stickers · files · music · voice ·
  video messages · contacts · locations · polls · dice & games · stories.
- **Text and links (13)**: text messages · links · invite links · hidden links · @usernames ·
  member mentions · hashtags · commands for other bots · e-mails · phone numbers · formatting ·
  spoilers · premium emoji.
- **Content (9)**: banned words (the «Banned words» list, «Allowed words» excepted) · blocked sites
  (the «Blocked links» list) · emoji flood · long messages · repeated characters/words · four
  language locks — Persian/Arabic, English/Latin, Russian/Cyrillic, Chinese/Japanese/Korean.
- **Behaviour (6)**: forwards (the «Allowed forward sources» list excepted) · inline bots · posting
  as a channel · bots added by members (removed; «Allowed bots» excepted) · service messages
  (join/leave/pin… notices deleted) · edited messages.

**Each lock has its own settings**: on/off · punishment (none, warning — the step ladder applies —,
mute, restrict, kick, ban) and its duration (10 min, 1 h, 1 d, 7 d, until lifted) · delete or keep
the message · notice in the group (standard, your own text with `{user}` and `{lock}`, or none) ·
log channel on/off · exceptions (admins, Aegis and VIPs always; the trusted list and moderators
switchable; up to 20 members by hand) · sensitivity (low/medium/high, for the 13 locks where it
means something — e.g. links: clickable only / also typed URLs / also disguised «site . com») ·
scope: everyone, or only new members (joined within 1 h / 1 d / 3 d / 7 d — a chat setting) ·
recent catches. «All locks off» asks first and keeps the settings.

**Language locks never delete a mixed-language message because of one foreign word**: a message is
"in" a script only when that script has the clear majority of its letters (70 / 50 / 30 % by
sensitivity) **and** at least two words of it (or the whole message is in it). Links, @usernames,
#tags, commands, e-mails, phone numbers and code don't count as words.

**How a caught message is handled**: delete (if any matching lock says so) → the strongest
punishment of the matching locks (recorded with source «lock», undo button on the notice) → one
notice (the previous lock notice is removed; at most one every 5 s, so a raid can't flood the
group) → log channel (new category «Locks»). Edits are checked again. A message sent as a channel
can only be deleted (Telegram hides the person). In Audit Mode nothing is deleted or punished and
nothing is posted in the group — the catch is recorded and logged.

## What Phase 3 does

**Moderation commands in the group** — `/warn /unwarn /warns /mute /unmute /restrict /unrestrict
/kick /ban /unban`, or plain words in any of the 5 languages («اخطار», «سکوت», «رفع سکوت», «بن»,
«رفع بن» …, «мут», «禁言», «bannir» …). Target: reply to the member's message, or `@username` /
numeric id / a mention; then an optional duration (`30m 2h 1d 1w`, «۲ ساعت», «3 дня», `forever`) and
a reason (≤ 200 characters). Example: reply with `/ban 1d spam links` or «سکوت ۲ ساعت فلود».
- **Who**: the owner; admins with at least View access (warn/unwarn/warns), plus Telegram's «Ban
  users» right for mute/restrict/kick/ban and lifting them; members of the «mod» list (warn,
  unwarn, warns, mute, unmute). Everyone else is ignored without an answer — ordinary members are
  never blocked or answered, and a plain word only counts with a target, so normal chat is safe.
  Re-checked live with Telegram every time.
- **Never a target**: the owner and admins (Telegram forbids it), Aegis itself, yourself, VIP-list
  members; a «mod» can't punish another «mod».
- **Notice** in the group (switchable) with who, what, how long and why, and a **↩️ Undo** button
  (also for the automatic step). With notices off the result goes to the person's private chat.

**Punishments** — warning, mute, restriction (text only), quarantine, kick, ban, blacklist ban,
demotion (anti-betrayal). Each one records the executor, the reason, the source (command, panel,
list, step, blacklist, anti-betrayal, done in Telegram itself) and its status. Every punishment can
be undone except a kick (the member can simply rejoin); timed ones end by themselves in Telegram.
Bans and unbans done **in Telegram itself** by admins are recorded too.

**Warnings and steps** — a ladder on active warnings (default: 3 → mute 1 day, 5 → ban), editable
in the panel as lines like `3 mute 1d` (Persian words work); warnings can expire (never / 1 day /
7 days / 30 days) and are cleared after the last step (switchable).

**Lists** (per chat, panel → 📋 Lists): ⭐ VIP · 🤝 Trusted · 🔇 Muted · 🚧 Restricted · ⛔️ Banned ·
🏴 Blacklist · ⚠️ Warned · 🧪 Quarantine · 👁 Suspicious · 🛡 Moderators · 🤖 Allowed bots ·
🚫 Banned words · ✅ Allowed words · 🔗 Allowed links · ⛓ Blocked links · 📢 Allowed forward sources ·
🎭 Blocked sticker packs · 🏷 Blocked name patterns. Each has add (Telegram's user picker, forwarded
messages, ids/@usernames, up to 50 lines with optional duration and note), remove (asks first),
edit value/note, search, details with its own history, the list's history, and CSV export (UTF-8
with BOM, times in UTC). The punishing lists mirror Telegram (adding mutes/bans, removing lifts);
the blacklist bans again whenever the member joins; the «mod» list grants the moderation commands.
Word/link/sticker/name/bot/forward lists are stored now and used by the locks and filters of later
phases (the panel says so).

**Anti-betrayal** (panel → 🛡) — an admin who removes or demotes N members within a window (default
5 in 1 minute; 3/5/10/20 and 1 min/5 min/10 min/1 h) is demoted if Aegis appointed them (Telegram
allows nothing else), loses the «mod» role, or is reported (owner, admins appointed elsewhere, or
response set to «alert only»). The alert goes to the group (not a channel), the owner's private
chat and the log channel, with **♻️ Unban removed members** and **↩️ Restore admin** (false alarm)
buttons. Turning it off notifies the owner.

**Audit Mode** (panel → 🕵️) — automatic punishments (steps, blacklist on join, anti-betrayal) are
recorded and reported but not carried out; commands and panel actions still work. Turning it on
notifies the owner.

**Log channel** (panel → 📜) — pick a channel or group with Telegram's chat picker (or forward a
post, @username, -100… id); Aegis checks it can post there and that you are an admin there, then
posts punishments, list changes, admin/security events and setting changes (each category
switchable), with a test button.

**Panel → ⚖️ Punishments** — every punishment with executor, source, duration, reason and status,
undo, paging and CSV export. Panel permissions: View browses/searches/exports, Settings changes
lists and warnings (punishing lists also need «Ban users»), Full changes the «mod» list,
anti-betrayal, Audit Mode and the log channel.

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
    handlers/                 message, edited_message, callback_query, my_chat_member, chat_member,
                              chat_join_request  → lib/router.js
    endpoints/bcLive.js       owner-only: the live broadcast page's batches
    lib/
      router.js               order of checks, callback_data table
      jobs.js                 work on the side of updates (broadcast chunks, housekeeping)
      config.js, env.js       settings; env.js is generated (AEGIS_OWNER_ID)
      core/                   tg (Bot API + trace), kv, dedupe, errors, audit, state, migrations, commands, bot, util,
                              duration, modparse, csv, msgscan (what a message contains), signals (security)
      engines/                users, chats, join, broadcast, buttons, rights, admins, system, settings, lists,
                              punish, steps, betrayal, admin_actions, logs, locks, members, guards, feds
      ui/                     start, owner, owner_bc, group (in-group messages), moderation (group commands,
                              undo buttons, bans/joins), enforce (locks at work), security (security at
                              work, captcha, lockdowns, federation bans), panel + panel_mod + panel_locks +
                              panel_security + panel_fed (a chat's panel), guard, system
      i18n/                   t(), digits, RTL; strings/ is generated from ../../locales
  locales/<lang>/*.json       fa, en, ru, zh, fr
  webapp/                     the 📡 live broadcast Mini App page (plain HTML/JS)
  scripts/                    tg.mjs (CLI wrapper), build-locales.mjs, gen-env.mjs
  test/                       static.mjs, unit/, e2e.mjs (sdk emulation + strict mock Bot API), cloud/smoke.mjs
  docs/                       NOT_BUILT.md, ASSUMPTIONS.md, tgcloud-sdk.md (platform SDK reference)
```
