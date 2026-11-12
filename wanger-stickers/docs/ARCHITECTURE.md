# Architecture — Wanger Stickers (Phase 1)

One tgcloud project (@Wanger_Motionbot, app9292593567): a thin Serverless backend in `tgcloud/`,
the Mini App in `src/` (Phase 0–1: the device spike page; the Studio from Phase 2), and the media
engine in `src/engine/`. Brief: [BRIEF.md](BRIEF.md); choices: [DECISIONS.md](DECISIONS.md).

## Request flow (chat)

```
handlers/{message,callback_query,my_chat_member}.js   (thin: one line each)
  → lib/boundary.js     buildApp → de-duplicate update_id → run → piggyback tick → flush stats
                        errors: log → errors row → throttled owner alert → normal return
  → lib/bot/router.js   maintenance → ban → flood → first-start language → GATE → step → command → media/text
                        callbacks: decode (≤ 64 bytes, typed args) → permission (every press) → GATE → route
  → lib/bot/*_ui.js, lib/admin/*_ui.js   screens and conversation steps
  → services            lib/wanger/{account,gate,broadcast}.js, lib/packs/{service,ops,publish}.js
  → lib/db/*.js         all SQL (sql tag), one statement per state change, every query LIMITed
  → sdk                 db, api (only through lib/tg.js, which records the trace)
```

## Modules

| Module | What it does |
|---|---|
| `lib/config.js` | Owner, bot id/username, seed channels, setting DEFAULTS and ranges, internal timings (`T`). Pure. |
| `lib/core/*` | Pure: `limits` (every platform number), `inspect` (WebP/WebM/PNG headers), `codec` (callback_data + keyboards), `errors` (Bot API error classes), `gate` (membership decisions), `packs` (names, titles, emojis, keywords, links, number lists), `roles` (owner / reviewer / user), `chatref`, `limiter`, `logger`, `html`, `util`, `bytes`. |
| `lib/i18n/{fa,en,index}.js` | Every text. `t()` escapes vars + Persian digits, `tp()` plain. Same keys in both (tested). |
| `lib/app.js` | Per-invocation context: clock, logger, Telegram client, settings (one query), buffered stats, alerts, audit, conversation state, the current user and role. Bootstrap seeds the gate channels once. |
| `lib/tg.js` | The only Bot API path; trace of every call; edit-or-send; never-throwing answer/remove; `inspectChannel`. |
| `lib/wanger/account.js` | Wanger Account adapter — LocalAccountProvider only (no hub exists). |
| `lib/wanger/gate.js` | Forced join: parallel checks, 10-min pass cache with a list version, broken channels skipped + alerted, owner management. |
| `lib/wanger/broadcast.js` | Broadcast engine: lease + cursor + in-flight marker (at most once per recipient), copy/forward, audiences. |
| `lib/packs/service.js` | Sticker-set operations by file_id; the `pack_items` mirror refreshed from `getStickerSet`; quotas. |
| `lib/packs/ops.js` | Bulk ops (import, copy, duplicate, merge) across invocations: snapshot + lease + forward-only cursor. |
| `lib/packs/publish.js` | Channel publishing: request → review cards → decide → one post (lease, no re-send) → withdraw/remove (48 h rule); channel + reviewers. |
| `lib/jobs.js` | The tick: housekeeping (≤ every 10 min, elected), broadcast slice, one queued post, one bulk-op slice, owner notices. |
| `lib/bot/{router,ui,packs_ui,publish_ui}.js` | Routing and user screens. |
| `lib/admin/{panel,channels_ui,broadcast_ui,publish_ui}.js` | Owner panel; reviewers reach only `a:home`, `a:q`, `a:qv` and `pr:*`. |
| `endpoints/spike_*.js` | Phase 0 spike tools (owner only), removed when the Studio arrives. |

## Data (schema.js, 20 tables)

users · usage_daily · channels · membership_cache · user_state · pending_actions · packs ·
pack_items · pack_posts · staff · pack_ops · broadcasts · settings · secrets · rate_limits · errors ·
stats_daily · processed_updates · alerts · audit_log. No foreign keys; children deleted before
parents in code; timestamps are unix seconds; jobs/uploads tables come with Phase 2.

## Platform rules the code follows (measured, SPIKE_REPORT §3a)

- CPU ≈ 3 s, wall ≈ 30 s per invocation → piggyback budget 2.5 s, button budget 20 s, item caps.
- No transactions → every state change is one conditional statement (`UPDATE … WHERE status = … RETURNING`).
- No scheduler → background work moves only on updates and owner buttons.
- One SQL value < 1 MB; ≤ 4096 bound values; ≤ 10 000 rows written; deletes in batches of ≤ 5000.
- `getChatMember` "member not found" = not a member; "member list is inaccessible" = bot not admin.
- `deleteMessage` only < 48 h → older channel posts get their buttons stripped instead.
- Module budget ≤ 85 (currently counted by `tests/guard.test.mjs`).

## Tests

`npm test`: unit (`core`, `guard`) + end-to-end on the SDK emulation (`tests/sdk/`, node:sqlite with
the platform's measured limits) and a strict fake Bot API with sticker-set rules
(`tests/helpers/fake-telegram.mjs`). Acceptance suites: `e2e.gate`, `e2e.packs`, `e2e.publish`,
`e2e.admin` (permission matrix over every admin route and step, broadcast interruption).
