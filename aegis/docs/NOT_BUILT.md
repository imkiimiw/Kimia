# Not built / partly built

Every feature that was not built, or only partly built, with the reason and what it would need.
Updated at the end of each phase. Constraint for all entries: **free only** — no paid service, API
or tier; only what Telegram Serverless and the Bot API allow.

> **Note on the spec.** `aegis/docs/SPEC.md` (the Persian master spec) was not in the repository
> when Phases 1–5 were built (searched the working tree, all branches on GitHub, and the
> container). They were built from their descriptions in the build instructions (Phases 3–5 by the
> owner's decision to go ahead without it — the 42 locks and the security modules are Aegis's own
> design, see ASSUMPTIONS); details the spec would normally settle are listed in
> [ASSUMPTIONS.md](ASSUMPTIONS.md). They will be re-checked against the spec once it is added.

## Phase 1 — Core

| Feature | State | Why | What it would need |
|---|---|---|---|
| Broadcast that runs unattended in the background | **Partial** | Telegram Serverless has **no scheduler, cron, timers or background jobs** (official docs: none described; the isolate has no `setTimeout`). A broadcast is a resumable queue, but it only advances when the owner presses «▶️ Send next batch», while the owner keeps the 📡 Live sending Mini App page open (≈ 25 msg/s), or a few messages at a time on the side of other updates the bot receives. | A platform scheduler (not offered) or an external always-on worker/cron calling the bot — which would be a separate paid or third-party host, so not used. |
| Aegis-specific **cron job** names | **Not applicable** | No cron/scheduler exists on the platform, so there are no jobs to name. Background work is done in `lib/jobs.js` on the side of updates. | A platform scheduler. |
| Aegis-specific **webhook path** | **Not possible** | The platform owns the webhook: `https://cloud.telegram.org/app8940801714/webhook`, rebuilt from the deployed handlers on every push. It can't be renamed. | — (the per-app id already isolates it). |
| `AEGIS_OWNER_ID` as a runtime environment variable | **Partial** | Deployed modules get no environment variables. The value is read from `aegis/.env`/the environment at **deploy time** and written into `tgcloud/lib/env.js` (default `5557901897`). Changing it needs a redeploy. | Runtime env/secrets support on the platform. |
| Broadcasting an **album** (media group) as one message | **Not built** | Telegram delivers each album item as a separate update, and without timers the bot can't wait to collect the group. The bot refuses albums and asks for one message. | A way to delay processing (scheduler), or a multi-step "add items" flow — possible later if wanted. |
| Extra **buttons on forwarded** broadcasts | **Not possible** | `forwardMessage` has no `reply_markup` parameter. Copy mode supports link buttons; the forward option says so in the UI. | — (Bot API limitation). |
| Callback (non-link) buttons in broadcasts | **Not built** | Only URL buttons are offered: a callback button in a broadcast would need a feature behind it. | A concrete use from the spec. |
| Member counts across managed chats | **Partial** | `getChatMemberCount` is one call per chat. Counts are cached for 1 h and refreshed lazily (up to 15 per stats view, a few in housekeeping), so with many chats the total can include counts up to an hour old; the stats screen says how many are stale. | — (rate limits make live per-view totals impossible at scale). |
| Forced-join membership where Aegis is not an admin | **Partial (by design)** | Telegram only lets a bot read channel membership where it is an admin. Such channels are skipped (so nobody is locked out) and the owner is warned. **Right now Aegis is not an admin in @HIDE_i_SEEK, @Nepenthw_ir or @wangerBots**, so the check is effectively off until it is made admin there. | Make Aegis an admin in each forced-join channel. |
| Private forced-join channel without an invite link | **Not built** | The bot needs a link to show; a private channel's link can only be created by an admin bot. Adding one is refused with an explanation. | Make Aegis an admin there (with "invite users"), then add it again. |
| Per-chat language **changer** | **Built in Phase 2** | (Was deferred in Phase 1.) Now in each chat's panel: 🌐 Chat language. | — |

## Phase 2 — Adding the bot, configuration & access control

