"""TRANSLATE + SUMMARIZE → OUTPUT VALIDATION → route (spec §6, §8, §9, §11), per STORY.

Stories (Phase 3): a story's lead is summarised once its story has settled, from ALL its
sources (lead + supporting reports): claims cite the sources that state them, disagreements
are reported as contradictions (never resolved), a source about another event is sent back out
(``excluded_sources``). Published stories with new independent reports get an ``update`` call:
same event? anything new? If so, an update post (a reply to the story); if not, the reports
count as corroboration.

For every text: guard layer 1 (deterministic, domain/guard.py) + layer 2 (one AI ``verify``
call per batch) → ONE ``rewrite`` on any issue → checked again → else a human. Then claims and
evidence are stored, importance/confidence computed (independent origins, contradictions), and
the item is routed by publish mode and the safety rules.

Budget: per run, per provider day and per minute; a batch only starts when its summarize +
verify calls fit. Quota exhausted or provider down → the rest stays ``ai_pending``.
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
from wanger_news.db.tables import AIRun, Article, Claim, Evidence, StoryCluster, Summary
from wanger_news.domain import guard as guard_layer1
from wanger_news.domain.breaking import decide as decide_breaking
from wanger_news.domain.claims import CONFLICTING, claim_confidence, claim_status
from wanger_news.domain.editorial import apply_rules, route
from wanger_news.domain.enums import (
    AIRunStatus,
    ArticleStatus,
    ClusterRole,
    DedupLevel,
    JobStatus,
    SourceType,
    Stage,
    SummaryOrigin,
)
from wanger_news.domain.guard import GuardReport
from wanger_news.domain.independence import Origin, origins
from wanger_news.domain.rules import Facts
from wanger_news.domain.rules import evaluate as evaluate_rules
from wanger_news.domain.scoring import confidence, importance
from wanger_news.domain.summary import SummaryDraft
from wanger_news.services.context import RunContext
from wanger_news.services.stories import StoryService, timeline_event

log = logging.getLogger("wanger_news.ai")
T = TypeVar("T", bound=BaseModel)
MODES_KEY = "editorial.modes"
CALLS_PER_BATCH = {True: 2, False: 1}  # verify on/off: the first call (+ verify) must fit
STORY, UPDATE = "story", "update"


@dataclass(slots=True)
class AIReport:
    processed: int = 0
    cached: int = 0
    calls: int = 0
    updates: int = 0
    corroborated: int = 0
    detached: int = 0
    waiting: int = 0
    corrections: int = 0  # Phase 5: proposals waiting for a human
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
    """One story (or one update to a story) on its way through the stage."""

    article: Article  # the lead (story) or the representative new report (update)
    key: str  # the id the model sees
    kind: str
    meta: list[dict[str, Any]]  # the sources as sent to the model
    sources: dict[str, str]  # source id → exactly the text the model saw (the guard checks it)
    source_hash: str
    members: list[Article] = field(default_factory=list)  # supports, or the other new reports
    story: StoryCluster | None = None
    previous: dict[str, Any] | None = None
    draft: SummaryDraft | None = None
    report: GuardReport = field(default_factory=GuardReport)
    origin: SummaryOrigin = SummaryOrigin.AI
    rewritten: bool = False
    model: str | None = None
    failure: str | None = None
    done: bool = False  # decided without a text (corroboration, detached)

    @property
    def size(self) -> int:
        return sum(len(t) for t in self.sources.values())


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
        stories: StoryService | None = None,
        corrections: Any = None,  # CorrectionService (Phase 5)
    ) -> None:
        self._cfg = config
        self._corrections = corrections
        self._ai = config.pipeline.ai
        self._story = config.pipeline.story
        self._provider = provider
        self._sleep = sleep
        self._stories = stories or StoryService(config, provider, sleep)
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
        stories = await self._story_items(repos, ctx, budget, report)
        stopped = await self._run_batches(repos, ctx, budget, stories, modes, report)
        if not stopped:
            updates = await self._update_items(repos, ctx)
            await self._run_batches(repos, ctx, budget, updates, modes, report)
        report.calls = self._calls_made
        return report

    async def _run_batches(
        self,
        repos: Repositories,
        ctx: RunContext,
        budget: Budget,
        items: list[Item],
        modes: PublishModes,
        report: AIReport,
    ) -> bool:
        """Returns True when the stage must stop (budget, quota, outage)."""
        per_batch = CALLS_PER_BATCH[self._ai.verify]
        for batch in self._batches(items):
            todo = [i for i in batch if not await self._from_cache(repos, ctx, i, modes, report)]
            if not todo:
                await repos.commit()
                continue
            if not budget.fits(per_batch):
                report.stopped = "budget"
                return True
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
                return True
            except AIUnavailable as exc:
                await repos.commit()
                report.stopped = f"unavailable: {exc}"
                ctx.error(f"ai: {exc}")
                await ctx.event(repos, "error", "ai_unavailable", error=str(exc)[:300])
                await repos.commit()
                return True
        return False

    def _batches(self, items: list[Item]) -> list[list[Item]]:
        """Several items per call, within the item count and the character budget."""
        batches: list[list[Item]] = []
        current: list[Item] = []
        size = 0
        for item in items:
            too_many = len(current) >= self._ai.articles_per_call
            too_big = current and size + item.size > self._story.max_input_chars_per_call
            if too_many or too_big:
                batches.append(current)
                current, size = [], 0
            current.append(item)
            size += item.size
        if current:
            batches.append(current)
        return batches

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

    # ---------------------------------------------------------------- items
    def _meta(self, article: Article, *, previous: bool = False) -> dict[str, Any]:
        body = article.description_original or article.content_original
        text = f"{article.title_original}\n\n{body}".strip()[: self._ai.max_input_chars_per_article]
        source = self._cfg.source(article.source_id)
        meta: dict[str, Any] = {
            "source_id": f"s{article.id}",
            "outlet": source.name if source else article.source_id,
            "language": article.language,
            "published": article.effective_at.isoformat(timespec="minutes"),
            "text": text,
        }
        if previous:
            meta["previous"] = True
        return meta

    def _make(
        self,
        article: Article,
        kind: str,
        metas: list[dict[str, Any]],
        members: list[Article],
        story: StoryCluster | None,
        previous: dict[str, Any] | None = None,
    ) -> Item:
        joined = "\n\x1e".join(f"{m['source_id']}\n{m['text']}" for m in metas)
        return Item(
            article=article,
            key=f"a{article.id}",
            kind=kind,
            meta=metas,
            sources={m["source_id"]: m["text"] for m in metas},
            source_hash="sha256:" + hashlib.sha256(joined.encode("utf-8")).hexdigest(),
            members=members,
            story=story,
            previous=previous,
        )

    def _reliability(self, article: Article) -> int:
        source = self._cfg.source(article.source_id)
        return source.reliability_score if source else 50

    async def _story_items(
        self, repos: Repositories, ctx: RunContext, budget: Budget, report: AIReport
    ) -> list[Item]:
        size = max(1, budget.left) * self._ai.articles_per_call
        items: list[Item] = []
        for article in await repos.articles.by_status(
            ArticleStatus.AI_PENDING, size * 4 + 20, newest_first=True
        ):
            if article.cluster_role == ClusterRole.UPDATE.value:
                continue
            story = await repos.stories.get(article.cluster_id)
            if not self._settled(article, story, ctx.now()):
                report.waiting += 1
                continue
            supports: list[Article] = []
            if story is not None:
                supports = [
                    m
                    for m in await repos.stories.members(story.id)
                    if m.cluster_role == ClusterRole.SUPPORT.value and m.id != article.id
                ]
                supports.sort(key=lambda m: (-self._reliability(m), m.id))
                supports = supports[: self._story.max_sources_per_story - 1]
            metas = [self._meta(article), *(self._meta(m) for m in supports)]
            items.append(self._make(article, STORY, metas, supports, story))
            if len(items) >= size:
                break
        return items

    def _settled(self, article: Article, story: StoryCluster | None, now: datetime) -> bool:
        """Wait a little for more sources before summarising (urgent news does not wait)."""
        if story is None or not self._story.enabled:
            return True
        if article.priority >= self._story.settle_skip_priority:
            return True
        return now - story.last_updated >= timedelta(minutes=self._story.settle_minutes)

    async def _update_items(self, repos: Repositories, ctx: RunContext) -> list[Item]:
        groups: dict[int, list[Article]] = {}
        for article in await repos.stories.by_role(
            ClusterRole.UPDATE.value, ArticleStatus.AI_PENDING, 200
        ):
            if article.cluster_id is not None:
                groups.setdefault(article.cluster_id, []).append(article)
        items: list[Item] = []
        for cluster_id, reports in groups.items():
            story = await repos.stories.get(cluster_id)
            if story is None or story.published_at is None:
                continue  # the story is not out yet: these wait
            reports.sort(key=lambda a: (-self._reliability(a), a.effective_at, a.id))
            reports = reports[: self._story.max_sources_per_story]
            lead = (
                await repos.articles.get(story.lead_article_id)
                if story.lead_article_id is not None
                else None
            )
            metas = []
            if lead is not None and lead.transport == "rss":
                metas.append(self._meta(lead, previous=True))
            metas.extend(self._meta(a) for a in reports)
            previous = story.published_text or {"title": story.title or "", "summary": ""}
            items.append(self._make(reports[0], UPDATE, metas, reports[1:], story, previous))
        return items

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
        record = AIRun(
            run_id=ctx.run_id,
            provider=self._provider.name,
            model=self._provider.model_for(operation),
            operation=operation,
            prompt_version=self._provider.prompt_version(
                operation, self._ai.output_language if operation != "verify" else "any"
            ),
            article_ids=[a.id for i in items for a in (i.article, *i.members)],
            started_at=ctx.now(),
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
    async def _from_cache(
        self,
        repos: Repositories,
        ctx: RunContext,
        item: Item,
        modes: PublishModes,
        report: AIReport,
    ) -> bool:
        """A valid summary of exactly these sources with this prompt is reused (stories only)."""
        if self._provider is None or item.kind != STORY:
            return False
        version = self._provider.prompt_version("summarize", self._ai.output_language)
        hit = await repos.summaries.cached(item.source_hash, version, self._ai.output_language)
        if hit is None:
            return False
        item.draft = _draft_of(hit)
        item.report = GuardReport.from_dict(hit.guard)
        item.origin = SummaryOrigin(hit.origin)
        item.rewritten = hit.origin == SummaryOrigin.REWRITE.value
        item.model = hit.model
        await self._finish(repos, ctx, item, modes, report, reuse=hit)
        report.cached += 1
        return True

    async def _process(
        self,
        repos: Repositories,
        ctx: RunContext,
        budget: Budget,
        items: list[Item],
        modes: PublishModes,
        report: AIReport,
    ) -> None:
        assert self._provider is not None
        try:
            await self._first_call(repos, ctx, budget, items)
        except (AIBlocked, AIInvalidOutput) as exc:
            if len(items) > 1:  # one bad item must not sink the batch: retry one by one
                for item in items:
                    if not budget.fits(CALLS_PER_BATCH[self._ai.verify]):
                        return
                    await self._process(repos, ctx, budget, [item], modes, report)
                return
            items[0].failure = f"{exc.status}: {exc}"
        for item in items:
            if item.kind == UPDATE and item.draft is not None:
                await self._decide_update(repos, ctx, item, report)
        active = [i for i in items if i.draft is not None and not i.done]
        for item in active:
            assert item.draft is not None
            item.report = guard_layer1.check(item.draft, item.sources, self._cfg.pipeline.guard)
        await self._verify(repos, ctx, budget, active)
        failing = [i for i in active if not i.report.passed]
        if failing and self._ai.rewrite_on_failure:
            await self._rewrite(repos, ctx, budget, failing)
        for item in items:
            if item.done:
                continue
            if item.draft is None:
                await self._failed(repos, ctx, item, report)
            else:
                await self._finish(repos, ctx, item, modes, report)

    async def _first_call(
        self, repos: Repositories, ctx: RunContext, budget: Budget, items: list[Item]
    ) -> None:
        assert self._provider is not None
        provider = self._provider
        kind = items[0].kind
        lang, cats = self._ai.output_language, self._categories
        payload: list[dict[str, Any]]
        if kind == STORY:
            payload = [{"id": i.key, "length": self._length(i), "sources": i.meta} for i in items]
            result: AIResult[Any] = await self._call(
                repos,
                ctx,
                budget,
                "summarize",
                items,
                lambda: provider.summarize(payload, language=lang, categories=cats),
            )
        else:
            payload = [{"id": i.key, "previous": i.previous, "sources": i.meta} for i in items]
            result = await self._call(
                repos,
                ctx,
                budget,
                "update",
                items,
                lambda: provider.update(payload, language=lang, categories=cats),
            )
        by_key = _by_id(result.data.articles, items)
        for item in items:
            answer = by_key.get(item.key)
            if answer is None:
                item.failure = "invalid_output: the answer had no item with this id"
                continue
            if kind == UPDATE:
                item.done = False
                item.previous = {
                    **(item.previous or {}),
                    "_same_event": answer.same_event,
                    "_has_new": answer.has_new_information,
                    "_corrections": [c.model_dump() for c in getattr(answer, "corrections", [])],
                }
            fields = answer.model_dump(
                exclude={"id", "same_event", "has_new_information", "corrections"}
            )
            item.draft = SummaryDraft.model_validate(fields).cleaned()
            item.model = result.usage.model

    def _length(self, item: Item) -> str:
        return "long" if item.article.priority >= self._ai.long_summary_min_importance else "short"

    async def _decide_update(
        self, repos: Repositories, ctx: RunContext, item: Item, report: AIReport
    ) -> None:
        """Different event → own story · nothing new → corroboration · else: an update text."""
        flags = item.previous or {}
        reports = [item.article, *item.members]
        proposals = flags.get("_corrections") or []
        wanted = flags.get("_same_event", True) and proposals and item.story is not None
        if wanted and self._corrections is not None and item.story is not None:
            names = {f"s{a.id}": self._stories.report_of(a).source_name for a in reports}
            report.corrections += await self._corrections.propose(
                repos, ctx, item.story, proposals, item.sources, names
            )
        if not flags.get("_same_event", True):
            for article in reports:
                await self._stories.detach(repos, ctx, article, "AI: a different event")
                report.detached += 1
            item.done = True
        elif not flags.get("_has_new", True):
            await self._corroborate(repos, ctx, item.story, reports)
            report.corroborated += len(reports)
            item.done = True

    async def _corroborate(
        self,
        repos: Repositories,
        ctx: RunContext,
        story: StoryCluster | None,
        reports: list[Article],
    ) -> None:
        now = ctx.now()
        for article in reports:
            article.cluster_role = ClusterRole.CORROBORATION.value
            article.duplicate_of_id = story.lead_article_id if story else None
            article.dedup_level = DedupLevel.EVENT.value
            await repos.articles.set_status(
                article, ArticleStatus.MERGED, now, "corroborates the published story, nothing new"
            )
            await repos.jobs.record(
                article.id,
                Stage.AI_UPDATE,
                JobStatus.SKIPPED,
                ctx.run_id,
                now,
                details={"corroboration": True},
            )
        if story is not None:
            timeline_event(
                story, now.isoformat(), "corroborated", article_ids=[a.id for a in reports]
            )
            await self._stories.refresh_sources(repos, story)

    async def _verify(
        self, repos: Repositories, ctx: RunContext, budget: Budget, items: list[Item]
    ) -> None:
        """Guard layer 2. Unavailable verification is an issue, never a pass."""
        if not self._ai.verify or not items:
            return
        assert self._provider is not None
        provider = self._provider
        payload = []
        for i in items:
            assert i.draft is not None
            payload.append(
                {
                    "id": i.key,
                    "sources": i.meta,
                    "draft": {
                        "title": i.draft.title,
                        "summary": i.draft.summary,
                        "key_points": i.draft.key_points,
                    },
                    "claims": [
                        {"index": n, "text": c.text, "sources": [s.source_id for s in c.support]}
                        for n, c in enumerate(i.draft.claims)
                    ],
                }
            )
        try:
            result = await self._call(
                repos, ctx, budget, "verify", items, lambda: provider.verify(payload)
            )
        except AIError as exc:
            # never a pass: the drafts go to a human; a provider failure also stops the stage
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
                "kind": i.kind,
                "previous": _public(i.previous),
                "sources": i.meta,
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
            item.report = guard_layer1.check(item.draft, item.sources, self._cfg.pipeline.guard)
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
        stage = Stage.AI_UPDATE if item.kind == UPDATE else Stage.AI_SUMMARIZE
        await repos.jobs.record(
            article.id, stage, JobStatus.FAILED, ctx.run_id, now, error=item.failure
        )
        attempts = await repos.jobs.attempts(article.id, stage)
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
        article, draft, story = item.article, item.draft, item.story
        if item.kind == STORY and draft.excluded_sources:
            await self._exclude(repos, ctx, item, report)
        cls = dict(article.classification or {})
        category = draft.category if draft.category in self._categories else article.category
        if category and category != article.category:
            cls["rule_category"] = article.category
            article.category = category
        cls["hashtags"] = self._hashtags(category, cls.get("hashtags") or [])
        article.classification = cls

        summary = reuse if reuse is not None and reuse.article_id == article.id else None
        if summary is None:
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

        groups = self._origins(item)
        best = groups[0].best if groups else None
        source = self._cfg.source(article.source_id)
        age = (now - article.effective_at).total_seconds() / 3600
        imp = importance(article.priority, draft.importance, age, self._cfg.pipeline.scoring)
        guard_state = (
            "failed" if not item.report.passed else "after_rewrite" if item.rewritten else "passed"
        )
        independent = (
            story.independent_sources if item.kind == UPDATE and story else max(1, len(groups))
        )
        best_source = self._cfg.source(best.source_id) if best else source
        conf = confidence(
            reliability=best.reliability if best else (source.reliability_score if source else 50),
            source_type=best_source.source_type if best_source else SourceType.BLOG,
            quality=article.quality_score or 0,
            guard_state=guard_state,
            independent_sources=independent,
            contradictions=len(draft.contradictions),
            cfg=self._cfg.pipeline.scoring,
        )
        article.importance_score, article.importance = imp.value, imp.as_dict()
        article.confidence_score, article.confidence = conf.value, conf.as_dict()
        await self._store_claims(repos, item, summary, groups)
        self._mark_breaking(item, imp.value, conf.value, now)

        ruled = evaluate_rules(
            self._cfg.rules.rules,
            Facts(
                category=category,
                source=article.source_id,
                source_type=str(source.source_type) if source else None,
                language=article.language,
                sensitive_topics=tuple(cls.get("sensitive_topics") or []),
                breaking=article.breaking,
                contradiction=bool(draft.contradictions),
                kind=item.kind,
                confidence=conf.value,
                importance=imp.value,
                priority=article.priority,
                independent_sources=independent,
                text=f"{article.title_original}\n{article.description_original or ''}",
            ),
        )
        if ruled.hits:
            article.classification = {**cls, "rules": ruled.hits}
        if ruled.priority is not None:
            article.priority = ruled.priority
        mode = ruled.mode or modes.for_category(category)
        decided = route(
            mode=mode,
            sensitive_topics=list(cls.get("sensitive_topics") or []),
            guard_passed=item.report.passed,
            insufficient=draft.insufficient_information,
            confidence=conf.value,
            importance=imp.value,
            auto=self._cfg.editorial.auto_publish,
            conflicting=bool(draft.contradictions) and self._story.review_conflicts,
        )
        decided = apply_rules(decided, ruled)
        article.publish_mode = mode.value
        article.review_reason = (
            decided.reason if decided.status is not ArticleStatus.QUEUED else None
        )
        await repos.articles.set_status(article, decided.status, now, decided.reason)
        if item.kind == UPDATE:
            await self._corroborate(repos, ctx, story, item.members)  # folded into this update
            report.updates += 1
        if story is not None:
            self._update_story(story, item, summary, imp.value, conf.value, now)
        stage = Stage.AI_UPDATE if item.kind == UPDATE else Stage.AI_SUMMARIZE
        await repos.jobs.record(
            article.id,
            stage,
            JobStatus.DONE,
            ctx.run_id,
            now,
            details={
                "summary_id": summary.id,
                "route": decided.reason,
                "guard": item.report.as_dict(),
                "cached": reuse is not None,
                "sources": sorted(item.sources),
                "independent_sources": independent,
                "contradictions": len(draft.contradictions),
            },
        )
        report.processed += 1
        report.routed[decided.status.value] = report.routed.get(decided.status.value, 0) + 1

    def _mark_breaking(self, item: Item, importance: int, conf: int, now: datetime) -> None:
        """🔴 or not (domain/breaking.py) — the reason is kept either way."""
        article, story = item.article, item.story
        first_seen = story.first_seen if story is not None else article.effective_at
        decided = decide_breaking(
            priority=article.priority,
            importance=importance,
            confidence=conf,
            age_minutes=(now - first_seen).total_seconds() / 60,
            update=item.kind == UPDATE,
            cfg=self._cfg.pipeline.breaking,
        )
        article.breaking, article.breaking_reason = decided.breaking, decided.reason
        if decided.breaking and story is not None and story.breaking_at is None:
            story.breaking_at = now
            timeline_event(
                story, now.isoformat(), "breaking", article_id=article.id, reason=decided.reason
            )

    async def _exclude(
        self, repos: Repositories, ctx: RunContext, item: Item, report: AIReport
    ) -> None:
        """Sources the AI says are about another event leave the story (never the lead)."""
        assert item.draft is not None
        excluded = set(item.draft.excluded_sources) - {f"s{item.article.id}"}
        keep: list[Article] = []
        for member in item.members:
            if f"s{member.id}" in excluded:
                await self._stories.detach(repos, ctx, member, "AI: about another event")
                item.sources.pop(f"s{member.id}", None)
                report.detached += 1
            else:
                keep.append(member)
        item.members = keep

    def _origins(self, item: Item) -> list[Origin]:
        reports = [
            self._stories.report_of(a)
            for a in (item.article, *item.members)
            if a.transport == "rss" and f"s{a.id}" in item.sources
        ]
        return origins(reports, self._story.syndication_min_jaccard) if reports else []

    async def _store_claims(
        self, repos: Repositories, item: Item, summary: Summary, groups: list[Origin]
    ) -> None:
        """Claims with their evidence and status (spec §8); disagreements as conflicting."""
        assert item.draft is not None
        if await repos.stories.claims_for(summary.id):
            return  # a reused summary already has them
        scoring = self._cfg.pipeline.scoring
        group_of = {aid: n for n, g in enumerate(groups) for aid in g.article_ids}
        rejected = {i.detail for i in item.report.issues if i.kind == "unsupported_claim"}
        cluster_id = item.story.id if item.story else None
        for claim in item.draft.claims:
            supports = [(s.source_id, s.evidence) for s in claim.support] or (
                [(f"s{item.article.id}", claim.evidence)] if claim.evidence else []
            )
            article_ids = [_aid(sid) for sid, _ in supports if _aid(sid) is not None]
            origin_ids = {group_of[a] for a in article_ids if a in group_of}
            primaries = [groups[n].best.reliability for n in origin_ids if groups[n].best.primary]
            status = claim_status(
                independent_supports=len(origin_ids),
                strongest_primary_reliability=max(primaries) if primaries else None,
                conflicting=False,
                rejected=claim.text[:200] in rejected,
                likely_min_reliability=scoring.likely_min_reliability,
            )
            reliabilities = [groups[n].best.reliability for n in origin_ids]
            await repos.stories.add_claim(
                Claim(
                    cluster_id=cluster_id,
                    summary_id=summary.id,
                    article_id=item.article.id,
                    text=claim.text,
                    status=status,
                    confidence=claim_confidence(status, reliabilities),
                    source_article_ids=sorted(a for a in article_ids if a is not None),
                ),
                [
                    Evidence(article_id=aid, excerpt=ev, supports=True)
                    for sid, ev in supports
                    if (aid := _aid(sid)) is not None
                ],
            )
        for contradiction in item.draft.contradictions:
            versions = [
                {
                    "source_id": v.source_id,
                    "article_id": _aid(v.source_id),
                    "statement": v.statement,
                    "evidence": v.evidence,
                }
                for v in contradiction.versions
            ]
            await repos.stories.add_claim(
                Claim(
                    cluster_id=cluster_id,
                    summary_id=summary.id,
                    article_id=item.article.id,
                    text=contradiction.topic,
                    status=CONFLICTING,
                    confidence=claim_confidence(CONFLICTING, []),
                    source_article_ids=sorted(
                        {v["article_id"] for v in versions if v["article_id"] is not None}
                    ),
                    versions=versions,
                ),
                [
                    Evidence(article_id=v["article_id"], excerpt=v["evidence"], supports=True)
                    for v in versions
                    if v["article_id"] is not None
                ],
            )

    def _update_story(
        self, story: StoryCluster, item: Item, summary: Summary, imp: int, conf: int, now: datetime
    ) -> None:
        assert item.draft is not None
        names = [e.original for e in item.draft.entities if e.original]
        places = [e.original for e in item.draft.entities if e.type == "place" and e.original]
        story.entities = list(dict.fromkeys([*(story.entities or []), *names]))[:60]
        story.locations = list(dict.fromkeys([*(story.locations or []), *places]))[:20]
        story.contradictions = max(story.contradictions or 0, len(item.draft.contradictions))
        if item.kind == STORY:
            story.summary_id = summary.id
            story.title = item.draft.title
            story.category = item.article.category
            story.importance_score, story.confidence_score = imp, conf
        story.updated_at = now
        timeline_event(
            story,
            now.isoformat(),
            "summarized" if item.kind == STORY else "update_ready",
            article_id=item.article.id,
            summary_id=summary.id,
            sources=sorted(item.sources),
        )

    def _prompt_version(self, item: Item) -> str:
        assert self._provider is not None
        if item.origin is SummaryOrigin.REWRITE:
            operation = "rewrite"
        else:
            operation = "update" if item.kind == UPDATE else "summarize"
        return self._provider.prompt_version(operation, self._ai.output_language)

    def _hashtags(self, category: str | None, existing: list[str]) -> list[str]:
        tags: list[str] = []
        main = self._cfg.categories.get(category or "")
        if main is not None:
            tags.append(main.hashtag)
        tags.extend(t for t in existing if t not in tags)
        return tags[: self._cfg.pipeline.classification.max_hashtags]


def _aid(source_id: str) -> int | None:
    """``s123`` → 123 (only ids we sent; anything else is not an article)."""
    if source_id.startswith("s") and source_id[1:].isdigit():
        return int(source_id[1:])
    return None


def _public(previous: dict[str, Any] | None) -> dict[str, Any] | None:
    if previous is None:
        return None
    return {k: v for k, v in previous.items() if not k.startswith("_")}


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
