# Decisions taken without the master spec

`docs/SPEC.md` (the Persian master spec, "the source of truth") was not in the repository when
Phases 1–9 were built (for Phases 3–9 the owner said to build them without the spec). Where the build instructions did not settle a detail, the choice below
was made. Each is easy to change once the spec says otherwise — nothing here drops, merges or
renames a feature from the instructions.

## Phase 1

| Topic | Decision |
|---|---|
| "Active" users | Two numbers: *active* = started the bot and not blocked (can receive messages), plus *used the bot* in the last 24 h / 7 days. |
| "New this week" | The last 7 days (rolling), not the calendar week. "Today" starts at 00:00 Asia/Tehran. |
| Forced-join cache | A passed check is trusted for 5 minutes; a failed one is never cached. |
| Broadcast queue | One broadcast runs (or is paused) at a time; others wait as "queued" and start in order. The owner is not a recipient (they see the preview). |
| Broadcast buttons | Link (URL) buttons only, typed as `Text - link`, `\|` between buttons in a row; at most 8 rows × 4. |
| Command aliases | Every command also works as a plain word in all five languages (Persian and English always). |

## Phase 2

| Topic | Decision |
|---|---|
| Access levels | Four levels per chat: **Full** (everything, including admins and access) · **Settings** (change settings) · **View** (read only) · **None** — plus the chat's owner above them. Only Telegram admins have any level. |
| Default level | From Telegram rights: «Add new admins» → Full; «Change info» → Settings; any other admin → View; bots → None. A manual level overrides it. |
| Who changes levels | The owner: anyone up to Full (Full asks for confirmation). Full admins: only admins below Full, and only to levels below Full. Nobody changes their own level or the owner's. |
| Who manages admins | Full level **and** Telegram's own «Add new admins» right (or being the owner) — the same rule Telegram applies to people. |
| Anti-escalation | Nobody can give a right they (or Aegis) don't have; such rights keep their current value when someone edits an admin. An Aegis admin at your level or above can only be edited by whoever appointed them, or by the owner. |
| Where the "added" warning goes | Group: in the group and in the adder's private chat. Channel: only the adder's private chat (a channel post would reach every subscriber). |
| «پیکربندی» in a group | Answered only for admins (a button to the private panel); ordinary members get no answer, so the command can't be used to spam. Anonymous admins are asked to use the private chat. |
| Group language | The language of the admin who added Aegis, changeable in the panel (Settings level). |
| Persistent reminder | Admins appointed outside Aegis are always listed in the panel; in the group a reminder is posted right after such an admin appears (at most every 10 minutes) and then at most once a day while any remain, on the next group activity (there is no scheduler). Admins with Settings level can switch the group reminder off. |
| Former admins | Revoked the moment Telegram reports the change (chat_member) or at the next live re-check: cached rights and manual level are deleted and the revocation is logged. |
| /shutdown | Asks for confirmation. While shut down Aegis answers only the owner, posts nothing, pauses broadcasts, and still records membership changes quietly. Button presses by others get a short "paused for maintenance" notice. |
| /status | State (and for how long), version/phase/data version, reachable users, groups/channels/registered chats, broadcast state, errors in 24 h and the last one, the webhook's pending updates and last delivery error. |

## Phase 3

