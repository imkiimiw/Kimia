# 🛡 Aegis — Telegram group & channel management / security bot

Aegis runs entirely on **Telegram Serverless** (code, database, webhook and Mini App are hosted by
Telegram; no VPS, no paid service). **Release 1.0.0** — all 10 phases are built, tested and deployed.

**In one minute**
- Add Aegis to a group or channel as an admin → it registers the chat, says which rights are missing,
  and its admins open the chat's panel with «پیکربندی» / `/config` (or from Aegis's private chat).
- Each chat has its own settings: lists, punishments with undo, warnings, 42 locks, security (anti-link,
  anti-flood, anti-raid, captcha, …), advanced settings, topics, channel tools, statistics, points,
  contests, polls, questions, appeals, 30 fun features and media tools — in five languages (fa, en, ru,
  zh, fr; Persian right-to-left), with commands also as Persian and English words.
- The owner (`AEGIS_OWNER_ID`) has the Super Admin panel: statistics, forced join, broadcasts, the
  global switch, and 🛠 Management — every chat, the bot's team with access levels, the sealed audit
  log, system settings, version, health, errors, queues, global backup and restore.

| Phase | Scope | State |
|---|---|---|
| 1 | Core: skeleton, config, DB + migrations, webhook, i18n (5 languages), /start, language picker, user tracking, forced join, owner panel (stats, forced-join channels, broadcast) | ✅ deployed |
| 2 | Adding the bot, configuration & access control: registration + warning, required rights, appoint/edit/remove admins through Aegis, «پیکربندی», access levels, revocation, change log, /shutdown /activate /status | ✅ deployed |
| 3 | Group lists (18), punishments with undo, warnings and step punishments, anti-betrayal, Audit Mode, log channel | ✅ deployed |
| 4 | Group locks: 42 locks, each with its own settings | ✅ deployed |
| 5 | Group security: anti-link, anti-ads/tabchi, anti-flood, anti-raid, captcha, quarantine, emergency lock, read-only, suspicious content, risk score with feedback, federations | ✅ deployed |
| 6 | Advanced group settings (26 + extras: welcome/goodbye, forced join/add for members, scheduled cleanup, night lock, time zone, message length, member reports, event channel, linked-channel posts) and forum topics | ✅ deployed |
| 7 | Channel panel: join requests and joins, members, invite links, impersonation and fakes, admin alerts, post protection (approval, versions, edit history), discussion group, direct messages, crisis/SOS, multi-channel dashboard, backups, extras | ✅ deployed |
| 8 | Reports, stats & social: group statistics and CSV, points, levels and badges, contests, polls, questions to the admins, moderated anonymous Q&A, appeals, review of decisions; channel analytics and health score | ✅ deployed |
| 9 | Fun & media: 30 fun features with per-feature settings and anti-abuse limits; media tools (sticker↔photo, sticker packs, GIF maker, image tools, QR, OCR, PDF check); QR and PDF security checks | ✅ deployed |
| 10 | Full Super Admin panel & release: global chat management, the bot's team with access levels, a sealed (append-only, hash-chained) audit log, system settings, version, health, errors, queues and timed work, global backup/restore, global stop; security, load and failure-injection tests | ✅ deployed |

Design decisions taken without the master spec (it was never added to the repository) are listed in
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md).

Features that can't be built for free on this platform, or only partly, are listed in
[docs/NOT_BUILT.md](docs/NOT_BUILT.md).

## What Phase 10 does

**🛠 Management** — a button in the owner panel (`/panel`), and for the bot's team `/staff` («ستاد»).
The owner panel itself, broadcasts, forced join and `/status` `/shutdown` `/activate` stay the
owner's alone (numeric id only).

