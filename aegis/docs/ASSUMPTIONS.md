# Decisions taken without the master spec

`docs/SPEC.md` (the Persian master spec, "the source of truth") was not in the repository when
Phases 1–5 were built (for Phases 3–5 the owner said to build them without the spec). Where the build instructions did not settle a detail, the choice below
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
