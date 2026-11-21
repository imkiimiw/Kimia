"""One full pass (``run-once``): lock → sync config → inbox → ingest → classify/gate → publish.

Every stage is isolated: a failure is recorded and the next stage still runs. Every stage is
resumable: its input is a status in the database, so an interrupted run is simply continued.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from wanger_news.adapters.http.robots import RobotsChecker
from wanger_news.ai.provider import AIProvider
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import RunStatus, Transport
from wanger_news.ports import (
    BotApi,
    Clock,
    EventMatcher,
    FeedFetcher,
    MotherBot,
    NullEventMatcher,
    NullMotherBot,
)
from wanger_news.services.ai_stage import AIStage
from wanger_news.services.commands import PAUSED_KEY, TARGET_KEY, CommandService
from wanger_news.services.context import RunContext, Target
from wanger_news.services.dedup import DedupService
from wanger_news.services.inbox import InboxService
from wanger_news.services.ingest import HealthSnapshot, IngestService
from wanger_news.services.processing import ProcessingService
from wanger_news.services.publish import PublishService
from wanger_news.services.review import ReviewService
from wanger_news.services.stories import StoryService
from wanger_news.services.targets import TargetError, resolve_target

log = logging.getLogger("wanger_news.pipeline")
LOCK_NAME = "pipeline"


@dataclass(frozen=True, slots=True)
class RunOptions:
    dry_run: bool = False
    trigger: str = "manual"
    max_posts: int | None = None
    only_sources: frozenset[str] | None = None
    skip_telegram: bool = False


@dataclass(slots=True)
class RunSummary:
    run_id: str
    status: RunStatus
    counters: dict[str, int] = field(default_factory=dict)
    sources: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status.value,
            "counters": self.counters,
            "sources": self.sources,
            "errors": self.errors,
        }


@dataclass(slots=True)
class Deps:
    config: AppConfig
    engine: AsyncEngine
    clock: Clock
    fetcher: FeedFetcher
    robots: RobotsChecker | None
    bot: BotApi | None
    target: Target | None
    observed_chats: list[ChatRef]
    owner_id: int
    admin_ids: frozenset[int]
    events: EventMatcher = field(default_factory=NullEventMatcher)
    mother: MotherBot = field(default_factory=NullMotherBot)
    ai: AIProvider | None = None
    #: configured channels by role; when given, the target is chosen per run (/settings target)
    channels: dict[str, ChatRef | None] = field(default_factory=dict)
    default_target: str = "test"
    out: Callable[[str], None] = print
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep


class Pipeline:
    def __init__(self, deps: Deps) -> None:
        self.d = deps
        cfg = deps.config
        self.dedup = DedupService(cfg.pipeline.dedup, deps.events)
        self.ingest = IngestService(cfg, deps.fetcher, deps.robots, self.dedup)
        self.processing = ProcessingService(cfg)
        self.publisher = PublishService(cfg, sleep=deps.sleep)
        self.stories = StoryService(cfg, deps.ai, sleep=deps.sleep)
        self.ai = AIStage(cfg, deps.ai, sleep=deps.sleep, stories=self.stories)
        self.review = ReviewService(cfg, self.publisher.posts)
        self.commands = CommandService(cfg, self.review)
        self.inbox = InboxService(cfg, self.dedup, self.commands, self.review)

    @asynccontextmanager
    async def _session(self, dry_run: bool) -> AsyncIterator[AsyncSession]:
        """Dry run: everything happens inside one outer transaction that is rolled back."""
        if not dry_run:
            async with AsyncSession(self.d.engine, expire_on_commit=False) as session:
                yield session
            return
        async with self.d.engine.connect() as conn:
            outer = await conn.begin()
            session = AsyncSession(
                bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
            )
            try:
                yield session
            finally:
                await session.close()
                await outer.rollback()

    def _context(self, run_id: str, opts: RunOptions) -> RunContext:
        return RunContext(
            run_id=run_id,
            config=self.d.config,
            clock=self.d.clock,
            dry_run=opts.dry_run,
            owner_id=self.d.owner_id,
            admin_ids=self.d.admin_ids,
            bot=None if opts.skip_telegram else self.d.bot,
            target=self.d.target,
            observed_chats=self.d.observed_chats,
            channels=dict(self.d.channels),
            out=self.d.out,
            max_posts=opts.max_posts,
            only_sources=opts.only_sources,
        )

    async def run_once(self, opts: RunOptions) -> RunSummary:
        run_id = f"{self.d.clock.now():%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:8]}"
        ctx = self._context(run_id, opts)
        cfg = self.d.config.pipeline
        async with self._session(opts.dry_run) as session:
            repos = Repositories(session)
            ttl = timedelta(minutes=cfg.locks.pipeline_ttl_minutes)
            if not opts.dry_run:
                if not await repos.locks.acquire(LOCK_NAME, run_id, ctx.now(), ttl):
                    await repos.commit()
                    log.warning("run_skipped_locked", extra={"run_id": run_id})
                    return RunSummary(run_id, RunStatus.SKIPPED_LOCKED)
                await repos.commit()
            await repos.runs.start(run_id, ctx.now(), dry_run=opts.dry_run, trigger=opts.trigger)
            await repos.commit()
            summary = RunSummary(run_id, RunStatus.OK)
            try:
                await self._stage(repos, ctx, "sync", self._sync(repos, ctx))
                ctx.target = await self._target(repos, ctx)
                await self.dedup.prepare(repos, ctx.now())
                if ctx.bot is not None:
                    await self._stage(repos, ctx, "inbox", self._inbox(repos, ctx))
                await self._stage(repos, ctx, "ingest", self._ingest(repos, ctx, summary))
                await self._stage(repos, ctx, "classify", self._classify(repos, ctx))
                await self._stage(repos, ctx, "cluster", self._cluster(repos, ctx))
                await self._stage(repos, ctx, "ai", self._ai(repos, ctx))
                if ctx.bot is not None or ctx.dry_run:
                    await self._stage(repos, ctx, "review", self._review(repos, ctx))
                await self._stage(repos, ctx, "publish", self._publish(repos, ctx))
                if not opts.dry_run:
                    await self._stage(repos, ctx, "maintenance", self._maintenance(repos, ctx))
            finally:
                summary.counters = dict(ctx.counters)
                summary.errors = ctx.errors
                if ctx.errors:
                    summary.status = RunStatus.PARTIAL
                active_rss = [
                    s for s in self.d.config.active_sources if s.transport is Transport.RSS
                ]
                fetched = [v for v in summary.sources.values() if v.get("ok") is not None]
                if any(not v["ok"] for v in fetched):
                    summary.status = RunStatus.PARTIAL
                if active_rss and fetched and not any(v["ok"] for v in fetched):
                    summary.status = RunStatus.FAILED
                await repos.runs.finish(run_id, summary.status, ctx.now(), summary.as_dict())
                if not opts.dry_run:
                    await repos.locks.release(LOCK_NAME, run_id)
                await repos.commit()
        try:
            await self.d.mother.report_run(summary.as_dict())
        except Exception:  # the mother-bot link must never fail a run
            log.exception("mother_bot_report_failed", extra={"run_id": run_id})
        log.info(
            "run_finished",
            extra={"run_id": run_id, "status": summary.status.value, "counters": summary.counters},
        )
        return summary

    async def _stage(
        self, repos: Repositories, ctx: RunContext, name: str, work: Awaitable[None]
    ) -> None:
        try:
            await work
        except Exception as exc:
            await repos.rollback()
            ctx.error(f"stage {name}: {type(exc).__name__}: {str(exc)[:200]}")
            log.exception("stage_failed", extra={"run_id": ctx.run_id, "stage": name})
            try:
                await repos.logs.add(
                    "error",
                    f"stage_failed:{name}",
                    ctx.now(),
                    ctx.run_id,
                    {"error": f"{type(exc).__name__}: {str(exc)[:300]}"},
                )
                await repos.commit()
            except Exception:  # the database itself may be what failed
                await repos.rollback()

    # ---------------------------------------------------------------- stages
    async def _sync(self, repos: Repositories, ctx: RunContext) -> None:
        await repos.sources.sync(self.d.config.sources.sources, ctx.now())
        await repos.admins.sync(self.d.owner_id, self.d.admin_ids, ctx.now())
        await repos.commit()

    async def _inbox(self, repos: Repositories, ctx: RunContext) -> None:
        ctx.count("updates_stored", await self.inbox.poll(repos, ctx))
        for key, value in (await self.inbox.process(repos, ctx)).items():
            ctx.count(f"updates_{key}", value)

    async def _ingest(self, repos: Repositories, ctx: RunContext, summary: RunSummary) -> None:
        health = await repos.sources.all_health()
        due, skipped = self.ingest.due_sources(ctx, health)
        for source_id, reason in skipped.items():
            summary.sources[source_id] = {"skipped": reason}
        snapshots = {
            sid: HealthSnapshot(h.etag, h.last_modified, h.robots_allowed, h.robots_checked_at)
            for sid, h in health.items()
        }
        fetches = await self.ingest.fetch_all(ctx, due, snapshots)
        for fetch in fetches:
            try:
                report = await self.ingest.store(repos, ctx, fetch)
                await repos.commit()
            except Exception as exc:  # one source's data must not roll back the others
                await repos.rollback()
                log.exception("source_store_failed", extra={"source": fetch.source.id})
                ctx.error(f"source {fetch.source.id}: {type(exc).__name__}")
                summary.sources[fetch.source.id] = {"ok": False, "error": type(exc).__name__}
                continue
            summary.sources[fetch.source.id] = {
                "ok": report.ok,
                "entries": report.entries,
                "new": report.new,
                **({"error": report.error} if report.error else {}),
                **report.counts,
            }
            ctx.count("sources_ok" if report.ok else "sources_failed")
            ctx.count("articles_new", report.new)

    async def _target(self, repos: Repositories, ctx: RunContext) -> Target | None:
        """Test or main channel: /settings target (stored) over WANGER_NEWS_PUBLISH_TARGET."""
        if not self.d.channels:
            return self.d.target
        role = str(await repos.settings.get(TARGET_KEY) or self.d.default_target)
        try:
            return resolve_target(
                self.d.channels.get("test"), self.d.channels.get("main"), want_main=role == "main"
            )
        except TargetError as exc:
            ctx.error(f"target: {exc}")
            return None

    async def _cluster(self, repos: Repositories, ctx: RunContext) -> None:
        report = await self.stories.run(repos, ctx)
        if report.skipped:
            ctx.counters[f"stories_skipped:{report.skipped[:60]}"] = 1
        ctx.count("stories_embedded", report.embedded)
        ctx.count("stories_new", report.new_stories)
        for role, n in report.joined.items():
            ctx.count(f"stories_{role}", n)

    async def _ai(self, repos: Repositories, ctx: RunContext) -> None:
        report = await self.ai.run(repos, ctx)
        if report.skipped:
            ctx.counters[f"ai_skipped:{report.skipped}"] = 1
        if report.stopped:
            ctx.counters[f"ai_stopped:{report.stopped[:60]}"] = 1
        ctx.count("ai_calls", report.calls)
        ctx.count("ai_processed", report.processed)
        ctx.count("ai_cached", report.cached)
        ctx.count("ai_expired", report.expired)
        for key in ("updates", "corroborated", "detached", "waiting"):
            if getattr(report, key):
                ctx.count(f"ai_{key}", getattr(report, key))
        for status, n in report.routed.items():
            ctx.count(f"ai_routed_{status}", n)

    async def _review(self, repos: Repositories, ctx: RunContext) -> None:
        ctx.count("review_cards", await self.review.send_cards(repos, ctx))

    async def _classify(self, repos: Repositories, ctx: RunContext) -> None:
        for status, n in (await self.processing.run(repos, ctx)).items():
            ctx.count(f"classified_{status}", n)

    async def _publish(self, repos: Repositories, ctx: RunContext) -> None:
        paused = bool(await repos.settings.get(PAUSED_KEY, False))
        report = await self.publisher.run(repos, ctx, paused=paused)
        if report.skipped:
            ctx.counters[f"publish_skipped:{report.skipped}"] = 1
        for key in ("sent", "previewed", "failed", "uncertain", "expired"):
            ctx.count(f"posts_{key}", getattr(report, key))
        for error in report.errors:
            ctx.error(f"publish: {error}")

    async def _maintenance(self, repos: Repositories, ctx: RunContext) -> None:
        r = self.d.config.pipeline.retention
        removed = await repos.maintenance.purge(
            ctx.now(),
            articles_days=r.articles_days,
            jobs_days=r.jobs_days,
            updates_days=r.updates_days,
            logs_days=r.logs_days,
            batch=r.batch_size,
        )
        await repos.commit()
        for key, value in removed.items():
            if value:
                ctx.count(f"purged_{key}", value)