| Feature | State | Why | What it would need |
|---|---|---|---|
| Editing or demoting admins **appointed outside Aegis** | **Not possible** | Telegram lets a bot edit or demote only admins it promoted itself (`can_be_edited`). Aegis shows them (⚠️), explains the fix, and reminds the group; anti-betrayal and admin restrictions in later phases can't act on them either. | The chat owner removes them as admins in Telegram and appoints them again through Aegis. |
| Appointing admins / restricting in a **basic group** | **Not possible** | `promoteChatMember` (and restricting) work only in supergroups and channels. Aegis says so in the warning and the panel and follows the group automatically when Telegram turns it into a supergroup. | Telegram converts the group (e.g. making it public or showing history to new members). |
| Aegis granting **itself** missing rights | **Not possible** | A bot can't change its own admin rights. Aegis lists what's missing and offers a link that opens Telegram's own "edit admin rights" screen with the needed rights pre-selected. | An admin of the chat taps the link / edits Aegis's rights. |
| Picking a member by **@username** | **Partial** | The Bot API can't look users up by username. Aegis resolves a @username only if it has met that user; otherwise it asks for Telegram's user picker («👤 Choose a user»), a forwarded message, or the numeric ID. A forward from someone who hides their account can't be used. | — (Bot API limitation). |
| «پیکربندی» from an **anonymous admin** in a group | **Partial** | An anonymous admin's messages come from the group itself, so Aegis can't tell who they are. It answers with how to proceed (turn anonymity off briefly, or use «پیکربندی» in the private chat, which lists all their chats). | — (Telegram design). |
| «پیکربندی» as a plain word where Aegis is **not an admin** | **Partial** | With privacy mode on, a non-admin bot receives only commands, so only `/config` works there; plain words work once Aegis is an admin (which it needs anyway). | Make Aegis an admin. |
| The "added" warning **in a channel** | **Partial (by design)** | Posting it in a channel would send it to every subscriber, so it goes only to the admin who added Aegis (in private). | — |
| **Persistent** reminder about outside admins | **Partial** | There is no scheduler, so the group reminder can't be timed. It is posted right after such an admin appears and then at most once a day **on the next group activity**; the panel always shows the list. | A platform scheduler. |
| «My chats» for chats where the user became admin while Aegis **missed the update** | **Partial** | The list comes from Aegis's admin cache (filled from Telegram's admin list and chat_member updates). If an update was missed, the chat appears after the next refresh — sending «پیکربندی» in that group refreshes it at once. | — |
| Super Admin access to **any** chat's panel / global chat management | **Phase 10** | Not part of Phase 2 (the owner manages chats where they are an admin, like anyone else). | Phase 10. |

## Phase 3 — Lists, punishments, warnings, logs

