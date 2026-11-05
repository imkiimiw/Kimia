Wanger Music — Master Build Prompt for Claude Code (v2)
5 Nov 2026 · @Kimi
0. How to work with this spec (read first)
You are the lead architect and senior engineer for Wanger Music, a production-grade Telegram music bot (working username @WangerMusicBot). This document is the single source of truth; follow it one phase at a time.
1. Before anything else, save this whole document verbatim as docs/SPEC.md. In later sessions I will only say “implement Phase N”: re-read docs/SPEC.md and docs/PLATFORM_NOTES.md first.
2. Create a short CLAUDE.md at the project root. Its first line is @AGENTS.md (the agent guide the Telegram Serverless scaffold creates). Then at most ~40 lines: stack, exact commands, architecture rules, current phase, and “read docs/SPEC.md before each phase”. Details stay in docs/.
3. Work strictly one phase at a time (Section 13). When a phase is done: run all tests, update the docs, write the report (Section 15), then STOP and wait for my explicit command before the next phase.
4. At the start of a phase, post a short plan (files, schema changes, risks), then implement. Wait for me only if the plan changes this spec.
5. Ask me before you: add any dependency; change the platform or architecture; delete or rewrite working code; apply a migrate step marked warning or manual; use push --force; or do anything that posts to a real channel or messages real users. Never run npx tgcloud migrate --yes.
6. Never fake a feature. If something cannot work on this platform or API: say so, give the technical reason, build the closest valid alternative, and list it under Known limitations.
7. If this spec conflicts with the official Telegram docs (Bot API or Serverless), the official docs win. Record the conflict in docs/PLATFORM_NOTES.md and tell me.
8. Don’t over-engineer. Build only the current phase, but keep the interfaces later phases need.
1. Mission and scope
Wanger Music is a Telegram-native music platform with two jobs: instant search and delivery of music, and automatic publishing of new tracks to channels the owner configures.
• Search and delivery: users find tracks with inline mode (@WangerMusicBot <song or artist> in any chat) and in the bot’s private chat, and get the audio instantly.
• Automatic publishing: new tracks are routed to destination channels by rules, e.g. Channel A = Persian music, Channel B = English music, each with its own captions, schedule and optional approval.
• Languages: Persian and English first. The model must allow more channel types later (instrumental, rap, rock, electronic, regional) without rewriting the core.
• Catalog: built from Telegram-hosted audio (file_id) that the owner or admins add, or that arrives from authorized source channels. The bot never downloads music from the internet.
• Destination channels: NOT CONFIGURED. I will give them in Phase 5. Never invent channels. Never auto-publish anywhere until I add a channel and explicitly enable it.
Target pipeline (build the architecture around it):
1. Music source (manual import or source channel)
2. Track detection and metadata extraction
3. Normalization
4. Duplicate detection
5. Language classification
6. Track catalog
7. Routing to matching destination channels
8. Publication queue (with optional approval)
9. Publishing to the channel
Final principle: this becomes a scalable platform, not a toy — but build the foundation correctly first, and never build a future phase before the current one works.
2. Platform: Telegram Serverless (fixed decision)
The bot runs entirely on Telegram Serverless (official docs): no VPS, no other cloud, no separate database.
Known facts (official docs, October 2026, CLI 0.2.0)
• Code is plain JavaScript ES modules inside tgcloud/: handlers/ (flat, one file per Telegram update type), lib/ (shared code, subfolders allowed), schema.js (one file, all tables) and endpoints/ (functions a Mini App calls). Only .js files in these places are deployed.
• A module may import only sdk (sdk/db, sdk/api, sdk/fetch) and other project modules by relative path ending in .js. No npm packages, no Node built-ins (Buffer, fs, process.env), no build step.
• A handler gets the update payload (e.g. a Message) as its first argument and ctx (with ctx.update, including update_id) as its second. An update type is delivered only if its handler file exists. The platform manages the webhook and allowed_updates; check with npx tgcloud webhook, fix with npx tgcloud webhook sync.
• Bot API: api.<method>({ snake_case params }), result unwrapped. Failures throw BotApiError with .code, .description, .method and .parameters (e.g. retry_after). The bot token never appears in our code.
• Files: upload with InputFile (50 MB max, photos 10 MB); download with api.getFileContent / api.getFileStream (20 MB max). Outbound HTTP via the SDK fetch (response 30 MB max).
• Database: SQLite-backed, one per bot; Drizzle-like schema DSL and query builder from sdk/db; raw SQL via db.run/all/get/values with the sql tag. onConflictDoUpdate, .returning(), unique, partial and expression indexes, and CHECK constraints work.
• Foreign keys are disabled and cannot be declared: enforce integrity in code. Multi-row inserts are capped by SQLite’s variable limit, so chunk them. Prefer multi-row statements over write loops.
• npx tgcloud push deploys code but never touches the database; npx tgcloud migrate applies schema changes after confirmation. To drop a table or column, mark it .deprecated() first; type changes are manual.
• npx tgcloud run <module> '<json5 payload>' [--ctx '<json5>'] runs local code on the platform without deploying. Assume it uses the bot’s real database.
• Logs: console.* (shown by tgcloud run). CLI credentials live in .tgcloud/ (git-ignored, never commit); CI uses the TGCLOUD_TOKEN environment variable.
Verify before writing Phase 1 code. Read AGENTS.md, docs/tgcloud-sdk.md and the official page, then answer each item in docs/PLATFORM_NOTES.md, or mark it unknown. Never guess.
1. Execution limits per invocation (time, CPU, memory) and concurrency.
2. Whether module-level variables survive between invocations.
3. Transactions or atomic batches in db.
4. Whether FTS5 full-text tables can be created and used.
5. Any native scheduler, cron or delayed execution.
6. Any config, secret or environment-variable mechanism.
7. What happens when a handler throws (retried? where logged?) and how to see production logs.
8. Availability of Web Crypto (crypto.getRandomValues) and Intl time zones.
Consequences already built into this spec: all important state lives in the database (in-memory caches are best-effort only); no cron is assumed, so background work runs through the tick mechanism (10.7); and pure logic never imports sdk, so it can be unit-tested locally with Node’s built-in test runner.
3. Telegram facts and hard limits
Design around these Bot API facts; several architecture choices below depend on them.
• Membership: getChatMember on a channel is reliable only when the bot is an admin there. Member = creator, administrator, member, or restricted with is_member: true. Not a member = left, kicked, or restricted with is_member: false.
• Channels: bots cannot read channel history. They receive channel_post only from channels where they are admins. No userbots or MTProto in this project.
• Inline setup: enable inline mode in @BotFather (/setinline); chosen_inline_result updates need /setinlinefeedback.
• Inline answers: at most 50 results; result id and next_offset at most 64 bytes; cache_time; is_personal; button (InlineQueryResultsButton with start_parameter, 1–64 chars of A-Z a-z 0-9 _ -). Answer within a few seconds or Telegram drops the answer.
• Audio results: InlineQueryResultCachedAudio shows the title, performer and thumbnail stored in the audio file itself; they can’t be overridden per result. A new cover or title means re-uploading the audio (download 20 MB max, upload with thumbnail, title, performer). thumbnail is ignored when sending by file_id.
• File ids: file_id belongs to this bot only (another bot can’t use it); use it to send. file_unique_id is stable over time and across bots but can’t send; use it as the primary duplicate key. No content hash exists without downloading the file.
• Sizes: message text 4096 chars; media caption 1024 chars; callback_data 1–64 bytes.
• Untrusted input: treat callback_data and /start payloads as untrusted (modified clients can send anything).
• Formatting: parse_mode: 'HTML' everywhere, and escape every dynamic value (&, <, >). No MarkdownV2.
• Rate limits (Bot FAQ guidance): about 1 message/s per chat, 20 messages/min per group or channel, 30 messages/s overall for bulk sends. On 429, wait parameters.retry_after — never retry sooner.
• Forwards: read forward_origin (MessageOriginChannel gives chat and message_id; user origins can be hidden). Protected content can’t be forwarded.
• my_chat_member: tells when a user blocks or unblocks the bot (private-chat status kicked / member) and when the bot is added, promoted or removed in a channel.
• Errors to expect: sending to a user who blocked the bot → 403 (mark them blocked). Editing a message with identical content → 400 “message is not modified” (treat as success). Always call answerCallbackQuery, also on errors and denials.
• IDs: Telegram ids fit in 52 bits, so they are safe as JS numbers and SQLite INTEGER. Channel ids are negative (-100…). Usernames change, so always store the numeric chat_id.
4. Configuration
These are the starting values; nothing is hard-coded outside the config module.
Setting
Initial value
Owner Telegram ID
5557901897
Bot username
WangerMusicBot (confirm the real one with me)
Force-join channels (seed)
@HIDE_i_SEEK, @Nepenthw_ir, @wangerBots — max 10
Destination channels
none (Phase 5)
Source channels
none (Phase 4)
Default UI language
Persian (fa); English (en) available
Schedule time zone
Asia/Tehran
Force-join failure mode
open (see 7.3)
Membership cache TTL
10 minutes
The platform has no .env, so the original “.env” requirement becomes:
• tgcloud/lib/config/static.js — the only place for static values (owner ID, username, seed lists, defaults, limits).
• settings table — runtime values I edit in ⚙️ Settings, read through SettingsService with defaults from static config.
• force_join_channels table — the source of truth after the first seed. Seed only when the table is empty, so later edits are never overwritten.
• Secrets: the MVP needs none, because the platform authenticates Bot API calls itself. If a later provider needs an API key, use the platform’s secret mechanism if one exists; otherwise a git-ignored tgcloud/lib/config/secrets.js, with a committed example outside tgcloud/. Never commit .tgcloud/ or any token.
• docs/CONFIG.md replaces .env.example: every key, its default and where it lives.
5. Architecture and project layout
Layers depend downward only: handlers → services → repositories → sdk.
• Handlers (tgcloud/handlers/*.js) are thin: parse the payload, call one service, render the reply.
• Services hold all business logic and know nothing about the update format.
• Repositories hold all SQL. No SQL anywhere else.
• Pure modules — normalization, language classifier, caption renderer, routing rules, callback codec, i18n, permission map, backoff math, HTML escaping — import nothing from sdk. A guard test enforces this.
• Dependency injection: lib/core/context.js builds repositories and services from sdk once per invocation and passes them down, so services can be tested with fakes.
Per-update flow, inside one error boundary: dedupe (side-effect updates only) → upsert user (throttled) → ban check → force-join gate (normal users) → route (command, text, callback or flow step) → service → render → optional small tick (never on inline_query).
Layout (adapt names to the scaffold if needed, but keep the separation):
wanger-music/
├─ tgcloud/
│  ├─ schema.js
│  ├─ handlers/    message.js, callback_query.js, my_chat_member.js   (Phase 1)
│  │               inline_query.js, chosen_inline_result.js           (Phase 3)
│  │               channel_post.js                                    (Phase 4)
│  ├─ endpoints/   opsTick.js  (owner-only background tick, see 10.7)
│  └─ lib/
│     ├─ config/       static.js (+ secrets.js only if ever needed, git-ignored)
│     ├─ core/         context, errors, logger, ids, time, version
│     ├─ telegram/     send/edit/answer helpers, error classification, html, limiter
│     ├─ bot/          router, commands, callback codec, keyboards, flows, middleware
│     ├─ i18n/         fa.js, en.js
│     ├─ permissions/  users/  forcejoin/  admin/  settings/  audit/  alerts/  broadcast/
│     ├─ music/        providers/ ingestion/ normalization/ duplicates/ classification/ search/ catalog/
│     ├─ publishing/   sources/ destinations/ routing/ approval/ captions/ worker/
│     ├─ jobs/         tick runner + processors
│     ├─ stats/
│     └─ repositories/
├─ tests/        unit/ (node --test), fixtures/updates/*.json5, smoke/ (tgcloud run scripts)
├─ scripts/      stamp-version, smoke runners
├─ docs/         SPEC.md, PLATFORM_NOTES.md, ARCHITECTURE.md, ROADMAP.md, CONFIG.md
├─ .github/workflows/tick.yml   (only if the tick fallback is needed, see 10.7)
└─ AGENTS.md, CLAUDE.md, README.md, tgcloud.jsonc, package.json, .gitignore
Each handler file subscribes the bot to that update type, so add a handler only in the phase that needs it, then run npx tgcloud webhook sync.
6. Data model
This is the target schema; create each table only in the phase that needs it.
Conventions: integer primary keys; a random public_id (8–10 chars, A-Z a-z 0-9) wherever an id is shown to users (inline result ids, deep links); unix-second timestamps; enums as TEXT with CHECK; JSON columns for flexible config. No foreign keys: services create parents first, delete children first, and a maintenance job sweeps orphans.
Phase 1
• users: id, telegram_id UNIQUE, username, first_name, language_code, ui_language, role (user/admin), is_banned, is_blocked, force_join_ok_until, created_at, last_seen_at (written at most every 10 min). The owner is not a role: owner = the static owner ID, always full access, cannot be demoted.
• force_join_channels: id, chat_id UNIQUE, username, title, invite_link, enabled, sort_order, last_check_status (ok/bot_not_admin/not_found/error), last_checked_at, created_at, updated_at. Max 10 rows (service rule).
• settings: key PK, value (json), updated_at, updated_by.
• audit_log: id, actor_id, action, target_type, target_id, details (json), created_at.
• user_flows: user_id PK, flow, step, data (json), expires_at.
• processed_updates: update_id PK, created_at (pruned after 48 h).
• error_log: id, created_at, handler, update_id, user_id, code, message, stack (truncated), context (json).
• alerts: key PK, last_sent_at, count.
• broadcasts: id, created_by, source_chat_id, source_message_id, status (draft/running/paused/done/cancelled), cursor_user_id, total, sent, failed, blocked, created_at, started_at, finished_at.
Phase 2
• tracks: id, public_id UNIQUE, title, artist, featured_artists, album, version, duration, genre, language (fa/en/other/unknown), language_confidence (high/medium/low), language_source (manual/source/artist/heuristic), audio_file_id, audio_file_unique_id UNIQUE, mime_type, file_size, file_name, cover_file_id, normalized_title, normalized_artist, dup_key, source_type (manual/telegram_channel/provider), source_id, origin_chat_id, origin_message_id, status (draft/active/hidden/removed), added_by, play_count, archive_message_id, created_at, updated_at, activated_at.
• Indexes on tracks: dup_key; (status, activated_at); UNIQUE (origin_chat_id, origin_message_id) where both are not null.
Phase 3
• track_terms: term, track_id, PRIMARY KEY (term, track_id).
• artists: id, name, normalized_name UNIQUE, language, created_at. artist_aliases: alias_normalized PK, artist_id.
Phase 4
• sources: id, source_type (telegram_channel), chat_id UNIQUE, username, title, default_language, enabled, auto_import (off/draft/active), last_post_at, imported_count, created_at, updated_at.
Phase 5
• destination_channels: id, chat_id UNIQUE, username, title, enabled (default 0), auto_publish (default 0), approval_required (default 1), rules (json: languages, genres, exclude_genres, min_language_confidence), caption_template, post_format (audio/cover_then_audio), min_interval_seconds, active_hours (json), daily_limit, time_zone, bot_rights_ok, last_published_at, created_at, updated_at.
Phase 6
• publications: id, track_id, channel_id, UNIQUE (track_id, channel_id), status (pending_approval/queued/sending/published/failed/rejected/uncertain/cancelled), attempt_count, last_error, next_attempt_at, locked_until, telegram_message_id, decided_by, decided_at, published_at, created_at, updated_at. Index: (status, next_attempt_at).
Phase 7
• stats_daily: date, metric, dimension, value, PRIMARY KEY (date, metric, dimension).
7. Bot core
The core gives every user a clean force-join gate and gives the owner full control from the bot’s private chat.
7.1 Users
• Upsert the user on private-chat activity (throttled writes). Keep is_blocked current via my_chat_member and 403 errors.
• Banned users get one short notice on /start and are ignored otherwise.
7.2 Roles and permissions
• One PermissionService; no if (userId === …) checks anywhere else.
• Owner (static owner ID): everything; cannot be removed.
• Admin (DB role) defaults: catalog.manage, approvals.review, stats.view.
• Owner-only by default: admins.manage, forcejoin.manage, destinations.manage, sources.manage, broadcast.send, settings.manage, users.ban.
• Every admin command, callback and flow step re-checks permission on the server. A visible button is never authorization.
• Admin features work only in the bot’s private chat.
• The owner adds, removes and lists admins (by numeric ID, or a forwarded message when the origin isn’t hidden). Command menus are scoped with setMyCommands: default scope for users, chat scope for the owner and each admin, refreshed when admins change.
7.3 Force-join
• Applies to normal users in private chat and in inline mode; the owner and admins bypass it (setting).
• Check all enabled channels in parallel with getChatMember. Store a pass in users.force_join_ok_until (TTL setting). Never cache a failure. Bump a forcejoin_version setting on any list change; this invalidates all passes.
• Not a member: no music. Send one message in friendly Persian, e.g. «برای استفاده از ربات، اول عضو این کانال‌ها شو 👇», with one URL button per missing channel (https://t.me/<username>, or the stored invite link for private channels) and «✅ عضو شدم» (fj:check).
• On «✅ عضو شدم»: re-check without cache. Still missing → edit the message to list only the remaining channels and show a short toast. All joined → unlock and continue what the user originally wanted (keep the original /start payload in the flow state).
• Errors per channel: bot not admin or chat not found → save last_check_status, alert the owner (at most once per hour per channel), and apply the failure mode: open (default: skip that channel) or closed (treat as not joined). Transient errors (429, 5xx, timeout) → one quick retry, then the failure mode. Never crash.
• Inline mode: a user who hasn’t passed gets no results, is_personal: true, cache_time: 0, and a button «🔒 اول عضو کانال‌ها شو» with start_parameter: 'join'.
• Management (owner only, private chat, 🔐 Force Join): list with health status; add by @username, numeric ID or a forwarded post (resolve with getChat, store the numeric id and title, check the bot is admin, otherwise explain the fix); remove (with confirmation); enable or disable; reorder; set an invite link. Max 10 channels.
7.4 Commands and user experience
• All user-facing text lives in lib/i18n — natural, friendly Persian by default; English via /lang.
• /start [payload]: welcome and how-to. Payloads: join, search, t_<publicId> (send that track). Anything else = plain start.
• /search <query>, or any plain text in private chat, runs a search (Phase 3): up to 10 result buttons with pagination (s:get:<publicId> sends the audio by file_id) and a «🔎 جستجوی اینلاین» button (switch_inline_query_current_chat).
• /help, /lang, /cancel (leaves any flow). /admin works only for admins; others get the normal unknown-command reply, so admin features stay invisible.
• /music from the old draft is merged into /search and inline mode.
7.5 Admin panel (/admin, inline keyboards, private chat only)
• Main menu: 🎵 Music · 📡 Sources · 📢 Destination Channels · 🔐 Force Join · 👥 Users · 📣 Broadcast · 📊 Statistics · ⚙️ Settings · 🧪 System Status. Sections not built yet say «در فاز N اضافه می‌شود» — an honest placeholder.
• callback_data codec: <ns>:<action>[:<arg>…], at most 64 bytes, validated per route. Stale or invalid data → «این منو منقضی شده؛ دوباره /admin را بزن».
• Multi-step input uses persisted user_flows (expires after 15 min; /cancel). Destructive actions need a confirm step. Long lists paginate. Every change writes audit_log.
• 👥 Users: totals (all, active 24 h / 7 d, blocked), look up a user by id or username, ban or unban, list and manage admins.
• ⚙️ Settings: default UI language, force-join failure mode and TTL, inline page size and cache time, tick interval, digest interval, time zone, archive channel, and “sync bot commands”.
• 🧪 System Status: getWebhookInfo (pending updates, last error), a DB round-trip time, counts (users, tracks, pending and failed publications), the last tick (time and trigger), force-join and destination channel health, the last 5 errors, the deployed version (lib/core/version.js, stamped by the deploy script) and a «▶️ اجرای تیک» button.
7.6 Broadcast (owner only, 📣)
• The owner sends or forwards any message inside the broadcast flow → preview → confirm → a broadcasts row is created.
• Delivery uses copyMessage from the owner’s chat to each non-blocked, non-banned user, in batches run by the tick (10.7), within rate limits and honoring retry_after. A 403 marks the user blocked.
• One progress message with Pause, Resume, Cancel and «▶️ ادامه» (runs the next batch now). Final report: sent, failed, blocked.
8. Music catalog
Phase 2 builds a clean, duplicate-free catalog of Telegram-hosted audio with good metadata.
8.1 Manual ingestion
• An admin sends or forwards an audio message to the bot in private chat (outside other flows; no command needed). Store file_id, file_unique_id, duration, performer, title, file name, MIME type, size and thumbnail; from forward_origin keep the origin chat and message id.
• A document or voice instead of audio → reply that it must be sent as music. (Converting needs a re-upload, 20 MB max; optional later.)
• Missing title or artist → parse the file name (“Artist - Title”), else ask in the import card.
• Import card to the admin: parsed metadata, detected language and confidence, any duplicate warning, and buttons ✅ Activate · ✏️ Title · ✏️ Artist · ✏️ Album · 🌐 Language · 🏷 Genre · 🖼 Cover · 🗑 Discard.
• Bulk: many forwards in a row produce one compact summary (created, duplicates, need review) instead of one card each (setting).
• Optional archive: if archive_chat_id is set (a private channel where the bot is admin), copy every activated track there and store archive_message_id. It is a browsable backup and a recovery path, because file_ids belong to this bot only.
• Optional re-upload with a new cover or tags: download (20 MB max), send it again with thumbnail (JPEG, under 200 kB, max 320 px) to the admin chat, then keep the new file_id and file_unique_id. Document the limits.
8.2 Normalization (pure module, heavily tested)
• Two outputs: display (clean, human-readable) and key (aggressive, for matching).
• Persian/Arabic: ي ى→ی, ك→ک, ة→ه, ۀ→ه, ؤ→و, ئ→ی, and in keys أ إ آ→ا. Remove diacritics (U+064B–U+065F, U+0670) and tatweel (U+0640). Turn ZWNJ, ZWJ and bidi marks into spaces, and also produce a space-free variant. Convert Persian and Arabic-Indic digits to ASCII.
• Latin: NFKC, lowercase, strip accents, &→and.
• Strip noise (list kept in config): @channel mentions, URLs, emojis, (Official Audio/Video/Lyrics), bitrate tags (128, 320, kbps, HQ), «دانلود آهنگ», «با کیفیت …», «کانال …», track numbers in file names.
• Keep version markers as data in version, because they change identity: remix, live, acoustic, unplugged, instrumental, cover, slowed/reverb, sped up, remaster, ریمیکس, لایو, بی‌کلام.
• Split featured artists (feat., ft., featuring, x, &, و) into featured_artists; normalized_artist is the primary artist.
8.3 Duplicate detection
• Hard duplicate (blocked): same audio_file_unique_id, or same origin chat and message id.
• Soft duplicate (flagged, never auto-deleted): same dup_key (normalized artist + title + version) and duration within 3 s. The admin picks keep both, replace, or discard.
• Examples: “blinding lights” / “the weeknd” equals “Blinding Lights” / “The Weeknd”; “Song (Remix)” is not “Song”.
8.4 Language classification (deterministic; no AI in the MVP)
• Priority: manual (high) > source default (high) > artist hint (high) > script heuristic.
• Heuristic: Persian-specific letters (پ چ ژ گ) or other Arabic-script text → fa, medium. Latin only → en, low (it may be Persian written in Latin letters). Mixed or empty → unknown.
• Store language, confidence and source. unknown and low-confidence tracks never auto-publish without approval (10.3). Keep the classifier behind an interface so a better one can replace it.
8.5 Providers
• MusicProvider interface (JSDoc): id, capabilities { search, metadata, cover, audio: 'telegram_file' | 'none' }, search(query), getTrack(ref), getMetadata(ref), getCover(ref).
• MVP provider: catalog (our database; audio = Telegram file).
• External providers come later, for metadata and covers only, via official APIs whose terms allow it, called through the SDK fetch with timeouts. A result without deliverable audio is never offered as playable.
• Keep metadata retrieval, audio availability and audio delivery separate.
8.6 Removal (takedown)
• An admin can hide or remove a track: it leaves search, inline and routing at once, and its pending or queued publications are cancelled.
• Optionally delete its channel posts with deleteMessage (Telegram limits apply; report failures).
• Removed tracks stay in the database so their duplicates stay blocked, unless the owner purges them.
8.7 Track management (🎵 Music)
• List with filters (status, language, needs review), search, a track card (edit, change status, see its publications) and counts.
9. Search and inline mode
Phase 3 makes @WangerMusicBot <query> return correct, playable results fast, from the local catalog only.
• Search covers status = active tracks only. No external calls in the inline path.
• Index: track_terms holds normalized terms of title, artist, album and aliases, plus a space-free variant of title and artist.
• Query: normalize; max 64 chars and 5 tokens. Every token must match; the last one by prefix, using an index-friendly range or GLOB query — never a %…% scan. If FTS5 exists and measures better, it may replace this; document the decision.
• Ranking: exact title or artist match, then prefix match; ties by play count, then recency.
• Inline answer: InlineQueryResultCachedAudio with id = public_id, the audio_file_id, and an optional caption from a global inline template. 20 results per page via next_offset.
• Always is_personal: true, so Telegram’s shared cache can’t leak results to users who haven’t passed force-join. cache_time comes from settings (default 60 s).
• Empty query → popular and newest tracks. No results → an empty list plus a button «🔎 جستجو در ربات» (start payload search).
• chosen_inline_result → increment play_count and stats.
• Performance target: inline handler p95 under 800 ms, measured with tgcloud run timings on staging. Never wait on slow work in this path, and never run a tick here.
• Caching: Telegram’s per-user cache (cache_time); an optional in-memory LRU only if module state survives (Section 2); a DB cache table only if measurements show a need. Activating or removing a track bumps catalog_version, which is part of every cache key.
• Deep link t_<publicId> sends that track in private chat (for sharing and for channel captions).
• Must pass (tests): ي/ی and ك/ک match; «می‌خوام» = «میخوام» = «می خوام»; ۲ = 2; week finds “The Weeknd”; «شادمهر» finds «شادمهر عقیلی»; the alias shadmehr finds the Persian-script artist; removed tracks never appear.
10. Publishing system
Phases 4–6 move new tracks from authorized sources to the right channels exactly once, within Telegram’s limits.
10.1 Sources (Phase 4)
• A source is a Telegram channel where the bot is admin and that I’m allowed to use. Add it by forward, @username or id (resolve and verify admin rights). Settings: enabled, default language, auto_import (off, draft, active).
• A channel_post with audio from an enabled source runs the ingestion pipeline (normalize, dedupe, classify, create a draft or active track). It never publishes; routing does that in Phase 6.
• Posts from unregistered channels are ignored. When the bot is added to a channel (my_chat_member), message the owner with buttons: Source · Destination · Force-join · Ignore.
• Document the limits: no history import (only posts after the bot became admin) and no channels without admin rights.
10.2 Destination channels (Phase 5)
• Add (owner): forward a post, or send @username or id → getChat → verify the bot is admin with can_post_messages (recommend edit and delete rights for takedowns) → store the numeric chat_id.
• New channels start disabled, with auto-publish off and approval on.
• Editable: title refresh; rules (languages, genres, excluded genres, minimum language confidence); caption template; post format (audio or cover_then_audio); schedule (minimum interval, active hours, daily limit, time zone); approval on/off; enable or disable; remove (with confirmation; history is kept).
• Health: a my_chat_member change, or a 400/403 such as “chat not found” or “not enough rights”, marks the channel unhealthy, disables publishing and alerts the owner.
10.3 Routing (Phase 6)
• Generic rule engine: a track matches a channel when the channel is enabled with auto-publish on, the track is active, and the rules match (language in the list, genre filters, language confidence at or above the channel’s minimum).
• When a track becomes active, create publication rows for matching channels with INSERT … ON CONFLICT (track_id, channel_id) DO NOTHING, so routing is idempotent.
• No backfill: tracks activated before a channel was enabled are never queued automatically. Backfill happens only through an explicit owner action with a preview and a count.
• Initial status: pending_approval when the channel requires approval or the track’s confidence is below the channel’s minimum; otherwise queued.
10.4 Approval (Phase 6)
• Pending items trigger a throttled digest to reviewers (e.g. «۱۲ آهنگ منتظر تأیید» with a Review button), never one message per track.
• Review screen: the audio (by file_id), the target channel, the rendered caption, and ✅ Approve · ❌ Reject · ⏭ Next.
• Decisions are conditional updates (WHERE status = 'pending_approval'), so a double tap or two admins can’t approve twice; the second reviewer sees who already handled it.
10.5 Captions
• Per-channel template. Variables: {title} {artist} {album} {duration} {language} {genre} {source} {artist_tag} (#Artist_Name, ZWNJ removed) {bot_link} (deep link to the track).
• Default template:
🎵 {title}
👤 {artist}
💿 {album}
⏱ {duration}
• Escape values for HTML. Drop any line whose variables are all empty. Keep the result within 1024 chars (truncate title or album with “…” if needed).
• Validate a template on save by sending a rendered preview to the owner; reject it on a Telegram parse error.
10.6 Publishing worker (Phase 6)
• Picks due queued publications while respecting each channel’s minimum interval, active hours (in the channel’s time zone) and daily limit, plus the global telegram_cooldown_until.
• Claims atomically in one statement: UPDATE publications SET status='sending', locked_until=…, attempt_count=attempt_count+1 WHERE id IN (SELECT … LIMIT n) AND status='queued' RETURNING *.
• Sends sendAudio (by file_id, HTML caption); for cover_then_audio, sendPhoto with the cover first. Success → published, store telegram_message_id and published_at, and update the channel’s last_published_at.
• Error handling (central, in lib/telegram/errors.js):
    ◦ 429 → back to queued, next_attempt_at = now + retry_after, and set the global cooldown.
    ◦ 5xx, network error, or timeout before any response → queued with exponential backoff and jitter (1, 2, 4, 8, 16… min, capped at 60 min); after 6 attempts → failed.
    ◦ 400/403 channel errors (chat not found, not enough rights, bot kicked) → failed, disable the channel, alert the owner.
    ◦ 400 file errors (wrong file identifier) → failed, flag the track for review.
    ◦ 400 caption or entity errors → failed, alert the owner (template problem).
• At most once: if a sending lease expires (the request may already have reached Telegram), mark the row uncertain and never resend automatically. The owner chooses «ثبت به‌عنوان منتشرشده» or «ارسال دوباره».
• Publication history is visible per track and per channel.
10.7 Background work without cron (built in Phase 1, reused in Phase 6)
• One runTick(trigger, budget) runs processors in order: maintenance (prune processed_updates, expire flows, release leases), a broadcast batch, a publication batch (Phase 6), and digests. Each stops at its time budget (a setting based on the verified execution limit) or its item cap.
• Trigger 1, piggyback: after handling message, callback_query, chosen_inline_result, channel_post or my_chat_member (never inline_query), run a tick if the last one is older than N seconds. One conditional UPDATE on the last_tick_at setting elects a single winner.
• Trigger 2, manual: the owner’s «▶️ اجرای تیک» and «▶️ ادامه» buttons.
• Trigger 3, scheduled: use a native scheduler if the platform has one. Otherwise add endpoints/opsTick.js, which accepts only ctx.initData.user.id === OWNER_ID, and a GitHub Actions schedule (default every 30 min) that runs npx tgcloud run endpoints/opsTick '{}' --ctx '{ initData: { user: { id: 5557901897 } } }' with TGCLOUD_TOKEN taken from the repo secret WANGER_MUSIC_TGCLOUD_TOKEN. The workflow must check out the deployed commit. Document this as a workaround, and mind GitHub Actions minutes on private repos.
• State the limitation plainly: scheduled posts, retries and broadcast batches run only when a tick happens, so their timing depends on traffic and the tick interval.
10.8 Rate limiting (central)
• Every outbound send goes through lib/telegram/. Bulk senders (broadcast, worker) share one limiter: at least 1 s between messages to the same chat, each channel’s minimum interval, per-tick caps, and the global cooldown after any 429.
• No sleep() calls scattered in code. Interactive replies never wait for long cooldowns.
11. Reliability, logging, security
Every update is handled safely and idempotently, and leaves a trace the owner can see from inside Telegram.
• Error boundary around every handler and endpoint: catch → structured log → error_log row → owner alert for severe errors (throttled per alert key, e.g. once per 30 min) → return normally, unless PLATFORM_NOTES.md shows platform retries are safe and useful.
• Update dedupe for side-effect update types: INSERT INTO processed_updates … ON CONFLICT DO NOTHING RETURNING; skip the update if nothing comes back.
• Idempotency: unique constraints and conditional status transitions everywhere; no read-then-write races on state.
• Structured logs: one JSON line per event via console, with ts, level, event, update_id, user_id, chat_id, track_id, channel_id, publication_id, status, duration_ms, error_code, error. Never log tokens, CLI credentials, raw updates or full user message text.
• Input safety: validate and length-limit commands, payloads, callback_data, flow input and templates. Parameterized SQL only (the sql tag binds values; no string concatenation). HTML-escape all dynamic output.
• Access: a permission check on every admin route; owner-only operations checked twice. .gitignore covers .tgcloud/, local secret files and node_modules/.
• Privacy: store only what’s needed; search analytics are aggregated, never per-user histories.
• Backups (Phase 8): an owner action exports core tables as JSON/CSV and sends them to the owner as a document (under 50 MB), optionally weekly via the tick; a documented restore script via tgcloud run; plus the optional archive channel for audio.
12. Testing
Every phase ends with all tests green, and the report shows the exact commands and their results.
• Unit tests: Node’s built-in runner (node --test), no dependencies. Cover pure modules, and services using in-memory fake repositories and a fake api that records calls and can throw BotApiError-like errors.
• Smoke tests: npx tgcloud run with JSON5 fixtures from tests/fixtures/updates/, on a separate staging bot only (its own Serverless project and database). Without a staging bot, ask me to create one, and run only read-only smoke tests on production.
• Guard test: fails if any pure module imports sdk.
Required cases (minimum):
• Authorization: the owner opens admin; a normal user can’t; an admin without a permission can’t; every registered admin callback route rejects a normal user (table-driven over the route registry); forged or stale callback_data is handled.
• Force-join: missing one channel; missing several; joined all; restricted with is_member; API error under failure mode open and closed; bot not admin → throttled owner alert; cache TTL and invalidation on list change; the inline gate returns the button with is_personal.
• Users and broadcast: a 403 marks the user blocked; batches respect caps; pause, resume and cancel work.
• Music: track creation; the normalization table (Persian/Arabic letters, ZWNJ, digits, diacritics, noise, version markers, featured artists); hard and soft duplicates; missing metadata, cover or audio; a document instead of audio.
• Inline: empty query; normal query; no results; pagination offsets; removed track excluded; non-member gate; query too long.
• Publishing: language routing; disabled channel; auto-publish off; no backfill; duplicate publication prevented; approval required; confidence below the minimum; 429 with retry_after; transient error with backoff; permanent error disables the channel; lease expiry → uncertain; caption rendering (escaping, dropped empty lines, the 1024 limit).
13. Phases and definition of done
A phase ends only when its “done when” checks pass; then stop and wait for my command.
Phase 1 — Core bot, background tick, broadcast
• Build: inspect or scaffold the project; PLATFORM_NOTES.md; config; i18n; router and callback codec; error boundary; logging; update dedupe; users; permissions and admin management; force-join with its full management UI (max 10, health, failure mode); /start /help /lang /cancel /admin; admin menu with placeholders; ⚙️ Settings (basic); 🧪 System Status; tick runner (piggyback, manual, opsTick); 📣 Broadcast; audit log; README (English, plus a short Persian quick-start), ARCHITECTURE, ROADMAP, CONFIG.
• Done when: deployed with push + migrate; a non-member gets the force-join message with 3 join buttons and «✅ عضو شدم»; after joining all three and tapping it, the bot unlocks; a channel where the bot isn’t admin follows the failure mode and alerts me (throttled); I can add, remove, disable and reorder force-join channels from private chat and changes apply immediately; only I can see and use /admin; a test broadcast to me and one test account shows progress and handles a blocked user; System Status shows real data; all tests pass.
Phase 2 — Music core
• Build: tracks schema; ingestion by send or forward; import card and bulk summary; normalization; duplicate detection; language classification (manual + heuristic); provider interface and catalog provider; 🎵 Music management; removal; optional archive channel.
• Done when: forwarding 10 audios creates 10 tracks with correct metadata; forwarding one again is rejected; a remix of an existing song is flagged, not blocked; editing and removal work; tests pass.
Phase 3 — Search and inline mode
• Build: track_terms index; search service; private-chat search with buttons; inline_query and chosen_inline_result handlers; pagination; empty and no-result behavior; inline force-join gate; deep links; caching per Section 9. My steps: @BotFather /setinline and /setinlinefeedback, then npx tgcloud webhook sync.
• Done when: @WangerMusicBot <query> returns correct audio results in any chat and sending works; the Section 9 examples pass; non-members get the join button; the p95 target is met on staging.
Phase 4 — Sources
• Build: channel_post handler; source management; import pipeline with dedupe and classification; the “bot added to a channel” prompt. No publishing.
• Done when: a new audio post in a registered source becomes a draft or active track per its settings; duplicates are skipped; unregistered channels are ignored.
Phase 5 — Destination channels
• Build: add, edit, enable, disable and remove, with bot-rights validation; rules; caption templates with preview; approval setting; schedule fields; health. I provide the real channels in this phase. Still no automatic publishing.
• Done when: I can add my real channels, configure them and preview captions, and nothing gets posted.
Phase 6 — Automatic publishing
• Build: routing; publication queue; worker on the tick; approvals; retries; rate limiting and cooldown; schedule windows; history; uncertain handling.
• Done when: with one channel enabled and auto-publish on, a newly activated matching track is posted exactly once; with approval on, it waits for me; a wrong-language track never reaches that channel; a simulated 429 or permanent error behaves as in 10.6.
Phase 7 — Analytics
• Build: stats_daily aggregation and the 📊 dashboard: users (total, new, active, blocked); searches (inline queries arrive per keystroke, so count only first-page queries of 3+ characters, or sample); chosen results; top tracks; publications per channel (published, failed, pending); source stats; force-join conversions.
• Done when: the dashboard numbers match direct database counts on staging.
Phase 8 — Production hardening
• Build: security and error-handling review; rate-limit review; index and query review; load test via scripted tgcloud run on staging; backup export and restore; monitoring (System Status alerts for webhook errors and rising failures); deployment and recovery docs.
• Done when: a restore from an export works on staging, and the review findings are fixed or listed as known limitations.
14. Development rules and out of scope
These rules apply in every phase; the out-of-scope list is a hard boundary.
Rules:
1. No runtime dependencies (a platform rule); dev dependencies only with my approval.
2. No giant files; one responsibility per module; clear names.
3. Thin handlers; business logic in services; SQL only in repositories; music-provider code isolated.
4. Pure modules never import sdk.
5. JSDoc types on every exported function; add // @ts-check and a jsconfig.json if SDK typings exist (or a minimal local .d.ts outside tgcloud/).
6. Validate all external input and handle every Bot API error path.
7. One place each for permissions, config, Telegram error classification and rate limiting.
8. Force-join channels, admins, sources and destination channels are database-driven.
9. Publishing is idempotent and at-most-once; retries are controlled.
10. Tests for every critical service; docs updated every phase.
Out of scope — do not build:
• Userbots or MTProto, scraping channels or websites, or reading chats where the bot isn’t admin.
• Downloading audio from YouTube, Spotify, SoundCloud or similar services, or bypassing DRM. Use only Telegram-hosted audio the owner is entitled to use; respect copyright and provider terms.
• Fake destination channels, any auto-publishing before I enable a channel, or automatic backfill.
• AI or LLM classifiers in the MVP.
• Infrastructure outside Telegram Serverless (the optional GitHub Actions tick is the only exception).
15. First task and report format
Start now with these steps, then implement Phase 1.
1. Inspect the current folder. If a project exists, keep working code and don’t overwrite anything blindly.
2. No Telegram Serverless project yet → run npm create @tgcloud/bot . (it never overwrites files), then npx tgcloud login. I will paste the CLI access token myself. Never ask for the bot API token.
3. Save this spec as docs/SPEC.md and create CLAUDE.md (Section 0).
4. Read AGENTS.md and docs/tgcloud-sdk.md, then write docs/PLATFORM_NOTES.md (the Section 2 questions).
5. Propose the final structure, the Phase 1 schema and any deviations; then implement Phase 1, run the tests and fix failures. Deploy only after my OK.
After every phase, report concisely under these headings, then STOP:
• Completed
• Files created / modified
• Platform findings
• Decisions and assumptions
• Dependencies
• Configuration (keys and defaults)
• How to deploy and run (exact commands)
• Manual steps for me (BotFather, Serverless, making the bot admin in channels, GitHub secret)
• Tests (commands and results)
• Known limitations
• Questions for me
• Next phase
