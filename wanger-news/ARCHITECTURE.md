# Wanger News — Architecture

Status: **Phase 2** (AI: Persian summaries, hallucination guard, review, main channel) on top of
Phase 1 (foundation). This document describes what exists, where every later feature plugs in,
and why each decision was taken (ADRs at the end; Phase 2 decisions are ADR-019 onwards).

## 1. Overview

```
                 config/*.yaml (sources, categories, filters, pipeline thresholds)
                                   │
 GitHub Actions cron ──► python -m wanger_news run-once ◄── Docker worker (option B)
                                   │
   ┌────────────────── services/pipeline.py (one pass, isolated stages) ──────────────────┐
   │ lock → sync → INBOX → INGEST → CLASSIFY+GATE → AI → REVIEW CARDS → PUBLISH → retention │
   └────────────────────────────────────────────────────────────────────────────────────────┘
   INBOX  : getUpdates → telegram_updates → admin commands · review buttons · edit replies ·
            source-channel posts · posts made by hand in the target channels
   INGEST : FETCH → PARSE → NORMALIZE → VALIDATE → DEDUPLICATE (L1, L2, L3-port)
   GATE   : rule-based category / priority / sensitive topics → ai_pending | filtered
   AI     : SUMMARIZE (Persian) → GUARD layer 1 (deterministic) + layer 2 (AI verify)
            → one REWRITE if needed → scores → route: queued | pending_review | held
   REVIEW : cards with ✅ 📤 ✏️ ❌ in the admins' private chats
   PUBLISH: claim → send (sendPhoto/sendMessage/copyMessage[s]) → record; test or main channel
                                   │
                 PostgreSQL (Neon/Supabase free tier) — ALL state lives here
```

The core (domain + services) does not know where it runs: the same `Pipeline.run_once` is the
GitHub Actions entrypoint (`run-once`) and the body of the long-running `worker`.

## 2. Layers (Ports & Adapters)

| Layer | Package | Rule |
|---|---|---|
| Domain (pure) | `domain/` — text, urls, fingerprint, keywords, classify, gate, quality, jalali, chatref, article, normalize, feed | no I/O, fully unit-tested |
| Formatting (pure) | `formatting/` — Telegram HTML escaping/splitting, Persian templates | the only place output text is built and escaped |
| Ports | `ports.py` (Clock, FeedFetcher, BotApi, EventMatcher, MotherBot), `ai/provider.py` (AIProvider) | interfaces the services depend on |
| Adapters | `adapters/http` (SSRF guard, safe fetcher, robots.txt), `adapters/feeds` (feedparser), `adapters/telegram` (Bot API client, update models, post → draft), `db/` (SQLAlchemy models, repositories, engine) | all I/O |
| Services | `services/` — ingest, dedup, processing, publish, inbox, commands, health, targets, doctor, pipeline | orchestration, depend on ports |
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
ai_pending ─► summary + guard (+ rewrite) ─► route:
   guard failed · insufficient information · sensitive topic · confidence < 50 → pending_review
   mode manual → held · mode semi → pending_review · mode auto (thresholds met) → queued
   AI keeps failing (max_attempts) → pending_review without text · too old → expired
pending_review ─► ✅ → queued · 📤 → queued + publish_now · ✏️ → human text → pending_review
               · ❌ → rejected · nobody decides in time → expired
held ─► /publish id → queued · too old → expired
queued ─► claim ─► sent → published · definite failure → failed (retry while attempts left)
                 · unknown outcome → uncertain (never re-sent) · too old → expired
source-channel post ─► published before? ─► duplicate (owner told) | new ─► queued ─► copied
post made by hand in a target channel ─► external (a dedup reference only)
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

## 5. Data model (migrations `0001` Phase 1, `0002` Phase 2)

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

`articles` gained (0002): `summary_id`, `importance_score` + breakdown, `confidence_score` +
breakdown, `publish_mode`, `review_reason`, `approved_by`/`approved_at`, `publish_now`. The
migration moved Phase 1 feed items that were still waiting (queued/pending_review, no Persian
text) to `ai_pending`; downgrade maps the new statuses back.

Times are stored in UTC (`UTCDateTime` refuses naive datetimes); display is `Asia/Tehran` with a
Jalali date. JSON columns are JSONB on PostgreSQL.

Tables of later phases, each in its own migration: `story_clusters`, `cluster_articles`,
`claims`, `evidence`, `entities` (Phase 3, with `CREATE EXTENSION vector` and an `embedding`
column — claims are already stored per summary in Phase 2); `corrections`,
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
| Multi-source confidence, contradictions (Phase 3) | `confidence(independent_sources=…)` already takes the count; `summaries.claims` hold claims + evidence |
| Breaking 🔴 (Phase 4) | `SummaryPost.breaking` is rendered already; nothing sets it yet |
| Full rules engine (Phase 5) | `domain/editorial.route` is the single routing function to generalise |
| Story clusters, same-event dedup (Phase 3) | `EventMatcher` port, called after L1/L2 in `DedupService.check` |
| Update/correction posts (Phase 3/5) | `published_posts.message_ids` (reply target) |
| Webhook instead of polling | a second inbox adapter feeding the same `InboxService.process` |
| Other output languages | template module per language (`formatting/templates_<lang>.py`) |
| Mother bot | `MotherBot` port (`report_run`, `report_event`), called after each run; no-op now |

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
