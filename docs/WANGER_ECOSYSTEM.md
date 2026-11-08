# Wanger ecosystem — v1 (2026-11-08)

The reference every Wanger bot follows for **forced join, bans, maintenance, admins, broadcast, stats,
privacy and the working rules**, and the contract of the **Wanger Hub**, the **Mother Bot** and
**`wanger-client`** for when they are built. Written at the owner's request ("سند رو هم خودت بساز")
from what the existing bots in this repository already do, so nothing here contradicts a working bot.

- **§1–§9 apply now.** Each bot implements them locally (the *local provider*).
- **§10–§13 describe the Hub era.** A bot that follows §1–§9 switches to the Hub by storing `HUB_URL`
  and `HUB_KEY`; no data migration is needed and the local lists stay as the fallback.

Owner: Telegram user id **`5557901897`** (the same constant in every bot's config). Changes to this
document are the owner's decision; bots record deviations in their own `docs/DECISIONS.md`.

---

## 1. The bots and the channels

| Bot | Username | Folder |
|---|---|---|
| Wanger Converter | `@Wanger_Converterbot` | `bots/converter/` |
| Wanger Music | `@Wange_Musicbot` | `wanger-music/` |
| Wanger Media | `@Wanger_mediabot` | `wanger-media/` |
| Shadow (whisper / anonymous messages) | `@Wanger_Shadowbot` | `whisper_bot/` |
| Others in this repository | see each folder's README | `aegis/`, `relay_bot/`, `memebot/`, `x_downloader_bot/`, `game_bot/`, the to-do bot at the root |

**Forced-join channels** (the same three in every bot that has forced join):

| Channel | chat_id | Role |
|---|---|---|
| `@HIDE_i_SEEK` (HIDE & SEEK) | `-1002407928564` | forced join |
| `@Nepenthw_ir` (Nepenthe) | `-1001816009903` | forced join |
| `@wangerBots` (Wanger bots) | `-1001910797391` | forced join + the ecosystem's announcement channel |

**Every bot must be an admin in every forced-join channel.** Telegram only lets admins read
membership. A bot that isn't admin there cannot check that channel (§3, failure mode).

## 2. Platform facts every Wanger bot designs around (Telegram Serverless)

Measured by the bots in this repository; each bot's `docs/LIMITS.md` (or equivalent) has the numbers.

- **Execution limits:** about 3 s of CPU and about 30 s of wall time per update.
- **Missing APIs:** no timers, no cron, and no `AbortController`.
  - Background work runs on traffic, on an owner's button, or through an external tick (GitHub
    Actions in a public repository).
- **Database:** no foreign keys and no transactions; every state change is one statement.
  - A query that reads more than about 50 000 rows fails, so every query is index-backed and `LIMIT`ed.
- **Outbound `fetch`:** only ports **80/443**; private and reserved addresses are blocked. A dead host
  costs 1.6–3.2 s.
- **Endpoints** (`/api/<name>`) run only for a valid Mini App `initData`. **One bot cannot call
  another bot's endpoint server-to-server.**
  - So the **Hub is not a Serverless bot**: it is an ordinary HTTPS service (§10).
  - Bots in a private chat never see each other's messages.
- **`callback_data`:** at most 64 bytes.
- **File names:** Telegram keeps at most 64 characters of a name (+ 16 of the extension).

## 3. Forced join (the gate)

- **Who is checked:** every update from a regular user in a private chat, before any action.
  - The owner and the bot's admins are exempt.
  - `/help`, `/privacy`, `/deletemydata` and the language choice work before the gate.
- **How:** `getChatMember` for every enabled channel, in parallel.
  - **Pass:** `creator`, `administrator`, `member`, or `restricted` with `is_member: true`.
  - **Fail:** `left`, `kicked`, or Telegram's "member not found".
- **Cache:** a **pass** is cached briefly (Converter: 5 min; Music: a setting). **A failure is never
  cached.** Any change to the channel list invalidates all passes (a version bump).
