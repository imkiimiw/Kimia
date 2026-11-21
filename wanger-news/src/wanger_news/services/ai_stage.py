"""TRANSLATE + SUMMARIZE → OUTPUT VALIDATION → route (spec §6, §9, §11).

For each batch of ``ai_pending`` items (highest priority first, fresh first):
1. summarize (one call for several items; a cached result for the same text is reused);
2. guard layer 1 (deterministic, domain/guard.py) + layer 2 (one AI ``verify`` call: every
   claim against its evidence, and statements the source does not support);
3. items with any issue get ONE ``rewrite`` without the unsupported parts, checked again;
4. scores (importance, confidence) and routing by publish mode / sensitivity / guard result.

Budget: per run and per provider day; a batch only starts when its summarize + verify calls fit.
Quota exhausted or provider down → the rest stays ``ai_pending`` for the next run. Nothing that
failed a check, or was only half processed, is ever routed to automatic publishing.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, TypeVar
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from wanger_news.ai.provider import (
    AIBlocked,
    AIBudgetExhausted,
    AIError,
    AIInvalidOutput,
    AIProvider,
    AIResult,
    AIUnavailable,
)
from wanger_news.config.models import AppConfig, PublishModes
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import AIRun, Article, Summary
from wanger_news.domain import guard as guard_layer1
from wanger_news.domain.editorial import route
from wanger_news.domain.enums import (
    AIRunStatus,
    ArticleStatus,
    JobStatus,
    SourceType,
    Stage,
    SummaryOrigin,
)
from wanger_news.domain.guard import GuardReport
from wanger_news.domain.scoring import confidence, importance
from wanger_news.domain.summary import SummaryDraft
from wanger_news.services.context import RunContext

log = logging.getLogger("wanger_news.ai")
T = TypeVar("T", bound=BaseModel)
MODES_KEY = "editorial.modes"
CALLS_PER_BATCH = {True: 2, False: 1}  # verify on/off: summarize (+ verify) must fit


@dataclass(slots=True)
class AIReport:
    processed: int = 0
    cached: int = 0
    calls: int = 0
    routed: dict[str, int] = field(default_factory=dict)
    expired: int = 0
    skipped: str | None = None
    stopped: str | None = None


class Budget:
    def __init__(self, calls: int) -> None:
        self.left = max(0, calls)

    def fits(self, calls: int) -> bool:
        return self.left >= calls

    def take(self) -> None:
        if self.left <= 0:
            raise AIBudgetExhausted("AI budget for this run is used up")
        self.left -= 1


@dataclass(slots=True)
class Item:
    """One article on its way through the stage."""

    article: Article
    key: str  # the id the model sees
    source: str  # exactly the text the model was given (the guard checks against it)
    source_hash: str
    draft: SummaryDraft | None = None
    report: GuardReport = field(default_factory=GuardReport)
    origin: SummaryOrigin = SummaryOrigin.AI
    rewritten: bool = False
    model: str | None = None
    failure: str | None = None


def modes_from(config: AppConfig, override: Any) -> PublishModes:
    """config/editorial.yaml, with the /settings overrides stored in the database on top."""
    base = config.editorial.publish_modes
    if not isinstance(override, dict):
        return base
    categories = {**base.categories, **(override.get("categories") or {})}
    return PublishModes.model_validate(
        {"default": override.get("default", base.default), "categories": categories}
    )


class AIStage:
    def __init__(
        self,
        config: AppConfig,
        provider: AIProvider | None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._cfg = config
        self._ai = config.pipeline.ai
        self._provider = provider
        self._sleep = sleep
        self._categories = [c.id for c in config.categories.categories]
        self._calls_made = 0
        self._stop: str | None = None  # set when the provider fails mid-batch

    # ---------------------------------------------------------------- entry point
    async def run(self, repos: Repositories, ctx: RunContext) -> AIReport:
        report = AIReport()
        await self._expire(repos, ctx, report)
        if not self._ai.enabled:
            report.skipped = "ai disabled in config"
            return report
        if self._provider is None:
            report.skipped = "no AI provider (WANGER_NEWS_GEMINI_API_KEY not set)"
            return report
        budget = await self._budget(repos, ctx)
        modes = modes_from(self._cfg, await repos.settings.get(MODES_KEY))
        per_batch = CALLS_PER_BATCH[self._ai.verify]
        size = self._ai.articles_per_call
        candidates = await repos.articles.by_status(
            ArticleStatus.AI_PENDING, max(1, budget.left) * size, newest_first=True
        )
        if not candidates:
            return report
        for start in range(0, len(candidates), size):
            batch = candidates[start : start + size]
            cached = await self._from_cache(repos, ctx, batch, modes, report)
            todo = [a for a in batch if a.id not in cached]
            if not todo:
                await repos.commit()
                continue
            if not budget.fits(per_batch):
                report.stopped = "budget"
                break
            try:
                await self._process(repos, ctx, budget, todo, modes, report)
                await repos.commit()
                if self._stop:
                    raise AIUnavailable(self._stop)
            except AIBudgetExhausted as exc:
                await repos.commit()  # keep what was recorded (ai_runs)
                report.stopped = f"quota: {exc}"
                await ctx.event(repos, "warning", "ai_quota", error=str(exc)[:200])
                await repos.commit()
                break
            except AIUnavailable as exc:
                await repos.commit()
                report.stopped = f"unavailable: {exc}"
                ctx.error(f"ai: {exc}")
                await ctx.event(repos, "error", "ai_unavailable", error=str(exc)[:300])
                await repos.commit()
                break
        report.calls = self._calls_made
        return report

    async def _budget(self, repos: Repositories, ctx: RunContext) -> Budget:
        reset = _quota_day_start(ctx.now(), self._ai.quota_reset_timezone)
        used_today = await repos.ai_runs.calls_since(reset)
        per_run = self._ai.dry_run_max_calls if ctx.dry_run else self._ai.max_calls_per_run
        return Budget(min(per_run, self._ai.max_calls_per_day - used_today))

    async def _expire(self, repos: Repositories, ctx: RunContext, report: AIReport) -> None:
        limit = ctx.now() - timedelta(hours=self._cfg.pipeline.publish.max_publish_age_hours)
        for article in await repos.articles.by_status(ArticleStatus.AI_PENDING, 500):
            if article.effective_at < limit:
                await repos.articles.set_status(
                    article, ArticleStatus.EXPIRED, ctx.now(), "too old for the AI stage"
                )
                report.expired += 1
        await repos.commit()

    # ---------------------------------------------------------------- calls
    async def _call(
        self,
        repos: Repositories,
        ctx: RunContext,
        budget: Budget,
        operation: str,
        items: Sequence[Item],
        work: Callable[[], Awaitable[AIResult[T]]],
    ) -> AIResult[T]:
        assert self._provider is not None
        budget.take()
        if self._calls_made:
            await self._sleep(60.0 / self._ai.requests_per_minute)
        self._calls_made += 1
        started = ctx.now()
        record = AIRun(
            run_id=ctx.run_id,
            provider=self._provider.name,
            model=self._provider.model_for(operation),
            operation=operation,
            prompt_version=self._provider.prompt_version(
                operation, self._ai.output_language if operation != "verify" else "any"
            ),
            article_ids=[i.article.id for i in items],
            started_at=started,
        )
        try:
            result = await work()
        except AIError as exc:
            record.status = exc.status
            record.error = str(exc)[:2000]
            record.response_excerpt = exc.raw[:4000] or None
            self._usage(record, exc.usage)
            record.finished_at = ctx.now()
            await repos.ai_runs.add(record)
            raise
        record.status = AIRunStatus.OK.value
        record.response_excerpt = result.raw[:4000]
        self._usage(record, result.usage)
        record.finished_at = ctx.now()
        await repos.ai_runs.add(record)
        return result

    @staticmethod
    def _usage(record: AIRun, usage: Any) -> None:
        if usage is None:
            record.input_tokens = record.output_tokens = record.thinking_tokens = 0
            record.cost_usd = 0.0
            return
        record.model = usage.model
        record.prompt_version = usage.prompt_version
        record.input_tokens = usage.input_tokens
        record.output_tokens = usage.output_tokens
        record.thinking_tokens = usage.thinking_tokens
        record.cost_usd = usage.cost_usd

    # ---------------------------------------------------------------- batch
    def _item(self, article: Article) -> Item:
        body = article.description_original or article.content_original
        text = f"{article.title_original}\n\n{body}".strip()[: self._ai.max_input_chars_per_article]
        return Item(
            article=article,
            key=f"a{article.id}",
            source=text,
            source_hash="sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest(),
        )

    async def _from_cache(
        self,
        repos: Repositories,
        ctx: RunContext,
        batch: list[Article],
        modes: PublishModes,
        report: AIReport,
    ) -> set[int]:
        done: set[int] = set()
        if self._provider is None:
            return done
        version = self._provider.prompt_version("summarize", self._ai.output_language)
        for article in batch:
            item = self._item(article)
            hit = await repos.summaries.cached(item.source_hash, version, self._ai.output_language)
            if hit is None:
                continue
            item.draft = _draft_of(hit)
            item.report = GuardReport.from_dict(hit.guard)
            item.origin = SummaryOrigin(hit.origin)
            item.rewritten = hit.origin == SummaryOrigin.REWRITE.value
            item.model = hit.model
            await self._finish(repos, ctx, item, modes, report, reuse=hit)
            report.cached += 1
            done.add(article.id)
        return done

    async def _process(
        self,
        repos: Repositories,
        ctx: RunContext,
        budget: Budget,
        articles: list[Article],
        modes: PublishModes,
        report: AIReport,
    ) -> None:
        assert self._provider is not None
        items = [self._item(a) for a in articles]
        try:
            await self._summarize(repos, ctx, budget, items)
        except (AIBlocked, AIInvalidOutput) as exc:
            if len(items) > 1:  # one bad item must not sink the batch: retry one by one
                for item in items:
                    if not budget.fits(CALLS_PER_BATCH[self._ai.verify]):
                        return
                    await self._process(repos, ctx, budget, [item.article], modes, report)
                return
            items[0].failure = f"{exc.status}: {exc}"
        for item in items:
            if item.draft is not None:
                item.report = guard_layer1.check(
                    item.draft, [item.source], self._cfg.pipeline.guard
                )
        drafted = [i for i in items if i.draft is not None]
        await self._verify(repos, ctx, budget, drafted)
        failing = [i for i in drafted if not i.report.passed]
        if failing and self._ai.rewrite_on_failure:
            await self._rewrite(repos, ctx, budget, failing)
        for item in items:
            if item.draft is None:
                await self._failed(repos, ctx, item, report)
            else:
                await self._finish(repos, ctx, item, modes, report)

    async def _summarize(
        self, repos: Repositories, ctx: RunContext, budget: Budget, items: list[Item]
    ) -> None:
        assert self._provider is not None
        provider = self._provider
        payload = [self._summary_input(i) for i in items]
        result = await self._call(
            repos,
            ctx,
            budget,
            "summarize",
            items,
            lambda: provider.summarize(
                payload, language=self._ai.output_language, categories=self._categories
            ),
        )
        by_key = _by_id(result.data.articles, items)
        for item in items:
            answer = by_key.get(item.key)
            if answer is None:
                item.failure = "invalid_output: the answer had no item with this id"
                continue
            item.draft = SummaryDraft.model_validate(answer.model_dump(exclude={"id"})).cleaned()
            item.model = result.usage.model

    def _summary_input(self, item: Item) -> dict[str, Any]:
        article = item.article
        source = self._cfg.source(article.source_id)
        long = article.priority >= self._ai.long_summary_min_importance
        return {
            "id": item.key,
            "source": source.name if source else article.source_id,
            "source_language": article.language,
            "published": article.effective_at.isoformat(timespec="minutes"),
            "length": "long" if long else "short",
            "text": item.source,
        }

    async def _verify(
        self, repos: Repositories, ctx: RunContext, budget: Budget, items: list[Item]
    ) -> None:
        """Guard layer 2. Unavailable verification is an issue, never a pass."""
        if not self._ai.verify or not items:
            return
        assert self._provider is not None
        provider = self._provider
        payload = [
            {
                "id": i.key,
                "source_text": i.source,
                "draft": {
                    "title": i.draft.title,
                    "summary": i.draft.summary,
                    "key_points": i.draft.key_points,
                }
                if i.draft
                else {},
                "claims": [
                    {"index": n, "text": c.text}
                    for n, c in enumerate(i.draft.claims if i.draft else [])
                ],
            }
            for i in items
        ]
        try:
            result = await self._call(
                repos, ctx, budget, "verify", items, lambda: provider.verify(payload)
            )
        except AIError as exc:
            # Never a pass: the drafts go to a human. A provider failure (quota, outage) also
            # stops the stage after this batch; our own budget running out does not.
            for item in items:
                item.report.add("verification_unavailable", str(exc)[:120])
            ours = isinstance(exc, AIBudgetExhausted) and budget.left == 0
            if isinstance(exc, (AIBudgetExhausted, AIUnavailable)) and not ours:
                self._stop = str(exc)
            return
        by_key = _by_id(result.data.articles, items)
        for item in items:
            verdict = by_key.get(item.key)
            if verdict is None:
                item.report.add("verification_unavailable", "no verdict for this item")
                continue
            claims = item.draft.claims if item.draft else []
            for judged in verdict.claims:
                if not judged.supported and judged.index < len(claims):
                    item.report.add("unsupported_claim", claims[judged.index].text)
            for statement in verdict.unsupported_statements:
                if statement.strip():
                    item.report.add("unsupported_statement", statement)

    async def _rewrite(
        self, repos: Repositories, ctx: RunContext, budget: Budget, items: list[Item]
    ) -> None:
        if not budget.fits(1 + (1 if self._ai.verify else 0)):
            return  # no room to rewrite AND re-verify: a human takes it
        assert self._provider is not None
        provider = self._provider
        payload = [
            {
                "id": i.key,
                "source_text": i.source,
                "draft": i.draft.model_dump() if i.draft else {},
                "problems": guard_layer1.unsupported_parts(i.report),
            }
            for i in items
        ]
        try:
            result = await self._call(
                repos,
                ctx,
                budget,
                "rewrite",
                items,
                lambda: provider.rewrite(
                    payload, language=self._ai.output_language, categories=self._categories
                ),
            )
        except AIError as exc:  # keep the failed drafts and their reports: they go to a human
            if isinstance(exc, (AIBudgetExhausted, AIUnavailable)):
                self._stop = str(exc)
            return
        by_key = _by_id(result.data.articles, items)
        rewritten: list[Item] = []
        for item in items:
            answer = by_key.get(item.key)
            if answer is None:
                continue
            item.draft = SummaryDraft.model_validate(answer.model_dump(exclude={"id"})).cleaned()
            item.report = guard_layer1.check(item.draft, [item.source], self._cfg.pipeline.guard)
            item.origin = SummaryOrigin.REWRITE
            item.rewritten = True
            rewritten.append(item)
        await self._verify(repos, ctx, budget, [i for i in rewritten if i.report.passed])

    # ---------------------------------------------------------------- results
    async def _failed(
        self, repos: Repositories, ctx: RunContext, item: Item, report: AIReport
    ) -> None:
        now = ctx.now()
        article = item.article
        await repos.jobs.record(
            article.id, Stage.AI_SUMMARIZE, JobStatus.FAILED, ctx.run_id, now, error=item.failure
        )
        attempts = await repos.jobs.attempts(article.id, Stage.AI_SUMMARIZE)
        if attempts >= self._ai.max_attempts:
            article.review_reason = f"ai_failed: {item.failure}"[:300]
            await repos.articles.set_status(
                article, ArticleStatus.PENDING_REVIEW, now, article.review_reason
            )
            report.routed["pending_review"] = report.routed.get("pending_review", 0) + 1

    async def _finish(
        self,
        repos: Repositories,
        ctx: RunContext,
        item: Item,
        modes: PublishModes,
        report: AIReport,
        reuse: Summary | None = None,
    ) -> None:
        assert item.draft is not None
        now = ctx.now()
        article = item.article
        draft = item.draft
        cls = dict(article.classification or {})
        category = draft.category if draft.category in self._categories else article.category
        if category and category != article.category:
            cls["rule_category"] = article.category
            article.category = category
        cls["hashtags"] = self._hashtags(category, cls.get("hashtags") or [])
        article.classification = cls

        if reuse is not None and reuse.article_id == article.id:
            summary = reuse
        else:
            summary = await repos.summaries.add(
                Summary(
                    article_id=article.id,
                    language=self._ai.output_language,
                    origin=item.origin.value,
                    prompt_version=(
                        reuse.prompt_version if reuse is not None else self._prompt_version(item)
                    ),
                    model=item.model,
                    source_hash=item.source_hash,
                    title=draft.title,
                    summary=draft.summary,
                    key_points=draft.key_points,
                    entities=[e.model_dump() for e in draft.entities],
                    quotes=[q.model_dump() for q in draft.quotes],
                    claims=[c.model_dump() for c in draft.claims],
                    category=draft.category,
                    importance_factors=draft.importance.model_dump() if draft.importance else None,
                    insufficient=draft.insufficient_information,
                    guard=item.report.as_dict(),
                    valid=item.report.passed,
                    created_at=now,
                )
            )
        article.summary_id = summary.id

        source = self._cfg.source(article.source_id)
        age = (now - article.effective_at).total_seconds() / 3600
        imp = importance(article.priority, draft.importance, age, self._cfg.pipeline.scoring)
        guard_state = (
            "failed" if not item.report.passed else "after_rewrite" if item.rewritten else "passed"
        )
        conf = confidence(
            reliability=source.reliability_score if source else 50,
            source_type=source.source_type if source else SourceType.BLOG,
            quality=article.quality_score or 0,
            guard_state=guard_state,
            independent_sources=1,
            cfg=self._cfg.pipeline.scoring,
        )
        article.importance_score, article.importance = imp.value, imp.as_dict()
        article.confidence_score, article.confidence = conf.value, conf.as_dict()
        mode = modes.for_category(category)
        decided = route(
            mode=mode,
            sensitive_topics=list(cls.get("sensitive_topics") or []),
            guard_passed=item.report.passed,
            insufficient=draft.insufficient_information,
            confidence=conf.value,
            importance=imp.value,
            auto=self._cfg.editorial.auto_publish,
        )
        article.publish_mode = mode.value
        article.review_reason = (
            decided.reason if decided.status is not ArticleStatus.QUEUED else None
        )
        await repos.articles.set_status(article, decided.status, now, decided.reason)
        await repos.jobs.record(
            article.id,
            Stage.AI_SUMMARIZE,
            JobStatus.DONE,
            ctx.run_id,
            now,
            details={
                "summary_id": summary.id,
                "route": decided.reason,
                "guard": item.report.as_dict(),
                "cached": reuse is not None,
            },
        )
        report.processed += 1
        report.routed[decided.status.value] = report.routed.get(decided.status.value, 0) + 1

    def _prompt_version(self, item: Item) -> str:
        assert self._provider is not None
        operation = "rewrite" if item.origin is SummaryOrigin.REWRITE else "summarize"
        return self._provider.prompt_version(operation, self._ai.output_language)

    def _hashtags(self, category: str | None, existing: list[str]) -> list[str]:
        tags: list[str] = []
        main = self._cfg.categories.get(category or "")
        if main is not None:
            tags.append(main.hashtag)
        tags.extend(t for t in existing if t not in tags)
        return tags[: self._cfg.pipeline.classification.max_hashtags]


def _by_id(answers: Sequence[Any], items: Sequence[Item]) -> dict[str, Any]:
    """Answers keyed by id; only ids we asked for count (the model cannot add items)."""
    wanted = {i.key for i in items}
    out: dict[str, Any] = {}
    for answer in answers:
        if answer.id in wanted and answer.id not in out:
            out[answer.id] = answer
    return out


def _draft_of(summary: Summary) -> SummaryDraft:
    return SummaryDraft.model_validate(
        {
            "title": summary.title,
            "summary": summary.summary,
            "key_points": summary.key_points,
            "category": summary.category,
            "importance": summary.importance_factors,
            "entities": summary.entities,
            "quotes": summary.quotes,
            "claims": summary.claims,
            "insufficient_information": summary.insufficient,
        }
    )


def _quota_day_start(now: datetime, timezone: str) -> datetime:
    local = now.astimezone(ZoneInfo(timezone))
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(now.tzinfo)
