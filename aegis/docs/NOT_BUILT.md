# Not built / partly built

Every feature that was not built, or only partly built, with the reason and what it would need.
Updated at the end of each phase. Constraint for all entries: **free only** — no paid service, API
or tier; only what Telegram Serverless and the Bot API allow.

> **Note on the spec.** `aegis/docs/SPEC.md` (the Persian master spec) was not in the repository
> when Phases 1 and 2 were built (searched the working tree, all branches on GitHub, and the
> container). Both phases were built from their descriptions in the build instructions; details the
> spec would normally settle are listed in [ASSUMPTIONS.md](ASSUMPTIONS.md). Both phases will be
> re-checked against the spec once it is added.

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