- **Failure mode** — what happens when a channel can't be checked (bot not admin, chat gone, network):
  - **Open (default):** that channel is skipped for this check, so users are not locked out by a setup
    mistake.
  - **Closed:** that channel counts as not joined. Use it only when the owner asks.
  - Transient errors (429, 5xx) get one quick retry, then the failure mode applies.
  - A channel known to be broken is skipped without asking Telegram again for about 10 min.
- **Owner alert:** for a broken channel, at most once per channel every 1–3 h.
- **Join screen:**
  - One URL button per missing channel, and «✅ عضو شدم», which re-checks without the cache.
  - The screen shrinks to the channels still missing.
- **Resume:** after a pass, the user's original action continues: the file they sent (a whole album,
  as one batch), the command, or the `/start` payload. A resume action expires after 24 h.
- **Groups:** bots that work in groups check the person who triggered the action, never the whole
  group.

## 4. Bans

- Set by the owner (and the bot's admins, if the bot allows it). **The owner can never be banned.**
- **What the banned user sees:** one short notice a day, then silence.
  - `/privacy` and `/deletemydata` still work.
  - A ban survives data deletion (the bot keeps only the id and the flag).
- **Scope:** each bot's own list today. With the Hub (§10) there is also a **global** list, checked
  in addition to the local one.

## 5. Maintenance

- A switch per bot (owner only).
- **During maintenance:**
  - The owner and admins keep full access.
  - Users get one short notice per action (one per album), and their files are not processed.
- With the Hub there is also a **global** switch, which overrides the local one.

## 6. Roles and the admin split

| Role | Where | Can |
|---|---|---|
| Owner (`5557901897`) | every bot | everything: keys (`/secret`), admins, maintenance, forced-join channels, broadcast, limits |
| Admin | a bot's `staff` table | that bot's panel: overview, jobs, retries, bans, read-only channel list — never keys, admins, maintenance, channel changes or broadcast |
| User | — | the bot's features |

- **Spec v2 split:** the Mother Bot holds ecosystem-wide admin (broadcast, global bans, forced-join
  list, global maintenance, global stats); each bot's `/panel` keeps only its own things.
- **Until the Mother Bot exists:** each bot carries a local copy of these controls in its own panel.
- **Every button and typed answer re-checks the permission.** A visible button is not authorization.

## 7. Broadcast

- **Source:** the owner sends (or forwards) the message to the bot. The bot asks for confirmation and
  then delivers it with `copyMessage`, so formatting, media and buttons are kept and there is no
  "forwarded from".
- **Batches:** about 25 users per run, driven by the owner's «▶️ ادامه» button or by traffic (there is
  no cron).
  - 429 `retry_after` is respected.
  - Users who blocked the bot are marked and skipped from then on.
- **One at a time:** only one broadcast runs at a time, and it can be cancelled.
- **Report:** sent / failed / blocked.
- **Hub era:** the Mother Bot posts the message in a private **Wanger broadcast channel** where every
  bot is an admin. Each bot `copyMessage`s from there to its own users (a bot can only send to people
  who started *it*) and reports progress to the Hub (§10.5).

## 8. Stats

- **Running counters only.** Rows look like `(day, key) → n`, plus `day = 'all'`. Day keys use the bot's
  time zone (Tehran for the Persian bots).
  - Stats screens never count by scanning growing tables.
- **Common keys:**
  - `users`, `users_new`, `users_active`, `users_blocked`
  - bot-specific job keys, such as `jobs_done`, `jobs_failed`, `jobs_done:<operation>`
- No content in stats: no message texts, file contents or names.

## 9. Privacy and data

- **Each bot states in `/privacy` exactly what it keeps and for how long:**
  - Telegram id, name, username, language
  - settings
  - file metadata for 24 h
  - job history for a set number of days
  - **never file contents and never message texts beyond the job they are for**
- `/deletemydata` deletes everything about the user except the ban flag.
- **Secrets** (API keys, worker/hub keys):
  - Kept in the bot's `secrets` table through the owner-only `/secret set NAME value`. The command
    message is deleted at once and values are never shown, logged or traced.
  - Never in code, git, logs or error rows.
