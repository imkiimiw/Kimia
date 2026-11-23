# Wanger News — Architecture

Status: **Phase 5** (operations: editorial rules engine, corrections, analytics and cost tracking,
source reliability learning, admin dashboard API) on top of Phase 4 (real time: 🔴 breaking, early
warning of growing topics, related stories, story timeline, daily brief) on top of Phase 3 (stories of one event across outlets, independent
sources, claims and evidence, contradictions, update posts), Phase 2 (AI: Persian summaries,
hallucination guard, review, main channel) and Phase 1 (foundation). This document describes what
exists, where every later feature plugs in, and why each decision was taken (ADRs at the end;
Phase 2 decisions are ADR-019 onwards, Phase 3 ADR-029 onwards, Phase 4 ADR-038 onwards, Phase 5
ADR-046 onwards).

## 1. Overview

```
                 config/*.yaml (sources, categories, filters, pipeline thresholds)
                                   │
 GitHub Actions cron ──► python -m wanger_news run-once ◄── Docker worker (option B)
                                   │
   ┌────────────────── services/pipeline.py (one pass, isolated stages) ──────────────────┐
   │ lock → sync → INBOX → INGEST → GATE → CLUSTER → AI → REVIEW → PUBLISH → TRENDS → BRIEF │
   └──────────────────────────────────────────────────────────────── → retention ───────────┘
   INBOX  : getUpdates → telegram_updates → admin commands · review buttons · edit replies ·
            source-channel posts · posts made by hand in the target channels
   INGEST : FETCH → PARSE → NORMALIZE → VALIDATE → DEDUPLICATE (L1, L2, L3-port)
   GATE   : rule-based category / priority / sensitive topics → ai_pending | filtered
   CLUSTER: EMBED → same event? (cosine + names + time) → story_clusters; role per report:
            lead · support · update · corroboration · human · external (L3 dedup)
   AI     : one multi-source SUMMARY per story (Persian; claims with per-source evidence,
            contradictions) → GUARD layer 1 + layer 2 (AI verify) → one REWRITE if needed →
            claims/evidence rows → scores → route: queued | pending_review | held
            UPDATE call for new independent reports of a published story → update post | corroboration
   REVIEW : cards with ✅ 📤 ✏️ ❌ in the admins' private chats
   PUBLISH: claim → send (sendPhoto/sendMessage/copyMessage[s]) → record; test or main channel;
            an update post is a reply to the story's last post; 🔴 first (hourly cap);
            related earlier stories linked; update posts list the story so far
   TRENDS : reports per story / name vs its own 24 h baseline → ⚠️ early warning (admins)
   BRIEF  : once a day (21:00 Tehran) the day's published titles, linked to their posts
   OPERATIONS: weekly reliability suggestions (owner applies) · monthly cost alert
   (rules.yaml applies inside CLUSTER and AI routing; corrections: cards → reply posts)
   API    : option B — FastAPI admin API over the same services (`python -m wanger_news api`)
                                   │
                 PostgreSQL (Neon/Supabase free tier) — ALL state lives here
```

The core (domain + services) does not know where it runs: the same `Pipeline.run_once` is the
GitHub Actions entrypoint (`run-once`) and the body of the long-running `worker`.

## 2. Layers (Ports & Adapters)

| Layer | Package | Rule |
|---|---|---|
| Domain (pure) | `domain/` — text, urls, fingerprint, keywords, classify, gate, quality, jalali, chatref, article, normalize, feed; summary, guard, scoring, editorial (Phase 2); similarity, independence, claims (Phase 3) | no I/O, fully unit-tested |
| Formatting (pure) | `formatting/` — Telegram HTML escaping/splitting, Persian templates | the only place output text is built and escaped |
| Ports | `ports.py` (Clock, FeedFetcher, BotApi, EventMatcher, MotherBot), `ai/provider.py` (AIProvider) | interfaces the services depend on |
| Adapters | `adapters/http` (SSRF guard, safe fetcher, robots.txt), `adapters/feeds` (feedparser), `adapters/telegram` (Bot API client, update models, post → draft), `db/` (SQLAlchemy models, repositories, engine) | all I/O |
| Services | `services/` — ingest, dedup, processing, publish, inbox, commands, health, targets, doctor, pipeline; ai_stage, posts, review (Phase 2); stories (Phase 3) | orchestration, depend on ports |
| Composition root | `runtime.py`, `cli.py` | the only places concrete adapters are built |

Adding a source never needs code (config/sources.yaml). A new transport (licensed API, a
Telegram channel, a scraper for a site that allows it) is a new adapter producing `ArticleDraft`s;
`Transport.API` / `Transport.SCRAPE` already exist and are refused while unimplemented.

## 3. Pipeline and statuses

Every stage reads its input from article statuses, so an interrupted run is continued by the
next one; `processing_jobs` records (article, stage) → done/failed/skipped, attempts, last error.

```
feed entry ─► (known external_id? skip) ─► stale | throttled | new ─► dedup? ─► duplicate
new ─► classify+gate ─► ai_pending | filtered
ai_pending ─► cluster: new story (lead) | joins a story:
   story not summarised yet → support (merged; one more source of the story's summary)
   independent origin, story summarised/published → update (waits; then the AI update call)
   same origin as a member (wire copy, same owner, recorded duplicate) → corroboration (merged)
lead ─► (settle time) ─► one summary of the story + guard (+ rewrite) ─► route:
   guard failed · insufficient information · sensitive topic · confidence < 50 → pending_review
   mode manual → held · mode semi → pending_review · mode auto (thresholds met) → queued
   AI keeps failing (max_attempts) → pending_review without text · too old → expired
pending_review ─► ✅ → queued · 📤 → queued + publish_now · ✏️ → human text → pending_review
               · ❌ → rejected · nobody decides in time → expired
held ─► /publish id → queued · too old → expired
queued ─► claim ─► sent → published · definite failure → failed (retry while attempts left)
                 · unknown outcome → uncertain (never re-sent) · too old → expired
   sources contradict each other → pending_review (conflicting_reports)
update ─► story published? ─► AI update: other event → detached (own story) · nothing new →
          merged (corroboration) · new information → summary + guard ─► route ─► reply post
source-channel post ─► published before? ─► duplicate (owner told) | new ─► queued ─► copied
                       (and joins its story as `human`)
post made by hand in a target channel ─► external: a dedup reference; marks its story published
sent in the MAIN channel ─► editions (Phase 6): matching edition channels get a copy (English:
                         guarded rendering of the verified summary, else skipped there)
run stages: sync → inbox → ingest → classify → cluster → ai → review → publish → editions →
            trends → brief → weekly → operations → maintenance; then reports to the mother bot
```