| Feature | State | Why | What it would need |
|---|---|---|---|
| Word, link, sticker, name, bot and forward lists **taking effect** | **Partial (by phase)** | The lists are complete (add, remove, edit, search, details, history, export), but deleting messages that match them is the job of the locks and filters of Phases 4–5. The panel says so on each list. | Phases 4–5. |
| VIP / Trusted / Suspicious lists | **Partial (by phase)** | VIPs are already protected from moderation commands; the exemptions from filters and locks, and the use of «Suspicious», come with Phases 4–5. | Phases 4–5. |
| Quarantine of **new members** automatically | **Not in this phase** | Quarantine works as a list/punishment now (muted until released); putting newcomers there automatically is a security feature (Phase 5). | Phase 5. |
| Anti-betrayal **demotion** of the owner or of admins appointed outside Aegis | **Not possible** | Telegram lets a bot demote only admins it promoted (`can_be_edited`); nobody can demote the owner. Aegis reports these instead, says why, and offers to unban the removed members. | Appoint admins through Aegis. |
| Anti-betrayal seeing every removal | **Partial** | Removals are counted from Telegram's `chat_member` updates, which a bot receives only where it is an admin. Bans through Aegis's own commands and panel are counted for the person who gave them. | Make Aegis an admin. |
| Restoring admins **demoted by** a betrayer | **Not built** | Their former rights are not known reliably once Telegram has removed them (an admin appointed outside Aegis couldn't be re-appointed by the bot anyway). The alert counts them; re-appoint them through the panel. | — |
| Undoing a **kick** | **Not possible** | A kick removes the member, who can rejoin by themselves; there is nothing to lift. The notice has no undo button for it. | — |
| Mute / restrict / quarantine in a **basic group** | **Not possible** | `restrictChatMember` works only in supergroups. Aegis says so; bans and kicks work in basic groups. | Telegram converts the group to a supergroup. |
| Timed punishments shown as "ended" exactly on time | **Partial** | Telegram lifts timed restrictions/bans itself (`until_date`); without a scheduler Aegis can't be woken at that moment, so its records simply read «expired» from then on. | A platform scheduler (not needed for correctness). |
| Warning expiry | **Partial** | Expired warnings stop counting at once (checked at query time); they are not deleted, so they stay in the member's history. | — (by design). |
| Punishing a **channel** or the group itself (`banChatSenderChat`) | **Not built** | Only members are punished in this phase; Aegis says so when someone replies to a channel's message. | A later phase if the spec asks for it. |
| Punishing members by **@username** Aegis has never seen | **Partial** | The Bot API can't resolve usernames; Aegis knows a @username only after meeting that user. Replies, mentions and numeric ids always work. | — (Bot API limitation). |
| Group notices for **panel** actions | **Partial (by design)** | Adding many members to a punishing list at once would flood the group with notices, so panel actions go to the log channel (and the panel's history) only; commands and automatic actions post notices. | — |

## Phase 4 — Group locks

| Feature | State | Why | What it would need |
|---|---|---|---|
| Locks working where Aegis is **not an admin** | **Not possible** | A bot sees every message, and may delete them, only as an admin with «Delete messages» (and «Ban users» to punish). The panel warns when a right is missing. | Make Aegis an admin with those rights. |
| Punishing the person behind a message **sent as a channel** | **Not possible** | Telegram hides who posted as a channel; such messages can only be deleted. (Banning the channel itself, `banChatSenderChat`, is not in this phase.) | A later phase if the spec asks for it. |
| Telling **Persian from Arabic** (or English from French …) | **Partial** | Language locks work by script: Arabic script (Persian and Arabic together), Latin, Cyrillic, CJK. Telling languages that share a script apart needs language models/dictionaries. | A free language-identification library small enough for the isolate (none used). |
| Old messages / messages sent **while Aegis was not there** | **Not possible** | Bots can't read chat history; only new messages and edits are checked. | — (Bot API). |
| Deleting the bot's own lock notices **after a delay** | **Partial** | There is no scheduler, so a notice can't remove itself later. Instead each new lock notice deletes the previous one, and at most one is posted every 5 s. | A platform scheduler. |
| «New members only» for people who joined **before** Aegis | **Partial (by design)** | Join times are known only from joins Telegram reported to Aegis; anyone else counts as an old member (never wrongly treated as new). | — |
| Locks on **channel posts** and the discussion group | **Phase 7** | Channels and their discussion groups get their own protection in the channel panel. Edited channel posts are not handled. | Phase 7. |
| Native Telegram permissions (`setChatPermissions`) as locks | **Not used** | Locks are enforced by Aegis per message, so they can have exceptions, sensitivity, scope and punishments, which Telegram's chat-wide permissions can't. (Read-only mode and emergency lock in Phase 5 will use them.) | — |
| Lock catches kept **longer than 7 days** | **Partial** | Kept 7 days for the panel's «recent catches» (database size); punishments from locks are kept like any other. | — |

## Phase 5 — Group security

| Feature | State | Why | What it would need |
|---|---|---|---|
| Captcha / raid mode / read-only **ending exactly on time** | **Partial** | There is no scheduler. An unsolved captcha is acted on, and a timed lock or raid mode is ended (permissions restored), at the next update of that chat or within a minute of any update the bot receives — not at the exact second. Quarantine uses Telegram's own `until_date`, so it ends on time. | A platform scheduler. |
| Captcha, quarantine, emergency lock, read-only in a **basic group** | **Not possible** | Restricting members and setting chat permissions work only in supergroups. The panel says so. | Telegram converts the group to a supergroup. |
| Join-request captcha **longer than 5 minutes** | **Not possible** | Telegram lets a bot write to someone who asked to join only for 5 minutes, so the captcha time is capped there. | — (Bot API). |
| Profile-photo or account-age signals for the risk score | **Not built** | Account age isn't available to bots; checking every newcomer's profile photos would be an extra API call per join. The score uses the name, username, the group's own data and behaviour. | Spec decision; possible later (getUserProfilePhotos). |
| Checking files' **contents** (viruses, archives with passwords, PDF scripts) | **Not built (Phase 9 for PDFs)** | Downloading and scanning files in the isolate is not possible within limits and no free scanning API is used. Files are judged by name, extension and type. | Phase 9 (PDF checks with free libraries) — antivirus scanning has no free option. |
| Telling the same **ad reworded** in other groups | **Partial** | Cross-group detection matches the same visible text (fingerprint), not paraphrases. | A similarity model (not free in the isolate). |
| Language detection for Persian vs. Arabic in ads/scam phrases | **Partial** | Phrase lists cover five languages; other languages' ads are caught only by links, contacts and behaviour. | Larger phrase lists from the spec. |
| Federations **retroactively** banning everyone on the list when a group joins | **Partial (by design)** | A joining group's members are banned when they join, write or request to join, not all at once (a big list would hit Telegram's limits). | — |
| Federation **subscriptions** (one federation following another) and fed-ban **notifications to every group** | **Not built** | Not described in the build instructions; a fed ban is reported in the group where it was given and logged there. | Spec details. |
| Risk alerts in a **group** chat | **Not built (by design)** | Alerts name a member and their score, so they go to the log channel, or the creator's private chat when there is none. | — |