- **Third-party services** a feature sends data to (e.g. Google Gemini for OCR) are named in
  `/privacy`. The user agrees once before the first use, with wording that matches the provider's
  current terms.

---

## 10. Wanger Hub API v1 (contract)

An HTTPS service (port 443), JSON, run by the owner. It is tiny, so it can share the machine that
runs the converter's worker (see `bots/converter/docs/HOSTING.md`). It stores the ecosystem lists
(channels, global bans, maintenance, per-bot settings), receives events, and holds broadcast jobs.

**It never checks membership.** That needs each bot's own token and admin rights, so bots keep doing
§3 themselves with the channel list the Hub gives them.

### 10.1 Authentication
- Each bot has its own `HUB_KEY` (≥ 32 random characters), issued by the Mother Bot, and stores
  `HUB_URL` + `HUB_KEY` with `/secret`.
- **Headers on every request:**
  - `X-Wanger-Bot: <bot username>`
  - `X-Wanger-Timestamp`
  - `X-Wanger-Nonce` (16–64 `[A-Za-z0-9_-]`)
  - `X-Wanger-Signature = hex(HMAC-SHA256(HUB_KEY, "{ts}.{nonce}.{METHOD}.{path?query}." + body))`
- The signature scheme is identical to the converter worker's (`bots/converter/worker/app/security.py`).
- **Accepted only if:**
  - the timestamp is within ±300 s;
  - each nonce is used once;
  - the comparison is constant-time.
- Unknown bot or bad signature → `401 {"error": "..."}`.

### 10.2 `GET /v1/config`
```json
{ "version": 17,
  "channels": [{ "chat_id": -1002407928564, "username": "HIDE_i_SEEK", "title": "HIDE & SEEK", "enabled": true }],
  "gate": { "failure_mode": "open", "pass_ttl_s": 300 },
  "maintenance": { "global": false, "bot": false },
  "settings": { "MAX_INPUT_MB": 20 },
  "links": [{ "key": "music", "username": "Wange_Musicbot" }] }
```
- **Caching in the bot:** 5 minutes, refreshed by one update at a time (claim, then fetch). A changed
  `version` invalidates join passes.
- **Hub down:** the bot keeps the last good config; with none, it uses its local lists. **Fail open:**
  it never locks users out because the Hub is down.
- `settings` overrides the bot's limits key by key (numbers only; unknown keys ignored). This is spec
  v2's `settings_json`.

### 10.3 `GET /v1/gate?user_id=<id>`
`{ "banned": false, "ban_reason": null }`. This is the global ban list.
- Asked only when the bot's cached answer for that user is older than 10 min.
- Hub down → treated as not banned. The local ban list still applies.

### 10.4 `POST /v1/events`
```json
{ "events": [ { "type": "job.completed", "at": 1794126856, "user_id": 123, "data": { "op": "img.cv", "ms": 745, "in": 638, "out": 198 } } ] }
```
- **Batching:** ≤ 100 events per request.
- **Buffering:** the bot buffers events in its own table and flushes them in batches on traffic (no
  timers).
- **At-least-once:** the Hub de-duplicates by `(bot, event id)`, so a bot adds `"id"` (ULID) to each
  event.
- **Types:**
  - `user.new`, `user.blocked`, `user.unblocked`, `user.deleted`
  - `job.queued`, `job.completed`, `job.failed`, `job.cancelled`
  - `gate.channel_broken`, `error`
- **No content:** no texts, file contents or file names.
- **Worker events:** the converter worker emits the same `job_event` records and can post them
  directly with its own key.

### 10.5 Broadcast
- `GET /v1/broadcasts/pending` →
  `[{ "id": 5, "source_chat_id": <broadcast channel>, "source_message_id": 42, "segments": ["all"] }]`
- `POST /v1/broadcasts/{id}/progress` with `{ "sent": 120, "failed": 2, "blocked": 7, "done": false }`
- The bot runs it with its own §7 batching. Only one broadcast per bot at a time.