| Section | What it does | Level |
|---|---|---|
| 👥 **All chats** | Every group and channel Aegis knows: filters (all · groups · channels · ⚠️ rights missing · 🚪 left · ⏸ suspended), pages, search by id, @username or title. A chat's details: id, type, Aegis's status and rights, members, admins known, who added it and when, settings changed, active punishments, lockdowns, logged events. | viewer |
| | 🔄 Re-check with Telegram (title, username, members, Aegis's own status and rights) | support |
| | ⏸ **Suspend** / ▶️ resume Aegis in the chat (asks first) · 🚪 **leave** the chat (asks first) · 💾 the chat's configuration backup file · ✉️ post a text message «from the Aegis team» | manager |
| 👮 **Bot team** | Add people by id, @username (if they opened Aegis) or a forwarded message — up to 20; levels 👁 viewer, 🧰 support, 🛡 manager; change or remove (asks first). They are told in private and get /staff in their menu. The level is read **on every press**: a removed member loses access at once. | owner |
| 📜 **Audit log** | Every sensitive action (who, what, which chat, when), filtered (all · people · system), paged; CSV of the latest 5000 (manager). | support |
| 🔏 **Seals** | The log is **append-only in the database** (triggers refuse UPDATE/DELETE) and sealed every 15 minutes in a **SHA-256 hash chain**; «🔍 Verify» re-checks every seal (a changed, deleted or inserted row breaks it); «🔏 Seal now» (manager); with a global log channel set, every seal's hash is also posted there, outside the database. | support |
| ⚙️ **System settings** | New chats on/off (off: Aegis leaves chats it's newly added to, unless the owner or the team added it) · fun features · media tools · error notices to the owner · timed work · the global log channel. Every change is logged. | owner |
| 🏷 **Version** | 1.0.0, phase, release date, data migrations, command menus, the bot, database tables, languages, the Mini App address. | viewer |
| 🩺 **Health** | A verdict and what needs attention: Bot API, webhook (managed by the platform), errors per hour/day, updates left half done, last housekeeping and sweep, forced-join channels where Aegis isn't admin, timed work paused, late items in any queue, the log's database guard, the global switch. | viewer |
| 🧯 **Errors** | Counts for 1 h / 24 h / 7 days, the commonest sources, the list; an error's details with its stack (support). | viewer |
| ⏱ **Queues** | Broadcasts, channel posts waiting or scheduled, night locks and cleanups, post-copy jobs, captchas, lockdowns, contests, polls, games, media jobs, pending inputs — each with how many are late. Manager: ⏸ pause / ▶️ resume timed work, 🧹 run the sweeps now, 🔓 release stuck locks. | viewer |
| 💾 **Backup / restore** | A **global** file (system settings, forced-join channels, the team) and **every chat's configuration** in files of 25 chats; restore from either: the file is checked and summarized, then applied after a confirmation (settings set, missing channels and members added, nothing removed; chats restored 8 per press, only where Aegis is now). | owner |
| ⛔️ **Global switch** | The `/status` screen and shut down / activate (asks first) — unchanged, linked here. | owner |

**Release work**: security tests (authorization matrix, 1200 fuzzed buttons, 500 fuzzed messages,
escaping, the Mini App endpoints' caller checks; a static rule refusing SQL outside the `sql` tag),
load and rate-limit tests (≈ 5,300 updates over 20 groups with budgets per update; what Aegis sends
stays within Telegram's 20 messages/minute per group and 30/second overall; 429 handling;
duplicates), and an error-handling review with **failure injection**: every Bot API method and every
database query of 14 representative updates is made to fail in turn — the handler never throws and a
pressed button is always answered once. See *Error handling* below.

## What Phase 9 does

**🎮 Fun** — 30 features, each with its own switch, who may use it (everyone or admins), a cooldown
and a daily limit per member, and points for a win (with Phase 8's points). The chat also has a
limit per minute for all fun commands (beyond it they're ignored), can delete fun replies after a
while, and can exempt its admins from the limits. Commands are slash commands or words (Persian and
the other languages) — words only as the whole message, or with valid arguments.
- **🎲 Dice games** (Telegram's animated dice): /dice, /darts, /basket, /football, /bowling, /slot.
- **🍀 Luck**: /coin, /rand (a range), /choose (options), /ball (a magic 8-ball), /fortune.
- **💬 Social**: /love (a reply: a match percentage, the same all day), /rate, /truth, /dare,
  /wyr (a «would you rather» poll), /hug /pat /highfive /wave /cheer, /couple (of the day).
- **📅 Daily**: /motd (member of the day), /birthday and /birthdays (Gregorian, or the Persian
  calendar for Persian groups; greeted on the first message of the day), /daily (a few points once
  a day), /quote.
- **🧩 Games**: /guess (1–100, higher or lower), /math, /scramble, /typing (a race; pasted text
  carries invisible marks and doesn't count), /trivia (a Telegram quiz; the first right answer
  wins), /click (tap the right emoji first; one wrong tap and you're out).
- **⚔️ Duels**: /rps (against Aegis, or a challenge with hidden picks) and /ttt (tic-tac-toe).
  Duels must be accepted; one game of each kind runs at a time; games end lazily when their time is up.
Some features (dice, luck, quotes, truth or dare, rating and the solo games) also work in private.

**🖼 Media tools** — everything is computed by Aegis itself (pure JavaScript codecs written for this
project, no paid service): send a photo, sticker, video, GIF or PDF to Aegis in private and pick a
tool, or reply to one in a group with /sticker, /tophoto, /gif, /qr, /readqr, /ocr, /pdf or /tools.
- **Photo → sticker**: a 512 px PNG added to the member's own Aegis sticker pack (made on first
  use, the 120 newest kept), then sent. **Sticker → photo** (static stickers) or as a file.
- **Image tools**: gray, sepia, invert, blur, pixelate, circle (a PNG with transparency), rotate,
  mirror, flip, square, half size, as a file.
- **GIF maker**: up to 10 photos → an animated GIF (speed 0.5 / 1 / 2 s); a video → a GIF
  (Telegram's kind: an MP4 shown as a GIF); a GIF → a video.
- **QR codes**: /qr text makes one; /readqr reads one in a photo (here, or in the Mini App).
- **Text in images (OCR)**: in the Mini App, with Tesseract.js running on the member's device
  (free, open source; language data downloaded once), in fa / en / ru / zh / fr; the text can be
  copied or sent to the chat.
- **PDF check**: JavaScript, automatic actions, launching programs, embedded files, forms that send
  data, links, encryption and disguised names — read from the raw file and its compressed streams.
Groups: on by default, for everyone or admins only, with a daily limit per member.

**🔰 Security** gets two more suspicious-content checks: a link hidden in a **QR code** in a photo
(unless its domain is allowed) and a **PDF** that can run code. Both feed the risk score too.

## What Phase 8 does

**Groups** get five new sections in their panel; **channels** get analytics and polls.
- **📊 Statistics** — messages today / 7 days / 30 days, active members, the share of media, joins
  and leaves, punishments, the busiest hours (in the chat's time zone), the last days one by one
  and the most active members; counting can be switched off. CSV of the last 90 days and of the
  members (messages, points, level, thanks, streak, first and last seen). Counting starts when
  Aegis is added — a bot can't read older messages.
- **🏆 Points and badges** (off by default) — 1, 2 or 5 points per message of 3+ characters or
  media, at most once every 0 / 30 / 60 / 300 seconds; a **thanks** (a short reply that only
  thanks, in any of the five languages, or 👍 🙏 ❤️ +1) gives the thanked member the same points
  (a giver at most once a minute). Levels: 10, 30, 60, 100… points. Ten automatic badges (first
  message, 100 / 1,000 / 10,000 messages, 10 and 100 thanks, 7- and 30-day streaks, level 10, a
  year in the group) and up to 20 of the group's own badges, given by admins (pick, forward, id or
  @username). Level-ups and new badges are announced in the group (switchable). Members: `/me`
  (their card, or a member's when replying) and `/top` (the leaderboard; by messages when points
  are off) — or the words «امتیاز من», «برترین‌ها», "my points", "leaderboard"… only as the whole
  message. Admins: `/give 10`, `/take 10` as a reply (or «امتیاز بده ۱۰»). Resetting points needs
  Full access and asks first.
- **🎉 Contests** — a **raffle** (members join with a button, only members of the group, winners
  drawn at random), an **activity contest** (who writes most until the end) and a **quiz** (the
  first right answer wins; case and spacing don't matter). 1 h – 7 days, 1 / 3 / 5 / 10 winners;
  end now (asks first) or cancel. Winners are announced in the group and the log channel.
- **🗳 Polls** — Telegram's own polls sent by Aegis: anonymous or not, several answers, a quiz with
  the right answer, closing after 1 h – 7 days; results kept from Telegram's poll updates; the
  voters of a non-anonymous poll as CSV; stop. In channels polls are always anonymous (Telegram).
- **❓ Questions to the admins** — `/ask` (or «پرسش از مدیران») gives a button to Aegis's private
  chat; the question goes privately to every admin who started Aegis (Answer / Close) and the
  answer comes back privately. One question per member and group every 5 minutes. The panel lists
  open questions and can post «Ask us» buttons in the group.
- **🕶 Anonymous questions** (off by default) — `/anon`: the admins see the question without the
  sender's name and **Publish** it in the group (with or without an answer; Settings level),
  **Reject** it, or **Block the sender** (Full access; the sender stays unknown to them).
- **⚖️ Appeals** — a punished member appeals once per decision: from the button under the
  punishment notice or `/appeal` («اعتراض») in private (warnings, mutes, restrictions, quarantine,
  bans, blacklist bans). Admins who may ban get it with Accept (the punishment is undone) / Reject;
  the member hears the decision.
- **Review of decisions** — with «Review all» (off by default) every punishment given by an admin
  below Full access is sent to the Full admins: Uphold / Overturn (undone; the moderator is told).
  The 🙋 Appeals section lists recent decisions (⚖️ appealed · ✅ upheld · ↩️ overturned) and each
  moderator's record (decisions, appealed, accepted, overturned); any decision can be reviewed there.
- **📈 Channel analytics** — subscribers and their flow (7 and 30 days), posts, **reactions**
  (Telegram's reaction counts on posts) and **comments** (replies in the discussion group) in 14
  days, per post per 1,000 subscribers, the best hour and the best posts, and a **health score**
  0–100 with grade A–E: growth 25, engagement 30, posting 20, safety 25 (Aegis has its rights, no
  admins appointed outside Aegis, no crisis, a protection on). Views aren't available to bots.
  CSV of 90 days. The 📊 channels dashboard shows each channel's health.

## What Phase 7 does

A **channel's panel** has its own sections (the group-only ones — locks, security, advanced
settings, topics — are not shown); the shared ones stay (lists, punishments, anti-betrayal, Audit
Mode, log channel, admins, access levels, language, change log).
- **🛂 Join requests** — every request is checked: VIP → approved; blacklist / ban list, known fakes
  and suspicious names or bios (look-alikes of the channel or its admins, links or invisible
  characters in the name, scam words in the bio, the «names» list) → declined; a burst (10/30/100 a
  minute) → automatic approvals pause for 30 min and the owner is told; then a captcha (in the
  requester's private chat — Telegram allows 5 minutes — or, when the owner made Aegis the
  channel's **guard bot**, as a Mini App) and the rule (admins decide / approve / decline). Every
  request is listed for the admins with approve / decline one or all.
- **👥 Members** — subscribers now, joins and leaves today and in 7 days, recent joins; find
  someone (shared user, forward, id, @username) and remove, ban or unban them.
- **🔗 Invite links** — create links with expiry, member limit or approval; joins and requests are
  counted per link; rename, approval on/off, revoke (asks first); a new primary link.
- **🎭 Fakes** — look-alikes who join are reported or removed; a list of known fake channels and
  accounts (blocked in the discussion group and direct messages, declined when they ask to join).
- **🚨 Alerts** — to the owner (and the log channel): admins appointed / removed / their rights
  changed (with who did it, powerful rights flagged, «appointed outside Aegis»), title and photo
  changes, post edits, Aegis's own rights or removal; the title can be locked (put back).
- **📝 Posts** — an archive with every version of every post; late edits can be put back
  automatically (after 5 min – 1 h, or always); any earlier version can be restored. **Approval
  before publishing**: a post made directly in the channel is removed at once and waits for the
  owner or a Full admin (Publish / Reject in their private chat). Posts **written through Aegis**
  are published now, at a time (up to 30 days), or sent for approval (Settings level).
- **💬 Discussion group** — opens the group's own panel (its locks and security are independent),
  and protects comments: comments sent as other channels (deleted, that channel banned),
  look-alikes and known fakes, «first comment» bots (new accounts in the 30 s after a post),
  comments only from subscribers (with a join button).
- **✉️ Direct messages** — in the channel's direct messages: blocked senders, links, scams and
  dangerous files, known fakes and floods are removed; suggested posts with links are declined.
- **✨ Extras** — a footer and link buttons added to every new post, posts that delete themselves
  after 1 h – 1 day, silent and protected publishing for posts sent through Aegis.
- **💾 Backups** — the channel's Aegis settings and lists as a JSON file, restored after a check
  (here or in another channel); a backup chat gets a copy of every new post, and older posts are
  copied there in batches; the post archive as CSV.
- **🆘 Crisis** — one button: revokes the links made through Aegis and makes a new primary link,
  declines new requests, holds every post for approval and puts back late edits, demotes the
  admins appointed through Aegis, locks the discussion group; «End crisis» puts it all back
  (re-appoints those admins with their rights). Each step is also a button of its own.

**📊 Channels dashboard** (from «پیکربندی» / the panel) — every channel you manage: subscribers,
today's joins and leaves, waiting requests and posts, alerts of the last day, crisis and missing
rights at a glance; **post to several channels** at once (published where you have Full access,
sent for approval elsewhere).

## What Phase 6 does

**⚙️ Advanced** (panel → ⚙️ Advanced) — 26 settings in four groups. Admins, VIP and trusted
members are never caught; in **Audit Mode** every rule below only records (log channel), it never
deletes, removes or locks.
- **🧹 Cleanup** — delete Telegram's join / leave / pin / title-and-photo / video-chat notices, the
  commands Aegis acted on, messages of other (non-admin) bots; Aegis's own notices vanish after
  1 min – 1 h.
- **💬 Messages** — Aegis slow mode (10 s – 5 min; a stopped message doesn't restart the wait), max
  lines, max mentions (anti mass-tag), no SHOUTING, no junk (only dots/symbols), edits allowed only
  for 1 min – 1 h (later edits are deleted), members' media vanish after 1 h – 1 day.
- **⌨️ Commands** — rules (`/rules`, «قوانین», a «📖 Rules» button under the welcome that opens them
  in the bot), members' commands on/off (`/rules`, `/admins`, `/mywarns`), answers in the member's
  private chat, `@admin` calls the admins privately (at most every 5 minutes), commands of the
  anonymous admin run only after a real admin confirms them with a button.
- **🚪 Join and identity** — bots added by a member are removed (admins may add bots), what to do
  with join requests when the captcha doesn't handle them (admins decide / approve all / decline
  all), name and username changes announced, the group title put back when someone changes it,
  admins told when a bot is added.

Extras on the same screen:
- **👋 Welcome & goodbye** — own text with `{name}`, `{mention}`, `{group}`, `{count}`, link buttons
  («Text - https://link»), preview, the previous welcome removed; after the captcha when there is
  one; none during a raid.
- **📢 Forced join / add for members** — up to 3 channels or groups members must join before they
  write (Aegis must be an admin there to check), with join buttons and «✅ I joined»; or members
  must add 1–10 people first. This only stops messages — nobody is removed.
- **🌙 Night lock** — the group closes for members every night and its permissions come back in
  the morning; **🧹 scheduled cleanup** up to 5 times a day (messages Aegis saw since the last
  cleanup, at most 48 h — Telegram's limit; admins' messages stay) and «clean now»; both in the
  chat's **🕐 time zone** (fixed offsets, default from the group's language).
- **📏 Message length** (min / max characters), **🚨 member reports** (`/report [reason]` or
  «گزارش» as a reply → the admins privately or the log channel, with 🗑 delete / 🔇 mute 1 d /
  ⛔️ ban / ✅ ignore; handled once; one report a minute per member), **📡 event channel** (joins,
  leaves, admin changes, name changes), **🔗 linked channel** posts kept / unpinned / deleted.

**🗂 Topics** (panel → 🗂 Topics, forum groups) — Telegram can't list a forum's topics to a bot, so
Aegis shows the ones it has seen or made: create, rename, close / reopen, delete (asks first),
**read-only for members** (Aegis deletes their messages there), and General: close / reopen,
hide / show.

**No scheduler**: the night lock, scheduled cleanup and self-destructing messages happen on the
first update Aegis receives after their time (any group or private message), checked at most once a
minute — in a completely silent bot they wait for the next update.

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
npm test                      # locales, static rules, unit, end-to-end, security, load + failure injection
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
  from the handlers present (`message`, `edited_message`, `channel_post`, `edited_channel_post`,
  `callback_query`, `my_chat_member`, `chat_member`, `chat_join_request`, `poll`, `poll_answer`,
  `message_reaction_count`).
- In a **channel**, Aegis needs to be an admin with «Post», «Edit» and «Delete messages», «Invite
  users», «Ban users», «Add new admins» (and «Manage direct messages» for direct messages); for the
  join-request Mini App, the owner chooses Aegis as the channel's guard bot in Telegram.
- In groups Aegis should be an **admin**: then Telegram delivers it every message (needed for
  «پیکربندی» as a plain word); without admin rights only `/config` reaches it (privacy mode).

## Database and migrations

68 tables, all prefixed `aegis_` (core: `users`, `chats`, `chat_admins`, `access`, `promotions`,
`join_channels`, `kv`, `states`, `updates`, `audit`, `errors`, `broadcasts`; then each phase's own,
e.g. Phase 6: `msg_log`, `schedules`, `reports`, `member_flags`, `topics`, `anon_cmds`; Phase 7:
`join_requests`, `invite_links`, `channel_stats`, `posts`, `post_versions`, `post_queue`, `crises`,
`backup_jobs`, `dm_chats`; Phase 8: `member_stats`, `stats_day`, `stats_hour`, `badges`, `badge_defs`,
`contests`, `contest_entries`, `polls`, `poll_votes`, `questions`, `qa_blocks`, `appeals`, `reviews`; Phase 9:
`fun_use`, `fun_games`, `birthdays`, `fun_daily`, `media_jobs`, `sticker_packs`; Phase 10: `staff`,
`audit_seals`) — see `tgcloud/schema.js`.

- **Schema** changes: edit `tgcloud/schema.js`, then `npm run deploy` (`tgcloud migrate --safe`
  adds tables/columns/indexes; drops only via `.deprecated()`; type changes are manual).
- **Data** migrations (seeding, backfills): `tgcloud/lib/core/migrations.js`, applied once each,
  in order, on the first update after a deploy (`aegis_kv.data_version`; 3 = the audit log's
  database triggers).

## Engineering notes

- **Idempotent updates**: every `update_id` is recorded; a redelivery is skipped, an update stuck
  "in progress" for 60 s (a dead invocation) is processed again.
- **Error handling** (reviewed in Phase 10): every entry point runs inside `router.run()` — dedupe,
  data migrations, the handler, background jobs — and **nothing escapes it**: a failure is written to
  `aegis_errors` and the console as one JSON line, the owner gets at most one note per 30 minutes
  (can be turned off), the update still returns `{ trace }`, and a pressed button is answered exactly
  once. Bot API calls that may fail without harm use `tryCall` (logged, the flow goes on); a 403 from
  a user marks them as having blocked the bot; a 429 makes a broadcast wait `retry_after`; each
  background job has its own try/catch so one failing job doesn't stop the others. `test/load.mjs`
  proves it by failure injection (every Bot API method, then every database query of 14 typical
  updates, failing in turn). Found and fixed in the review: `getWebhookInfo` is refused to bots on
  Telegram Serverless, so /status and Health now say the webhook is managed by the platform instead of
  «Telegram didn't answer»; a game test that failed 1 time in 100 (secret number 1) was corrected.
- **Security model**: owner = numeric `OWNER_ID`; team levels read fresh on every press; a chat's
  settings only after a live admin re-check in that chat (`ui/guard.js`); ids from callback_data are
  always re-checked; user content is escaped and direction-isolated (`iso()`); SQL only through the
  `sql` tag (parameters), `sql.raw()` only with constants (static rule); the Mini App endpoints act
  only for the user in Telegram's verified init data; risky actions ask first; sensitive ones are
  logged in the append-only, sealed audit log.
- **Audit log** (`aegis_audit`, append-only — database triggers refuse UPDATE/DELETE — and sealed in a SHA-256 hash chain): forced-join changes, broadcasts, chats joined/left,
  registrations, Aegis's rights, admin appointments/edits/removals (and changes made outside Aegis),
  access levels and revocations, chat settings, shutdown/activate, data migrations, and (Phase 10) the
  team, system settings, suspensions, restores and every Management action. A chat's part of it is
  its 📜 change log.
- **Housekeeping** runs on the side of updates (old update ids, expired inputs, stale member counts,
  old security memory, and the audit seals).
- **i18n**: every string lives in `aegis/locales/<lang>/<namespace>.json`; `npm run locales`
  compiles them into `tgcloud/lib/i18n/strings/*.js` (deployed code can't read files).
  `npm test` fails if any key is missing in any language, placeholders differ, HTML is invalid,
  or the code uses a key that doesn't exist.
- **CPU budget**: about 3 s of CPU per update (measured: larger work is stopped with «CPU timer
  exceeded»), and `Date.now()` doesn't move during one. Media work keeps to it: photos are used at
  ≤ 1280 px (Telegram's sizes), GIFs at ≤ 360 px and 10 frames, PDFs up to 20 MB with a limit on
  what is decompressed.
- **Module cap**: the platform refuses a deploy with too many modules (104 were refused, 88 and 94
  deploy). Small modules are merged into sections of a related module — e.g. `engines/social.js`
  exports `stats`, `badges`, `contests`, `polls`, `questions`, `appeals`, each the object a module
  used to be — and `test/static.mjs` fails above 95.
- Only **block comments** in `tgcloud/` (a paste that loses line breaks still works); no globals the
  isolate lacks (`Intl`, timers, `URL`, `Buffer`…) — `test/static.mjs` enforces both.

## Layout

```
aegis/
  tgcloud/
    schema.js                 aegis_* tables
    handlers/                 message, edited_message, channel_post, edited_channel_post, callback_query,
                              my_chat_member, chat_member, chat_join_request, poll, poll_answer,
                              message_reaction_count  → lib/router.js
    endpoints/bcLive.js       owner-only: the live broadcast page's batches
    endpoints/joinGuard.js    the join-request captcha Mini App (Aegis as a chat's guard bot)
    endpoints/media.js        the media Mini App: a member's own photo, and the text read sent back (off with g_media)
    lib/
      router.js               order of checks, callback_data table
      jobs.js                 work on the side of updates (broadcast chunks, housekeeping, timed jobs,
                              scheduled posts, backup copies)
      config.js, env.js       settings; env.js is generated (AEGIS_OWNER_ID)
      core/                   tg (Bot API + trace, the bot itself), kv, dedupe, errors, audit, state, migrations,
                              commands (menus, moderation command parsing), util (+ CSV, UTF-8), msgscan (what
                              a message contains), signals (security), clock (times of day, durations),
                              content (a post's content: read, publish, edit back; link buttons), levels
                              (points, levels, automatic badges, thanks, a channel's health score), files
                              (zlib, base64, the PDF check, SHA-256), image (JPEG/PNG decoders, JPEG/PNG/GIF
                              encoders, colors, image tools, QR codes)
      engines/                users, chats, join, broadcast, rights, admins, system (the global switch, status;
                              Phase 10 sections staff, globals, seals, allChats, globalBackup; health,
                              queues), settings (+ warning steps),
                              lists, punish, betrayal (+ adminActions), logs, locks, members, guards, feds,
                              msglog, schedules, groupdata, events, channels, invites, posts, crisis, backup,
                              social (stats, badges, contests, polls, questions, appeals), fun (the 30
                              features, limits, games, birthdays, media jobs, sticker packs)
      ui/                     start, owner, owner_bc, group (in-group messages), moderation (group commands,
                              undo buttons, bans/joins), enforce (locks at work), security (security at
                              work, captcha, lockdowns, federation bans), advanced (advanced settings at
                              work, member commands, reports, night lock, cleanup), welcome, channel
                              (channels at work), social (points, contests, polls, reactions at work; qa:
                              questions, anonymous Q&A, appeals, review), panel + panel_mod + panel_locks +
                              panel_security + panel_fed + panel_adv + panel_topics + panel_channel +
                              panel_posts + panel_social (statistics, points, contests, polls; panelQa;
                              panelAnalytics) (a chat's panel), fun (fun at work + panelFun), media (media
                              tools + panelMedia), dashboard (channels dashboard), guard, admin (🛠 Management
                              and the team panel, the global switch)
      i18n/                   t(), digits, RTL; strings/ is generated from ../../locales
  locales/<lang>/*.json       fa, en, ru, zh, fr
  webapp/                     Mini App pages (plain HTML/JS): 📡 live broadcast, join-request captcha, media
                              (OCR with Tesseract.js and QR reading with jsQR, from the jsDelivr CDN)
  scripts/                    tg.mjs (CLI wrapper), build-locales.mjs, gen-env.mjs
  test/                       static.mjs, unit/, e2e.mjs (sdk emulation + strict mock Bot API), security.mjs,
                              load.mjs (load, rate limits, 429, failure injection), harness.mjs (their
                              shared setup), cloud/smoke.mjs (the real platform)
  docs/                       NOT_BUILT.md, ASSUMPTIONS.md, tgcloud-sdk.md (platform SDK reference)
```
