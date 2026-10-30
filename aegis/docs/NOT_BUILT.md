# Not built / partly built

Every feature that was not built, or only partly built, with the reason and what it would need.
Updated at the end of each phase. Constraint for all entries: **free only** — no paid service, API
or tier; only what Telegram Serverless and the Bot API allow.

> **Note on the spec.** `aegis/docs/SPEC.md` (the Persian master spec) was not in the repository
> when Phase 1 was built (searched the working tree, all branches on GitHub, and the container).
> Phase 1 was built from the Phase 1 description in the build instructions. The spec must be added
> before Phase 2, and Phase 1 will be re-checked against it.

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
| Per-chat language **changer** | **Deferred to Phase 2** | The per-chat language is stored (`aegis_chats.lang`, from the admin who added the bot) but the group's settings panel is Phase 2. In Phase 1 the bot posts nothing of its own in groups (broadcasts copy the owner's message as-is). | Phase 2 group panel. |