### 10.6 Errors and limits
- `400` bad request, `401` auth, `404` unknown, `429` with `retry_after`, `5xx`.
- Bots back off on `429`/`5xx` and never retry reads synchronously, because of the dead-host cost in §2.

## 11. The Mother Bot

A Serverless bot for the owner and ecosystem admins. It talks only to the Hub (HTTPS, its own key).

- **Bots:** each bot's last event, version and health, and "events stopped" alerts. It also issues and
  revokes `HUB_KEY`s and shows the `/secret set` lines to paste into the child bot.
- **Forced-join channel list:** add, remove, enable, and the failure mode. It shows each bot's
  reported admin status per channel (from `gate.channel_broken` events).
- **Global** bans and maintenance (global or per bot).
- **Broadcast:** to all bots or selected ones, through the broadcast channel (§7, §10.5).
- **Stats:** per bot and in total, from events.
- **Per-bot settings** (`settings` in §10.2).

## 12. `wanger-client`

A small pure-JS module vendored into each bot (e.g. `lib/vendor/wanger-client.js`; no `sdk`
import — the bot passes `fetch` and its DB helpers in). It contains:
- signing (§10.1, `crypto.subtle`);
- the config cache with claim-then-refresh and fail-open (§10.2);
- the ban cache (§10.3);
- the event buffer and flush (§10.4);
- the gate provider interface `check(ctx) → { pass, missing }`, with two providers: `local` (today)
  and `hub`.

**CI check:** the vendored file is byte-identical in every bot.

## 13. Moving a bot from local to Hub

1. **Mother Bot:** «➕ ربات» issues the key and shows two lines.
2. **Child bot (owner, private chat):**
   ```
   /secret set HUB_URL https://hub.example.com
   /secret set HUB_KEY …
   ```
3. **Child bot:** `/connect` checks a signed `GET /v1/config` and shows the result.
   - From then on, the channel list, global bans and maintenance come from the Hub.
   - Local lists remain the fallback.
   - The local panel shows them read-only with «🧠 مدیریت در بات مادر».
4. **Undo:** `/secret del HUB_KEY` returns the bot to the local provider at once.

## 14. Working rules for building Wanger bots

- **Persian first.**
  - `fa` is the default, `en` is the second language, and both have the same keys (tested).
  - Persian digits and Jalali dates follow the user's setting.
  - Invisible characters (ZWNJ, bidi) are written as escapes in code.
- **One folder = one tgcloud project.**
  - Run the CLI only with that bot's own token variable (e.g. `npm run tg -- …` in
    `bots/converter/`).
  - Never touch another bot's folder.
- **Phases.** Each project has a spec with phases.
  - After each phase: tests green, docs updated (`PROGRESS`, `DECISIONS`, `LIMITS`), deploy, and a
    **complete report in Persian** to the owner covering what was done, what wasn't and why, problems
    found and fixed, and what the owner must do. The report is also saved in `docs/reports/`.
  - The owner decides whether to wait between phases. The standing instruction of 2026-11-07 for
    Wanger Converter is to continue through C8 and report after each phase.
- **Never without the owner:**
  - `push --force`
  - destructive migrations (drops)
  - anything that costs money or needs the owner's accounts or credentials — list those in the report
- **Secrets:** see §9. A secret the owner pastes in chat goes straight into the bot's `secrets` table
  and nowhere else.
- **Tests:**
  - local SDK emulation (unit + end to end)
  - a query-plan guard: no full scans of growing tables
  - `callback_data` ≤ 64 bytes
  - i18n parity and valid Telegram HTML
- **Platform measurements** go into the bot's limits document before a design depends on them.

## 15. Open questions for the owner

1. **Hosting:** host the Hub together with the converter worker (one VM), or separately?
2. **Global bans:** should global bans also hide a user from bots where they never misbehaved
   (default: yes, a global ban is global)?
3. **Failure mode:** stay **open** everywhere (current behaviour), or should some bots be **closed**?
4. **Broadcast channel:** create a private «Wanger broadcast» channel and add every bot as admin
   (needed for §7 in the Hub era).