Cheap stages run before anything expensive: normalization, exact/near dedup and the
rule-based gate happen before any AI call. A feed item is never published without a validated
(or human-approved) Persian text; source-channel posts are human-curated and copied as they are.

Priority queue: 100 (international crisis) · 80 (important politics/economy) · 50 (normal) · 20
(low). The AI stage takes the highest priority first and fresh items first (quota is best spent
on news that will not expire). Publishing takes "publish now" first, then the importance score
(priority when there is none), oldest first. Source-channel posts get
`telegram.source_post_priority` (80).

## 4. Option A constraints (GitHub Actions + free PostgreSQL + Gemini free tier)

| Constraint | Design answer |
|---|---|
| Runners are stateless | All state in PostgreSQL: articles, fingerprints, health, ETags, robots.txt cache, Telegram offset + inbox, posts, locks, runs, logs. Nothing on local disk. |
| Cron is late/irregular | Nothing depends on timing: freshness is judged from item dates (`max_item_age_hours`, `max_publish_age_hours`), fetch intervals from stored timestamps, albums settle by age. |
| Two jobs may overlap | Workflow `concurrency` group + a **lease lock row** (`locks`) + a **unique idempotency key per post**. Any one of the three prevents a double post (tested with 8 concurrent claimants on PostgreSQL). |
| The bot is not always on | Admin commands and source-channel posts are read with `getUpdates` on every run (delay = cron interval). Updates are stored before the offset is confirmed. Telegram keeps updates 24 h: if runs stop for longer, older updates are lost (documented in README). Webhook mode is a future adapter (needs option B's `app`). |
| Gemini free-tier quota (Phase 2) | Per-run AI budget; several items per request (batch); results cached by content hash; items left over stay `queued` for the next run; nothing half-processed is ever published. `AIBudgetExhausted` / `AIUnavailable` in `ai/provider.py` carry this contract. |
| 6-hour job limit / minutes | A run is ~1 minute (16 feeds concurrently, few posts). `timeout-minutes: 10`. Public repository → Actions minutes are free. |
| Scheduled workflows | Run only from the default branch; GitHub disables them after 60 days without repository activity. |

## 5. Data model (migrations `0001`–`0006`, one per phase)

| Table | Purpose |
|---|---|
| `sources` | mirror of config/sources.yaml (config JSON + hash; removed sources stay, inactive) |
| `source_health` | circuit-breaker state, failures, last error, ETag/Last-Modified, robots.txt cache, counts |
| `articles` | every item (spec §6 fields + status, priority, sensitive, classification breakdown, dedup info) |
| `article_fingerprints` | exact-duplicate keys: `url` (scheme-less canonical URL), `content` (sha256 of normalized text), `media` (Telegram file_unique_id), `tg_origin` (forwarded original) |
| `published_posts` | one row per (article, channel), unique `idempotency_key`, status claimed/sent/failed/uncertain, message ids |
| `processing_jobs` | (article, stage) status, attempts, error, details |
| `pipeline_runs` | every run: status, counters, per-source report, errors |
| `telegram_updates` | getUpdates inbox: raw payload, processed_at, outcome |
| `settings` | key/value: Telegram offset, publishing paused, one-time notices |
| `locks` | lease locks (`pipeline`) |
| `system_logs` | warnings/errors worth showing in `/status` (stdout gets everything) |
| `admins` | owner + admins, synced from the environment |
| `ai_runs` (0002) | every AI call: run, provider, model, operation, prompt version, items, status, tokens (input/output/thinking), cost, error, response excerpt |
| `summaries` (0002) | Persian renderings: origin ai/rewrite/human, prompt version, model, source hash (cache key), title, summary, key points, entities, quotes, claims with evidence, AI category and importance factors, guard report, valid |
| `review_requests` (0002) | review cards and edit prompts sent to admins: message ids, open/closed, outcome, who decided |
| `story_clusters` (0003) | one row per event: `event_id`, lead article, title, summary, category, names, first seen / last updated, importance, confidence, independent sources (+ list), member count, centroid embedding, contradictions, timeline, published at / post chat / post message id / published text |
| `claims` (0003) | claims of a story's summary: text, status (confirmed/likely/unconfirmed/conflicting/rejected), confidence, supporting articles, versions (for conflicting claims) |
| `evidence` (0003) | verbatim excerpt per (claim, article), supports or not |
| `trend_alerts` (0004) | early warnings: kind (story/name), key, label, window, reports, outlets, usual count, ratio, story, notified |
| `corrections` (0005) | corrections of published stories: item, wrong/correct value, source, evidence, origin (ai/human), status (proposed/approved/published/rejected/invalid), check problems, review messages, who decided, the reply post |
| `reliability_history` (0005) | reliability suggestions and decisions: source, old/new score, signals, explanation, status (suggested/applied/dismissed/superseded), who decided |

`articles` gained (0002): `summary_id`, `importance_score` + breakdown, `confidence_score` +
breakdown, `publish_mode`, `review_reason`, `approved_by`/`approved_at`, `publish_now`. The
migration moved Phase 1 feed items that were still waiting (queued/pending_review, no Persian
text) to `ai_pending`; downgrade maps the new statuses back.

Times are stored in UTC (`UTCDateTime` refuses naive datetimes); display is `Asia/Tehran` with a
Jalali date. JSON columns are JSONB on PostgreSQL.

`articles` gained (0003): `cluster_id`, `cluster_role`, `cluster_score` (why it joined: cosine,
names, time), `embedding`; `published_posts` gained `kind` (story/update), `cluster_id`,
`reply_to_message_id`. A story's members are `articles.cluster_id` — no separate
`cluster_articles` table (one article belongs to one story). Embeddings are pgvector `vector`
columns on PostgreSQL (`CREATE EXTENSION IF NOT EXISTS vector` in 0003) and JSON on SQLite
(ADR-031). Names stay a JSON list on the story; an `entities` table waits for search (Phase 6).

Phase 4 (0004): `articles.breaking` + `breaking_reason`; `story_clusters.breaking_at` and
`related` (linked stories with their scores); `published_posts.breaking`, and
`published_posts.article_id` is nullable so a daily brief or a trend alert (kind `brief` /
`trend`) uses the same claim → send → record protocol (ADR-043).

Tables of later phases, each in its own migration: `corrections`,
`reliability_history`, `categories`/`tags` tables if the dashboard needs them (Phase 5). There is
no separate `translations` table: the Persian summary is the translation (ADR-021).

## 6. Deployment

- **Option A (now):** `.github/workflows/news.yml`. `test` job on pushes (lint, mypy, offline
  tests + PostgreSQL service, live dry run, migrate + run-once smoke). `run` job every 15 min and
  on demand (`run-once`, `run-once --dry-run`, `migrate`, `doctor`, `check-sources`). Secrets:
  `WANGER_NEWS_BOT_TOKEN`, `WANGER_NEWS_DATABASE_URL`; variables: channels and admin ids.
  Migrations are applied only by the explicit `migrate` command; `run-once` refuses to run on a
  database that is not at the latest revision.
- **Option B (later):** `docker-compose.yml` — `postgres` (pgvector image), `migrate`, `worker`
  (the same `run-once` in a loop). Sketched for later phases: `app` (FastAPI dashboard API +
  Telegram webhook), `scheduler`, `redis` (queue/rate buckets once several workers exist).

## 7. Security

- Secrets only from the environment/.env (`.env` git-ignored, `.env.example` empty). The token
  is never logged: httpx loggers silenced, Bot API exceptions raised `from None` without URLs,
  and a redaction filter removes token- and password-shaped strings from every log line.
- Input validation with Pydantic (config, feed drafts, Telegram updates). ORM / bound parameters
  only (no SQL built from strings).
- SSRF: only http/https, ports 80/443, no credentials in URLs, no localhost/.local/.internal,
  every resolved address must be public — checked again on **every redirect hop**; redirect count
  and response size are capped.
- Feed HTML is sanitized by feedparser and then reduced to plain text; nothing from a feed is
  ever sent as markup. Every output value is escaped in `formatting/`.
- Copyright: only the feed's own teaser (≤ `description_excerpt_chars`) + link; never full text;
  paywalled sources inactive; robots.txt honoured; only feed-published images, credited.
- Only the owner/admin ids get command answers; everyone else is ignored silently.

## 8. Extension points (where later phases plug in)

| Later feature | Where |
|---|---|
| Another AI provider (OpenAI, Anthropic, local) | a new `AIProvider` adapter next to `ai/gemini.py`; `ai.fallback_provider` (config) is where a fallback is chosen |
| ANN search over many stories | a fixed-dimension `vector(n)` column + HNSW index and `ORDER BY centroid <=> :q` in `StoryRepo.candidates` (ADR-031) |
| Weekly intelligence report | built (Phase 6): `services/weekly.py`, ADR-054 |
| Trend posts with an AI explanation | `TrendService` → a new prompt; today alerts are counts only (ADR-039) |
| Corrections of published posts (Phase 5) | `story_clusters.post_message_id` / `published_text`, claims with versions |
| Full rules engine (Phase 5) | `domain/editorial.route` is the single routing function to generalise |
| Same-event check inside ingest (instant L3) | `EventMatcher` port in `DedupService.check` (kept as a no-op: L3 is the CLUSTER stage, ADR-029) |
| Webhook instead of polling | a second inbox adapter feeding the same `InboxService.process` |
| Other output languages | built for English (Phase 6): `formatting/templates_en.py`, prompt `localize.<lang>`, `EditionConfig.language` (ADR-057); another language = a template, a prompt file and the guard's language check |
| Mother bot | built (Phase 6): signed HTTPS reports, `adapters/mother.py` (ADR-058); commands from the mother bot: a signed inbound endpoint next to the admin API |
| Push notifications for the mobile app | the mother-bot events (`published`, `weekly`) or a new port called where `ctx.mother_events` are collected |

## 9. Architecture Decision Records

**ADR-001 — Python project in its own folder, not tgcloud.** The repository's other bots run on
Telegram Serverless (JS, SQLite, no cron). The spec asks for PostgreSQL + pgvector, Alembic,
Pydantic, Gemini and a scheduled pipeline, which that platform cannot provide. So `wanger-news/`
is a self-contained Python 3.11+ package; nothing outside it was changed except the new workflow
file `.github/workflows/news.yml`.

**ADR-002 — async SQLAlchemy 2 + psycopg 3, not asyncpg.** Neon/Supabase URLs
(`postgresql://…?sslmode=require&channel_binding=require`) work unchanged with psycopg (libpq),
while asyncpg needs rewritten parameters and breaks with transaction-mode poolers. Server-side
prepared statements are disabled (`prepare_threshold=None`) for the same poolers. Windows needs the
selector event loop (handled in `cli._run`). SQLite (aiosqlite) runs the tests and the dry run
without a server; the code is dialect-portable (dialect `INSERT … ON CONFLICT`), and PostgreSQL
behaviour is tested separately in CI.

**ADR-003 — Telegram via getUpdates on every run (no webhook in option A).** A webhook needs an
always-on HTTPS endpoint, which option A does not have. Offset and inbox are in the DB; an update
is stored and committed before the next `getUpdates(offset)` confirms it, so a crash at any point
loses nothing and processing is once per `update_id`. Dry runs read one page with the stored
offset, which confirms nothing.

**ADR-004 — at most once, never at least once.** Publishing claims a unique key and commits
before sending. A definite failure (connection never made, 4xx) may be retried; an unknown outcome
(read timeout, 5xx, a part of a split message already out, a claim left by a crashed run) becomes
`uncertain`, is never re-sent, and the owner is told. Rationale: a missing post can be posted by
hand; a duplicate in a news channel cannot be undone quietly. Channel-level errors (bot not admin,
chat not found) stop the run without consuming attempts.

**ADR-005 — a thin Bot API client instead of aiogram.** A stateless run needs ~8 methods and
precise control over outcome classes (sent / not sent / unknown), 429 `retry_after`, and token
hygiene. aiogram is built around a long-running dispatcher and would hide those details. The
`BotApi` port keeps the door open: aiogram (or webhooks) can be adopted for option B without
touching the services.

**ADR-006 — lease lock row, not advisory locks.** Session-level advisory locks do not survive
PgBouncer transaction pooling (Neon/Supabase poolers). A `locks` row with `expires_at`, taken by
one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at < now RETURNING`, works everywhere
and expires by itself if a runner dies. **`RETURNING` is used instead of `rowcount` everywhere:**
psycopg's async cursor reports `-1` for `INSERT … ON CONFLICT DO NOTHING`, which once let every
concurrent claimant "win" (caught by the PostgreSQL concurrency test, fixed).

**ADR-007 — duplicate detection, three levels, thresholds measured.**
L1 (exact): an `article_fingerprints` table indexed on (kind, value) — normalized URL
(tracking parameters, `www.`/`m.`, default ports, fragments, trailing slashes removed; scheme
ignored), sha256 of the normalized text (Persian/Arabic letters and digits unified, ZWNJ and
diacritics ignored, links/mentions/hashtags removed), Telegram media `file_unique_id`, and the
forwarded original. L2 (near): a 64-bit SimHash over 2-word shingles as a cheap **prefilter**
(≤ 12 bits), then an exact **confirmation** on the few candidates: token-set Jaccard ≥ 0.8 **and the
same numbers** (a changed figure is an update, never a duplicate). Measured on 720 live items
(258,839 pairs): the prefilter let through 14 pairs, all of them templated bulletins; 3-word
shingles missed a copy with one appended clause (distance 9), so 2-word shingles were chosen. A
reworded repost (two words swapped) scores Jaccard 1.0. L3 (same event): `EventMatcher` port, a
no-op until Phase 3 (embeddings + entities + time + place).

**ADR-008 — the source channel.** Posts in the configured source channel(s) are re-published with
`copyMessage`/`copyMessages` (media, formatting and albums preserved, no "forwarded from"
header). They are human-curated, so they skip the gate and review; the only question is "was this
published before?": a match on any L1 key or an L2 near-match against a *published*, *uncertain*
or *external* item makes it a duplicate (not posted; the owner gets a notice with the reason and a
link). Unpublished automatic copies (new/queued/pending) are instead superseded by the human post.
Posts made by hand in the target channels are recorded as `external` so they count as published.
Albums are copied once all parts are older than `album_settle_seconds`. A post from an unknown
channel produces one owner notice with its numeric id. Short captions alone (< 3 words, e.g.
"#خبر") never make two posts equal. Limits: bots cannot read channel history, so only posts that
arrived while the bot was admin are known; edits of source posts are not followed in Phase 1.

**ADR-009 — Phase 1 post content (superseded by ADR-021/022 in Phase 2: only validated Persian
summaries are posted now; the Phase 1 template stays in `formatting/templates_fa.py`, unused by
the publisher).** Without AI there is no translation, so a test-channel post
carries the original title, the feed's own teaser cut to 300 characters (never full text), the
"گزارش اولیه" single-source note, the source, the canonical link, Tehran time (Jalali), at most
three hashtags, and the feed image if the feed published one (credited); captions are kept within
1024 by shortening only the teaser, else the image is dropped; text messages are split at 4096.

**ADR-010 — sensitive topics by keywords, over-matching on purpose.** War, deaths, coups,
elections, security crises, major medical claims and heads of state are detected with keyword
lists (`config/categories.yaml`). A false positive only waits for a human (`pending_review`);
a false negative would publish without review, so the lists are broad. The live dry run showed
war news slipping through a narrow list; it was widened.

**ADR-011 — backfill and flood protection.** Items older than `max_item_age_hours` when first
seen are `stale`; undated items on a source's first fetch are `stale`; a queued item older than
`max_publish_age_hours` expires; at most `max_posts_per_run` per run; a source exceeding
`max_new_items_per_hour` is throttled; `min_fetch_interval_minutes` per source.

**ADR-012 — dry run = one rolled-back transaction.** `--dry-run` runs the whole pipeline inside an
outer transaction (session commits become savepoints) and rolls it back: no DB change, nothing
sent, posts printed. pysqlite's legacy transaction handling breaks savepoints, so the SQLite engine
emits its own `BEGIN` (SQLAlchemy's documented recipe) — found by a test that left 8 rows behind.

**ADR-013 — robots.txt (RFC 9309) and a generic User-Agent.** robots.txt is checked per source
and cached 24 h in `source_health`: 4xx = no rules, 5xx/unreachable = disallowed for now. The
User-Agent is generic (`WangerNewsBot/0.1 (RSS reader)`) so no personal data leaves; a contact URL
can be added in `config/pipeline.yaml`.

**ADR-014 — SSRF residual risk.** Addresses are checked before each hop, but the HTTP client
resolves the name again (DNS rebinding window). Feed URLs come from our own config, and Phase 1
downloads nothing else (Telegram fetches images itself), so the risk is accepted; pinning the
resolved address in a custom transport is a Phase 5 hardening TODO.

**ADR-015 — circuit breaker per source.** After `failure_threshold` consecutive failed runs the
source is skipped for `cooldown_minutes`, doubling on each failed half-open probe up to
`max_cooldown_minutes`; one success closes it. Retries inside a run: exponential backoff with
jitter for timeouts, connection errors, 429 (Retry-After honoured up to a cap) and 5xx.

**ADR-016 — pgvector arrives with its first use (Phase 3).** Phase 1 has no vectors; the Phase 3
migration runs `CREATE EXTENSION IF NOT EXISTS vector` (available on Neon and Supabase, and in the
`pgvector/pgvector` image used by CI and docker-compose).

**ADR-017 — own Jalali conversion.** A 20-line arithmetic algorithm, tested against known
Nowruz dates, instead of a dependency.

**ADR-018 — SimHash thresholds and all limits live in config.** Every number above is a key in
`config/pipeline.yaml` (defaults in `config/models.py`), so tuning needs no code change.

### Phase 2

**ADR-019 — Gemini over plain REST, behind the AIProvider port.** `generateContent` with
`x-goog-api-key` (never a key in a URL), JSON answers (`responseMimeType` + `responseJsonSchema`,
and the same schema in the prompt). If the API refuses an optional field (the schema field, the
thinking level) the client retries once without it, so a model that lacks a feature degrades
instead of stopping. Default model `gemini-3.5-flash-lite` (Google lists `gemini-2.5-flash` as
deprecated from 2026-12-01; flash-lite's default thinking is "minimal", which saves quota);
`gemini-3.6-flash` can be set in config when the quota allows. No SDK: one small client is
easier to test and keeps token hygiene under our control. A newer Google API ("Interactions")
exists; if `generateContent` is ever retired, a new adapter replaces this one only.

**ADR-020 — prompt injection defence.** Article text is untrusted (spec §3.3): it is sent as a
JSON value (escaped) between two markers carrying a random 16-hex boundary that an article cannot
predict; the system instruction (a separate API field) says that content is data, never
instructions; the answer must be JSON matching a Pydantic schema; ids are checked (an id the model
invents is ignored, a missing one is retried); and every claim must still pass the guard. Prompts
are versioned files (`prompts/<name>.<lang>.vN.md`); the version used is stored on every summary
and every `ai_runs` row.

**ADR-021 — the summary is the translation.** Full articles are never translated (copyright,
spec §3.4); one call per batch produces the Persian title, summary, key points, entities (with
the original spelling), quotations (with the verbatim original), claims (with verbatim
evidence), the category and importance factors. So `summaries` replaces the suggested
`translations` table, and translation, summarization and AI classification cost one call.

**ADR-022 — hallucination guard in two layers, then one rewrite, then a human.** Layer 1 is
deterministic (`domain/guard.py`): every number written with digits must be in the source (digits
unified, thousands/decimal separators, number words such as "two"/"دو", scaled values such as
"$1.2bn"); every Latin-script name and every declared entity must be in the source; every «quote»
must be declared and its original nearly verbatim in the source; every claim needs nearly
verbatim evidence; the text must be Persian and free of links/mentions/markup. Converting a date
to the Jalali calendar fails the number check on purpose (the prompt forbids it). Layer 2 is one
AI `verify` call per batch: claim-by-claim support and unsupported statements. Verification that
could not run is an issue, never a pass. Any issue → one `rewrite` without the unsupported parts →
both layers again → still failing: `pending_review` with the issues on the card, confidence capped
at 49 ("unconfirmed"). Never published automatically.

**ADR-023 — scores are explainable and conservative.** Importance = weighted mean of the rule
priority, the AI's six 0–10 factors and recency. Confidence = weighted mean of source reliability,
primary-source type, quality and the guard result, then capped: one source ≤ 69 ("گزارش اولیه"),
because independent confirmation only arrives with clustering in Phase 3; failed guard ≤ 49.
Both store their components, weights and caps.

**ADR-024 — publish modes per category, safety before mode.** auto / semi / manual from
`config/editorial.yaml`, overridable per category with `/settings`. MVP default: semi. Whatever
the mode, a failed guard, insufficient information, a sensitive topic or confidence below 50 goes
to a human; auto additionally needs `auto_publish.min_confidence` (never below 50, enforced by the
config model) and `min_importance`. Manual = held until an admin picks it (`/pending`, `/publish`).

**ADR-025 — review without a server.** Cards go to the owner (and admins) with ✅ 📤 ✏️ ❌;
taps and replies are read on the next run, so `answerCallbackQuery` may come too late (Telegram
then refuses it; the decision still stands). At most `review.max_cards_per_run` cards per run,
most important first; items nobody decides on expire after `review.expire_after_hours`. Every
card of an item is closed (buttons replaced by the outcome) when one admin decides. An edit is a
reply to the bot's prompt: first line title, then text, "•" lines key points; it becomes a human
summary (guard run as advice) and needs Approve/Publish like any card. "Publish now" bypasses the
per-run cap and age expiry; approved items do not expire either (a human decided).

**ADR-026 — AI budget.** Calls per run (`max_calls_per_run`), per provider day
(`max_calls_per_day`, counted from `ai_runs` since midnight Pacific, the Gemini reset) and per
minute (pacing). A batch only starts when summarize + verify fit; a rewrite only when rewrite +
re-verify fit, else the item goes to a human. Quota errors or an outage stop the stage; items stay
`ai_pending` (or expire when stale). A summary of exactly the same source text and prompt version
is reused instead of calling again. Dry runs may spend at most `dry_run_max_calls`.

**ADR-027 — main channel from Phase 2, switched by the owner.** The code may now target the main
channel, but the default stays the test channel (`WANGER_NEWS_PUBLISH_TARGET=test`) until the owner
switches with `/settings target main` (stored in the database) or the variable. The idempotency key
includes the chat, so switching never re-posts what the test channel already got.

**ADR-028 — the live Gemini check is the owner's.** The development session had no Gemini key, so
the provider is tested against recorded-shape responses (MockTransport) and the stage with a
deterministic fake. `doctor` checks the key and model names (model metadata, no generation
quota); the first real runs should be watched (`/status`, `ai_runs`) — see PLAN.md.

### Phase 3 — intelligence

**ADR-029 — same-event detection is a pipeline stage, not a dedup level inside ingest.**
Level-3 dedup needs embeddings (a budgeted AI call) and should only be paid for items that
passed the cheap filters, so it runs as the CLUSTER stage after the gate and before the AI. A
report about an event we already have is not thrown away like an L1/L2 duplicate: it becomes a
source of that story (`merged` with a role), and it is what makes multi-source confidence
possible. The `EventMatcher` port in `DedupService.check` stays a no-op for an instant check later.

**ADR-030 — embeddings: `gemini-embedding-001`, 768 dimensions, task type CLUSTERING.** The text
is the title + the first 1200 characters in the source language (the model is multilingual, so
nothing is translated first). 768 dimensions (the model's Matryoshka truncation) keep a free-tier
database small. Embedding requests take up to 100 texts and are budgeted separately
(`story.max_embed_calls_per_run`); they are logged in `ai_runs` as `embed` but do not count
towards the daily *generation* quota, which is a separate quota at Google. Without a provider or
when embedding fails, every report stays a story of its own (nothing is merged — the safe
direction) and the next run catches up.

**ADR-031 — vectors in pgvector, similarity in Python.** The column type is pgvector's `vector`
without a fixed dimension (so the dimension is a config value, not a migration), JSON on SQLite
(tests, dry runs). Candidates are only stories updated within `story.window_hours` (72 h, at most
`max_candidates`), so comparing a few hundred centroids in Python is cheap and needs no ANN index;
it also keeps SQLite and PostgreSQL behaving identically. When volume grows: a fixed `vector(768)`
column, an HNSW index and `ORDER BY centroid <=> :q` in `StoryRepo.candidates` (one function).
Neon and Supabase ship the extension; the migration runs `CREATE EXTENSION IF NOT EXISTS vector`
and its downgrade leaves the extension installed (other database objects may use it).

**ADR-032 — a conservative, hybrid same-event rule; the AI can undo a merge.** Same event when
cosine ≥ `min_cosine` (0.84) AND (cosine ≥ `strong_cosine` (0.92) OR shared names ≥
`min_entity_overlap` (0.2)), within the time window; candidates are ranked by
0.7·cosine + 0.2·names + 0.1·time. Wrongly merging two events would hide one of them, which is
worse than missing a merge (two posts about one event). Second line of defence: the summary call
may list `excluded_sources` (those reports leave the story), and the update call answers
`same_event`. **These thresholds are not calibrated on real embeddings** — the development
session had no Gemini key (ADR-028); every join stores its `cluster_score` so the first real runs
can be checked and the values tuned in `config/pipeline.yaml`.

**ADR-033 — roles and the life of a story.** `lead` (gets the summary) · `support` (joined before
the summary: one more source of it) · `update` (an independent report after the summary: waits
until the story is out, then the AI decides) · `corroboration` (same origin as a member, or an
update with nothing new: counts, nothing posted) · `human` (a source-channel post) · `external`
(a post made by hand in a target channel). A lead waits `settle_minutes` (15) after the story's
last change to collect sources first; priority-100 news does not wait. One summary per story from
up to `max_sources_per_story` (5) sources, most reliable first. Human posts keep their Phase 1
behaviour (copied as they are) and become the story's representative when nothing was published
yet: a hand-made post in the target channel marks the story published (updates reply to it) and
an unapproved automatic lead becomes an update candidate. If a lead dies (rejected, expired), a
waiting update becomes the new lead. Every step is a `timeline` event of the story.

**ADR-034 — independent sources = independent origins.** Reports are grouped (union-find) when
their outlets share an `owner_group`, when one is a recorded L1/L2 duplicate of the other, or when
their texts are nearly the same (token Jaccard ≥ `syndication_min_jaccard`, 0.6 — a wire copy).
Each origin is represented by its most reliable report (primary sources first). A story's
`independent_sources` counts origins of feed reports; our own channels' posts are never sources.

**ADR-035 — claims cite sources; statuses are rules, not AI opinions.** Each claim of the summary
lists the sources that state it, each with a verbatim excerpt; the guard checks every excerpt
against *that* source's text and refuses unknown source ids. Status: `rejected` (the verifier
found no support) · `conflicting` · `confirmed` (≥ 2 independent origins) · `likely` (one primary
source with reliability ≥ `likely_min_reliability`, 80) · `unconfirmed`. Claims and evidence are
rows (`claims`, `evidence`). Story confidence adds the number of independent origins (1: 40,
2: 75, 3+: 100) and a consistency component; caps: one origin ≤ 69, contradictions ≤ 69, failed
guard ≤ 49.

**ADR-036 — contradictions are reported, never resolved, and always seen by a human.** The AI
reports a disagreement as a topic plus ≥ 2 versions (source id, Persian predicate, verbatim
evidence). The guard checks each version against its own source (numbers included); a
"contradiction" from a single source fails. The post renders it with one fixed sentence —
«گزارش‌ها دربارهٔ X متفاوت است؛ A …، در حالی که B ….» — plus a note when the reports were
published ≥ 2 h apart, so a newer figure is not read as a contradiction by accident. Status
«متناقض»; with `story.review_conflicts` (default) the story goes to review
(`conflicting_reports`) whatever the publish mode.

**ADR-037 — updates are replies, never edits.** New information becomes a short update post
(«🔄 به‌روزرسانی», only the new facts, «منابع تازه») sent as a reply to the story's last post in
the same channel (`reply_parameters`, `allow_sending_without_reply` so a deleted original does
not block it). Editing a published post would silently change what readers already saw; real
corrections are Phase 5. An update in another channel than the story's (after `/settings target`)
is sent without the reply. The per-article idempotency key is unchanged.

### Phase 4 — real time

**ADR-038 — 🔴 breaking changes the order and the marker, never the safety checks.** An item is
breaking when its rule priority is 100 (international crisis) or its importance ≥ 85, its
confidence ≥ 50 (never "unconfirmed") and its story was first seen ≤ 120 minutes ago
(`domain/breaking.py`; the reason is stored either way). Breaking items are first in the publish
queue and in the review cards, and their cards are not held back by `max_cards_per_run`; the
settle wait is already skipped for priority 100. They still need a validated text, and sensitive
topics still go to a human. At most `breaking.max_per_hour` (3) 🔴 posts per channel per hour —
more are posted without the marker, because a channel where everything is red numbs its readers.
Update posts are not breaking by default (`allow_updates`).

**ADR-039 — early warning by counting, against each topic's own history.** A topic is a story
(one event) or a name. It trends when, in the last 60 minutes, it has ≥ 5 reports from ≥ 3
outlets (owner groups) and that is ≥ 3× its usual count per hour over the preceding 24 hours
(`domain/trends.py`). Each outlet counts at most twice per window (one noisy feed cannot make a
trend); a topic with no history counts as "usually 1"; no alerts while the database holds less
than `min_history_hours` (6) of reports (a new database knows no "usual"); one alert per topic
per 6 hours; a name that trends only inside one trending story is not alerted again. The alert is
a count, never a claim — no AI writes it. It goes to the admins; posting it in the channel is
the owner's decision (`trends.post_to_channel`, off). Entities are Latin-script names from the
feeds, shown with the Persian spelling a summary used when there is one. The thresholds were
checked against one day of real feeds (no alert at the defaults; with relaxed values the
detector found Trump, Ukraine, FBI…), not tuned on weeks of data.

**ADR-040 — related stories link earlier posts, with stored reasons.** When a story is posted,
earlier stories posted in the same channel in the last 7 days are related when their meaning is
close (centroid cosine ≥ 0.75 — below the same-event threshold) or they share ≥ 2 names with an
overlap ≥ 0.34 (`domain/related.py`). At most 2 links, best first, under «🔗 مرتبط:», each the
earlier post's own published title (no new text). The scores and shared names are kept in
`story_clusters.related`. Links go to posts of the same channel only (`t.me/<name>/<id>`, or
`t.me/c/<id>/<msg>` for a private channel, which opens for members only).

**ADR-041 — the timeline is the story's own record.** Every step of a story is a `timeline`
event since Phase 3 (created, joined, summarized, published, breaking, update_published,
corroborated, trend…). From the second update on, an update post lists the story's earlier posts
in this channel with their Tehran time («🧵 روند خبر»; with one earlier post the reply already
shows it). `/timeline <article id>` shows admins the whole record.

**ADR-042 — the daily brief contains only what was already published.** At `local_time` (21:00
Tehran) the first run sends the day's published stories of the channel, most important first
(3 to 10), each its published title linked to its first post, with its status, 🔴 and the number
of updates, plus the day's trend topics. No AI text, so nothing new to verify. Cron is late or
irregular: a run up to `max_late_hours` (3) after the time sends it; a later run skips the day.
Fewer than `min_items` stories → no brief. `/brief` previews it for admins without sending.
`destination: admins` sends it to the admins instead of the channel.

**ADR-043 — posts without an article reuse `published_posts`.** A brief or a channel trend
alert is claimed with the key `brief:<date>:chat:<chat>` / `trend:<id>:chat:<chat>` and
`article_id` NULL, so the at-most-once guarantee, the uncertain state and the stale-claim
reconciliation are the same code as for articles — not a second mechanism to get wrong.
Downgrading 0004 deletes those rows.

### Owner decisions after Phase 4 (2026-11-22)

**ADR-044 — source-channel posts are re-sent under the target's name.** The owner chose: not a
plain copy — remove the source's Telegram IDs, add the target channel's @username and the
poster's name as a hashtag. `domain/rebrand.py` removes @mentions, t.me / telegram.me links (as
text or as links), links to user accounts, and lines that held only an ID or pointed to one
(«🆔 @x», «عضو شوید: t.me/…»); every other entity (bold, website links) is kept with its UTF-16
offsets recomputed. Then «✍️ #poster» (the channel's *Sign messages* signature; none → no
hashtag) and «🆔 @target». Text → `sendMessage` with entities (no HTML parsing of human text);
one photo/video/document → `copyMessage` with the new caption (the file is not re-uploaded); an
album → `sendMediaGroup` with the stored `file_id`s. Stickers and round videos have no caption
and are copied. A post that was nothing but IDs is not sent (`filtered`). If the signature would
break the caption/message limit it is left out; posts stored before this change (no `items`) are
copied. `telegram.source_posts.mode: copy` restores the old behaviour. A target channel is checked
before the source channels, so a misconfigured channel can never feed its own posts back.

**ADR-045 — the owner's panel lives in the bot; its settings in the database.** `/panel` (or
`/start` from the owner) opens one message with inline buttons, edited in place (owner only):
status, channels, RSS sources, publish modes, pause, pending, trends, brief. Choosing a channel is
a reply to the bot's prompt (or `/channel …`); the bot checks with `getChat` / `getChatMember`
that it is a channel and the bot is an admin (with the right to post, for test/main), and refuses
a target as a source. Changes are stored in `settings` (`panel.channels`, `panel.sources`) and
applied at the start of the next run over the environment and the config files
(`services/overrides.py`, in `runtime.build` and `doctor`). Only RSS sources that are active or
"Candidate" may be switched; sources off for legal or technical reasons stay off. Without a
server every tap is handled on the next run (minutes) — said on the panel itself; a webhook
(option B) would make it instant. The owner's three channels are defaults in the workflow, so no
GitHub variables are needed.

### Phase 5 — operations

**ADR-046 — the rules engine only tightens.** `config/rules.yaml` (spec §11) holds `if` → `then`
rules, validated at load: unknown categories, sensitive topics or sources, empty conditions, and
an action used at the wrong stage are refused. Conditions are AND, a list means "any of".
Actions: `require_human_review`, `hold`, `skip`, `{priority}`, `{mode}` in the AI routing, and
`merge` / `new_story` (with `duplicate_similarity_gt`) at clustering. Rules run AFTER the safety
routing (`domain/editorial.apply_rules`), and only in the strict direction: skip > review > hold.
A guard failure, a sensitive topic, contradicting sources or confidence < 50 can never be turned
into "publish" by a rule. Every hit is recorded on the article and named on the review card; the
owner can switch each rule off in the panel (stored like the other panel switches).

**ADR-047 — a correction is a stricter update and always seen by a human.** The update prompt
(v2) may list `corrections` when a new report states that a published fact was wrong (a rising
toll is new information, not a correction). `domain/corrections.check` needs the old value in what
we published (numbers compared), the new value in the new source (numbers included) and a
verbatim excerpt; failing proposals are kept as `invalid`, never shown. Admins can also write one
(`/correct id | item | wrong | correct | source`). Every proposal becomes a card; only an approved
one is posted, in the publish stage (pause, dry run and the at-most-once key apply), as a reply
under the story's post with the spec §10 sentence. The wording "به اشتباه" asserts an error,
which is why a human decides.

**ADR-048 — edits in the source channel follow the post.** `edited_channel_post` is now read.
The stored text of the source post is updated; if it was already published, the bot's copy is
edited (`editMessageText` / `editMessageCaption`) with the same rebrand rule. Posts of a target
channel are never treated as source posts.

**ADR-049 — analytics and costs are read-only views.** `services/analytics.py` aggregates what is
already recorded (articles, posts by kind, admin decisions, time to publish, `ai_runs` tokens and
estimated cost per operation and model, guard results, stories, corrections): `/report [days]`,
the panel's 💰 screen and `/api/analytics`. The cost is the paid-plan estimate (`ai.price_*`); the
free tier costs nothing. `costs.monthly_budget_usd` (0 = off) warns the owner once a month at
`alert_at_fraction` of the budget.

**ADR-050 — reliability learning suggests; the owner decides.** Weekly, per RSS source, over 30
days: the admins' approvals vs rejections, the guard's verdicts on texts made from it, how often
its claims were confirmed by another independent origin (only in stories that had at least two
origins — an exclusive report is not a weakness) and published corrections of stories it led.
`domain/reliability.suggest` turns them into a bounded change (≤ ±10, ignored below 3, signals
with fewer than 5 cases ignored), every point explained. Suggestions and decisions are rows of
`reliability_history`; an applied score is a panel setting used from the next run. Nothing is
ever applied automatically (spec §16).

**ADR-051 — the dashboard API is the bot's services over HTTP.** `api/app.py` (FastAPI, optional
`[api]` extra, option B: `python -m wanger_news api`, docker-compose profile `api`): status, news
and decisions, stories, sources and rules (switches), analytics, trends, reliability, corrections.
Every route but `/health` needs `Authorization: Bearer <WANGER_NEWS_API_TOKEN>` (constant-time
compare); without a token the app refuses to start. Decisions call the same code as the bot's
buttons, so the API cannot do anything the bot would not. It is bound to 127.0.0.1 in compose:
expose it only behind a TLS reverse proxy. A web dashboard UI and the Telegram webhook (instant
replies) belong to option B and are not built.


### Operations after Phase 5 (2026-11-23)

**ADR-052 — the daily AI quota is spread over the day.** Gemini's free tier is a per-day quota
(requests per day, reset at midnight Pacific time: `ai.quota_reset_timezone`). Spending it as fast
as news arrives empties it in the morning and leaves the rest of the day without summaries. Each
run now gets its share (`domain/quota.paced_allowance`): `quota × (elapsed fraction of the quota
day + one run interval)` minus what was already used, capped by `ai.max_calls_per_run` and by
what is left. Missed runs leave their share to later runs (within the cap); a whole day of runs
uses the quota and never more, so it lasts every day of the month. The quota in effect is, in
order: the per-day value Google states in a 429 `QuotaFailure` (learned automatically,
`settings["ai.daily_quota"]`), the owner's `/quota N` (the RPD figure AI Studio shows), else
`ai.max_calls_per_day`. Dry runs keep their own small cap. Learning only goes down (Google
states the quota only when it is exceeded), so a higher real quota is set with `/quota`.

**ADR-053 — runs are started by an external timer.** GitHub's `schedule` started runs hours
late for this repository (ADR-042's problem in production). Option A therefore uses a free
external timer (cron-job.org) that calls the GitHub REST API every 10 minutes:
`POST /repos/imkiimiw/Kimia/actions/workflows/news.yml/dispatches` with
`{"ref": <default branch>, "inputs": {"command": "run-once", "trigger": "cron"}}`, authorised by
a fine-grained token limited to this repository and to "Actions: read and write". `trigger=cron`
gives the timer's runs the scheduled-run behaviour (a setup problem warns instead of failing).
GitHub's own schedule stays as an hourly fallback; the `concurrency` group keeps runs one at a
time. The token sits at a third party: it can only start workflows of this repository, has an
expiry, and is revoked in GitHub settings if ever in doubt. Option B (a small server) remains
the long-term home.

### Phase 6 — expansion

**ADR-054 — the weekly intelligence report is counts and published titles only.** Like the
daily brief (ADR-036), `domain/weekly.build` turns what was already published in the target
channel (stories first published in the window, update posts, 🔴 posts, corrections, trend
alerts, the outlets of each story) into numbers and lists: top stories by importance and
independent origins, developing stories by update posts (older stories that developed count
too), categories, top trends, most-cited outlets, change against the previous week. No AI text,
so it cannot add a claim. Due at `weekly_report.weekday` / `local_time` (Tehran); the first run
after that moment sends it, a run more than `max_late_hours` late skips the week; at most once
per ISO week and channel (`weekly:<year>-W<week>`, claim → send → record). `/weekly` and the
panel show a preview; `/api/weekly` and `/api/v1/weekly` return the numbers.

**ADR-055 — search reads published posts only; text first, then meaning.** `domain/search`
turns a query into terms (Arabic ي/ك folded, common Persian/English words dropped, digits in
both spellings); `PublishedRepo.search_text` requires every term (each term: one of its
spellings) in the Persian title/summary or the original title/teaser, bounded by
`search.window_days` and LIMIT. Semantic search embeds the query once (embedding quota, an
`ai_runs` row with prompt version `search`) and ranks published story centroids by cosine over
`min_similarity`. Results are always sent posts with their links, so a search can never surface
unpublished, rejected or pending items. Admins search test + main (`/search`, `/api/search`); the
mobile API searches the feed channel only and never exposes scores.

**ADR-056 — editions: personalization narrows, it never decides.** An edition is an extra
channel (`editions.editions`, or added in `/panel` → 🌐 / `/edition`, stored as
`panel.editions`) with categories, minimum importance, breaking only, updates and source posts
switches and a language. Each run, after publishing, it receives only what was sent to the MAIN
channel in the last `window_hours` (`follow: main`; `any` would also copy test-channel posts —
the owner's choice) through `PublishService.send_edition` (claim → send → record, role
`edition`, the article and story untouched). Updates reply to the story's first post in the same
edition (`PublishedRepo.first_in_chat`); an update whose story never went there is skipped. An
edition channel is never a source (inbox: `ignored:edition_channel`) and can never be the test or
main channel. A chat error stops that edition for the run and tells the owner.

**ADR-057 — multilingual output is a guarded rendering of the verified Persian summary.** For an
English edition the AI (`localize`, prompt `localize.en.v1`) renders the VERIFIED Persian
summary — sources are given only to spell names and check numbers. `domain/editions.check_english`
then requires: English text, no links/markup, length limits, every number in the Persian summary
or the sources, every proper name in the sources or among the summary's declared originals
(capitalised sentence starts excepted). A failing text is stored (`summaries`, language `en`,
`valid` false) and never posted; at most two attempts per article, then the item stays Persian
only. Conflicting stories (contradictions are shown side by side in Persian) and human-curated
source posts are never machine-translated. Translations run inside the same paced daily quota
(`AIStage.allowance`, ADR-052) and `editions.max_translations_per_run`.

**ADR-058 — the mother bot gets signed reports, never secrets or article text.**
`adapters/mother.HttpMotherBot` implements the `MotherBot` port: one POST per report to
`WANGER_NEWS_MOTHER_URL` (HTTPS only; plain HTTP only to localhost), JSON
`{bot, version, kind, sent_at, payload}`, headers `X-Wanger-Timestamp` and
`X-Wanger-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`; the receiver checks the
signature and rejects timestamps older than 5 minutes (`verify_signature`). Kinds: `run` (the
run summary: counters, sources, errors), `published`, `review`, `error`, `weekly` — filtered by
`mother_bot.events` — and `ping` (`doctor`). Events are collected during the run and sent after
the database work is committed; errors are logged and swallowed (timeout
`mother_bot.timeout_seconds`), so the link can never fail a run. Dry runs do not report.
Commands FROM the mother bot are not built: the admin API (token) already offers them for
option B; a signed inbound endpoint is the next step when the mother bot exists.

**ADR-059 — the mobile API is a separate read-only door.** `/api/v1` (feed with keyset cursor
pagination, story, search, categories, weekly) is mounted only when
`WANGER_NEWS_MOBILE_API_TOKEN` is set — a different token from the admin one, because a token
shipped in an app can be extracted: this one can read only what was already published in the
feed channel (`public_api.feed_channel`, main by default), never queued/pending/rejected items,
review reasons, scores or decisions, and it has no write route. Per-client request limit
(`requests_per_minute`, one process), CORS only for `public_api.cors_origins` and only for GET.
`lang=en` returns the English edition text when one passed its guard.

**ADR-060 — the web dashboard is a static page over the admin API.** `/dashboard` serves three
files (`api/static`: HTML, CSS, plain JS; no build step, no third-party script). The page holds no
data: it asks for the admin token, keeps it in `sessionStorage` (gone with the tab) and calls the
same `/api/*` routes — so it can do exactly what the API (= the bot's buttons) can. Every value is
inserted as a text node, never parsed as HTML (article text is untrusted); strict CSP
(`default-src 'none'`, own script/style/connect only, `frame-ancestors 'none'`), nosniff,
no-referrer. It runs with the API (option B), behind TLS.

