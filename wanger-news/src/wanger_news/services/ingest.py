"""FETCH → PARSE → NORMALIZE → VALIDATE → DEDUPLICATE for RSS sources.

Network work runs concurrently and touches no database; storing then runs source by source,
each in its own transaction, so one broken source can never stop (or roll back) the others.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from wanger_news.adapters.feeds.parser import FeedParseError, parse_feed
from wanger_news.adapters.http.fetcher import FetchError, FetchResult
from wanger_news.adapters.http.robots import RobotsChecker, RobotsDecision
from wanger_news.config.models import AppConfig, SourceConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import SourceHealth
from wanger_news.domain.article import ArticleDraft, Rejected, check_draft
from wanger_news.domain.enums import ArticleStatus, JobStatus, Stage, Transport
from wanger_news.domain.feed import ParsedFeed
from wanger_news.domain.normalize import entry_to_draft, url_policy
from wanger_news.ports import FeedFetcher
from wanger_news.services.context import RunContext
from wanger_news.services.dedup import DedupService, fingerprints_of
from wanger_news.services.health import may_attempt, record_failure, record_success

log = logging.getLogger("wanger_news.ingest")


@dataclass(frozen=True, slots=True)
class HealthSnapshot:
    """What the network phase may know about a source (read before, no DB during fetching)."""

    etag: str | None
    last_modified: str | None
    robots_allowed: bool | None
    robots_checked_at: datetime | None


@dataclass(slots=True)
class SourceFetch:
    source: SourceConfig
    started_at: datetime
    result: FetchResult | None = None
    feed: ParsedFeed | None = None
    error: str | None = None
    robots: RobotsDecision | None = None  # a fresh robots.txt decision (to be cached)
    blocked: str | None = None  # skipped because of a cached robots.txt decision


@dataclass(slots=True)
class SourceReport:
    source_id: str
    ok: bool
    entries: int = 0
    new: int = 0
    counts: dict[str, int] = field(default_factory=dict)
    error: str | None = None


class IngestService:
    def __init__(
        self,
        config: AppConfig,
        fetcher: FeedFetcher,
        robots: RobotsChecker | None,
        dedup: DedupService,
    ) -> None:
        self._cfg = config
        self._fetcher = fetcher
        self._robots = robots
        self._dedup = dedup
        self._policy = url_policy(config.pipeline.dedup)

    # ---------------------------------------------------------------- selection
    def due_sources(
        self, ctx: RunContext, health: dict[str, SourceHealth]
    ) -> tuple[list[SourceConfig], dict[str, str]]:
        due: list[SourceConfig] = []
        skipped: dict[str, str] = {}
        now = ctx.now()
        for source in ctx.config.active_sources:
            if source.transport is not Transport.RSS:
                continue
            if ctx.only_sources is not None and source.id not in ctx.only_sources:
                continue
            row = health.get(source.id)
            if row is not None:
                allowed, reason = may_attempt(row, source, now)
                if not allowed and ctx.only_sources is None:
                    skipped[source.id] = reason
                    continue
            due.append(source)
        due.sort(key=lambda s: -s.priority)
        return due, skipped

    # ---------------------------------------------------------------- network phase
    async def fetch_all(
        self, ctx: RunContext, sources: list[SourceConfig], snapshots: dict[str, HealthSnapshot]
    ) -> list[SourceFetch]:
        semaphore = asyncio.Semaphore(self._cfg.pipeline.http.concurrency)

        async def one(source: SourceConfig) -> SourceFetch:
            async with semaphore:
                return await self.fetch_one(ctx, source, snapshots.get(source.id))

        return list(await asyncio.gather(*(one(s) for s in sources)))

    async def fetch_one(
        self, ctx: RunContext, source: SourceConfig, snap: HealthSnapshot | None
    ) -> SourceFetch:
        outcome = SourceFetch(source=source, started_at=ctx.now())
        assert source.rss_url is not None  # guaranteed by SourceConfig validation
        try:
            if self._robots is not None:
                if not self._robots_fresh(ctx, snap):
                    outcome.robots = await self._robots.check(source.rss_url)
                    if not outcome.robots.allowed:
                        return outcome
                elif snap is not None and snap.robots_allowed is False:
                    outcome.blocked = "disallowed by robots.txt (cached)"
                    return outcome
            outcome.result = await self._fetcher.fetch(
                source.rss_url,
                etag=snap.etag if snap else None,
                last_modified=snap.last_modified if snap else None,
            )
            if not outcome.result.not_modified:
                outcome.feed = parse_feed(
                    outcome.result.body,
                    outcome.result.url,
                    self._cfg.pipeline.ingest.max_entries_per_feed,
                    outcome.result.content_type,
                )
        except (FetchError, FeedParseError) as exc:
            outcome.error = f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # isolation: nothing from one source escapes
            outcome.error = f"unexpected {type(exc).__name__}: {str(exc)[:200]}"
            log.exception("source_fetch_crashed", extra={"source": source.id})
        return outcome

    def _robots_fresh(self, ctx: RunContext, snap: HealthSnapshot | None) -> bool:
        if snap is None or snap.robots_checked_at is None or snap.robots_allowed is None:
            return False
        age = ctx.now() - snap.robots_checked_at
        return age < timedelta(hours=self._cfg.pipeline.http.robots_cache_hours)

    # ---------------------------------------------------------------- storing phase
    async def store(self, repos: Repositories, ctx: RunContext, fetch: SourceFetch) -> SourceReport:
        source = fetch.source
        now = ctx.now()
        health = await repos.sources.health(source.id, now)
        if fetch.robots is not None:
            health.robots_allowed = fetch.robots.allowed
            health.robots_reason = fetch.robots.reason[:200]
            health.robots_checked_at = now
            if not fetch.robots.allowed:
                health.last_attempt_at = now
                await ctx.event(
                    repos,
                    "warning",
                    "source_blocked_by_robots",
                    source=source.id,
                    reason=fetch.robots.reason,
                )
                return SourceReport(source.id, ok=False, error=fetch.robots.reason)
        if fetch.blocked is not None:
            return SourceReport(source.id, ok=False, error=fetch.blocked)
        if fetch.error is not None:
            opened = record_failure(health, now, fetch.error, self._cfg.pipeline.circuit_breaker)
            await ctx.event(
                repos,
                "warning",
                "source_failed",
                source=source.id,
                error=fetch.error,
                circuit_opened=opened,
                consecutive_failures=health.consecutive_failures,
            )
            return SourceReport(source.id, ok=False, error=fetch.error)
        assert fetch.result is not None
        health.etag = (fetch.result.etag or "")[:512] or None
        health.last_modified = (fetch.result.last_modified or "")[:128] or None
        if fetch.result.not_modified or fetch.feed is None:
            record_success(health, now, items=0, new=0)
            return SourceReport(source.id, ok=True)

        first_fetch = health.total_successes == 0
        report = await self._store_entries(repos, ctx, source, fetch.feed, first_fetch)
        record_success(health, now, items=len(fetch.feed.entries), new=report.new)
        if fetch.feed.warning:
            report.counts["malformed_but_usable"] = 1
        return report

    async def _store_entries(
        self,
        repos: Repositories,
        ctx: RunContext,
        source: SourceConfig,
        feed: ParsedFeed,
        first_fetch: bool,
    ) -> SourceReport:
        cfg = self._cfg.pipeline
        now = ctx.now()
        report = SourceReport(source.id, ok=True, entries=len(feed.entries))
        drafts: list[ArticleDraft] = []
        for entry in feed.entries:
            try:
                draft = entry_to_draft(entry, source, now, cfg.ingest, cfg.dedup, self._policy)
                drafts.append(check_draft(draft, cfg.ingest))
            except Rejected as exc:
                report.counts[f"rejected:{exc.reason}"] = (
                    report.counts.get(f"rejected:{exc.reason}", 0) + 1
                )
            except ValueError as exc:  # pydantic validation of untrusted feed data
                report.counts["rejected:invalid"] = report.counts.get("rejected:invalid", 0) + 1
                log.debug("entry_invalid", extra={"source": source.id, "error": str(exc)[:200]})
        # the same entry seen again (every run re-reads the feed) is simply skipped
        known = await repos.articles.known_external_ids(source.id, [d.external_id for d in drafts])
        unique: dict[str, ArticleDraft] = {}
        for draft in drafts:
            if draft.external_id not in known:
                unique.setdefault(draft.external_id, draft)
        fresh_limit = now - timedelta(hours=cfg.ingest.max_item_age_hours)
        statuses: dict[str, tuple[ArticleStatus, str | None]] = {}
        fresh: list[ArticleDraft] = []
        for draft in unique.values():
            if draft.published_at is not None and draft.published_at < fresh_limit:
                statuses[draft.external_id] = (ArticleStatus.STALE, "older than max_item_age")
            elif draft.published_at is None and first_fetch:
                statuses[draft.external_id] = (ArticleStatus.STALE, "undated, first fetch")
            else:
                fresh.append(draft)
        # anti-spam: an abnormal burst from one source is throttled (newest items kept)
        allowance = source.rate_limit.max_new_items_per_hour - await repos.articles.count_new_since(
            source.id, now - timedelta(hours=1)
        )
        fresh.sort(key=lambda d: d.effective_time, reverse=True)
        for index, draft in enumerate(fresh):
            if index >= max(0, allowance):
                statuses[draft.external_id] = (ArticleStatus.THROTTLED, "source burst limit")
            else:
                statuses[draft.external_id] = (ArticleStatus.NEW, None)
        if len(fresh) > max(0, allowance):
            await ctx.event(
                repos,
                "warning",
                "source_throttled",
                source=source.id,
                fresh=len(fresh),
                allowance=allowance,
            )

        for draft in sorted(unique.values(), key=lambda d: d.effective_time):
            status, reason = statuses[draft.external_id]
            hit = await self._dedup.check(repos, draft)
            article = await repos.articles.insert(draft, status, now, reason=reason)
            if hit is not None:
                await repos.articles.mark_duplicate(
                    article, hit.original_id, hit.level, now, hit.distance
                )
                status = ArticleStatus.DUPLICATE
            await repos.articles.add_fingerprints(article.id, fingerprints_of(draft), now)
            self._dedup.index.add(article)
            await repos.jobs.record(
                article.id,
                Stage.INGEST,
                JobStatus.DONE,
                ctx.run_id,
                now,
                details={"status": status.value},
            )
            report.counts[status.value] = report.counts.get(status.value, 0) + 1
            if status is ArticleStatus.NEW:
                report.new += 1
        return report
