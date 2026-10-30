# Decisions taken without the master spec

`docs/SPEC.md` (the Persian master spec, "the source of truth") was not in the repository when
Phases 1 and 2 were built. Where the build instructions did not settle a detail, the choice below
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