| Topic | Decision |
|---|---|
| The 18 lists | VIP, Trusted, Muted, Restricted, Banned, Blacklist, Warned, Quarantine, Suspicious, Moderators («mod»), Allowed bots, Banned words, Allowed words, Allowed links, Blocked links, Allowed forward sources, Blocked sticker packs, Blocked name patterns. Per chat, up to 2,000 entries each, up to 50 added per message. |
| Punishing lists | Muted / Restricted / Banned / Blacklist / Quarantine mirror Telegram: adding punishes, removing lifts, and punishments given by command appear in them. «Warned» is a view of members with active warnings (adding warns, removing clears). |
| Restriction vs. mute vs. quarantine | Mute: nothing can be sent. Restriction: text only (no media, stickers, polls, links previews). Quarantine: muted until an admin releases it (no default end). Blacklist: banned now and again on every join. |
| Default durations | A command without a duration means «until lifted» (Telegram: forever). Durations from 1 minute to 366 days (Telegram's limits). |
| Who may moderate | The owner: everything. Admins with at least View: warn/unwarn/warns; with Telegram's «Ban users» right also mute, restrict, kick, ban and lifting. «mod» list members (not admins): warn, unwarn, warns, mute, unmute. Nobody can do through Aegis what Telegram wouldn't let them do. |
| Protected members | The owner and admins (Telegram forbids restricting them), Aegis, the person themselves, VIP-list members; «mod» members can't punish each other. |
| Plain-word commands | Count only with a target (reply, @username, id, mention), so chat that happens to start with «بن» or "warn" is ignored. Ordinary members are never answered. |
| Undo | Every punishment except a kick, from the notice's button (creator; admins with «Ban users»; «mod» members for warnings and mutes; restoring a demoted admin needs Full and «Add new admins») or from the panel (Settings level + the same Telegram right). |
| Default steps | 3 warnings → mute 1 day; 5 → ban. Warnings never expire by default; they are cleared after the last step (switchable). |
| Audit Mode semantics | Applies to punishments Aegis decides **on its own**: warning steps, blacklist on join, anti-betrayal. They are recorded (status «audit only») and reported, not done. A command or panel action is a human decision and is carried out. Off by default. |
| Anti-betrayal | Counts bans/kicks of members and demotions of admins, per admin, in a sliding window (default 5 in 60 s; choices 3/5/10/20 and 1 min/5 min/10 min/1 h). One incident per burst. Response «demote» (default) or «alert only». Changing it needs Full; turning it off (or Audit Mode on) notifies the owner privately. |
| Log channel | Any channel/group where Aegis can post **and** the person setting it is an admin (so logs can't be sent to someone else's chat); not the group itself. Categories: punishments, lists, admins & security, settings — all on by default. |
| Telegram-side bans | Recorded as punishments (source «in Telegram»), shown in the Banned list, undoable from the panel; an unban in Telegram closes them. The blacklist entry stays (it is Aegis's own rule). |
| Names of members | Aegis keeps the name of members it punishes or sees punished, so lists, notices and logs show names instead of ids. |
| Exports | CSV, UTF-8 with BOM (opens correctly in spreadsheet apps), times in UTC, sent to the person's private chat. Exports are logged. |

## Phase 4

| Topic | Decision |
|---|---|
| The 42 locks | **Media 14**: photo, video, GIF, sticker, animated/video sticker, file, music, voice, video message, contact, location/venue, poll, dice/game emoji, story. **Text & links 13**: text messages, links, invite links, hidden (text) links, @usernames, mentions of members without username, hashtags/cashtags, commands for other bots, e-mail, phone numbers, formatting, spoilers, premium emoji. **Content 9**: banned words, blocked sites, emoji flood, long messages, repeated characters/words, Persian/Arabic script, Latin script, Cyrillic script, CJK. **Behaviour 6**: forwards, inline bots, posting as a channel, adding bots, service messages, edited messages. |
| Defaults | Every lock off; when turned on: delete, no punishment, standard notice, logged, trusted and moderators exempt, sensitivity medium, everyone. |
| Always exempt | Admins (from the admin list, kept current by Telegram's updates), Aegis, the anonymous admin, the linked channel's own posts, VIP-list members. The service lock applies to every service message regardless of who caused it. |
| Several locks match | The message is deleted if any of them says delete; the strongest punishment wins (ban > kick > restrict > mute > warning); one notice (the strongest lock's text); one log line naming all of them. |
| Who may set locks | Settings level; choosing mute, restrict, kick or ban also needs Telegram's «Ban users» (or being the creator). |
| Language rule | Script share of letters ≥ 70 / 50 / 30 % (low / medium / high) **and** at least two words in that script, or ≥ 90 % of the message; links, usernames, tags, commands, e-mails, phones and code are ignored. One foreign word in a mixed message never triggers. |
| Sensitivity meanings | Links / blocked sites: clickable only · + typed URLs · + disguised domains. Hidden links: deceptive only · any. Commands: only addressed to other bots · any not Aegis's. Banned words: whole words · + stretched («spaaam») · anywhere. Emoji: > 10 / 6 / 3. Long: > 2000 / 1000 / 500 characters. Repeat: 15/10/6 same characters or 6/4/3 same words in a row. Forwards: channels · + groups and bots · everything. |
| Notices | Standard text, or the admins' own (≤ 300 characters, `{user}` and `{lock}` filled in, HTML escaped). Each new lock notice deletes the previous one; at most one per 5 s per chat. |
| Bots lock | Removes bots added by non-admins (kick: ban + unban), except usernames on «Allowed bots»; the lock's punishment applies to the person who added them. |
| Edits | Every edit is checked against the content locks; the edit lock deletes any edited message. |
| Audit Mode | Locks are automatic, so in Audit Mode nothing is deleted or punished and nothing is posted in the group; the catch is recorded («audit only») and logged. |

## Phase 5

| Topic | Decision |
|---|---|
| Modules | Eight, all off by default: anti-link, anti-ads/tabchi, anti-flood, anti-raid, captcha, quarantine, suspicious content, risk score — plus emergency lock, read-only mode and federations. |
| Order | Locks run first, then security, then commands (a message a lock or security deletes is not executed as a command). Exempt: admins, Aegis, the anonymous admin, the linked channel's posts, VIP and trusted lists. |
| Defaults | Anti-link: delete, no punishment. Anti-ads: delete + mute 1 day, «new» = 10 min. Flood: 5 messages in 5 s or the same message 3×, delete + mute 10 min, punished once per window. Raid: 10 joins in 60 s → captcha for 30 min. Captcha: emoji buttons, 3 min, unsolved → kick, 2 tries. Quarantine: text only for 1 h. Suspicious: all checks, delete. Risk: medium (alert 40, act 70), mute 1 day. |
| Who may | Module settings: Settings level (punishments above a warning also need «Ban users»). Emergency lock / read-only: anyone with «Ban users» or the creator (command or panel). Captcha approve/remove and ending a lock from its message: admins with «Ban users». Risk feedback: Settings level. Federation create/join/leave: Full level; manage: its owner; /fban /unfban: owner and fed admins. |
| Restoring permissions | Before locking, the chat's permissions are read and saved; the same permissions are set back when the last lock ends (several locks at once restore only once, to the original). |
| Risk signals and weights | 18 signals with fixed default points (see `core/signals.js`); feedback multiplies the weights of that alert's signals ×1.1 (right) or ×0.8 (wrong), bounded 0.3–2×, per group, resettable. «Wrong» also undoes the punishment. |
| Audit Mode | Security is automatic, so in Audit Mode nothing is deleted, punished, locked or captcha'd; it is recorded and logged. Commands (/lockdown, /fban) are human decisions and still work. |
| Federations | One federation per group; up to 50 groups and 20 admins per federation; joining needs the owner's join code and the group's own Full admin; a fed ban bans at once in every member group where Aegis can ban, and again on join/message/join request. |
| Memory | Flood counters, media and ad fingerprints are kept 1 day; risk alerts 30 days; finished captchas 7 days. |

## Phase 6

| Topic | Decision |
|---|---|
| The 26 advanced settings | **Cleanup 8**: delete join notices, leave notices, pin notices, title/photo notices, video-chat notices, commands Aegis acted on, other bots' messages; Aegis's notices vanish after (off / 1 min / 5 min / 15 min / 1 h). **Messages 7**: slow mode (off / 10 s / 30 s / 1 min / 5 min), max lines (10 / 20 / 50), max mentions (3 / 5 / 10), no CAPITALS, no junk, edits allowed for (1 min / 5 min / 1 h), members' media vanish after (1 h / 6 h / 1 day). **Commands 6**: rules, rules button under the welcome, members' commands, answer in private, `@admin` calls admins, anonymous admin's commands. **Join & identity 5**: remove members' bots, join requests (admins decide / approve all / decline all), name-change alerts, title lock, bot-added alerts. |
| The 26th setting | Was planned as the CAS spam-list check; CAS now needs a personal API key (see NOT_BUILT), so «Remove members' bots» took its place: a bot added by a non-admin is banned at once (so it can't simply be re-added), the admins are told; admins may add bots. (The Phase 4 bots lock does the same per lock settings, with exceptions and a punishment for the adder; this setting is the simple switch.) |
| Defaults | Everything off except: rules button, members' commands, `@admin` calls, bot-added alerts, removing the previous welcome, reports (to the admins privately), event types (once an event channel is set). Join requests: the admins decide. Linked-channel posts: kept. Time zone: from the group's language. |
| Extras | Welcome and goodbye (own text ≤ 1000 / 500 characters with `{name}` `{mention}` `{group}` `{count}`, link buttons as in broadcasts, previous welcome removed, after the captcha, none during a raid, no goodbye for someone an admin removed). Forced join: up to 3 channels/groups where Aegis is an admin, a passed check trusted 10 min. Forced add: 1, 2, 3, 5 or 10 people (counted from Telegram's «X added Y» notices since Phase 6). Scheduled cleanup: up to 5 times a day; what: everything / media only / notices only. Night lock: one window a day, may cross midnight. Message length: min 2/3/5/10, max 200/500/1000/2000/4000 characters (the minimum applies to text messages only). |
| Exempt | Admins, VIP and trusted members are never caught by these rules; Aegis's own messages and the linked channel's posts neither. |
| Order | Locks → service-message handling (topics, forced-add counting, title lock, linked posts, notice deletion) → security → advanced message rules (bots, edits, read-only topics, forced join, forced add, slow mode, length, lines, mentions, CAPS, junk) → member and moderation commands. The first rule that deletes a message ends the checks for it. |
| Notices | All advanced rules share the locks' rolling notice (each new one deletes the previous, at most one per 5 s per chat), and are logged to the log channel under «locks». |
| Reports | `/report [reason]` (or «گزارش» …) as a reply; one per member per minute; not on admins, Aegis or oneself; the /report message is deleted; the admins get the reported text (≤ 300 characters), a link to the message (supergroups) and buttons; the first admin to act closes it for everyone; mute = 1 day; mute/ban need «Ban users». |
| Who may | Changing any advanced setting or topic: Settings level. Viewing: View level. Confirming an anonymous admin's command: any admin (it runs with their own access). Handling a report: admins with «Ban users» for mute/ban, any admin for delete/ignore. |
| Times | Fixed UTC offsets (no daylight saving); 24 offered; «auto» follows the group's language. Times are entered as «03:00, 15:30» or «۳:۰۰ و ۱۵» (Persian digits and «و» understood); the night window as «23:00 - 07:00» (or «تا»). |
| Topics | Topics Aegis has seen or created are listed; «read-only» is Aegis's own (members' messages there are deleted), closing uses Telegram's close. Delete asks first. |
| Audit Mode | Every advanced rule that deletes, removes, locks or restores the title only records and logs. Human actions (reports, «clean now», confirming an anonymous command) still work. |

## Phase 7

| Topic | Decision |
|---|---|
| Channel panel | Own sections: join requests, members, invite links, fakes, posts, alerts, discussion group, direct messages, extras, backups, crisis; shared: lists, punishments, anti-betrayal, Audit Mode, log channel, admins, access levels, language, change log. Group-only sections are hidden for channels. A 📊 channels dashboard lists every channel a person manages. |
| Join requests | Order: VIP (approve) → blacklist / ban list → known fakes → suspicious name or bio → burst limit → captcha → the rule. Defaults: the admins decide, suspicious names declined, burst limit 30 a minute (pause 30 min), captcha off. Captcha mode and time come from the security captcha settings (button by default, 3 min, at most 5 min — Telegram's limit). As guard bot Aegis answers within Telegram's 10 seconds (Mini App, or «queue» to leave it to the admins). In Audit Mode Aegis doesn't decline on its own. |
| Look-alikes | A name whose letters (after look-alike folding) equal the channel's title or an admin's name, a username that folds to the channel's username, links or invisible characters in the name, look-alike letters, scam words in the bio, a name containing an entry of the «names» list. Joins: reported (default) or removed (kick: the person can come back). |
| Alerts | To the log channel (category admin / security, when set) and the creator's private chat. Powerful rights: add admins, change info, delete messages, ban users, invite users. Changes made through Aegis's panel are not alerted (they are in the change log). Edit alerts are off by default; admin, info and Aegis-rights alerts on. |
| Posts | Archive on by default, 90 days, 20 versions per post. Edit lock off by default; when on, an edit later than the grace time (default 5 min) is put back to the version before it. Approval off by default; approvers are the creator and Full admins; Settings admins writing through Aegis need approval. Scheduled posts: up to 30 days ahead, in the channel's time zone. Waiting queue: 50 posts. |
| Discussion group | Its protections are settings of the channel, applied in the linked group (learned from getChat or the first automatic forward). «First comment» bots: comments within 30 s after a post from accounts that joined the group less than a day ago (or never seen joining). Admins of the group or the channel, VIP and trusted members are exempt. |
| Direct messages | Rules (when the filter is on): blocked senders (blacklist or ban list), suggested posts with links (declined), known fakes, scams or dangerous files, links, more than 10 messages a minute. Offending messages are deleted; scam alerts go to the owner. |
| Crisis | Needs Full access (demoting also needs «Add new admins» for the person and Aegis). Saves the request rule, approval, edit lock and grace time, and each demoted admin's rights; «End crisis» restores those and unlocks the discussion group. |
| Backups | A JSON file of the settings (not the log or backup chats, not locked titles), configuration lists (not punishment lists) and, for groups, locks and security. Restoring needs Full access, checks the kind of chat and the version, validates every value again, and asks first. Copying older posts: 50 ids per step, once a minute or per button. |
| Members | Remove = kick (ban and unban), ban and unban go through the punishment engine (logged, reversible). Needs Settings level and «Ban users» (or the creator). |
| Invite links | Named «Aegis N»; expiry never / 1 h / 1 d / 7 d; limit none / 1 / 10 / 100 / 1000; approval and a limit can't be combined (Telegram). 50 live links per channel. |
| Dashboard | Channels where the person has View access; member counts refreshed when older than an hour (5 per view). Cross-posting: up to 10 channels, each checked live. |

## Phase 8

| Topic | Decision |
|---|---|
| Statistics | On by default for every registered group: per member (messages, points, thanks, streak, first and last seen), per day (messages, media, active members, joins, leaves; kept 400 days) and per hour of the day (in the chat's time zone). Only members' messages with content count (not bots, not messages sent as a channel, not service messages); a message removed by a lock or the security never counts. |
| Points | Off by default. 1 point per message (choices 1 / 2 / 5) of at least 3 characters or with media, at most once a minute (choices 0 / 30 / 60 / 300 s). A thanks gives the thanked member as many points as a message, a giver at most once a minute, never to bots or oneself. Level n needs 5·n·(n+1) points (max level 100). Admins give or take 1–1000 points as a reply. Announcements on by default. |
| Badges | Ten automatic badges (checked at level-ups and at 1, 100, 1,000, 10,000 messages, every 50 messages and at 7- and 30-day streaks) and up to 20 of the group's own (an emoji and a name up to 24 characters), given by Settings admins; removing one removes it from everyone. |
| Contests | Settings level. Default 1 day and 1 winner. Raffles: only current members (checked live), at most 5000 entries. Activity: every counted message of a member is a point; ties go to who wrote first. Quiz: messages during the quiz are attempts (they count as taking part). A discarded draft disappears; a cancelled contest stays listed. |
| Polls | Settings level. Up to 10 answers (Telegram allows 12), 300-character question, 100-character answers, duplicates dropped. Anonymous by default. Closing time none / 1 h / 1 d / 3 d / 7 d. A quiz has exactly one right answer and no multiple answers. |
| Questions | On by default; anonymous questions off. A question goes to at most 10 admins who started Aegis (View level or more). Answering and closing: View; publishing: Settings; blocking: Full. One question per member and group every 5 minutes; 1000 characters. |
| Appeals | On by default. Warnings, mutes, restrictions, quarantine, bans and blacklist bans can be appealed (not kicks or demotions), once per punishment, while it is active. Deciding needs «Ban users» (or the creator). |
| Review | «Review all» off by default; it sends punishments given with Aegis's commands by admins below Full access to the Full admins who started Aegis. From the panel a Full admin can uphold or overturn any recent decision (30 days). Overturning undoes the punishment and tells the moderator. |
| Health score | Growth 25 (net subscribers in 7 days: +2 % or more → 25, none → 15, −2 % or worse → 0), engagement 30 (reactions + comments per post per 1,000 subscribers in 14 days: 20 or more → 30), posting 20 (days with a post in the last 14: 10 or more → 20), safety 25 (Aegis has its rights 10, no admins appointed outside Aegis 5, no crisis 5, a protection on 5). Grades A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, E. |
| Command words | Words work only as the whole message (so ordinary chat is never taken for a command): «امتیاز من» / "my points", «برترین‌ها» / "leaderboard", «امتیاز بده ۱۰» / "give points 10", «پرسش از مدیران» / "ask the admins", «سوال ناشناس» / "anonymous question", «اعتراض» / "appeal" (private), and the same in Russian, Chinese and French. |
| Module cap | The platform refused a deploy of 104 modules. Small modules were merged (no behaviour change): duration → clock, csv → util, health → levels, modparse → commands, steps → settings, buttons → content, bot → tg, admin_actions → a section of betrayal, the six Phase 8 data modules → sections of engines/social.js, ui/qa → a section of ui/social.js, panel_qa and panel_analytics → sections of panel_social.js. 88 modules now; the static test fails above 95. |

## Phase 9

| Topic | Decision |
|---|---|
| The 30 fun features | Without the spec's list, Aegis's own 30 in six groups. **Dice** (Telegram's animated dice): dice, darts, basketball, football, bowling, slot machine. **Luck**: coin flip, random number, choose for me, magic 8-ball, fortune cookie. **Social**: love meter, rate anything, truth, dare, would-you-rather poll, actions (hug, pat, high-five, wave, cheer), couple of the day. **Daily**: member of the day, birthdays, daily bonus, quote. **Games**: guess the number, quick math, word scramble, typing race, trivia quiz, quick click. **Duels**: rock-paper-scissors, tic-tac-toe. |
| Per-feature settings | One setting each: on/off, who (everyone or admins), cooldown 0 / 10 / 30 / 60 / 120 / 300 s, daily limit per member 0 (none) / 3 / 5 / 10 / 20 / 30 / 50, points for a win 0 / 1 / 2 / 5 / 10 (games and dice; needs Phase 8 points on). All on by default with modest limits (e.g. dice 30 s and 20 a day; guess 5 points). |
| Chat-wide limits | Fun on by default; at most 10 fun commands a minute in a chat (choices 5 / 10 / 20 / 30 / off), silently ignored beyond; fun replies can delete themselves after 1 min / 5 min / 1 h; admins skip the per-member limits (switchable). A refused command answers once with the wait or «enough for today» (also within the chat limit). |
| Words as commands | Only as the whole message, or followed by valid arguments (e.g. «انتخاب کن چای، قهوه»); otherwise the message is ordinary chat. Everyday words were avoided (e.g. Russian «хочу правду» rather than «правда»). |
| Fairness and stability | Love meter, ratings, the couple and the member of the day come from a hash of the people/text and the local day, so they don't change when asked again the same day. The couple/member of the day are picked among members who wrote in the last 7 days (Phase 8 counts). |
| Games | One game of each kind per chat at a time. Guess: 10 min, one guess per member every 3 s, «higher/lower» replies. Math, scramble, typing: 3 min. Trivia: Telegram's quiz, open 60 s; the first right answer (from the poll answers) wins. Quick click: 2 min, a wrong tap puts the member out. Duels: must be accepted; 10 min; picks in rock-paper-scissors are hidden until both chose. Content (questions, words, sentences, dares…) per language in `locales/<lang>/funlist.json`. |
| Typing race anti-cheat | The sentence shown carries invisible word joiners (U+2060); a pasted copy contains them and is ignored. |
| Birthdays | Month-day in the chat's calendar: Persian (Jalali) for Persian chats, Gregorian otherwise (switchable). Greeted once a year on the first message of the local day; `/birthday off` removes it. |
| Daily bonus | 1–10 points once per local day; needs points on. |
| Media tools | On in groups by default, for everyone, 10 uses per member per day (3 / 5 / 10 / 20 / 50), 5 s between uses; private chats: 50 a day, 2 s apart. Only the member who asked can press a tool's buttons. Jobs (the file a tool works on) are kept a day. |
| Sticker packs | One pack per member, named `a<id>_by_<bot>`, title «My Aegis stickers»; stickers 512 px PNG, ≤ 256 colors (dithered) to stay under 512 KB; the 120 newest kept (the oldest is removed when full). |
| Image sizes | Tools use Telegram's photo size closest to 800 px (≤ 1280 px), output JPEG quality 88; circles as PNG files; GIF frames ≤ 360 px, up to 10, 0.5 / 1 / 2 s each, one shared palette with ordered dithering. |
| OCR and QR in the Mini App | Tesseract.js 5.1.1 and jsQR 1.4.0 from jsDelivr (Apache-2.0), run on the member's device; languages by the member's language (+ English). The endpoint gives a photo only to the member whose job it is. |
| Security checks | Two more checks in «suspicious content», on by default whenever the module is on: QR codes in photos whose link is not on the allowed-links list, and PDFs with JavaScript, launch actions, embedded files or rich media. Signals for the risk score: «qr_link» 40, «pdf_active» 50. |
| Module cap | 94 modules after Phase 9 (6 new: core/files, core/image, engines/fun, ui/fun, ui/media, endpoints/media). |

